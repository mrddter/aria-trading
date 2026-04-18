/**
 * Workers AI client for Llama 4 Scout and Kimi K2.
 * Free tier: 10,000 neurons/day on Cloudflare Workers AI.
 */

import { costTracker } from './client';

export interface AiBinding {
  run(model: string, inputs: {
    messages: Array<{ role: string; content: string }>;
    max_tokens?: number;
    temperature?: number;
  }): Promise<{ response?: string }>;
}

/**
 * Batch sensor: Llama 4 Scout primary, GPT-OSS 20B fallback.
 * Both verified working on Workers AI on 2026-04-18.
 */
const SENSOR_BATCH_MODELS = [
  { id: '@cf/meta/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout' },
  { id: '@cf/openai/gpt-oss-20b', name: 'GPT-OSS 20B' },
];

export async function callWorkersAI(
  ai: AiBinding,
  opts: {
    prompt: string;
    systemPrompt: string;
    temperature?: number;
    maxTokens?: number;
  }
): Promise<{ text: string; inferenceMs: number; estimatedCost: number }> {
  const errors: string[] = [];

  for (const model of SENSOR_BATCH_MODELS) {
    const start = Date.now();
    try {
      const result: any = await ai.run(model.id, {
        messages: [
          { role: 'system', content: opts.systemPrompt },
          { role: 'user', content: opts.prompt },
        ],
        max_tokens: opts.maxTokens ?? 512,
        temperature: opts.temperature ?? 0.05,
      });

      const inferenceMs = Date.now() - start;
      const text = extractText(result).trim();

      if (!text) {
        errors.push(`${model.name}: empty (${inferenceMs}ms)`);
        console.warn(`[SensorBatch] ${model.name} empty, trying next...`);
        continue;
      }

      const inputTokens = Math.ceil((opts.prompt.length + opts.systemPrompt.length) / 4);
      const outputTokens = Math.ceil(text.length / 4);
      costTracker.track(`workers-ai/${model.name}`, inputTokens, outputTokens);

      return { text, inferenceMs, estimatedCost: 0 };
    } catch (err) {
      errors.push(`${model.name}: ${(err as Error).message?.slice(0, 80)}`);
      console.warn(`[SensorBatch] ${model.name} failed, trying next...`);
    }
  }

  throw new Error(`All batch sensor models failed: ${errors.join(' | ')}`);
}

/**
 * High-impact sensor models in priority order.
 * Same shape handling as the strategist; gpt-oss has the cleanest JSON output
 * for single-item classification, llama-4-scout is the proven workhorse fallback.
 */
const SENSOR_HIGH_MODELS = [
  { id: '@cf/openai/gpt-oss-120b', name: 'GPT-OSS 120B' },
  { id: '@cf/openai/gpt-oss-20b', name: 'GPT-OSS 20B' },
  { id: '@cf/meta/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout' },
];

/**
 * Single-item sentiment classification with model fallback. Used for HIGH-impact news.
 */
export async function callSensorHigh(
  ai: AiBinding,
  opts: {
    prompt: string;
    systemPrompt: string;
    temperature?: number;
    maxTokens?: number;
  },
): Promise<{ text: string; inferenceMs: number; estimatedCost: number; model: string }> {
  const errors: string[] = [];

  for (const model of SENSOR_HIGH_MODELS) {
    const start = Date.now();
    try {
      const result: any = await ai.run(model.id, {
        messages: [
          { role: 'system', content: opts.systemPrompt },
          { role: 'user', content: opts.prompt },
        ],
        max_tokens: opts.maxTokens ?? 384,
        temperature: opts.temperature ?? 0.05,
      });

      const inferenceMs = Date.now() - start;
      const text = extractText(result).trim();

      if (!text) {
        errors.push(`${model.name}: empty response (${inferenceMs}ms)`);
        console.warn(`[SensorHIGH] ${model.name} returned empty, trying next...`);
        continue;
      }

      const inputTokens = Math.ceil((opts.prompt.length + opts.systemPrompt.length) / 4);
      const outputTokens = Math.ceil(text.length / 4);
      costTracker.track(`workers-ai/${model.name}`, inputTokens, outputTokens);

      console.log(`[SensorHIGH] ${model.name} responded in ${inferenceMs}ms (${text.length} chars)`);

      return { text, inferenceMs, estimatedCost: 0, model: model.name };
    } catch (err) {
      const msg = (err as Error).message?.slice(0, 100) || 'unknown';
      errors.push(`${model.name}: ${msg}`);
      console.warn(`[SensorHIGH] ${model.name} failed: ${msg}, trying next...`);
    }
  }

  throw new Error(`All high-impact sensor models failed: ${errors.join(' | ')}`);
}

