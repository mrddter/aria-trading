import { describe, it, expect } from 'vitest';
import { calculatePositionSize } from '../src/trading/risk';

describe('calculatePositionSize', () => {
  it('sizes correctly for 2% risk', () => {
    // Balance $10,000, risk 2%, entry $100, SL $95 (5% away)
    const size = calculatePositionSize(10000, 2, 100, 95, 5, 5000);
    // riskAmount = 200, priceDiff = 5, riskPerUnit = 0.05
    // size = 200 / 0.05 = 4000
    expect(size).toBeCloseTo(4000);
  });

  it('caps at maxPositionSize', () => {
    const size = calculatePositionSize(100000, 2, 100, 95, 5, 5000);
    expect(size).toBe(5000);
  });

  it('returns 0 for zero entry price', () => {
    expect(calculatePositionSize(10000, 2, 0, 95, 5, 5000)).toBe(0);
  });

  it('returns 0 if SL equals entry', () => {
    expect(calculatePositionSize(10000, 2, 100, 100, 5, 5000)).toBe(0);
  });

  it('works for SHORT (SL above entry)', () => {
    // Entry $100, SL $105 (5% above)
    const size = calculatePositionSize(10000, 2, 100, 105, 5, 5000);
    expect(size).toBeCloseTo(4000);
  });

  it('smaller size for wider SL', () => {
    const tight = calculatePositionSize(10000, 2, 100, 98, 5, 50000); // 2% SL
    const wide = calculatePositionSize(10000, 2, 100, 90, 5, 50000);  // 10% SL
    expect(tight).toBeGreaterThan(wide);
  });

  it('larger size for higher risk percent', () => {
    const low = calculatePositionSize(10000, 1, 100, 95, 5, 50000);
    const high = calculatePositionSize(10000, 3, 100, 95, 5, 50000);
    expect(high).toBeGreaterThan(low);
  });
});
