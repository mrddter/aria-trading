/**
 * Composite Scoring System
 *
 * Combines multiple signals into a single 0-100 trade quality score.
 * Inspired by claude-trading-skills market top detector approach.
 *
 * Components (weights):
 *   1. Sentiment Signal   (25%) - LLM sentiment score, confidence, magnitude
 *   2. Momentum           (25%) - RSI, MACD histogram, EMA alignment
 *   3. Volatility/Risk    (20%) - ATR ratio, Bollinger position, volume
 *   4. Trend Alignment    (15%) - ADX strength, DI alignment with direction
 *   5. Regime Alignment   (15%) - F&G regime agreement with direction
 *
 * Score interpretation:
 *   80-100: Strong setup → full position size
 *   60-79:  Decent setup → reduced position size (0.7x)
 *   40-59:  Weak setup   → skip or minimal size (0.4x)
 *   0-39:   Poor setup   → reject trade
 */

import {
  calculateRSI,
  calculateMACD,
  calculateBollingerBands,
  calculateATR,
  calculateADX,
  calculateEMA,
  calculateVolumeSMA,
} from '../utils/indicators';
import type { SentimentSignal } from '../sentiment/types';

export interface CompositeResult {
  score: number;         // 0-100
  breakdown: {
    sentiment: number;   // 0-100
    momentum: number;    // 0-100
    volatility: number;  // 0-100
    trend: number;       // 0-100
    regime: number;      // 0-100
  };
  sizeMultiplier: number; // 0.4 - 1.0
  approved: boolean;
  reason: string;
}

