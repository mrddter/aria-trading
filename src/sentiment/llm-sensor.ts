/**
 * LLM Sensor - converts raw text into structured sentiment data.
 *
 * Architecture: Ingestion → THIS MODULE → Quant Filter → Risk → Order
 *
 * The LLM is a CLASSIFIER, not a decision-maker.
 * It extracts: asset, sentiment_score, confidence, magnitude, category.
 * It NEVER says "buy" or "sell".
 */

import { z } from 'zod';
import { extractJson } from '../wavespeed/client';
import { callWorkersAI, callSensorHigh, AiBinding } from '../wavespeed/workers-ai';
import { SentimentSignal } from './types';
import { RawTextItem } from '../ingestion/sources';

// Zod schema for LLM output validation
const SentimentExtractSchema = z.object({
  asset: z.string(),
  sentiment_score: z.number().min(-1).max(1),
  confidence: z.number().min(0).max(1),
  magnitude: z.number().min(0).max(1),
  category: z.enum(['event', 'sentiment_aggregate', 'rumor', 'announcement']),
}).passthrough(); // Allow extra fields like "reasoning" from LLM

type SentimentExtract = z.infer<typeof SentimentExtractSchema>;

// Map protocol/project names → Binance ticker
const ASSET_ALIASES: Record<string, string> = {
  bitcoin: 'BTC', btc: 'BTC', 'bitcoin cash': 'BCH',
  ethereum: 'ETH', eth: 'ETH', ether: 'ETH',
  solana: 'SOL', sol: 'SOL',
  binance: 'BNB', bnb: 'BNB',
  ripple: 'XRP', xrp: 'XRP',
  dogecoin: 'DOGE', doge: 'DOGE', shiba: 'SHIB',
  cardano: 'ADA', ada: 'ADA',
  avalanche: 'AVAX', avax: 'AVAX',
  polkadot: 'DOT', dot: 'DOT',
  chainlink: 'LINK', link: 'LINK',
  polygon: 'POL', matic: 'POL', pol: 'POL',
  sui: 'SUI', aptos: 'APT', arbitrum: 'ARB', optimism: 'OP',
  uniswap: 'UNI', aave: 'AAVE', maker: 'MKR',
  litecoin: 'LTC', ltc: 'LTC',
  near: 'NEAR', 'near protocol': 'NEAR',
  pepe: 'PEPE', floki: 'FLOKI', bonk: 'BONK',
  render: 'RENDER', fetch: 'FET', 'fetch.ai': 'FET',
  injective: 'INJ', sei: 'SEI', celestia: 'TIA',
  filecoin: 'FIL', arweave: 'AR',
  toncoin: 'TON', ton: 'TON',
  zksync: 'ZK', starknet: 'STRK',
  worldcoin: 'WLD', jupiter: 'JUP',
  ethfi: 'ETHFI', eigenlayer: 'EIGEN',
  hedera: 'HBAR', algorand: 'ALGO',
  cosmos: 'ATOM', atom: 'ATOM',
  tron: 'TRX', trx: 'TRX',
};

const SYSTEM_PROMPT = `You are a financial news classifier for the cryptocurrency market.
Extract structured data from the text. Output ONLY valid JSON.

Schema:
{
  "asset": "<TICKER>",
  "sentiment_score": <float -1.0 to 1.0>,
  "confidence": <float 0.0 to 1.0>,
  "magnitude": <float 0.0 to 1.0>,
  "category": "<event|sentiment_aggregate|rumor|announcement>"
}

CRITICAL RULES for "asset":
- ALWAYS identify the specific cryptocurrency ticker. Examples:
  - "ZKsync" → "ZK"
  - "Ethereum merge" → "ETH"
  - "Solana outage" → "SOL"
  - "Banks adopt blockchain" → identify WHICH blockchain → its ticker
- Use "MARKET" ONLY if the news genuinely affects ALL crypto equally with NO specific project mentioned
  (e.g., "Fed raises rates", "G20 bans crypto", "Total crypto market cap drops")
- If a project/protocol is mentioned but you don't know its ticker, use the project name in CAPS (e.g., "ZKSYNC")
- If multiple assets: pick the one MOST affected by the news

Rules for other fields:
- sentiment_score: -1.0 = extremely bearish, 0 = neutral, +1.0 = extremely bullish
- confidence: how certain you are about the classification
- magnitude: how much this should move price
  - ETF approval/major hack = 0.9-1.0
  - Partnership/listing/adoption by major bank = 0.5-0.7
  - Minor update/opinion piece = 0.1-0.3
- category: "event" for things that happened, "rumor" for unconfirmed, "announcement" for official
- Do NOT predict price from technical analysis - only from NEWS CONTENT`;

/**
 * Resolve LLM output asset name to a Binance-compatible ticker.
 */
