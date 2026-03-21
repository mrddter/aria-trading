/**
 * Sentiment data types.
 * These are the structured outputs from the "LLM as sensor" pattern.
 * The LLM converts raw text → these structures. It never decides buy/sell.
 */

/** Single sentiment signal from one source/article */
export interface SentimentSignal {
  asset: string;            // "BTC", "ETH", "SOL", or "MARKET" for general
  sentimentScore: number;   // -1.0 (extremely bearish) to +1.0 (extremely bullish)
  confidence: number;       // 0.0 to 1.0
  magnitude: number;        // 0.0 to 1.0 (how impactful the event is)
  direction: 'positive' | 'negative' | 'neutral';
  source: string;           // "cryptocompare", "fear_greed", "reddit", etc.
  category: 'event' | 'sentiment_aggregate' | 'rumor' | 'announcement';
  timestamp: number;
}

/** Aggregated sentiment snapshot for one asset */
export interface SentimentSnapshot {
  asset: string;
  compositeScore: number;   // weighted average of recent signals
  signalCount: number;      // number of signals in the window
  freshnessHours: number;   // hours since oldest signal included
  avgConfidence: number;
  avgMagnitude: number;
  timestamp: number;
}

/** Historical sentiment data point (for backtesting) */
export interface HistoricalSentimentPoint {
  timestamp: number;
  fearGreedIndex: number;   // 0-100 (raw from Alternative.me)
  fearGreedNormalized: number; // -1 to +1
  newsCount: number;        // articles in time window
  newsSentimentAvg: number; // -1 to +1 average from CryptoCompare
  relatedAssets: string[];  // which coins mentioned
}

/** Portfolio allocation for market-neutral strategy */
export interface PortfolioLeg {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  sentimentScore: number;
  entryPrice: number;
  quantity: number;       // USDT size
  stopLoss: number;
  takeProfit: number;
  entryTime: number;
}
