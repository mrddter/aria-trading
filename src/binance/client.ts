/**
 * Binance Futures API client.
 * Hardcoded URLs to prevent API key exfiltration via URL manipulation.
 */

import { createHmacSignature } from './auth';
import type { IExchange, SymbolPrecision, Ticker24hr, PositionRiskEntry, AccountInfo, NewOrderParams, AlgoOrderParams } from '../exchange/types';

export interface BinanceEnv {
  BINANCE_API_KEY: string;
  BINANCE_API_SECRET: string;
  ENVIRONMENT: string;
}

export class BinanceFuturesClient implements IExchange {
  readonly name = 'Binance';
  private apiKey: string;
  private apiSecret: string;
  private baseUrl: string;
  private symbolInfoCache: Map<string, SymbolPrecision> = new Map();
  private exchangeInfoLoaded = false;

  // Hardcoded URLs - never trust user-configurable base URLs
  private static readonly URLS = {
    mainnet: 'https://fapi.binance.com',
    testnet: 'https://testnet.binancefuture.com',
  } as const;

  constructor(env: BinanceEnv) {
    this.apiKey = env.BINANCE_API_KEY;
    this.apiSecret = env.BINANCE_API_SECRET;
    this.baseUrl = env.ENVIRONMENT === 'testnet'
      ? BinanceFuturesClient.URLS.testnet
      : BinanceFuturesClient.URLS.mainnet;
  }

  // --- EXCHANGE INFO (precision per symbol) ---

  async loadExchangeInfo(): Promise<void> {
    if (this.exchangeInfoLoaded) return;
    try {
      const data = await this.publicGet('/fapi/v1/exchangeInfo') as any;
      let skipped = 0;
      for (const s of data.symbols) {
        // Skip TradFi perps (stocks, commodities) - require special agreement
        // Skip pre-market, index, and non-standard contracts
        if (s.contractType !== 'PERPETUAL' || s.underlyingType !== 'COIN') {
          skipped++;
          continue;
        }
        // Only include active USDT-margined pairs
        if (s.status !== 'TRADING' || !s.symbol.endsWith('USDT')) {
          skipped++;
          continue;
        }
        const lotFilter = s.filters.find((f: any) => f.filterType === 'LOT_SIZE');
        const priceFilter = s.filters.find((f: any) => f.filterType === 'PRICE_FILTER');
        const minNotionalFilter = s.filters.find((f: any) => f.filterType === 'MIN_NOTIONAL');
        this.symbolInfoCache.set(s.symbol, {
          quantityPrecision: s.quantityPrecision,
          pricePrecision: s.pricePrecision,
          stepSize: parseFloat(lotFilter?.stepSize || '0.01'),
          tickSize: parseFloat(priceFilter?.tickSize || '0.01'),
          minQty: parseFloat(lotFilter?.minQty || '0.001'),
          maxQty: parseFloat(lotFilter?.maxQty || '1000000'),
          minNotional: parseFloat(minNotionalFilter?.notional || '5'),
        });
      }
      this.exchangeInfoLoaded = true;
      console.log(`[Binance] Loaded exchangeInfo: ${this.symbolInfoCache.size} tradeable symbols (${skipped} skipped: TradFi/pre-market/index)`);
    } catch (e) {
      console.error('[Binance] Failed to load exchangeInfo:', e);
    }
  }

  getSymbolPrecision(symbol: string): SymbolPrecision | null {
    return this.symbolInfoCache.get(symbol) || null;
  }

  isSymbolAvailable(symbol: string): boolean {
    return this.symbolInfoCache.has(symbol);
  }

  roundQuantity(symbol: string, qty: number): number {
    const info = this.symbolInfoCache.get(symbol);
    if (!info) return Math.floor(qty * 100) / 100; // fallback 2 decimals
    const step = info.stepSize;
    const rounded = Math.floor(qty / step) * step;
    // Round to avoid floating point issues
    const decimals = this.countDecimals(step);
    return parseFloat(rounded.toFixed(decimals));
  }

