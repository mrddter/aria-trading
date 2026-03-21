/**
 * NVIDIA NIM API client for Qwen3.5 122B.
 * Used as the Strategist agent - called only when a strong signal is detected.
 * Has enable_thinking for chain-of-thought reasoning.
 */

import { costTracker } from './client';

const NVIDIA_API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

export interface NvidiaResponse {
  text: string;
  thinkingText?: string;
  inferenceMs: number;
  estimatedCost: number;
}

/**
 * Call Qwen3.5 via NVIDIA NIM API.
 * Returns the model's response with optional thinking trace.
 */
export async function callQwenStrategist(
  apiKey: string,
  opts: {
    prompt: string;
    systemPrompt: string;
    temperature?: number;
    maxTokens?: number;
    enableThinking?: boolean;
  }
): Promise<NvidiaResponse> {
  const start = Date.now();

  const response = await fetch(NVIDIA_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      model: 'qwen/qwen3.5-122b-a10b',
      messages: [
        { role: 'system', content: opts.systemPrompt },
        { role: 'user', content: opts.prompt },
      ],
      max_tokens: opts.maxTokens ?? 8192,
      temperature: opts.temperature ?? 0.6,
      top_p: 0.95,
      stream: false,
      chat_template_kwargs: {
        enable_thinking: opts.enableThinking ?? true,
      },
    }),
  });

  const inferenceMs = Date.now() - start;

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`NVIDIA API ${response.status}: ${errorText.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    choices: Array<{
      message: {
        content: string;
        reasoning_content?: string;
      };
    }>;
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  };

  const choice = data.choices?.[0];
  let text = choice?.message?.content || '';
  const thinkingText = choice?.message?.reasoning_content || '';

  // Qwen3.5 sometimes puts JSON in thinking instead of content
  // If content is empty but thinking has JSON, extract it
  if (!text && thinkingText) {
    const jsonMatch = thinkingText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      text = jsonMatch[1].trim();
    } else {
      // Try to find raw JSON object/array in thinking
      const rawJson = thinkingText.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
      if (rawJson) {
        text = rawJson[1].trim();
      }
    }
  }

  // Track costs - NVIDIA NIM pricing for Qwen3.5 122B
  // ~$0.18/1M input, ~$0.18/1M output (very cheap for 122B model)
  const inputTokens = data.usage?.prompt_tokens || 0;
  const outputTokens = data.usage?.completion_tokens || 0;
  const estimatedCost = (inputTokens * 0.18 + outputTokens * 0.18) / 1_000_000;

  costTracker.track('nvidia/qwen3.5-122b', inputTokens, outputTokens);

  return {
    text: text.trim(),
    thinkingText: thinkingText.trim(),
    inferenceMs,
    estimatedCost,
  };
}
