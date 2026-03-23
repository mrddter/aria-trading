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
  walletAddress?: string; // Main wallet address (if using API wallet)
  vaultAddress?: string;
  isTestnet: boolean;
}

export class HyperliquidClient implements IExchange {
  readonly name = 'Hyperliquid';
  private privateKey: string;
  private address: string;       // API wallet address (signs transactions)
  private userAddress: string;   // Main wallet address (holds funds)
  private vaultAddress?: string;
  private isTestnet: boolean;
  private baseUrl: string;

  // Asset mapping
  private assetIndex: Map<string, number> = new Map(); // BTC -> 0, ETH -> 1
  private assetInfo: Map<string, { szDecimals: number; maxLeverage: number }> = new Map();
  // Cache clearinghouseState to avoid redundant API calls (HL rate limits aggressively)
  private cachedState: HlClearinghouseState | null = null;
  private cachedStateTs = 0;
  private symbolPrecisionCache: Map<string, SymbolPrecision> = new Map();
  private loaded = false;

  constructor(env: HyperliquidEnv) {
    // Clean up private key — remove 0x prefix, trim whitespace/newlines
    let pk = env.privateKey.trim();
    if (pk.startsWith('0x')) pk = pk.slice(2);
    pk = pk.replace(/[\s\n\r]/g, '');

    if (pk.length !== 64 || !/^[0-9a-fA-F]+$/.test(pk)) {
      throw new Error(`Invalid private key: expected 64 hex chars, got ${pk.length} chars`);
    }

    this.privateKey = pk;
    this.address = privateKeyToAddress(this.privateKey);
    this.userAddress = env.walletAddress || this.address;
    this.vaultAddress = env.vaultAddress;
    this.isTestnet = env.isTestnet;
    this.baseUrl = env.isTestnet
      ? 'https://api.hyperliquid-testnet.xyz'
      : 'https://api.hyperliquid.xyz';
    console.log(`[Hyperliquid] API wallet: ${this.address}, User wallet: ${this.userAddress} (${env.isTestnet ? 'testnet' : 'mainnet'})`);
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

  /** Get clearinghouse state with 30s cache */
  private async getClearinghouseState(): Promise<HlClearinghouseState> {
    const now = Date.now();
    if (this.cachedState && now - this.cachedStateTs < 30_000) {
      return this.cachedState;
    }
    this.cachedState = await this.infoPost<HlClearinghouseState>({
      type: 'clearinghouseState',
      user: this.userAddress,
    });
    this.cachedStateTs = now;
    return this.cachedState;
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

  /** Invalidate cache after trades change state */
  private invalidateCache(): void {
    this.cachedState = null;
    this.cachedStateTs = 0;
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

  /**
   * Get price precision (max decimals) for a given price.
   * Hyperliquid uses 5 significant figures for prices.
   */
  private priceDecimalsForValue(price: number): number {
    if (price <= 0) return 2;
    const order = Math.floor(Math.log10(price));
    return Math.max(0, 5 - order - 1);
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

      const priceDecimals = 2; // placeholder — actual decimals computed dynamically from price
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

  roundPrice(_symbol: string, price: number): number {
    // Hyperliquid: 5 significant figures, decimals depend on price magnitude
    const decimals = this.priceDecimalsForValue(price);
    const tick = Math.pow(10, -decimals);
    const rounded = Math.round(price / tick) * tick;
    return parseFloat(rounded.toFixed(decimals));
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
    const state = await this.getClearinghouseState();

    // Always fetch both perps and spot balance (unified account support)
    let walletBalance = parseFloat(state.marginSummary.accountValue || '0');
    let availableBalance = parseFloat(state.withdrawable || '0');
    console.log(`[Hyperliquid] Perps balance: ${walletBalance}, user: ${this.userAddress}`);

    // Always check spot for USDC balance and add to total
    try {
      const spotState = await this.infoPost<{ balances: Array<{ coin: string; total: string }> }>({
        type: 'spotClearinghouseState',
        user: this.userAddress,
      });
      const usdcBalance = spotState.balances?.find(b => b.coin === 'USDC');
      const spotUsdc = parseFloat(usdcBalance?.total || '0');
      console.log(`[Hyperliquid] Spot USDC: ${spotUsdc}`);
      walletBalance += spotUsdc;
      availableBalance += spotUsdc;
    } catch (e) {
      console.error(`[Hyperliquid] Spot balance fetch failed: ${(e as Error).message}`);
    }

    const totalUnrealized = state.assetPositions.reduce(
      (sum, p) => sum + parseFloat(p.position.unrealizedPnl || '0'), 0
    );

    const positions = state.assetPositions.map(p => {
      const szi = parseFloat(p.position.szi);
      const posValue = parseFloat(p.position.positionValue || '0');
      const markPrice = szi !== 0 ? Math.abs(posValue / szi) : 0;
      return {
        symbol: this.fromHlSymbol(p.position.coin),
        positionSide: (szi >= 0 ? 'LONG' : 'SHORT') as 'LONG' | 'SHORT',
        positionAmt: p.position.szi,
        entryPrice: p.position.entryPx,
        markPrice: markPrice.toString(),
        unrealizedProfit: p.position.unrealizedPnl,
        leverage: p.position.leverage.value.toString(),
      };
    });

    return {
      totalWalletBalance: walletBalance.toString(),
      totalUnrealizedProfit: totalUnrealized.toString(),
      totalMarginBalance: walletBalance.toString(),
      availableBalance: availableBalance.toString(),
      positions,
    };
  }

  async getPositionRisk(): Promise<PositionRiskEntry[]> {
    const state = await this.getClearinghouseState();

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
      price = floatToWire(aggPrice, this.priceDecimalsForValue(aggPrice));
      tif = 'Ioc';
    } else {
      const roundedPrice = this.roundPrice(params.symbol, params.price!);
      price = floatToWire(roundedPrice, this.priceDecimalsForValue(roundedPrice));
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

    this.invalidateCache();
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

    const roundedTrigger = this.roundPrice(params.symbol, params.triggerPrice);
    const triggerDecimals = this.priceDecimalsForValue(roundedTrigger);

    const order = {
      a: assetIdx,
      b: isBuy,
      p: floatToWire(roundedTrigger, triggerDecimals),
      s: size,
      r: true, // TP/SL are always reduce-only
      t: {
        trigger: {
          triggerPx: floatToWire(roundedTrigger, triggerDecimals),
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
      user: this.userAddress,
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
      user: this.userAddress,
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
