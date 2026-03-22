/**
 * Hyperliquid DEX client implementing IExchange.
 * Uses the Hyperliquid REST API with EIP-712 signing.
 */

import type {
  IExchange, SymbolPrecision, AccountInfo, PositionRiskEntry,
  NewOrderParams, AlgoOrderParams, Ticker24hr,
} from '../exchange/types';
import { signL1Action, privateKeyToAddress, floatToWire } from './auth';
import type { HlMeta, HlClearinghouseState, HlCandle, HlFill, HlOrderResponse } from './types';

export interface HyperliquidEnv {
  privateKey: string;
  vaultAddress?: string;
  isTestnet: boolean;
}

export class HyperliquidClient implements IExchange {
  readonly name = 'Hyperliquid';
  private privateKey: string;
  private address: string;
  private vaultAddress?: string;
  private isTestnet: boolean;
  private baseUrl: string;

  // Asset mapping
  private assetIndex: Map<string, number> = new Map(); // BTC -> 0, ETH -> 1
  private assetInfo: Map<string, { szDecimals: number; maxLeverage: number }> = new Map();
  private symbolPrecisionCache: Map<string, SymbolPrecision> = new Map();
  private loaded = false;

  constructor(env: HyperliquidEnv) {
    this.privateKey = env.privateKey.startsWith('0x') ? env.privateKey.slice(2) : env.privateKey;
    this.address = privateKeyToAddress(this.privateKey);
    this.vaultAddress = env.vaultAddress;
    this.isTestnet = env.isTestnet;
    this.baseUrl = env.isTestnet
      ? 'https://api.hyperliquid-testnet.xyz'
      : 'https://api.hyperliquid.xyz';
  }

  // --- Helpers ---

  /** Convert BTCUSDT -> BTC */
  private toHlSymbol(symbol: string): string {
    return symbol.replace(/USDT$/, '');
  }

  /** Convert BTC -> BTCUSDT */
  private fromHlSymbol(coin: string): string {
    return coin + 'USDT';
  }

  private getAssetIndex(symbol: string): number {
    const coin = this.toHlSymbol(symbol);
    const idx = this.assetIndex.get(coin);
    if (idx === undefined) throw new Error(`Unknown asset: ${coin}`);
    return idx;
  }

