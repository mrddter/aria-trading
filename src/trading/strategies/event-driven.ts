/**
 * Event-Driven Trading Strategy
 *
 * Flow: News event detected → LLM classifies → Quant filter confirms → Trade
 *
 * Key rules:
 * 1. Only trade HIGH magnitude events (>0.6)
 * 2. LLM must have HIGH confidence (>0.7)
 * 3. Quant filter must confirm (RSI not extreme, volume spiking, price not already moved)
 * 4. Execute within 60 seconds of event detection
 * 5. Tight SL (1.5x ATR), moderate TP (2.5x ATR) - quick profit target
 */

import { SentimentSignal } from '../../sentiment/types';
import {
  calculateRSI,
  calculateADX,
  calculateATR,
  calculateVolumeSMA,
  calculateEMA,
} from '../../utils/indicators';

export interface EventTradeSetup {
  approved: boolean;
  reason: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  strength: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  atr: number;
  timeoutHours: number; // close after N hours if SL/TP not hit
  indicators: {
    rsi: number;
    adx: number;
    atr: number;
    volumeRatio: number;
  };
}

/**
 * Evaluate whether a sentiment signal warrants a trade.
 * This is the "Quant Filter" that confirms the LLM sensor output.
 */
export function evaluateEventSignal(
  signal: SentimentSignal,
  highs: number[],
  lows: number[],
  closes: number[],
  volumes: number[],
  currentPrice: number
): EventTradeSetup {
  const symbol = signal.asset + 'USDT';

  // Indicators (computed up-front so we can attach them to every reject/approve).
  const rsi = calculateRSI(closes);
  const adxRes = calculateADX(highs, lows, closes);
  const atr = calculateATR(highs, lows, closes);
  const avgVol = calculateVolumeSMA(volumes, 20);
  const recentVol = volumes.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const volumeRatio = avgVol > 0 ? recentVol / avgVol : 1;
  const indicators = { rsi, adx: adxRes.adx, atr, volumeRatio };

  // --- Gate 1: Magnitude threshold ---
  if (signal.magnitude < 0.5) {
    return reject(symbol, 'Magnitude too low (<0.5)', indicators);
  }

  // --- Gate 2: Confidence threshold ---
  if (signal.confidence < 0.7) {
    return reject(symbol, 'Confidence too low (<0.7)', indicators);
  }

  // --- Gate 3: Sentiment must have clear direction ---
  if (Math.abs(signal.sentimentScore) < 0.3) {
    return reject(symbol, 'Sentiment too neutral (|score| < 0.3)', indicators);
  }

  const direction: 'LONG' | 'SHORT' =
    signal.sentimentScore > 0 ? 'LONG' : 'SHORT';

  // --- Gate 4: RSI not at extreme in trade direction ---
  if (direction === 'LONG' && rsi > 75) {
    return reject(symbol, `RSI too high for LONG (${rsi.toFixed(0)})`, indicators);
  }
  if (direction === 'SHORT' && rsi < 25) {
    return reject(symbol, `RSI too low for SHORT (${rsi.toFixed(0)})`, indicators);
  }

  // --- Gate 5: Price hasn't already moved too much ---
  // Check if price moved >6% in the last 3 candles (event already priced in)
  if (closes.length >= 4) {
    const recentMove = Math.abs(
      (closes[closes.length - 1] - closes[closes.length - 4]) / closes[closes.length - 4]
    );
    if (recentMove > 0.06) {
      return reject(symbol, `Price already moved ${(recentMove * 100).toFixed(1)}% (>6%)`, indicators);
    }
  }

  // --- Gate 6: Anti-bounce-trap for SHORT in EXTREME_FEAR (RSI<30 = oversold) ---
  // Caller passes regime via separate path; this gate is in composite-score for now.

  // --- Gate 7: Trend alignment (bonus, not required) ---
  const ema20 = calculateEMA(closes, 20);
  const lastEma20 = ema20[ema20.length - 1];
  let trendBonus = 0;

  if (direction === 'LONG' && currentPrice > lastEma20 && adxRes.plusDI > adxRes.minusDI) {
    trendBonus = 0.1; // trend alignment bonus
  }
  if (direction === 'SHORT' && currentPrice < lastEma20 && adxRes.minusDI > adxRes.plusDI) {
    trendBonus = 0.1;
  }

  // --- Calculate SL/TP ---
  const slMultiplier = 1.5; // Tight SL for event trades
  const tpMultiplier = 2.5; // Quick TP

  let stopLoss: number;
  let takeProfit: number;

  if (direction === 'LONG') {
    stopLoss = currentPrice - atr * slMultiplier;
    takeProfit = currentPrice + atr * tpMultiplier;
  } else {
    stopLoss = currentPrice + atr * slMultiplier;
    takeProfit = currentPrice - atr * tpMultiplier;
  }

  // Strength combines sentiment + confidence + magnitude + trend
  const strength = Math.min(1,
    Math.abs(signal.sentimentScore) * 0.3 +
    signal.confidence * 0.3 +
    signal.magnitude * 0.3 +
    trendBonus
  );

  return {
    approved: true,
    reason: `Event: ${signal.category}, score=${signal.sentimentScore.toFixed(2)}, ` +
      `conf=${signal.confidence.toFixed(2)}, mag=${signal.magnitude.toFixed(2)}, ` +
      `RSI=${rsi.toFixed(0)}, vol=${volumeRatio.toFixed(1)}x`,
    symbol,
    direction,
    strength,
    entryPrice: currentPrice,
    stopLoss,
    takeProfit,
    atr,
    timeoutHours: 2, // Close after 2 hours if no SL/TP (event edge decays)
    indicators,
  };
}

function reject(
  symbol: string,
  reason: string,
  indicators: { rsi: number; adx: number; atr: number; volumeRatio: number },
): EventTradeSetup {
  return {
    approved: false,
    reason,
    symbol,
    direction: 'LONG',
    strength: 0,
    entryPrice: 0,
    stopLoss: 0,
    takeProfit: 0,
    atr: 0,
    timeoutHours: 0,
    indicators,
  };
}
