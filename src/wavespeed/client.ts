/**
 * WaveSpeed AI - Any LLM Gateway client.
 * Used as the "LLM sensor" layer: converts raw text → structured data.
 * The LLM NEVER decides buy/sell. It classifies and extracts.
 */

import { z, ZodSchema } from 'zod';

const WAVESPEED_API_URL = 'https://api.wavespeed.ai/api/v3/wavespeed-ai/any-llm';

// Cost per 1M tokens on WaveSpeed (March 2026 pricing)
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  'anthropic/claude-haiku-4.5':    { input: 1.10, output: 5.50 },
  'anthropic/claude-3.5-haiku':    { input: 0.88, output: 4.40 },
  'anthropic/claude-3-haiku':      { input: 0.28, output: 1.40 },
  'anthropic/claude-sonnet-4.5':   { input: 3.00, output: 15.00 },
  'anthropic/claude-sonnet-4.6':   { input: 3.00, output: 15.00 },
  'anthropic/claude-3.5-sonnet':   { input: 3.00, output: 15.00 },
  'google/gemini-2.5-flash':       { input: 0.15, output: 0.60 },
  'google/gemini-2.5-pro':         { input: 1.25, output: 10.00 },
  'openai/gpt-4o':                 { input: 2.50, output: 10.00 },
  'workers-ai/llama-4-scout':      { input: 0, output: 0 }, // Free on Workers AI
};

/** In-memory cost tracker for the current cron cycle */
export const costTracker = {
  totalCalls: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostUsd: 0,
  wavespeedCalls: 0,
  wavespeedCost: 0,
  workersAiCalls: 0,
  nvidiaCalls: 0,

  track(model: string, inputTokens: number, outputTokens: number) {
    this.totalCalls++;
    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;

    if (model.startsWith('workers-ai/') || model.startsWith('nvidia/')) {
      // Free tier models
      if (model.startsWith('workers-ai/')) this.workersAiCalls++;
      else this.nvidiaCalls++;
      return 0;
    }

    // Paid models (WaveSpeed)
    const costs = MODEL_COSTS[model] || { input: 1.0, output: 5.0 };
    const cost = (inputTokens * costs.input + outputTokens * costs.output) / 1_000_000;
    this.totalCostUsd += cost;
    this.wavespeedCalls++;
    this.wavespeedCost += cost;
    return cost;
  },

  reset() {
    this.totalCalls = 0;
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalCostUsd = 0;
    this.wavespeedCalls = 0;
    this.wavespeedCost = 0;
    this.workersAiCalls = 0;
    this.nvidiaCalls = 0;
  },
};

/** Persistent cost data stored in KV */
export interface CostData {
  // Lifetime totals
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  wavespeedCalls: number;
  wavespeedCost: number;
  workersAiCalls: number;
  nvidiaCalls: number;
  // Daily breakdown
  daily: Record<string, {
    calls: number;
    costUsd: number;
    wavespeedCalls: number;
    wavespeedCost: number;
    workersAiCalls: number;
    nvidiaCalls: number;
  }>;
  // First tracked date
  startedAt: string;
  // Last update
  updatedAt: string;
}

const COST_KV_KEY = 'llm_costs_v1';

