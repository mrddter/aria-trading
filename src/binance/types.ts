/** Binance Futures API types */

export type OrderSide = 'BUY' | 'SELL';
export type PositionSide = 'LONG' | 'SHORT' | 'BOTH';
export type OrderType = 'LIMIT' | 'MARKET' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
export type TimeInForce = 'GTC' | 'IOC' | 'FOK';

export interface NewOrderParams {
  symbol: string;
  side: OrderSide;
  positionSide: PositionSide;
  type: OrderType;
  quantity: number;
  price?: number;
  stopPrice?: number;
  timeInForce?: TimeInForce;
  reduceOnly?: boolean;
}

export interface AccountInfo {
  totalWalletBalance: string;
  totalUnrealizedProfit: string;
  totalMarginBalance: string;
  availableBalance: string;
  positions: Position[];
}

export interface Position {
  symbol: string;
  positionSide: PositionSide;
  positionAmt: string;
  entryPrice: string;
  unrealizedProfit: string;
  leverage: string;
}

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
