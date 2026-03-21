/**
 * Workers AI client for Llama 4 Scout.
 * Used for batch news classification (low-impact items).
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
 * Call Llama 4 Scout via Workers AI binding.
 * Same interface as callWaveSpeed for easy swapping.
 */
export async function callWorkersAI(
  ai: AiBinding,
  opts: {
    prompt: string;
    systemPrompt: string;
    temperature?: number;
    maxTokens?: number;
  }
): Promise<{ text: string; inferenceMs: number; estimatedCost: number }> {
  const start = Date.now();

  const result = await ai.run('@cf/meta/llama-4-scout-17b-16e-instruct', {
    messages: [
      { role: 'system', content: opts.systemPrompt },
      { role: 'user', content: opts.prompt },
    ],
    max_tokens: opts.maxTokens ?? 512,
    temperature: opts.temperature ?? 0.05,
  });

  const inferenceMs = Date.now() - start;
  const text = result.response || '';

  // Track as $0 cost (free tier)
  const inputTokens = Math.ceil((opts.prompt.length + opts.systemPrompt.length) / 4);
  const outputTokens = Math.ceil(text.length / 4);
  costTracker.track('workers-ai/llama-4-scout', inputTokens, outputTokens);

  return {
    text: text.trim(),
    inferenceMs,
    estimatedCost: 0, // Free!
  };
}
