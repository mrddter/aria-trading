/**
 * Event-Driven Trading Strategy
 *
 * Flow: News event detected → LLM classifies → Quant filter confirms → Trade
 *
 * Key rules:
 * 1. Only trade HIGH magnitude events (>0.6)
 * 2. LLM must have HIGH confidence (>0.7)
 * 3. Quant filter must confirm (RSI not extreme, volume spiking, price not already moved)
 * 4. RSI momentum gate (Sprint 2A): SHORT/LONG require RSI≥45
 * 5. Volume gates: SHORT vol≥0.5 (panic-sell), LONG vol≥0.7 (buying pressure)
 * 6. Trend confirmation (Sprint 2B): ADX≥18 — no range markets
 * 7. Volatility gate (Sprint 2B): ATR%≥0.4% — TP must be reachable in 4h
 * 8. Execute within 60 seconds of event detection
 * 9. Tight SL (1.5x ATR), TP 1.8x ATR — realistic for 4h holding
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

  // --- Gate 6: RSI direction-momentum gate (Sprint 2A) ---
  // Data 2026-04-19→24 (58 trade): SHORT con RSI 35-45 = WR 33% / -$0.65 (15 trade).
  //                                LONG  con RSI 35-45 = WR 0%  / -$0.20 (2 trade).
  // Estendo anti-bounce SHORT: RSI<45 → block. Aggiungo pro-momentum LONG: RSI<45 → block.
  if (direction === 'SHORT' && rsi < 45) {
    return reject(symbol, `Anti-bounce: SHORT blocked, RSI=${rsi.toFixed(0)} (need ≥45 for clean downtrend)`, indicators);
  }
  if (direction === 'LONG' && rsi < 45) {
    return reject(symbol, `Pro-momentum: LONG blocked, RSI=${rsi.toFixed(0)} (need ≥45 for trend confirmation)`, indicators);
  }
  if (direction === 'SHORT' && volumeRatio < 0.5) {
    return reject(symbol, `Anti-bounce: SHORT blocked, vol=${volumeRatio.toFixed(2)}x (no panic-sell)`, indicators);
  }

  // --- Gate 7: LONG buying-pressure (Sprint 2B) ---
  // Data 25/04: 2 BTC LONG aperti con vol 0.53 e 0.70 → entrambi timeout perdita.
  // Senza domanda confermata, i LONG su news positive si afflosciano.
  // Soglia 0.7 (più permissiva del SHORT 0.5) — i LONG hanno più bisogno di buying pressure.
  if (direction === 'LONG' && volumeRatio < 0.7) {
    return reject(symbol, `LONG blocked: vol=${volumeRatio.toFixed(2)}x (no buying pressure, need ≥0.7)`, indicators);
  }

  // --- Gate 8: ADX minimo — serve un trend confermato (Sprint 2B) ---
  // Data 25/04: BTC LONG con ADX 9.6 e 18.6 → mercato range, TP irraggiungibile.
  // ADX <18 = trend troppo debole/inesistente per un trade event-driven a 4h.
  if (adxRes.adx < 18) {
    return reject(symbol, `Trend troppo debole (ADX=${adxRes.adx.toFixed(0)}<18, mercato range)`, indicators);
  }

  // --- Gate 9: ATR% minimo — serve volatilità sufficiente per il TP (Sprint 2B) ---
  // Data 25/04: BTC LONG con ATR 0.22% e 0.24% → TP a 1.8x ATR ≈ 0.43% movimento.
  // In 4h con mercato piatto BTC non fa 0.43%, quindi timeout garantito.
  // Soglia 0.4% perché TP 1.8x ATR = 0.72% movimento richiesto, ragionevole in 4h.
  const atrPct = (atr / currentPrice) * 100;
  if (atrPct < 0.4) {
    return reject(symbol, `Volatilità insufficiente (ATR=${atrPct.toFixed(2)}%<0.4%, TP irraggiungibile in 4h)`, indicators);
  }

  // --- Gate 10: Trend alignment (bonus, not required) ---
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
  const tpMultiplier = 1.8; // Realistic TP — matches 4h holding window (was 2.5x, too ambitious)

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
    timeoutHours: 4, // Close after 4 hours if no SL/TP (was 2h — too short for TP to hit)
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
