/**
 * Exchange abstraction layer.
 * Defines a common interface for any futures exchange (Binance, Hyperliquid, etc.).
 */

// --- Common types ---

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

export interface AlgoOrderParams {
  symbol: string;
  side: OrderSide;
  positionSide: PositionSide;
  type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
  triggerPrice: number;
  quantity?: number;
  closePosition?: boolean;
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

export interface PositionRiskEntry {
  symbol: string;
  positionSide: string;
  positionAmt: string;
  entryPrice: string;
  leverage: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
}

export interface SymbolPrecision {
  quantityPrecision: number;
  pricePrecision: number;
  stepSize: number;
  tickSize: number;
  minQty: number;
  maxQty: number;
  minNotional: number;
}

export interface Ticker24hr {
  priceChangePercent: string;
}

// --- Exchange interface ---

export interface IExchange {
  /** Exchange name for logging */
  readonly name: string;

  // --- Setup ---
  loadExchangeInfo(): Promise<void>;
  isSymbolAvailable(symbol: string): boolean;
  getSymbolPrecision(symbol: string): SymbolPrecision | null;
  roundQuantity(symbol: string, qty: number): number;
  roundPrice(symbol: string, price: number): number;

  // --- Market data ---
  getPrice(symbol: string): Promise<number>;
  getKlines(symbol: string, interval: string, limit: number): Promise<number[][]>;
  getTicker24hr(symbol: string): Promise<Ticker24hr>;

  // --- Account ---
  getAccountInfo(): Promise<AccountInfo>;
  getPositionRisk(): Promise<PositionRiskEntry[]>;

  // --- Trading ---
  setLeverage(symbol: string, leverage: number): Promise<any>;
  setPositionMode(dualSidePosition: boolean): Promise<any>;
  setMarginType(symbol: string, marginType: 'ISOLATED' | 'CROSSED'): Promise<any>;
  newOrder(params: NewOrderParams): Promise<any>;
  newAlgoOrder(params: AlgoOrderParams): Promise<any>;
  cancelOrder(symbol: string, orderId: string): Promise<any>;
  getOpenOrders(symbol?: string): Promise<any>;

  // --- History ---
  getUserTrades(symbol?: string, limit?: number): Promise<any[]>;
  getAllUserTrades(limit?: number): Promise<any[]>;
}
