/**
 * Risk management - position sizing and trade gating.
 * Pure math for calculatePositionSize (used in backtesting).
 * canTrade() depends on D1 but is only used in live engine.
 */

export interface RiskConfig {
  maxDailyLoss: number;
  maxDailyLossPercent: number;
  maxDrawdown: number;
  maxPositionSize: number;
  maxLeverage: number;
  maxOpenPositions: number;
  cooldownAfterLoss: number; // minutes
}

/**
 * Calculate position size based on stop-loss distance.
 * This is the correct way: risk a fixed % of balance,
 * and size the position so that if SL is hit, loss = riskPercent% of balance.
 */
export function calculatePositionSize(
  balance: number,
  riskPercent: number,
  entryPrice: number,
  stopLossPrice: number,
  leverage: number,
  maxPositionSize: number
): number {
  if (entryPrice <= 0 || stopLossPrice <= 0) return 0;

  const riskAmount = balance * (riskPercent / 100);
  const priceDiff = Math.abs(entryPrice - stopLossPrice);

  if (priceDiff === 0) return 0;

  const riskPerUnit = priceDiff / entryPrice;
  let size = riskAmount / riskPerUnit;

  // Cap to max position size
  size = Math.min(size, maxPositionSize);

  return size;
}

/**
 * Full RiskManager - used in live engine (Phase 2).
 * canTrade() requires D1 access.
 */
export class RiskManager {
  constructor(private config: RiskConfig) {}

  /** Position sizing (pure math - usable in backtest) */
  calculatePositionSize(
    balance: number,
    riskPercent: number,
    entryPrice: number,
    stopLossPrice: number,
    leverage: number
  ): number {
    return calculatePositionSize(
      balance,
      riskPercent,
      entryPrice,
      stopLossPrice,
      leverage,
      this.config.maxPositionSize
    );
  }

  get maxOpenPositions() {
    return this.config.maxOpenPositions;
  }

  get maxLeverage() {
    return this.config.maxLeverage;
  }
}
