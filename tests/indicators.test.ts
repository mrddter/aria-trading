import { describe, it, expect } from 'vitest';
import {
  calculateRSI,
  calculateEMA,
  calculateMACD,
  calculateBollingerBands,
  calculateATR,
} from '../src/utils/indicators';

describe('calculateRSI', () => {
  it('returns 50 for insufficient data', () => {
    expect(calculateRSI([100, 101, 102])).toBe(50);
  });

  it('returns 100 for only upward moves', () => {
    const data = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(calculateRSI(data)).toBe(100);
  });

  it('returns close to 0 for only downward moves', () => {
    const data = Array.from({ length: 20 }, (_, i) => 200 - i);
    expect(calculateRSI(data)).toBeLessThan(5);
  });

  it('returns ~50 for alternating up/down of equal magnitude', () => {
    const data: number[] = [];
    for (let i = 0; i < 30; i++) {
      data.push(i % 2 === 0 ? 100 : 101);
    }
    const rsi = calculateRSI(data);
    expect(rsi).toBeGreaterThan(40);
    expect(rsi).toBeLessThan(60);
  });

  it('returns between 0 and 100', () => {
    const data = [100, 102, 99, 103, 97, 105, 95, 108, 92, 110, 88, 112, 90, 105, 100, 98];
    const rsi = calculateRSI(data);
    expect(rsi).toBeGreaterThanOrEqual(0);
    expect(rsi).toBeLessThanOrEqual(100);
  });
});

describe('calculateEMA', () => {
  it('with period 1, equals the data itself', () => {
    const data = [10, 20, 30, 40, 50];
    const ema = calculateEMA(data, 1);
    expect(ema).toEqual(data);
  });

  it('seed is SMA of first N values', () => {
    const data = [10, 20, 30, 40, 50, 60, 70];
    const ema = calculateEMA(data, 3);
    // SMA of first 3: (10+20+30)/3 = 20
    expect(ema[2]).toBe(20);
    // First 2 values should be NaN (warm-up)
    expect(ema[0]).toBeNaN();
    expect(ema[1]).toBeNaN();
  });

  it('EMA tracks data direction', () => {
    const uptrend = Array.from({ length: 30 }, (_, i) => 100 + i);
    const ema = calculateEMA(uptrend, 10);
    const last = ema[ema.length - 1];
    const prevLast = ema[ema.length - 2];
    expect(last).toBeGreaterThan(prevLast);
  });

  it('returns at least one value for short data', () => {
    const ema = calculateEMA([100], 5);
    expect(ema.length).toBe(1);
    expect(ema[0]).toBe(100);
  });
});

describe('calculateMACD', () => {
  it('returns zero-ish for flat data', () => {
    const flat = Array.from({ length: 50 }, () => 100);
    const macd = calculateMACD(flat);
    expect(Math.abs(macd.macd)).toBeLessThan(0.01);
    expect(Math.abs(macd.histogram)).toBeLessThan(0.01);
  });

  it('positive MACD for strong uptrend', () => {
    // Accelerating uptrend to create divergence between fast and slow EMA
    const uptrend = Array.from({ length: 80 }, (_, i) => 100 + i * 2 + i * i * 0.02);
    const macd = calculateMACD(uptrend);
    expect(macd.macd).toBeGreaterThan(0);
  });

  it('negative MACD for strong downtrend', () => {
    const downtrend = Array.from({ length: 80 }, (_, i) => 300 - i * 2 - i * i * 0.02);
    const macd = calculateMACD(downtrend);
    expect(macd.macd).toBeLessThan(0);
  });
});

describe('calculateBollingerBands', () => {
  it('bands converge for flat data', () => {
    const flat = Array.from({ length: 25 }, () => 100);
    const bb = calculateBollingerBands(flat);
    expect(bb.middle).toBeCloseTo(100);
    expect(bb.upper).toBeCloseTo(100);
    expect(bb.lower).toBeCloseTo(100);
  });

  it('upper > middle > lower for volatile data', () => {
    const data = Array.from({ length: 25 }, (_, i) => 100 + Math.sin(i) * 10);
    const bb = calculateBollingerBands(data);
    expect(bb.upper).toBeGreaterThan(bb.middle);
    expect(bb.middle).toBeGreaterThan(bb.lower);
  });

  it('wider bands for more volatile data', () => {
    const low_vol = Array.from({ length: 25 }, (_, i) => 100 + Math.sin(i));
    const high_vol = Array.from({ length: 25 }, (_, i) => 100 + Math.sin(i) * 20);
    const bb_low = calculateBollingerBands(low_vol);
    const bb_high = calculateBollingerBands(high_vol);
    const width_low = bb_low.upper - bb_low.lower;
    const width_high = bb_high.upper - bb_high.lower;
    expect(width_high).toBeGreaterThan(width_low);
  });
});

describe('calculateATR', () => {
  it('returns 0 for single candle', () => {
    expect(calculateATR([100], [90], [95])).toBe(0);
  });

  it('calculates true range correctly', () => {
    // Two candles: high-low range, high-prevClose gap, low-prevClose gap
    const highs = [110, 120];
    const lows = [90, 100];
    const closes = [95, 115];
    const atr = calculateATR(highs, lows, closes);
    // TR of candle 1: max(120-100, |120-95|, |100-95|) = max(20, 25, 5) = 25
    expect(atr).toBe(25);
  });

  it('higher ATR for more volatile data', () => {
    const n = 20;
    const low_vol_highs = Array.from({ length: n }, () => 101);
    const low_vol_lows = Array.from({ length: n }, () => 99);
    const low_vol_closes = Array.from({ length: n }, () => 100);

    const high_vol_highs = Array.from({ length: n }, () => 110);
    const high_vol_lows = Array.from({ length: n }, () => 90);
    const high_vol_closes = Array.from({ length: n }, () => 100);

    const atr_low = calculateATR(low_vol_highs, low_vol_lows, low_vol_closes);
    const atr_high = calculateATR(high_vol_highs, high_vol_lows, high_vol_closes);
    expect(atr_high).toBeGreaterThan(atr_low);
  });
});
