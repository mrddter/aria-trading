/**
 * Technical indicators - pure math, zero dependencies.
 * Works in both Cloudflare Workers and Node.js.
 */

/** Calcola RSI (Relative Strength Index) */
export function calculateRSI(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Calcola EMA (Exponential Moving Average) con SMA seed */
export function calculateEMA(data: number[], period: number): number[] {
  if (data.length < period) return [data[data.length - 1]];

  let seed = 0;
  for (let i = 0; i < period; i++) seed += data[i];
  seed /= period;

  const multiplier = 2 / (period + 1);
  const ema: number[] = new Array(period - 1).fill(NaN);
  ema.push(seed);

  for (let i = period; i < data.length; i++) {
    ema.push((data[i] - ema[ema.length - 1]) * multiplier + ema[ema.length - 1]);
  }

  return ema;
}

/** Calcola MACD */
export function calculateMACD(closes: number[]): {
  macd: number;
  signal: number;
  histogram: number;
} {
  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);

  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (isNaN(ema12[i]) || isNaN(ema26[i])) {
      macdLine.push(NaN);
    } else {
      macdLine.push(ema12[i] - ema26[i]);
    }
  }

  const validMacd = macdLine.filter((v) => !isNaN(v));
  const signalLine = calculateEMA(validMacd, 9);

  const last = validMacd.length - 1;
  const lastSignal = signalLine[signalLine.length - 1];
  const lastMacd = validMacd[last];

  return {
    macd: lastMacd ?? 0,
    signal: lastSignal ?? 0,
    histogram: (lastMacd ?? 0) - (lastSignal ?? 0),
  };
}

/** Calcola Bollinger Bands */
export function calculateBollingerBands(
  closes: number[],
  period: number = 20,
  stdDev: number = 2
): { upper: number; middle: number; lower: number } {
  const slice = closes.slice(-period);
  if (slice.length < period) {
    const last = closes[closes.length - 1];
    return { upper: last, middle: last, lower: last };
  }

  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, val) => sum + (val - sma) ** 2, 0) / (period - 1);
  const std = Math.sqrt(variance);

  return {
    upper: sma + stdDev * std,
    middle: sma,
    lower: sma - stdDev * std,
  };
}

/** Calcola ATR (Average True Range) con dati OHLC */
export function calculateATR(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number = 14
): number {
  if (highs.length < 2) return 0;

  const trueRanges: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trueRanges.push(tr);
  }

  const recent = trueRanges.slice(-period);
  if (recent.length === 0) return 0;
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

/**
 * Calcola ADX (Average Directional Index) - misura la FORZA del trend.
 * ADX > 25 = trend forte, ADX < 20 = range/no trend
 * +DI > -DI = trend rialzista, -DI > +DI = trend ribassista
 */
export function calculateADX(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number = 14
): { adx: number; plusDI: number; minusDI: number } {
  if (highs.length < period + 1) return { adx: 0, plusDI: 0, minusDI: 0 };

  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const tr: number[] = [];

  for (let i = 1; i < highs.length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];

    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      )
    );
  }

  // Smoothed averages (Wilder's smoothing)
  let smoothTR = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothPlusDM = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothMinusDM = minusDM.slice(0, period).reduce((a, b) => a + b, 0);

  const dx: number[] = [];

  for (let i = period; i < tr.length; i++) {
    smoothTR = smoothTR - smoothTR / period + tr[i];
    smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDM[i];
    smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDM[i];

    const pdi = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
    const mdi = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
    const diSum = pdi + mdi;
    dx.push(diSum > 0 ? (Math.abs(pdi - mdi) / diSum) * 100 : 0);
  }

  if (dx.length < period) return { adx: 0, plusDI: 0, minusDI: 0 };

  // ADX = smoothed DX
  let adx = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) {
    adx = (adx * (period - 1) + dx[i]) / period;
  }

  const lastPDI = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
  const lastMDI = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;

  return { adx, plusDI: lastPDI, minusDI: lastMDI };
}

/**
 * Calcola Volume SMA - per confermare breakout con volume
 */
export function calculateVolumeSMA(volumes: number[], period: number = 20): number {
  const slice = volumes.slice(-period);
  if (slice.length === 0) return 0;
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}
