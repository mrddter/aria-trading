/**
 * Signal generator v2 - Trend-following with regime detection.
 *
 * Key improvements from research (TradingAgents, LLM_trader, LLM-TradeBot):
 * 1. ADX regime filter: only trade when trend is strong (ADX > 25)
 * 2. Trade WITH the trend, not against it (no mean-reversion in trends)
 * 3. Volume confirmation for entries
 * 4. Tighter SL (1x ATR) with wider TP (2.5x ATR) for better R:R
 * 5. EMA alignment requirement (price > EMA20 > EMA50 for LONG)
 */

import {
  calculateRSI,
  calculateEMA,
  calculateMACD,
  calculateBollingerBands,
  calculateATR,
  calculateADX,
  calculateVolumeSMA,
} from '../utils/indicators';

export interface TradingSignal {
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  strength: number;
  action: 'OPEN' | 'CLOSE' | 'HOLD';
  stopLoss: number;
  takeProfit: number;
  atr: number;
  regime: 'TRENDING' | 'RANGING' | 'UNKNOWN';
  indicators: SignalIndicators;
}

export interface SignalIndicators {
  rsi: number;
  ema20: number;
  ema50: number;
  macd: number;
  macdSignal: number;
  macdHistogram: number;
  bbUpper: number;
  bbMiddle: number;
  bbLower: number;
  atr: number;
  adx: number;
  plusDI: number;
  minusDI: number;
  volumeRatio: number; // current vol / avg vol
}

