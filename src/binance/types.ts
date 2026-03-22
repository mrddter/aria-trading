/**
 * Binance-specific types.
 * Re-exports common exchange types for backwards compatibility.
 */

// Re-export common types from exchange abstraction
export type { OrderSide, PositionSide, OrderType, TimeInForce, NewOrderParams, AccountInfo, Position } from '../exchange/types';

/** Kline (candlestick) data from Binance */
export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

/** Parse raw kline array from Binance API */
export function parseKline(raw: (string | number)[]): Kline {
  return {
    openTime: raw[0] as number,
    open: parseFloat(raw[1] as string),
    high: parseFloat(raw[2] as string),
    low: parseFloat(raw[3] as string),
    close: parseFloat(raw[4] as string),
    volume: parseFloat(raw[5] as string),
    closeTime: raw[6] as number,
  };
}