  roundPrice(symbol: string, price: number): number {
    const info = this.symbolInfoCache.get(symbol);
    if (!info) return Math.round(price * 100) / 100; // fallback 2 decimals
    const tick = info.tickSize;
    const rounded = Math.round(price / tick) * tick;
    const decimals = this.countDecimals(tick);
    return parseFloat(rounded.toFixed(decimals));
  }

  private countDecimals(value: number): number {
    const str = value.toString();
    if (str.includes('e-')) return parseInt(str.split('e-')[1]);
    if (!str.includes('.')) return 0;
    return str.split('.')[1].length;
  }

  // --- PUBLIC (no auth) ---

  async getPrice(symbol: string): Promise<number> {
    const res = await this.publicGet('/fapi/v1/ticker/price', { symbol }) as { price: string };
    return parseFloat(res.price);
  }

  async getKlines(symbol: string, interval: string = '1h', limit: number = 100): Promise<number[][]> {
    return this.publicGet('/fapi/v1/klines', { symbol, interval, limit: String(limit) }) as Promise<number[][]>;
  }

  async getTicker24hr(symbol: string): Promise<Ticker24hr> {
    return this.publicGet('/fapi/v1/ticker/24hr', { symbol }) as Promise<Ticker24hr>;
  }

  async getLongShortRatio(symbol: string, period: string = '1h') {
    return this.publicGet('/futures/data/globalLongShortAccountRatio', {
      symbol, period, limit: '10',
    });
  }

  // --- PRIVATE (signed) ---

  async getAccountInfo(): Promise<AccountInfo> {
    return this.signedGet('/fapi/v3/account') as Promise<AccountInfo>;
  }

  /** Get positions with entry price, leverage, and mark price */
  async getPositionRisk(): Promise<PositionRiskEntry[]> {
    const all = await this.signedGet('/fapi/v3/positionRisk') as any[];
    const open = all.filter((p: any) => parseFloat(p.positionAmt) !== 0);
    // v3 API may use different field names - normalize
    for (const p of open) {
      if (!p.unRealizedProfit && p.unrealizedProfit) p.unRealizedProfit = p.unrealizedProfit;
    }
    if (open.length > 0 && !open[0].leverage) {
      console.log(`[Binance] positionRisk sample fields: ${Object.keys(open[0]).join(', ')}`);
    }
    return open;
  }

  async newOrder(params: NewOrderParams) {
    const orderParams: Record<string, string> = {
      symbol: params.symbol,
      side: params.side,
      positionSide: params.positionSide,
      type: params.type,
      quantity: params.quantity.toString(),
    };
    if (params.price) orderParams.price = params.price.toString();
    if (params.stopPrice) orderParams.stopPrice = params.stopPrice.toString();
    if (params.timeInForce) orderParams.timeInForce = params.timeInForce;
    if (params.type === 'LIMIT') orderParams.timeInForce = params.timeInForce || 'GTC';
    if (params.reduceOnly) orderParams.reduceOnly = 'true';

    return this.signedPost('/fapi/v1/order', orderParams);
  }

  async newAlgoOrder(params: AlgoOrderParams) {
    const orderParams: Record<string, string> = {
      algoType: 'CONDITIONAL',
      symbol: params.symbol,
      side: params.side,
      positionSide: params.positionSide,
      type: params.type,
      triggerPrice: params.triggerPrice.toString(),
      workingType: 'CONTRACT_PRICE',
      priceProtect: 'TRUE',
    };
    if (params.closePosition) orderParams.closePosition = 'true';
    else if (params.quantity) orderParams.quantity = params.quantity.toString();

    return this.signedPost('/fapi/v1/algoOrder', orderParams);
  }

  async cancelOrder(symbol: string, orderId: string) {
    return this.signedDelete('/fapi/v1/order', { symbol, orderId });
  }

  async setLeverage(symbol: string, leverage: number) {
    return this.signedPost('/fapi/v1/leverage', {
      symbol, leverage: leverage.toString(),
    });
  }

  async getUserTrades(symbol?: string, limit: number = 500): Promise<any[]> {
    const params: Record<string, string> = { limit: limit.toString() };
    if (symbol) params.symbol = symbol;
    return this.signedGet('/fapi/v1/userTrades', params) as Promise<any[]>;
  }