/** Load persistent costs from KV */
export async function loadCosts(kv: KVNamespace): Promise<CostData> {
  const raw = await kv.get(COST_KV_KEY);
  if (raw) return JSON.parse(raw);
  return {
    totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0,
    totalCostUsd: 0, wavespeedCalls: 0, wavespeedCost: 0, workersAiCalls: 0, nvidiaCalls: 0,
    daily: {}, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

/** Flush current cycle costs to KV (call at end of each cron cycle) */
export async function flushCosts(kv: KVNamespace): Promise<CostData> {
  const data = await loadCosts(kv);
  const today = new Date().toISOString().slice(0, 10);

  // Accumulate lifetime totals
  data.totalCalls += costTracker.totalCalls;
  data.totalInputTokens += costTracker.totalInputTokens;
  data.totalOutputTokens += costTracker.totalOutputTokens;
  data.totalCostUsd += costTracker.totalCostUsd;
  data.wavespeedCalls += costTracker.wavespeedCalls;
  data.wavespeedCost += costTracker.wavespeedCost;
  data.workersAiCalls += costTracker.workersAiCalls;

  // Accumulate daily
  data.nvidiaCalls = (data.nvidiaCalls || 0) + costTracker.nvidiaCalls;

  if (!data.daily[today]) {
    data.daily[today] = { calls: 0, costUsd: 0, wavespeedCalls: 0, wavespeedCost: 0, workersAiCalls: 0, nvidiaCalls: 0 };
  }
  data.daily[today].calls += costTracker.totalCalls;
  data.daily[today].costUsd += costTracker.totalCostUsd;
  data.daily[today].wavespeedCalls += costTracker.wavespeedCalls;
  data.daily[today].wavespeedCost += costTracker.wavespeedCost;
  data.daily[today].workersAiCalls += costTracker.workersAiCalls;
  data.daily[today].nvidiaCalls = (data.daily[today].nvidiaCalls || 0) + costTracker.nvidiaCalls;

  data.updatedAt = new Date().toISOString();

  await kv.put(COST_KV_KEY, JSON.stringify(data));
  costTracker.reset();
  return data;
}

/** Format persistent costs for Telegram */
export function formatCostsTelegram(costs: CostData, tradingPnl: number, unrealizedPnl: number): string {
  const days = Object.keys(costs.daily).length || 1;
  const totalPnl = tradingPnl + unrealizedPnl;
  // Monthly projection from cumulative average (all-time P&L / days * 30)
  const dailyPnlAvg = totalPnl / days;
  const monthlyPnlEstimate = dailyPnlAvg * 30;

  let msg = `\u{1F4B0} <b>Costi & P&L Netto</b>\n\n`;

  msg += `<b>━━━ Trading P&L ━━━</b>\n`;
  msg += `Realizzato: <code>${tradingPnl >= 0 ? '+' : ''}$${tradingPnl.toFixed(2)}</code>\n`;
  msg += `Unrealized: <code>${unrealizedPnl >= 0 ? '+' : ''}$${unrealizedPnl.toFixed(2)}</code>\n`;
  msg += `Totale: <code>${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}</code>\n`;
  msg += `Media/giorno: <code>${dailyPnlAvg >= 0 ? '+' : ''}$${dailyPnlAvg.toFixed(2)}</code>\n\n`;

  msg += `<b>━━━ Costi LLM ━━━</b>\n`;
  const nvCalls = costs.nvidiaCalls || 0;
  msg += `Totale: <code>${costs.totalCalls} calls</code>\n`;
  msg += `  NVIDIA Qwen 3.5: <code>${nvCalls} calls</code> - $0 \u{2705}\n`;
  msg += `  Workers AI Llama 4: <code>${costs.workersAiCalls} calls</code> - $0 \u{2705}\n`;
  if (costs.wavespeedCost > 0) {
    msg += `  WaveSpeed (fallback): <code>${costs.wavespeedCalls} calls</code> - $${costs.wavespeedCost.toFixed(4)}\n`;
  }
  const monthlyLlmCost = costs.totalCostUsd / days * 30;
  msg += `<b>Costo LLM/mese: <code>$${monthlyLlmCost.toFixed(2)}</code></b>${monthlyLlmCost < 1 ? ' \u{2705}' : ''}\n\n`;

  msg += `<b>━━━ Costi Infra ━━━</b>\n`;
  msg += `Cloudflare (Workers/KV/D1/AI): <code>$0</code>\n`;
  msg += `NVIDIA NIM API: <code>$0</code> (free fino 20/09/2026)\n`;
  msg += `Telegram: <code>$0</code>\n\n`;

  msg += `<b>━━━ NETTO MENSILE (stima cumulativa) ━━━</b>\n`;
  const netEmoji = monthlyPnlEstimate >= 0 ? '\u{1F4B9}' : '\u{26A0}\u{FE0F}';
  msg += `P&L medio/giorno: <code>${dailyPnlAvg >= 0 ? '+' : ''}$${dailyPnlAvg.toFixed(2)}</code>\n`;
  msg += `Proiezione 30gg: ${netEmoji} <code>${monthlyPnlEstimate >= 0 ? '+' : ''}$${monthlyPnlEstimate.toFixed(2)}/mese</code>\n`;
  msg += `Target: <code>$990/mese ($33/giorno)</code>\n\n`;

  msg += `<i>\u{1F4C5} Tracking da ${costs.startedAt.slice(0, 10)} (${days} giorni)</i>`;
  return msg;
}

export interface WaveSpeedResponse {
  code: number;
  data: {
    id: string;
    status: string;
    outputs: string;
    timings?: { inference: number };
  };
}

/**
 * Call WaveSpeed Any LLM API.
 * Returns the text output and inference time.
 */
export async function callWaveSpeed(
  apiKey: string,
  opts: {
    prompt: string;
    systemPrompt: string;
    model: string;
    temperature?: number;
    maxTokens?: number;
  }
): Promise<{ text: string; inferenceMs: number }> {
  const res = await fetch(WAVESPEED_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt: opts.prompt,
      system_prompt: opts.systemPrompt,
      model: opts.model,
      temperature: opts.temperature ?? 0.1,
      max_tokens: opts.maxTokens ?? 512,
      enable_sync_mode: true,
    }),
  });

  if (!res.ok) {
    throw new Error(`WaveSpeed API error: ${res.status}`);
  }

  const result = (await res.json()) as WaveSpeedResponse;

  if (result.data.status !== 'completed' || !result.data.outputs) {
    throw new Error(`WaveSpeed task status: ${result.data.status}`);
  }

  // WaveSpeed returns outputs in various formats:
  // - string: "the response text"
  // - array: ["the response text"]
  // - array with markdown: ["```json\n{...}\n```"]
  let text: string;
  const outputs = result.data.outputs;

  if (typeof outputs === 'string') {
    text = outputs;
  } else if (Array.isArray(outputs)) {
    // Join array elements and strip markdown code fences
    text = outputs.join('\n');
  } else {
    text = JSON.stringify(outputs);
  }

  // Strip markdown code fences: ```json ... ```
  text = text.replace(/```json\s*/g, '').replace(/```\s*/g, '');

  // Estimate tokens (~4 chars per token) and track cost
  const inputTokens = Math.ceil((opts.prompt.length + opts.systemPrompt.length) / 4);
  const outputTokens = Math.ceil(text.length / 4);
  const callCost = costTracker.track(opts.model, inputTokens, outputTokens);

  return {
    text: text.trim(),
    inferenceMs: result.data.timings?.inference ?? 0,
    estimatedCost: callCost,
  };
}

/**
 * Extract and validate JSON from LLM text response.
 * Uses Zod schema for type-safe validation.
 */
export function extractJson<T>(text: string, schema?: ZodSchema<T>): T | null {
  // Try full response as JSON first
  try {
    const parsed = JSON.parse(text);
    if (schema) {
      const result = schema.safeParse(parsed);
      return result.success ? result.data : null;
    }
    return parsed as T;
  } catch {
    // Fall through to regex extraction
  }

  // Extract last JSON object from text
  const matches = text.match(/\{[^{}]*\}/g);
  if (!matches) return null;

  // Try from last match (most likely the actual JSON)
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(matches[i]);
      if (schema) {
        const result = schema.safeParse(parsed);
        if (result.success) return result.data;
      } else {
        return parsed as T;
      }
    } catch {
      continue;
    }
  }

  return null;
}
