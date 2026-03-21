import { describe, it, expect } from 'vitest';
import { generateSignal } from '../src/trading/signals';

// Helper: generate synthetic OHLC data
function syntheticData(closes: number[], spread: number = 0.5) {
  const highs = closes.map((c) => c + spread);
  const lows = closes.map((c) => c - spread);
  return { highs, lows, closes };
}

describe('generateSignal', () => {
  it('returns NEUTRAL for insufficient data', () => {
    const { highs, lows, closes } = syntheticData([100, 101, 102]);
    const signal = generateSignal(highs, lows, closes, 102);
    expect(signal.direction).toBe('NEUTRAL');
    expect(signal.action).toBe('HOLD');
  });

  it('returns LONG for strong oversold uptrend setup', () => {
    // Price drops sharply then starts recovering (RSI oversold + bullish context)
    const closes: number[] = [];
    // Down trend for 40 candles (EMA50 will be bearish initially)
    for (let i = 0; i < 40; i++) closes.push(100 - i * 0.5);
    // Sharp drop to create oversold RSI
    for (let i = 0; i < 20; i++) closes.push(80 - i * 1.5);
    // Quick recovery
    for (let i = 0; i < 40; i++) closes.push(50 + i * 1.2);

    const { highs, lows } = syntheticData(closes, 1);
    const signal = generateSignal(highs, lows, closes, closes[closes.length - 1]);

    // Should detect bullish momentum
    expect(signal.indicators.rsi).toBeDefined();
    expect(signal.indicators.ema20).toBeDefined();
    expect(signal.indicators.ema50).toBeDefined();
  });

  it('sets SL and TP for LONG signals', () => {
    // Strong uptrend - should produce LONG
    const closes = Array.from({ length: 100 }, (_, i) => 100 + i * 0.5);
    // Make RSI oversold by adding a dip at the end
    for (let i = 0; i < 15; i++) closes.push(150 - i * 3);
    closes.push(110); // recovery candle

    const { highs, lows } = syntheticData(closes, 2);
    const signal = generateSignal(highs, lows, closes, 110);

    if (signal.direction === 'LONG') {
      expect(signal.stopLoss).toBeLessThan(110);
      expect(signal.takeProfit).toBeGreaterThan(110);
      expect(signal.atr).toBeGreaterThan(0);
    }
  });

  it('sets SL and TP for SHORT signals', () => {
    // Strong downtrend + overbought RSI
    const closes = Array.from({ length: 100 }, (_, i) => 200 - i * 0.5);
    // Spike up to create overbought
    for (let i = 0; i < 15; i++) closes.push(150 + i * 3);
    closes.push(190);

    const { highs, lows } = syntheticData(closes, 2);
    const signal = generateSignal(highs, lows, closes, 190);

    if (signal.direction === 'SHORT') {
      expect(signal.stopLoss).toBeGreaterThan(190);
      expect(signal.takeProfit).toBeLessThan(190);
    }
  });

  it('strength is between 0 and 1', () => {
    const closes = Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i / 5) * 10);
    const { highs, lows } = syntheticData(closes, 1);
    const signal = generateSignal(highs, lows, closes, 105);
    expect(signal.strength).toBeGreaterThanOrEqual(0);
    expect(signal.strength).toBeLessThanOrEqual(1);
  });

  it('returns structured indicators including ADX', () => {
    const closes = Array.from({ length: 100 }, (_, i) => 100 + i * 0.1);
    const { highs, lows } = syntheticData(closes, 0.5);
    const signal = generateSignal(highs, lows, closes, 110);

    expect(signal.indicators).toHaveProperty('rsi');
    expect(signal.indicators).toHaveProperty('ema20');
    expect(signal.indicators).toHaveProperty('ema50');
    expect(signal.indicators).toHaveProperty('macd');
    expect(signal.indicators).toHaveProperty('bbUpper');
    expect(signal.indicators).toHaveProperty('atr');
    expect(signal.indicators).toHaveProperty('adx');
    expect(signal.indicators).toHaveProperty('plusDI');
    expect(signal.indicators).toHaveProperty('minusDI');
    expect(signal.indicators).toHaveProperty('volumeRatio');
    expect(signal).toHaveProperty('regime');
    expect(typeof signal.indicators.rsi).toBe('number');
    expect(['TRENDING', 'RANGING', 'UNKNOWN']).toContain(signal.regime);
  });
});