  async getAllUserTrades(limit: number = 500): Promise<any[]> {
    // Binance requires symbol for userTrades, so fetch per open position + recent symbols
    const account = await this.getAccountInfo();
    const activeSymbols = new Set<string>();
    for (const p of account.positions) {
      if (parseFloat(p.positionAmt) !== 0) {
        activeSymbols.add(p.symbol);
      }
    }
    // Also check common symbols we might have traded
    const commonSymbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'];
    for (const s of commonSymbols) activeSymbols.add(s);

    const allTrades: any[] = [];
    for (const symbol of activeSymbols) {
      try {
        const trades = await this.getUserTrades(symbol, limit);
        allTrades.push(...trades);
      } catch {
        // Symbol might not have trades
      }
    }
    return allTrades.sort((a, b) => a.time - b.time);
  }

  async setMarginType(symbol: string, marginType: 'ISOLATED' | 'CROSSED') {
    try {
      return await this.signedPost('/fapi/v1/marginType', { symbol, marginType });
    } catch {
      // Ignore if already set
    }
  }

  async setPositionMode(dualSidePosition: boolean) {
    try {
      return await this.signedPost('/fapi/v1/positionSide/dual', {
        dualSidePosition: dualSidePosition.toString(),
      });
    } catch {
      // Ignore if already set
    }
  }

  async getOpenOrders(symbol?: string) {
    const params: Record<string, string> = {};
    if (symbol) params.symbol = symbol;
    return this.signedGet('/fapi/v1/openOrders', params);
  }

  // --- INTERNAL ---

  /** Fetch Binance server time directly to avoid clock drift issues */
  private async getServerTimestamp(): Promise<string> {
    try {
      const res = await fetch(`${this.baseUrl}/fapi/v1/time`);
      const data = (await res.json()) as { serverTime: number };
      return data.serverTime.toString();
    } catch {
      // Fallback to local time
      return Date.now().toString();
    }
  }

  private sanitizeError(status: number, body: string): string {
    const sanitized = body.replace(new RegExp(this.apiKey, 'g'), '[REDACTED]');
    return `Binance ${status}: ${sanitized.slice(0, 200)}`;
  }

  async publicGet(path: string, params: Record<string, string> = {}) {
    const qs = new URLSearchParams(params).toString();
    const url = `${this.baseUrl}${path}${qs ? '?' + qs : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(this.sanitizeError(res.status, await res.text()));
    return res.json();
  }

  private async signedGet(path: string, params: Record<string, string> = {}) {
    params.timestamp = await this.getServerTimestamp();
    params.recvWindow = '10000';
    const qs = new URLSearchParams(params).toString();
    const signature = await createHmacSignature(this.apiSecret, qs);
    const url = `${this.baseUrl}${path}?${qs}&signature=${signature}`;
    const res = await fetch(url, {
      headers: { 'X-MBX-APIKEY': this.apiKey },
    });
    if (!res.ok) throw new Error(this.sanitizeError(res.status, await res.text()));
    return res.json();
  }

  private async signedPost(path: string, params: Record<string, string> = {}) {
    params.timestamp = await this.getServerTimestamp();
    params.recvWindow = '10000';
    const qs = new URLSearchParams(params).toString();
    const signature = await createHmacSignature(this.apiSecret, qs);
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': this.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `${qs}&signature=${signature}`,
    });
    if (!res.ok) throw new Error(this.sanitizeError(res.status, await res.text()));
    return res.json();
  }

  private async signedDelete(path: string, params: Record<string, string> = {}) {
    params.timestamp = await this.getServerTimestamp();
    params.recvWindow = '10000';
    const qs = new URLSearchParams(params).toString();
    const signature = await createHmacSignature(this.apiSecret, qs);
    const url = `${this.baseUrl}${path}?${qs}&signature=${signature}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { 'X-MBX-APIKEY': this.apiKey },
    });
    if (!res.ok) throw new Error(this.sanitizeError(res.status, await res.text()));
    return res.json();
  }
}
