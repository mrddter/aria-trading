/**
 * Quantitative filter for sentiment signals.
 *
 * Architecture: LLM (sensor) → THIS MODULE (filter) → Risk Management → Order
 *
 * The LLM says "ETH sentiment is bullish". This module checks:
 * - Is RSI confirming? (not overbought for longs, not oversold for shorts)
 * - Is there a trend? (ADX > 20)
 * - Is volume confirming? (above average)
 * If all checks pass, the signal is approved for execution.
 */

import { SentimentSnapshot } from '../../sentiment/types';
import { RegimeParams } from '../regime';
import {
  calculateRSI,
  calculateEMA,
  calculateADX,
  calculateATR,
  calculateVolumeSMA,
} from '../../utils/indicators';

export interface FilterResult {
  approved: boolean;
  reason: string;
  adjustedStrength: number; // 0-1, combines sentiment + quant
  stopLoss: number;
  takeProfit: number;
  atr: number;
}

export function shouldExecuteSentimentSignal(
  sentiment: SentimentSnapshot,
  highs: number[],
  lows: number[],
  closes: number[],
  volumes: number[],
  currentPrice: number,
  direction: 'LONG' | 'SHORT',
  regimeParams?: RegimeParams | null
): FilterResult {
  const rsi = calculateRSI(closes);
  const adx = calculateADX(highs, lows, closes);
  const atr = calculateATR(highs, lows, closes);
  const ema20 = calculateEMA(closes, 20);
  const lastEma20 = ema20[ema20.length - 1];

  // Apply regime bias to sentiment
  let effectiveSentiment = sentiment.compositeScore;
  let slMult = 2.0;
  let tpMult = 3.0;
  let minConf = 0;

  if (regimeParams) {
    const bias = direction === 'LONG' ? regimeParams.longBias : regimeParams.shortBias;
    effectiveSentiment *= bias;
    slMult = regimeParams.slMultiplier;
    tpMult = regimeParams.tpMultiplier;
    minConf = regimeParams.minConfidence;
  }

  // Volume confirmation
  const avgVol = calculateVolumeSMA(volumes, 20);
  const currentVol = volumes[volumes.length - 1] || 0;
  const volumeRatio = avgVol > 0 ? currentVol / avgVol : 1;

  // --- LONG filters ---
  if (direction === 'LONG') {
    if (rsi > 75) {
      return reject('RSI overbought (>75), skip LONG', atr);
    }
    if (effectiveSentiment < 0.15) {
      return reject('Sentiment too weak for LONG (<0.15)', atr);
    }
    if (adx.adx > 25 && adx.minusDI > adx.plusDI) {
      return reject('Strong downtrend (ADX>25, -DI>+DI), skip LONG', atr);
    }
  }

  // --- SHORT filters ---
  if (direction === 'SHORT') {
    if (rsi < 25) {
      return reject('RSI oversold (<25), skip SHORT', atr);
    }
    if (effectiveSentiment > -0.15) {
      return reject('Sentiment too weak for SHORT (>-0.15)', atr);
    }
    if (adx.adx > 25 && adx.plusDI > adx.minusDI) {
      return reject('Strong uptrend (ADX>25, +DI>-DI), skip SHORT', atr);
    }
  }

  // --- Volume gate ---
  if (volumeRatio < 0.7) {
    return reject('Volume too low (<0.7x average)', atr);
  }

  if (minConf > 0 && sentiment.avgConfidence < minConf) {
    return reject(`Confidence too low (${(sentiment.avgConfidence*100).toFixed(0)}% < ${(minConf*100).toFixed(0)}%)`, atr);
  }

  // --- Calculate SL/TP ---
  let stopLoss: number;
  let takeProfit: number;

  if (direction === 'LONG') {
    stopLoss = currentPrice - atr * slMult;
    takeProfit = currentPrice + atr * tpMult;
  } else {
    stopLoss = currentPrice + atr * slMult;
    takeProfit = currentPrice - atr * tpMult;
  }

  // Combine sentiment strength with quant confirmation
  const sentimentStrength = Math.abs(sentiment.compositeScore);
  const quantStrength = Math.min(1, (adx.adx / 50) * (volumeRatio / 1.5));
  const adjustedStrength = sentimentStrength * 0.6 + quantStrength * 0.4;

  return {
    approved: true,
    reason: `Approved: RSI=${rsi.toFixed(0)}, ADX=${adx.adx.toFixed(0)}, Vol=${volumeRatio.toFixed(1)}x`,
    adjustedStrength,
    stopLoss,
    takeProfit,
    atr,
  };
}

function reject(reason: string, atr: number): FilterResult {
  return {
    approved: false,
    reason,
    adjustedStrength: 0,
    stopLoss: 0,
    takeProfit: 0,
    atr,
  };
}