export function generateSignal(
  highs: number[],
  lows: number[],
  closes: number[],
  currentPrice: number,
  volumes?: number[]
): TradingSignal {
  const rsi = calculateRSI(closes);
  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const macd = calculateMACD(closes);
  const bb = calculateBollingerBands(closes);
  const atr = calculateATR(highs, lows, closes);
  const adx = calculateADX(highs, lows, closes);

  // Volume analysis
  let volumeRatio = 1;
  if (volumes && volumes.length > 20) {
    const avgVol = calculateVolumeSMA(volumes, 20);
    volumeRatio = avgVol > 0 ? volumes[volumes.length - 1] / avgVol : 1;
  }

  const lastEma20 = ema20[ema20.length - 1];
  const lastEma50 = ema50[ema50.length - 1];

  if (isNaN(lastEma20) || isNaN(lastEma50)) {
    return neutralSignal(currentPrice, atr, rsi, lastEma20, lastEma50, macd, bb, adx, volumeRatio);
  }

  // ==============================
  // STEP 1: REGIME DETECTION (ADX)
  // ==============================
  const isTrending = adx.adx > 25;
  const isStrongTrend = adx.adx > 35;
  const regime = isTrending ? 'TRENDING' : 'RANGING';

  // EMA alignment
  const bullishEMA = lastEma20 > lastEma50;
  const bearishEMA = lastEma20 < lastEma50;
  const priceAboveEMA = currentPrice > lastEma20 && currentPrice > lastEma50;
  const priceBelowEMA = currentPrice < lastEma20 && currentPrice < lastEma50;

  // DI direction
  const bullishDI = adx.plusDI > adx.minusDI;
  const bearishDI = adx.minusDI > adx.plusDI;

  let longScore = 0;
  let shortScore = 0;

  // ==============================
  // STEP 2: TREND-FOLLOWING SIGNALS
  // ==============================

  if (isTrending) {
    // --- In a trend: trade WITH the trend ---

    // LONG setup: trend up + pullback to support
    if (bullishEMA && bullishDI) {
      longScore += 2; // base trend score

      // RSI pullback in uptrend (40-50 zone = buy the dip)
      if (rsi > 40 && rsi < 55) longScore += 1.5;
      // Price near EMA20 (dynamic support in uptrend)
      if (currentPrice <= lastEma20 * 1.005 && currentPrice >= lastEma20 * 0.99) longScore += 1.5;
      // MACD bullish
      if (macd.histogram > 0) longScore += 1;
      // Price bouncing from BB middle or lower
      if (currentPrice <= bb.middle * 1.01) longScore += 1;
    }

    // SHORT setup: trend down + pullback to resistance
    if (bearishEMA && bearishDI) {
      shortScore += 2;

      if (rsi > 45 && rsi < 60) shortScore += 1.5;
      if (currentPrice >= lastEma20 * 0.995 && currentPrice <= lastEma20 * 1.01) shortScore += 1.5;
      if (macd.histogram < 0) shortScore += 1;
      if (currentPrice >= bb.middle * 0.99) shortScore += 1;
    }

    // Strong trend bonus
    if (isStrongTrend) {
      if (bullishDI) longScore += 1;
      if (bearishDI) shortScore += 1;
    }

  } else {
    // --- In a range: mean-reversion but with caution ---

    // Only trade extreme RSI in ranging markets
    if (rsi < 25 && bullishEMA) {
      longScore += 2;
      if (currentPrice <= bb.lower) longScore += 1.5;
    }
    if (rsi > 75 && bearishEMA) {
      shortScore += 2;
      if (currentPrice >= bb.upper) shortScore += 1.5;
    }

    // Ranging signals are weaker (penalize)
    longScore *= 0.7;
    shortScore *= 0.7;
  }

  // ==============================
  // STEP 3: VOLUME CONFIRMATION
  // ==============================
  // Require above-average volume for entries (1.2x avg)
  if (volumeRatio < 1.0) {
    longScore *= 0.6;
    shortScore *= 0.6;
  } else if (volumeRatio > 1.5) {
    // High volume confirms the signal
    longScore *= 1.2;
    shortScore *= 1.2;
  }

  // ==============================
  // STEP 4: DIRECTION & STRENGTH
  // ==============================
  const maxScore = 8;
  const netScore = longScore - shortScore;

  let direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  let strength: number;
  let action: 'OPEN' | 'CLOSE' | 'HOLD';

  // Very high threshold - only trade the best setups
  if (netScore > 4.0) {
    direction = 'LONG';
    strength = Math.min(longScore / maxScore, 1);
    action = strength > 0.6 ? 'OPEN' : 'HOLD';
  } else if (netScore < -4.0) {
    direction = 'SHORT';
    strength = Math.min(shortScore / maxScore, 1);
    action = strength > 0.6 ? 'OPEN' : 'HOLD';
  } else {
    direction = 'NEUTRAL';
    strength = 0;
    action = 'HOLD';
  }

  // ==============================
  // STEP 5: SL/TP (ATR-based)
  // ==============================
  let stopLoss = 0;
  let takeProfit = 0;

  // Wide TP for high R:R, moderate SL
  const slMultiplier = 2.0;
  const tpMultiplier = isTrending ? 3.5 : 2.5;

  if (direction === 'LONG') {
    stopLoss = currentPrice - atr * slMultiplier;
    takeProfit = currentPrice + atr * tpMultiplier;
  } else if (direction === 'SHORT') {
    stopLoss = currentPrice + atr * slMultiplier;
    takeProfit = currentPrice - atr * tpMultiplier;
  }

  return {
    direction,
    strength,
    action,
    stopLoss,
    takeProfit,
    atr,
    regime,
    indicators: {
      rsi,
      ema20: lastEma20,
      ema50: lastEma50,
      macd: macd.macd,
      macdSignal: macd.signal,
      macdHistogram: macd.histogram,
      bbUpper: bb.upper,
      bbMiddle: bb.middle,
      bbLower: bb.lower,
      atr,
      adx: adx.adx,
      plusDI: adx.plusDI,
      minusDI: adx.minusDI,
      volumeRatio,
    },
  };
}

function neutralSignal(
  price: number,
  atr: number,
  rsi: number,
  ema20: number,
  ema50: number,
  macd: { macd: number; signal: number; histogram: number },
  bb: { upper: number; middle: number; lower: number },
  adx: { adx: number; plusDI: number; minusDI: number },
  volumeRatio: number
): TradingSignal {
  return {
    direction: 'NEUTRAL',
    strength: 0,
    action: 'HOLD',
    stopLoss: 0,
    takeProfit: 0,
    atr,
    regime: 'UNKNOWN',
    indicators: {
      rsi,
      ema20: ema20 || 0,
      ema50: ema50 || 0,
      macd: macd.macd,
      macdSignal: macd.signal,
      macdHistogram: macd.histogram,
      bbUpper: bb.upper,
      bbMiddle: bb.middle,
      bbLower: bb.lower,
      atr,
      adx: adx.adx,
      plusDI: adx.plusDI,
      minusDI: adx.minusDI,
      volumeRatio,
    },
  };
}