export function calculateCompositeScore(
  signal: SentimentSignal,
  highs: number[],
  lows: number[],
  closes: number[],
  volumes: number[],
  direction: 'LONG' | 'SHORT',
  regime?: string,
): CompositeResult {
  const currentPrice = closes[closes.length - 1];

  // ---- 1. SENTIMENT SCORE (25%) ----
  const sentStrength = Math.abs(signal.sentimentScore); // 0-1
  const sentAligned = (direction === 'LONG' && signal.sentimentScore > 0) ||
                      (direction === 'SHORT' && signal.sentimentScore < 0);
  const sentimentScore = sentAligned
    ? Math.min(100, (sentStrength * 40) + (signal.confidence * 35) + (signal.magnitude * 25))
    : 0; // Wrong direction = 0

  // ---- 2. MOMENTUM SCORE (25%) ----
  const rsi = calculateRSI(closes);
  const macd = calculateMACD(closes);

  let momentumScore = 50; // neutral baseline

  if (direction === 'LONG') {
    // RSI: 30-50 = good entry (not overbought), 50-70 = ok, >70 = bad
    if (rsi >= 30 && rsi <= 50) momentumScore += 20;
    else if (rsi > 50 && rsi <= 65) momentumScore += 10;
    else if (rsi > 70) momentumScore -= 25;
    else if (rsi < 30) momentumScore += 5; // oversold bounce potential

    // MACD histogram positive and growing = bullish momentum
    if (macd.histogram > 0) momentumScore += 15;
    else momentumScore -= 10;

    // MACD line above signal = bullish
    if (macd.macd > macd.signal) momentumScore += 10;
    else momentumScore -= 5;
  } else {
    // SHORT: inverse logic
    if (rsi >= 50 && rsi <= 70) momentumScore += 20;
    else if (rsi > 70) momentumScore += 15; // overbought = good for short
    else if (rsi < 30) momentumScore -= 25;
    else if (rsi >= 35 && rsi < 50) momentumScore += 10;

    if (macd.histogram < 0) momentumScore += 15;
    else momentumScore -= 10;

    if (macd.macd < macd.signal) momentumScore += 10;
    else momentumScore -= 5;
  }

  momentumScore = Math.max(0, Math.min(100, momentumScore));

  // ---- 3. VOLATILITY/RISK SCORE (20%) ----
  const atr = calculateATR(highs, lows, closes);
  const atrPercent = (atr / currentPrice) * 100;
  const bb = calculateBollingerBands(closes);
  const bbWidth = ((bb.upper - bb.lower) / bb.middle) * 100;
  const avgVol = calculateVolumeSMA(volumes, 20);
  const recentVol = volumes.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const volumeRatio = avgVol > 0 ? recentVol / avgVol : 1;

  let volatilityScore = 50;

  // Moderate ATR is ideal (enough movement for profit, not too wild)
  if (atrPercent >= 0.5 && atrPercent <= 3.0) volatilityScore += 15;
  else if (atrPercent > 5.0) volatilityScore -= 20; // too volatile
  else if (atrPercent < 0.3) volatilityScore -= 15; // too quiet

  // BB position: near lower band for LONG, near upper for SHORT
  const bbPosition = (currentPrice - bb.lower) / (bb.upper - bb.lower); // 0-1
  if (direction === 'LONG' && bbPosition < 0.3) volatilityScore += 15;
  else if (direction === 'LONG' && bbPosition > 0.8) volatilityScore -= 10;
  else if (direction === 'SHORT' && bbPosition > 0.7) volatilityScore += 15;
  else if (direction === 'SHORT' && bbPosition < 0.2) volatilityScore -= 10;

  // Volume: elevated = market reacting, good for event trades
  if (volumeRatio >= 1.2 && volumeRatio <= 3.0) volatilityScore += 15;
  else if (volumeRatio > 5.0) volatilityScore -= 10; // panic/mania
  else if (volumeRatio < 0.5) volatilityScore -= 10; // no interest

  volatilityScore = Math.max(0, Math.min(100, volatilityScore));

  // ---- 4. TREND ALIGNMENT (15%) ----
  const adx = calculateADX(highs, lows, closes);
  const ema20 = calculateEMA(closes, 20);
  const lastEma = ema20[ema20.length - 1];

  let trendScore = 50;

  // Strong trend (ADX > 25) in our direction = good
  if (adx.adx > 25) {
    const trendBullish = adx.plusDI > adx.minusDI;
    if ((direction === 'LONG' && trendBullish) || (direction === 'SHORT' && !trendBullish)) {
      trendScore += 25; // trend aligned
    } else {
      trendScore -= 15; // counter-trend
    }
  } else {
    // Weak trend - neutral, slightly negative
    trendScore -= 5;
  }

  // Price vs EMA20
  if (direction === 'LONG' && currentPrice > lastEma) trendScore += 15;
  else if (direction === 'LONG' && currentPrice < lastEma) trendScore -= 10;
  else if (direction === 'SHORT' && currentPrice < lastEma) trendScore += 15;
  else if (direction === 'SHORT' && currentPrice > lastEma) trendScore -= 10;

  trendScore = Math.max(0, Math.min(100, trendScore));

  // ---- 5. REGIME ALIGNMENT (15%) ----
  let regimeScore = 50; // neutral if no regime data

  if (regime) {
    if (regime === 'EXTREME_FEAR') {
      if (direction === 'SHORT') regimeScore = 85; // shorts thrive in fear
      else regimeScore = 25; // longs risky in fear
    } else if (regime === 'FEAR') {
      if (direction === 'SHORT') regimeScore = 70;
      else regimeScore = 35;
    } else if (regime === 'NEUTRAL') {
      regimeScore = 50; // no edge either way
    } else if (regime === 'GREED') {
      if (direction === 'LONG') regimeScore = 70;
      else regimeScore = 35;
    } else if (regime === 'EXTREME_GREED') {
      if (direction === 'LONG') regimeScore = 85;
      else regimeScore = 25;
    }
  }

  // ---- COMPOSITE ----
  const weights = {
    sentiment: 0.25,
    momentum: 0.25,
    volatility: 0.20,
    trend: 0.15,
    regime: 0.15,
  };

  const score = Math.round(
    sentimentScore * weights.sentiment +
    momentumScore * weights.momentum +
    volatilityScore * weights.volatility +
    trendScore * weights.trend +
    regimeScore * weights.regime
  );

  // Size multiplier based on score
  let sizeMultiplier: number;
  if (score >= 80) sizeMultiplier = 1.0;
  else if (score >= 60) sizeMultiplier = 0.7;
  else if (score >= 40) sizeMultiplier = 0.4;
  else sizeMultiplier = 0;

  const approved = score >= 40;
  const reason = approved
    ? `Score ${score}/100 (Sent:${sentimentScore.toFixed(0)} Mom:${momentumScore.toFixed(0)} Vol:${volatilityScore.toFixed(0)} Trend:${trendScore.toFixed(0)} Reg:${regimeScore.toFixed(0)})`
    : `Score too low: ${score}/100 (min 40)`;

  return {
    score,
    breakdown: {
      sentiment: Math.round(sentimentScore),
      momentum: Math.round(momentumScore),
      volatility: Math.round(volatilityScore),
      trend: Math.round(trendScore),
      regime: Math.round(regimeScore),
    },
    sizeMultiplier,
    approved,
    reason,
  };
}