/**
 * Strategist models in priority order. Falls through if current is unavailable.
 *
 * Selected via live latency/JSON benchmark (2026-04-18):
 *   - gpt-oss-120b: 1.2s, perfect JSON, OpenAI Responses API shape
 *   - gpt-oss-20b: 0.85s, perfect JSON, same shape
 *   - llama-4-scout: 0.9s, JSON wrapped in ```...```, classic Workers AI shape
 *
 * Removed (broken on Workers AI as of 2026-04-18):
 *   - kimi-k2.5: returns empty response after 12s
 *   - deepseek-r1-distill-qwen-32b: returns think-aloud, not JSON
 *   - qwen2.5-coder-32b: malformed response object
 */
const STRATEGIST_MODELS = [
  { id: '@cf/openai/gpt-oss-120b', name: 'GPT-OSS 120B' },
  { id: '@cf/openai/gpt-oss-20b', name: 'GPT-OSS 20B' },
  { id: '@cf/meta/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout' },
];

/** Extract assistant text across the various Workers AI response shapes. */
function extractText(out: any): string {
  if (typeof out?.response === 'string') return out.response;
  if (Array.isArray(out?.choices) && out.choices[0]?.message?.content) return out.choices[0].message.content;
  if (typeof out?.output_text === 'string') return out.output_text;
  if (Array.isArray(out?.output) && out.output[0]?.content?.[0]?.text) return out.output[0].content[0].text;
  return '';
}

/**
 * Call strategist via Workers AI with model fallback.
 * Tries models in priority order until one succeeds.
 */
export async function callStrategist(
  ai: AiBinding,
  opts: {
    prompt: string;
    systemPrompt: string;
    temperature?: number;
    maxTokens?: number;
  }
): Promise<{ text: string; inferenceMs: number; estimatedCost: number; model: string }> {
  const errors: string[] = [];

  for (const model of STRATEGIST_MODELS) {
    const start = Date.now();
    try {
      const result: any = await ai.run(model.id, {
        messages: [
          { role: 'system', content: opts.systemPrompt },
          { role: 'user', content: opts.prompt },
        ],
        max_tokens: opts.maxTokens ?? 512,
        temperature: opts.temperature ?? 0.3,
      });

      const inferenceMs = Date.now() - start;
      const text = extractText(result).trim();

      // Treat empty response as failure — try next model
      if (!text) {
        errors.push(`${model.name}: empty response (${inferenceMs}ms)`);
        console.warn(`[Strategist] ${model.name} returned empty, trying next...`);
        continue;
      }

      const inputTokens = Math.ceil((opts.prompt.length + opts.systemPrompt.length) / 4);
      const outputTokens = Math.ceil(text.length / 4);
      costTracker.track(`workers-ai/${model.name}`, inputTokens, outputTokens);

      console.log(`[Strategist] ${model.name} responded in ${inferenceMs}ms (${text.length} chars)`);

      return {
        text,
        inferenceMs,
        estimatedCost: 0,
        model: model.name,
      };
    } catch (err) {
      const msg = (err as Error).message?.slice(0, 100) || 'unknown';
      errors.push(`${model.name}: ${msg}`);
      console.warn(`[Strategist] ${model.name} failed: ${msg}, trying next...`);
    }
  }

  throw new Error(`All strategist models failed: ${errors.join(' | ')}`);
}