  private async infoPost<T>(body: any): Promise<T> {
    const res = await fetch(`${this.baseUrl}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HL info ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json() as Promise<T>;
  }

  private async exchangePost(action: any): Promise<any> {
    const nonce = Date.now();
    const signature = await signL1Action(
      this.privateKey, action, nonce, this.isTestnet, this.vaultAddress
    );

    const res = await fetch(`${this.baseUrl}/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        nonce,
        signature,
        vaultAddress: this.vaultAddress || null,
      }),
    });
    if (!res.ok) throw new Error(`HL exchange ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  /** Get price precision based on szDecimals */
  private pricePrecision(szDecimals: number): number {
    return Math.max(0, 6 - szDecimals);
  }

  // --- IExchange Implementation ---

  async loadExchangeInfo(): Promise<void> {
    if (this.loaded) return;
    const meta = await this.infoPost<HlMeta>({ type: 'meta' });

    for (let i = 0; i < meta.universe.length; i++) {
      const asset = meta.universe[i];
      if (asset.isDelisted) continue;

      this.assetIndex.set(asset.name, i);
      this.assetInfo.set(asset.name, {
        szDecimals: asset.szDecimals,
        maxLeverage: asset.maxLeverage,
      });

      const priceDecimals = this.pricePrecision(asset.szDecimals);
      const stepSize = Math.pow(10, -asset.szDecimals);
      const tickSize = Math.pow(10, -priceDecimals);
      const symbol = this.fromHlSymbol(asset.name);

      this.symbolPrecisionCache.set(symbol, {
        quantityPrecision: asset.szDecimals,
        pricePrecision: priceDecimals,
        stepSize,
        tickSize,
        minQty: stepSize,
        maxQty: 1_000_000, // Hyperliquid doesn't have explicit maxQty
        minNotional: 10, // ~$10 minimum
      });
    }

    this.loaded = true;
    console.log(`[Hyperliquid] Loaded ${this.assetIndex.size} assets`);
  }

  isSymbolAvailable(symbol: string): boolean {
    return this.symbolPrecisionCache.has(symbol);
  }

  getSymbolPrecision(symbol: string): SymbolPrecision | null {
    return this.symbolPrecisionCache.get(symbol) || null;
  }

  roundQuantity(symbol: string, qty: number): number {
    const info = this.symbolPrecisionCache.get(symbol);
    if (!info) return Math.floor(qty * 100) / 100;
    const step = info.stepSize;
    const rounded = Math.floor(qty / step) * step;
    return parseFloat(rounded.toFixed(info.quantityPrecision));
  }

  roundPrice(symbol: string, price: number): number {
    const info = this.symbolPrecisionCache.get(symbol);
    if (!info) return Math.round(price * 100) / 100;
    const tick = info.tickSize;
    const rounded = Math.round(price / tick) * tick;
    return parseFloat(rounded.toFixed(info.pricePrecision));
  }

  async getPrice(symbol: string): Promise<number> {
    const mids = await this.infoPost<Record<string, string>>({ type: 'allMids' });
    const coin = this.toHlSymbol(symbol);
    const mid = mids[coin];
    if (!mid) throw new Error(`No price for ${coin}`);
    return parseFloat(mid);
  }

  async getKlines(symbol: string, interval: string, limit: number): Promise<number[][]> {
    const coin = this.toHlSymbol(symbol);
    const now = Date.now();
    // Estimate start time based on interval and limit
    const intervalMs: Record<string, number> = {
      '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
      '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000,
      '1d': 86_400_000, '1w': 604_800_000,
    };
    const ms = intervalMs[interval] || 3_600_000;
    const startTime = now - (limit * ms);

    const candles = await this.infoPost<HlCandle[]>({
      type: 'candleSnapshot',
      req: { coin, interval, startTime, endTime: now },
    });

    // Convert to Binance-style number[][] format: [time, open, high, low, close, volume, closeTime]
    return candles.slice(-limit).map(c => [
      c.t,
      parseFloat(c.o),
      parseFloat(c.h),
      parseFloat(c.l),
      parseFloat(c.c),
      parseFloat(c.v),
      c.T,
    ]);
  }

  async getTicker24hr(symbol: string): Promise<Ticker24hr> {
    // Get 24h klines to compute price change
    const klines = await this.getKlines(symbol, '1d', 2);
    if (klines.length < 2) return { priceChangePercent: '0' };

    const prevClose = klines[klines.length - 2][4]; // close price of prev day
    const currClose = klines[klines.length - 1][4];
    const changePct = ((currClose - prevClose) / prevClose * 100);
    return { priceChangePercent: changePct.toFixed(2) };
  }

  async getAccountInfo(): Promise<AccountInfo> {
    const state = await this.infoPost<HlClearinghouseState>({
      type: 'clearinghouseState',
      user: this.address,
    });

    const totalUnrealized = state.assetPositions.reduce(
      (sum, p) => sum + parseFloat(p.position.unrealizedPnl || '0'), 0
    );

    const positions = state.assetPositions.map(p => {
      const szi = parseFloat(p.position.szi);
      return {
        symbol: this.fromHlSymbol(p.position.coin),
        positionSide: (szi >= 0 ? 'LONG' : 'SHORT') as 'LONG' | 'SHORT',
        positionAmt: p.position.szi,
        entryPrice: p.position.entryPx,
        unrealizedProfit: p.position.unrealizedPnl,
        leverage: p.position.leverage.value.toString(),
      };
    });

    return {
      totalWalletBalance: state.marginSummary.accountValue,
      totalUnrealizedProfit: totalUnrealized.toString(),
      totalMarginBalance: state.marginSummary.accountValue,
      availableBalance: state.withdrawable,
      positions,
    };
  }

  async getPositionRisk(): Promise<PositionRiskEntry[]> {
    const state = await this.infoPost<HlClearinghouseState>({
      type: 'clearinghouseState',
      user: this.address,
    });

    return state.assetPositions
      .filter(p => parseFloat(p.position.szi) !== 0)
      .map(p => {
        const szi = parseFloat(p.position.szi);
        // Get current price from position value / size
        const markPrice = Math.abs(parseFloat(p.position.positionValue) / szi);
        return {
          symbol: this.fromHlSymbol(p.position.coin),
          positionSide: szi >= 0 ? 'LONG' : 'SHORT',
          positionAmt: p.position.szi,
          entryPrice: p.position.entryPx,
          leverage: p.position.leverage.value.toString(),
          markPrice: markPrice.toString(),
          unRealizedProfit: p.position.unrealizedPnl,
          liquidationPrice: p.position.liquidationPx || '0',
        };
      });
  }

  async setLeverage(symbol: string, leverage: number): Promise<any> {
    return this.exchangePost({
      type: 'updateLeverage',
      asset: this.getAssetIndex(symbol),
      isCross: true,
      leverage,
    });
  }

  async setPositionMode(_dualSidePosition: boolean): Promise<any> {
    // Hyperliquid doesn't support hedge mode — always net position
    console.log('[Hyperliquid] setPositionMode is a no-op (net positions only)');
    return {};
  }

  async setMarginType(_symbol: string, _marginType: 'ISOLATED' | 'CROSSED'): Promise<any> {
    // Handled via updateLeverage isCross flag
    return {};
  }

  async newOrder(params: NewOrderParams): Promise<any> {
    const assetIdx = this.getAssetIndex(params.symbol);
    const info = this.assetInfo.get(this.toHlSymbol(params.symbol));
    const szDecimals = info?.szDecimals || 2;
    const isBuy = params.side === 'BUY';

    let price: string;
    let tif: string;

    if (params.type === 'MARKET') {
      // Market order = aggressive limit + IOC with 1% slippage
      const currentPrice = await this.getPrice(params.symbol);
      const slippage = isBuy ? 1.01 : 0.99;
      const aggPrice = this.roundPrice(params.symbol, currentPrice * slippage);
      price = floatToWire(aggPrice, this.pricePrecision(szDecimals));
      tif = 'Ioc';
    } else {
      price = floatToWire(params.price!, this.pricePrecision(szDecimals));
      tif = params.timeInForce === 'IOC' ? 'Ioc' : params.timeInForce === 'FOK' ? 'Fok' : 'Gtc';
    }

    const order = {
      a: assetIdx,
      b: isBuy,
      p: price,
      s: floatToWire(params.quantity, szDecimals),
      r: params.reduceOnly || false,
      t: { limit: { tif } },
    };

    const result = await this.exchangePost({
      type: 'order',
      orders: [order],
      grouping: 'na',
    }) as HlOrderResponse;

    // Extract order ID from response
    const status = result.response?.data?.statuses?.[0];
    if (status?.error) throw new Error(`HL order error: ${status.error}`);

    return {
      orderId: status?.resting?.oid || status?.filled?.oid || 0,
      status: status?.filled ? 'FILLED' : 'NEW',
      ...status,
    };
  }

  async newAlgoOrder(params: AlgoOrderParams): Promise<any> {
    const assetIdx = this.getAssetIndex(params.symbol);
    const info = this.assetInfo.get(this.toHlSymbol(params.symbol));
    const szDecimals = info?.szDecimals || 2;
    const isBuy = params.side === 'BUY';

    const tpsl = params.type === 'TAKE_PROFIT_MARKET' ? 'tp' : 'sl';

    // For closePosition, we need to get current position size
    let size: string;
    if (params.closePosition) {
      const positions = await this.getPositionRisk();
      const pos = positions.find(p => p.symbol === params.symbol);
      size = pos ? floatToWire(Math.abs(parseFloat(pos.positionAmt)), szDecimals) : '0';
    } else {
      size = floatToWire(params.quantity!, szDecimals);
    }

    const order = {
      a: assetIdx,
      b: isBuy,
      p: floatToWire(params.triggerPrice, this.pricePrecision(szDecimals)),
      s: size,
      r: true, // TP/SL are always reduce-only
      t: {
        trigger: {
          triggerPx: floatToWire(params.triggerPrice, this.pricePrecision(szDecimals)),
          isMarket: true,
          tpsl,
        },
      },
    };

    const result = await this.exchangePost({
      type: 'order',
      orders: [order],
      grouping: 'na',
    }) as HlOrderResponse;

    const status = result.response?.data?.statuses?.[0];
    if (status?.error) throw new Error(`HL algo order error: ${status.error}`);

    return { orderId: status?.resting?.oid || 0 };
  }

  async cancelOrder(symbol: string, orderId: string): Promise<any> {
    return this.exchangePost({
      type: 'cancel',
      cancels: [{ a: this.getAssetIndex(symbol), o: parseInt(orderId) }],
    });
  }

  async getOpenOrders(symbol?: string): Promise<any[]> {
    const result = await this.infoPost<any[]>({
      type: 'openOrders',
      user: this.address,
    });
    if (symbol) {
      const coin = this.toHlSymbol(symbol);
      return result.filter((o: any) => o.coin === coin);
    }
    return result;
  }

  async getUserTrades(symbol?: string, limit?: number): Promise<any[]> {
    const fills = await this.infoPost<HlFill[]>({
      type: 'userFills',
      user: this.address,
      aggregateByTime: false,
    });

    let result = fills;
    if (symbol) {
      const coin = this.toHlSymbol(symbol);
      result = fills.filter(f => f.coin === coin);
    }

    // Map to Binance-like format
    return result.slice(0, limit || 500).map(f => ({
      symbol: this.fromHlSymbol(f.coin),
      id: f.oid,
      price: f.px,
      qty: f.sz,
      side: f.side === 'B' ? 'BUY' : 'SELL',
      positionSide: f.dir.includes('Long') ? 'LONG' : 'SHORT',
      realizedPnl: f.closedPnl,
      commission: f.fee,
      time: f.time,
    }));
  }

  async getAllUserTrades(limit?: number): Promise<any[]> {
    return this.getUserTrades(undefined, limit);
  }
}