function resolveAssetTicker(raw: string): string {
  const lower = raw.toLowerCase().trim();
  // Direct alias match
  if (ASSET_ALIASES[lower]) return ASSET_ALIASES[lower];
  // Already uppercase ticker
  if (/^[A-Z]{2,10}$/.test(raw)) return raw;
  // Try partial match
  for (const [alias, ticker] of Object.entries(ASSET_ALIASES)) {
    if (lower.includes(alias) || alias.includes(lower)) return ticker;
  }
  return raw.toUpperCase();
}

/**
 * Process a batch of raw text items through the LLM sensor.
 * Workers AI only: Llama 4 Scout primary with GPT-OSS 20B fallback (free tier).
 */
export async function processBatch(
  ai: AiBinding,
  items: RawTextItem[],
): Promise<SentimentSignal[]> {
  const signals: SentimentSignal[] = [];
  const batchSize = 5;

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchSignals = await processSingleBatch(ai, batch);
    signals.push(...batchSignals);
  }

  return signals;
}

async function processSingleBatch(
  ai: AiBinding,
  items: RawTextItem[],
): Promise<SentimentSignal[]> {
  const prompt = items
    .map((item, idx) => `[${idx + 1}] (${item.source}) ${item.text}`)
    .join('\n\n');

  const fullPrompt = `Analyze these ${items.length} crypto news items. Return a JSON ARRAY with one object per item:\n\n${prompt}\n\nReturn: [${items.map((_, i) => `{item ${i + 1} analysis}`).join(', ')}]`;

  try {
    const result = await callWorkersAI(ai, {
      prompt: fullPrompt,
      systemPrompt: SYSTEM_PROMPT,
      temperature: 0.05,
      maxTokens: 1024,
    });
    const text = result.text;
    const inferenceMs = result.inferenceMs;
    console.log(`[LLM Sensor] Workers AI ${items.length} items, ${inferenceMs}ms - FREE`);

    console.log(`[LLM Sensor] Raw output: ${text.slice(0, 400)}`);

    // Try to parse as array
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        const parsed = JSON.parse(arrayMatch[0]) as unknown[];
        return parsed
          .map((obj, idx) => {
            const validated = SentimentExtractSchema.safeParse(obj);
            if (!validated.success) return null;
            return toSentimentSignal(validated.data, items[idx]);
          })
          .filter((s): s is SentimentSignal => s !== null);
      } catch {
        // Fall through to single-item parsing
      }
    }

    // Fallback: try to extract individual JSON objects
    const signals: SentimentSignal[] = [];
    for (let idx = 0; idx < items.length; idx++) {
      const extracted = extractJson<SentimentExtract>(text, SentimentExtractSchema);
      if (extracted) {
        signals.push(toSentimentSignal(extracted, items[idx]));
        break; // extractJson gets the first match
      }
    }

    return signals;
  } catch (err) {
    console.error('[LLM Sensor] Error:', (err as Error).message);
    return [];
  }
}

/**
 * Process a single high-impact item via Workers AI (gpt-oss-120b primary,
 * gpt-oss-20b → llama-4-scout fallback). Used for event-driven trades where
 * accuracy matters more than latency.
 */
export async function processHighImpactItem(
  ai: AiBinding,
  item: RawTextItem,
): Promise<SentimentSignal | null> {
  const prompt = `URGENT crypto news - analyze carefully:\n\n"${item.text}"\n\nSource: ${item.source}\nPublished: ${new Date(item.publishedAt).toISOString()}\n\nReturn JSON:`;

  try {
    const result = await callSensorHigh(ai, {
      prompt,
      systemPrompt: SYSTEM_PROMPT,
      temperature: 0.1,
      maxTokens: 384,
    });
    console.log(`[LLM Sensor HIGH] ${result.model} ${result.inferenceMs}ms - FREE - ${item.text.slice(0, 60)}...`);
    console.log(`[LLM Sensor HIGH] Raw output: ${result.text.slice(0, 300)}`);

    const extracted = extractJson<SentimentExtract>(result.text, SentimentExtractSchema);
    if (!extracted) {
      console.log('[LLM Sensor HIGH] Failed to extract JSON from output');
      return null;
    }

    return toSentimentSignal(extracted, item);
  } catch (err) {
    console.error('[LLM Sensor HIGH] Error:', (err as Error).message);
    return null;
  }
}

function toSentimentSignal(
  extract: SentimentExtract,
  source: RawTextItem
): SentimentSignal {
  return {
    asset: resolveAssetTicker(extract.asset),
    sentimentScore: extract.sentiment_score,
    confidence: extract.confidence,
    magnitude: extract.magnitude,
    direction: extract.sentiment_score > 0.1
      ? 'positive'
      : extract.sentiment_score < -0.1
        ? 'negative'
        : 'neutral',
    source: source.source,
    category: extract.category,
    timestamp: source.publishedAt,
  };
}
