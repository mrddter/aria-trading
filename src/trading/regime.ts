/**
 * Market Regime Detector
 *
 * Analyzes macro conditions to adapt trading behavior:
 * - RISK_ON (bullish): favor longs, wider TP, bigger size
 * - RISK_OFF (bearish): favor shorts, tighter SL, smaller size
 * - NEUTRAL: balanced market-neutral, standard params
 * - EXTREME_FEAR: reduce all activity, only high-confidence trades
 * - EXTREME_GREED: reduce longs (reversal risk), tighter TP
 */

export type MarketRegime = 'RISK_ON' | 'RISK_OFF' | 'NEUTRAL' | 'EXTREME_FEAR' | 'EXTREME_GREED';

export interface RegimeParams {
  regime: MarketRegime;
  description: string;
  longBias: number;          // 0.0 to 2.0 (1.0 = neutral)
  shortBias: number;         // 0.0 to 2.0
  sizeMultiplier: number;    // 0.3 to 1.5
  leverageMultiplier: number; // 0.3 to 2.0 (applied to base leverage)
  slMultiplier: number;
  tpMultiplier: number;
  minConfidence: number;     // 0.0 to 1.0
  maxPositions: number;
  rebalanceIntervalHours: number;
}

export interface RegimeInput {
  fearGreedValue: number;
  btcPriceChange24h: number;
  btcVolatility: number;
  marketDominanceBtc: number;
  avgVolume24hRatio: number;
}

export function detectRegime(input: RegimeInput): RegimeParams {
  const { fearGreedValue, btcPriceChange24h } = input;

  let regime: MarketRegime;

  if (fearGreedValue <= 15) {
    regime = 'EXTREME_FEAR';
  } else if (fearGreedValue >= 80) {
    regime = 'EXTREME_GREED';
  } else if (fearGreedValue < 40 && btcPriceChange24h < -2) {
    regime = 'RISK_OFF';
  } else if (fearGreedValue > 55 && btcPriceChange24h > 2) {
    regime = 'RISK_ON';
  } else {
    regime = 'NEUTRAL';
  }

  switch (regime) {
    case 'EXTREME_FEAR':
      return {
        regime, description: 'Extreme fear - active shorting, cautious longs only on high confidence',
        longBias: 0.3, shortBias: 1.8, sizeMultiplier: 0.5,
        leverageMultiplier: 0.5,  // 10x base → 5x (not too low, we want to profit from shorts)
        slMultiplier: 1.5, tpMultiplier: 2.5, minConfidence: 0.6,
        maxPositions: 4, rebalanceIntervalHours: 2,
      };
    case 'RISK_OFF':
      return {
        regime, description: 'Bearish - favor shorts, reduce longs, tighter risk',
        longBias: 0.5, shortBias: 1.5, sizeMultiplier: 0.6,
        leverageMultiplier: 0.5,  // 10x base → 5x
        slMultiplier: 1.8, tpMultiplier: 2.5, minConfidence: 0.6,
        maxPositions: 5, rebalanceIntervalHours: 3,
      };
    case 'NEUTRAL':
      return {
        regime, description: 'Neutral - balanced market-neutral, standard parameters',
        longBias: 1.0, shortBias: 1.0, sizeMultiplier: 1.0,
        leverageMultiplier: 1.0,  // 10x base → 10x
        slMultiplier: 2.0, tpMultiplier: 3.0, minConfidence: 0.5,
        maxPositions: 8, rebalanceIntervalHours: 4,
      };
    case 'RISK_ON':
      return {
        regime, description: 'Bullish - favor longs, wider TP, higher leverage to close fast',
        longBias: 1.5, shortBias: 0.5, sizeMultiplier: 1.3,
        leverageMultiplier: 1.5,  // 10x base → 15x
        slMultiplier: 2.0, tpMultiplier: 4.0, minConfidence: 0.4,
        maxPositions: 8, rebalanceIntervalHours: 4,
      };
    case 'EXTREME_GREED':
      return {
        regime, description: 'Extreme greed - reduce longs (reversal risk), tighter TP',
        longBias: 0.5, shortBias: 1.3, sizeMultiplier: 0.5,
        leverageMultiplier: 0.7,  // 10x base → 7x
        slMultiplier: 1.5, tpMultiplier: 2.0, minConfidence: 0.7,
        maxPositions: 4, rebalanceIntervalHours: 2,
      };
  }
}

export function formatRegimeTelegram(params: RegimeParams, input: RegimeInput): string {
  const emoji: Record<MarketRegime, string> = {
    RISK_ON: '🟢', RISK_OFF: '🔴', NEUTRAL: '⚪',
    EXTREME_FEAR: '🟣', EXTREME_GREED: '🟡',
  };
  return `${emoji[params.regime]} <b>Regime: ${params.regime}</b>\n` +
    `  ${params.description}\n` +
    `  F&G: ${input.fearGreedValue} | BTC 24h: ${input.btcPriceChange24h > 0 ? '+' : ''}${input.btcPriceChange24h.toFixed(1)}%\n` +
    `  Long: ${params.longBias.toFixed(1)}x | Short: ${params.shortBias.toFixed(1)}x | Size: ${params.sizeMultiplier.toFixed(1)}x | Lev: ${params.leverageMultiplier.toFixed(1)}x`;
}
