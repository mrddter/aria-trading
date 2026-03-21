/**
 * Sentiment aggregator - combines multiple signals into a snapshot.
 * Pure math, no dependencies. Time-weighted averaging.
 */

import { SentimentSignal, SentimentSnapshot } from './types';

/**
 * Aggregate signals for one asset into a single snapshot.
 * Newer signals have more weight (exponential decay).
 */
export function aggregateSignals(
  signals: SentimentSignal[],
  now: number,
  decayHalfLifeHours: number = 6
): SentimentSnapshot {
  if (signals.length === 0) {
    return {
      asset: '',
      compositeScore: 0,
      signalCount: 0,
      freshnessHours: Infinity,
      avgConfidence: 0,
      avgMagnitude: 0,
      timestamp: now,
    };
  }

  const asset = signals[0].asset;
  let weightedScoreSum = 0;
  let weightSum = 0;
  let confidenceSum = 0;
  let magnitudeSum = 0;
  let oldestTimestamp = now;

  for (const signal of signals) {
    const ageHours = (now - signal.timestamp) / (1000 * 60 * 60);
    // Exponential decay: weight halves every decayHalfLifeHours
    const timeWeight = Math.pow(0.5, ageHours / decayHalfLifeHours);
    // Combined weight: time decay * confidence * magnitude
    const weight = timeWeight * signal.confidence * (0.5 + signal.magnitude * 0.5);

    weightedScoreSum += signal.sentimentScore * weight;
    weightSum += weight;
    confidenceSum += signal.confidence;
    magnitudeSum += signal.magnitude;

    if (signal.timestamp < oldestTimestamp) {
      oldestTimestamp = signal.timestamp;
    }
  }

  const compositeScore = weightSum > 0 ? weightedScoreSum / weightSum : 0;
  const freshnessHours = (now - oldestTimestamp) / (1000 * 60 * 60);

  return {
    asset,
    compositeScore: Math.max(-1, Math.min(1, compositeScore)),
    signalCount: signals.length,
    freshnessHours,
    avgConfidence: confidenceSum / signals.length,
    avgMagnitude: magnitudeSum / signals.length,
    timestamp: now,
  };
}

/**
 * Rank assets by composite sentiment score.
 * Returns sorted array: best sentiment first.
 */
export function rankBySentiment(
  snapshots: SentimentSnapshot[]
): SentimentSnapshot[] {
  return [...snapshots].sort((a, b) => b.compositeScore - a.compositeScore);
}

/**
 * Select market-neutral portfolio legs.
 * Top N = LONG candidates, Bottom N = SHORT candidates.
 */
export function selectMarketNeutralLegs(
  ranked: SentimentSnapshot[],
  longsCount: number = 3,
  shortsCount: number = 3,
  minAbsScore: number = 0.15
): { longs: SentimentSnapshot[]; shorts: SentimentSnapshot[] } {
  const longs = ranked
    .filter((s) => s.compositeScore > minAbsScore && s.signalCount > 0)
    .slice(0, longsCount);

  const shorts = ranked
    .filter((s) => s.compositeScore < -minAbsScore && s.signalCount > 0)
    .slice(-shortsCount)
    .reverse(); // worst sentiment first

  return { longs, shorts };
}
