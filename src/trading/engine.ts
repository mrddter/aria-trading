/**
 * Live Trading Engine
 *
 * Pipeline: Ingestion → LLM Sensor → Quant Filter → Risk → Order
 *
 * Combines:
 * - Market Neutral Sentiment (hourly rebalancing)
 * - Event-Driven (real-time on high-impact news)
 */

import type { IExchange, AccountInfo } from '../exchange/types';
import { TelegramBot } from '../telegram/bot';
import { collectEvents, classifyImpact } from '../ingestion/collector';
import { processHighImpactItem, processBatch, PriceContext } from '../sentiment/llm-sensor';
import { aggregateSignals, rankBySentiment, selectMarketNeutralLegs } from '../sentiment/aggregator';
import { evaluateEventSignal } from './strategies/event-driven';
import { shouldExecuteSentimentSignal } from './strategies/market-neutral-filter';
import { calculatePositionSize } from './risk';
import { detectRegime, RegimeParams, formatRegimeTelegram } from './regime';
import { ExperienceDB } from './experience';
import { calculateCompositeScore } from './composite-score';
import { calculateRSI, calculateADX, calculateEMA, calculateMACD } from '../utils/indicators';
import { logEvent, logError } from '../utils/log';
import { logGate } from './gate-telemetry';
import {
  getOrCreateDailyState,
  setHalted,
  isOverDailyLossLimit,
  addRealizedPnl,
} from './daily-risk';
import { costTracker, extractJson } from '../wavespeed/client';
import type { AiBinding } from '../wavespeed/workers-ai';
import { callStrategist } from '../wavespeed/workers-ai';
import type { SentimentSignal, SentimentSnapshot } from '../sentiment/types';
import type { RawTextItem } from '../ingestion/sources';

export interface EngineConfig {
  leverage: number;
  riskPerTrade: number;
  maxPositionSizeUsdt: number;
  maxPositions: number;
  enableEventDriven: boolean;
  enableMarketNeutral: boolean;
  // Step 1 capital preservation gates (defaults applied in index.ts)
  dailyLossLimitPct?: number;          // default 2.0
  fundingGateThresholdPct?: number;    // default 50 (used asymmetrically: LONG +X, SHORT -(X-15))
  fundingEmergencyExitPct?: number;    // default 500
}

interface SoftOrder {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  stopLoss: number;
  takeProfit: number;
  quantity: number;
  entryPrice: number;
  strategy: string;
  openedAt: number;
  timeoutAt?: number; // ms timestamp; if set and exceeded, force-close at market
}

// Persisted across cron invocations via module-level variable (same isolate)
const softOrders: Map<string, SoftOrder> = new Map();

// Trend-reversal telemetry: persists across cron invocations within same isolate.
// Cleared on deploy. Useful to verify the early-exit logic is firing.
interface ReversalCheck {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  pnl: number;
  heldMin: number;
  signals: string;
  flipped: boolean;
  ts: number;
}
const reversalChecks: ReversalCheck[] = [];
const MAX_REVERSAL_HISTORY = 50;

export function getReversalChecks(): ReversalCheck[] {
  return [...reversalChecks];
}

/** Get current soft order keys for audit */
export function getSoftOrderKeys(): string[] {
  return [...softOrders.keys()];
}

/** Drop soft orders for a symbol+direction (used after manual close from Telegram) */
export function deleteSoftOrdersFor(symbol: string, direction: 'LONG' | 'SHORT'): number {
  const prefix = `${symbol}:${direction}:`;
  let n = 0;
  for (const key of softOrders.keys()) {
    if (key.startsWith(prefix)) {
      softOrders.delete(key);
      n++;
    }
  }
  return n;
}

export class TradingEngine {
  private exchange: IExchange;
  private telegram: TelegramBot;
  private config: EngineConfig;
  private ai: AiBinding;
  // NOTE: Worker is stateless - these reset each invocation.
  // For MVP this is fine: we process ALL recent items each cycle.
  // In production, use KV or D1 for persistence.
  private seenIds = new Set<string>();
  private sentimentHistory: SentimentSignal[] = [];
  private currentRegime: RegimeParams | null = null;
  private lastFearGreed: number = 50;
  private firstRun = true;
  private experience?: ExperienceDB;
  // Cache account info per cycle to avoid redundant API calls (Binance rate limits)
  private cachedAccount: AccountInfo | null = null;
  private cachedAccountTs = 0;

  constructor(
    exchange: IExchange,
    telegram: TelegramBot,
    config: EngineConfig,
    ai: AiBinding,
    db?: D1Database,
  ) {
    this.exchange = exchange;
    this.telegram = telegram;
    this.config = config;
    this.ai = ai;
    if (db) this.experience = new ExperienceDB(db);
  }

  /** Get account info with 30s cache to avoid redundant API calls */
  private async getAccount(forceRefresh = false): Promise<AccountInfo> {
    const now = Date.now();
    if (!forceRefresh && this.cachedAccount && now - this.cachedAccountTs < 30_000) {
      return this.cachedAccount;
    }
    this.cachedAccount = await this.exchange.getAccountInfo();
    this.cachedAccountTs = now;
    return this.cachedAccount;
  }

  /** Invalidate account cache after a trade changes balances/positions */
  private invalidateAccountCache(): void {
    this.cachedAccount = null;
    this.cachedAccountTs = 0;
  }

  /** Expose exchange client for audit (avoids creating a new client) */
  getExchange(): IExchange {
    return this.exchange;
  }

  /**
   * Main cycle - called by cron every 5 minutes.
   * 1. Collect news events
   * 2. Process through LLM sensor
   * 3. Event-driven: trade on high-impact news immediately
   * 4. Accumulate sentiment for market-neutral rebalancing
   */
  async runCycle(): Promise<void> {
    console.log(`[Engine] Cycle start: ${new Date().toISOString()}`);

    // Load exchange info for dynamic precision (cached after first call)
    await this.exchange.loadExchangeInfo();

    try {
      // 1. Collect events (seenIds only works within same isolate)
      const { newItems: rawItems, fearGreed } = await collectEvents(
        this.seenIds,
        60 * 60 * 1000 // 1 hour lookback
      );
      this.lastFearGreed = fearGreed.value;

      // 2. Deduplicate against D1 (persists across Worker restarts/deploys)
      let newItems = rawItems;
      if (this.experience && rawItems.length > 0) {
        const seenTitles = await this.experience.getRecentNewsTitles(2);
        const before = newItems.length;
        newItems = rawItems.filter(item => !seenTitles.has(item.text));
        const deduped = before - newItems.length;
        if (deduped > 0) console.log(`[Engine] Deduped ${deduped} news already in D1`);
      }

      console.log(`[Engine] Collected ${newItems.length} new items, F&G: ${fearGreed.value}`);

      // Detect market regime
      try {
        const btcTicker = await this.exchange.getTicker24hr('BTCUSDT');
        const btcChange = parseFloat(btcTicker?.priceChangePercent || '0');
        const regimeInput = {
          fearGreedValue: fearGreed.value,
          btcPriceChange24h: btcChange,
          btcVolatility: 0,
          marketDominanceBtc: 50,
          avgVolume24hRatio: 1.0,
        };
        this.currentRegime = detectRegime(regimeInput);
        console.log(`[Regime] ${this.currentRegime.regime}: ${this.currentRegime.description}`);
      } catch (err) {
        console.error(`[Regime] Detection failed:`, (err as Error).message);
      }

      if (newItems.length === 0) {
        console.log('[Engine] No items, skipping LLM processing');
        // Still add Fear & Greed signal for market-neutral
        this.sentimentHistory.push({
          asset: 'MARKET',
          sentimentScore: (fearGreed.value - 50) / 50,
          confidence: 0.7,
          magnitude: 0.3,
          direction: fearGreed.value > 55 ? 'positive' : fearGreed.value < 45 ? 'negative' : 'neutral',
          source: 'fear_greed',
          category: 'sentiment_aggregate',
          timestamp: Date.now(),
        });
      }

      if (newItems.length === 0) return;

      // 2. Classify impact
      const highImpact: RawTextItem[] = [];
      const normalItems: RawTextItem[] = [];

      for (const item of newItems) {
        const impact = classifyImpact(item);
        if (impact === 'high') highImpact.push(item);
        else normalItems.push(item);
      }

      console.log(`[Engine] High impact: ${highImpact.length}, Normal: ${normalItems.length}`);

      // Record all news items in D1 for deduplication and tracking
      if (this.experience) {
        for (const item of newItems) {
          try {
            await this.experience.recordNewsEvent({
              source: item.source,
              title: item.text,
              body: item.text.slice(0, 500),
              asset: item.relatedAssets?.[0],
              impactLevel: classifyImpact(item) === 'high' ? 'HIGH' : 'NORMAL',
              publishedAt: new Date(item.publishedAt).toISOString(),
            });
          } catch { /* ignore duplicate errors */ }
        }
      }

      // 3. Event-Driven: process high-impact items with Sonnet 4.5
      if (this.config.enableEventDriven && highImpact.length > 0) {
        for (const item of highImpact.slice(0, 3)) { // Max 3 per cycle
          await this.processEventDriven(item);
        }
      }

      // 4. Process normal items via Workers AI (Llama 4 Scout primary, GPT-OSS 20B fallback).
      if (normalItems.length > 0) {
        const batchInput = normalItems.slice(0, 15); // Max 15 per cycle for cost control
        const signals = await processBatch(this.ai, batchInput);
        this.sentimentHistory.push(...signals);

        // Enrich D1 news_events rows with sentiment from LLM (A1.1).
        // Match signals to input items by index; processBatch preserves order per batch of 5.
        if (this.experience) {
          for (let i = 0; i < signals.length && i < batchInput.length; i++) {
            const s = signals[i];
            const item = batchInput[i];
            try {
              await this.experience.enrichNewsByTitle(
                item.text,
                s.asset !== 'MARKET' ? s.asset : undefined,
                s.sentimentScore,
                s.confidence,
                s.magnitude,
                s.category,
              );
            } catch { /* ignore */ }
          }
        }
      }

      // Also add Fear & Greed as a market-wide signal
      this.sentimentHistory.push({
        asset: 'MARKET',
        sentimentScore: (fearGreed.value - 50) / 50,
        confidence: 0.7,
        magnitude: 0.3,
        direction: fearGreed.value > 55 ? 'positive' : fearGreed.value < 45 ? 'negative' : 'neutral',
        source: 'fear_greed',
        category: 'sentiment_aggregate',
        timestamp: Date.now(),
      });

      // Prune old signals (keep last 24 hours)
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      this.sentimentHistory = this.sentimentHistory.filter((s) => s.timestamp > cutoff);

      console.log(`[Engine] Sentiment history: ${this.sentimentHistory.length} signals`);

      // Send cycle summary to Telegram
      const highCount = newItems.filter((i) => classifyImpact(i) === 'high').length;
      const signalAssets = this.sentimentHistory
        .filter((s) => s.asset !== 'MARKET')
        .map((s) => `${s.asset}(${s.sentimentScore > 0 ? '+' : ''}${s.sentimentScore.toFixed(2)})`)
        .slice(0, 8);

      const regimeEmoji: Record<string, string> = {
        RISK_ON: '🟢', RISK_OFF: '🔴', NEUTRAL: '⚪',
        EXTREME_FEAR: '🟣', EXTREME_GREED: '🟡',
      };
      const r = this.currentRegime;
      const effectiveLev = r ? Math.max(1, Math.round(this.config.leverage * r.leverageMultiplier)) : this.config.leverage;

      let cycleMsg = `📊 <b>Cycle Report</b>\n\n`;
      cycleMsg += `<b>News:</b> ${newItems.length} items (${highCount} high-impact)\n`;
      cycleMsg += `<b>F&G:</b> ${fearGreed.value} (${fearGreed.classification})\n`;
      if (r) {
        cycleMsg += `${regimeEmoji[r.regime] || '⚪'} <b>Regime: ${r.regime}</b>\n`;
        cycleMsg += `  Lev: <code>${effectiveLev}x</code> | Size: <code>${r.sizeMultiplier}x</code> | Long: <code>${r.longBias}x</code> | Short: <code>${r.shortBias}x</code>\n`;
      }
      cycleMsg += `<b>Signals:</b> ${this.sentimentHistory.length}\n`;
      if (signalAssets.length > 0) cycleMsg += `<b>Assets:</b> ${signalAssets.join(', ')}\n`;

      // LLM cost breakdown
      const nvidiaFree = costTracker.totalCalls - costTracker.wavespeedCalls - costTracker.workersAiCalls;
      const llmParts: string[] = [];
      if (costTracker.workersAiCalls > 0) llmParts.push(`${costTracker.workersAiCalls} Llama`);
      if (nvidiaFree > 0) llmParts.push(`${nvidiaFree} Qwen`);
      if (costTracker.wavespeedCalls > 0) llmParts.push(`${costTracker.wavespeedCalls} WaveSpeed $${costTracker.wavespeedCost.toFixed(4)}`);
      const allFree = costTracker.wavespeedCost === 0;
      cycleMsg += `<b>LLM:</b> <code>${llmParts.join(' + ') || 'none'}</code>${allFree ? ' ✅ FREE' : ''}\n`;

      cycleMsg += `<b>Time:</b> ${new Date().toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome' })}`;

      await this.telegram.sendMessage(cycleMsg);
    } catch (err) {
      console.error('[Engine] Cycle error:', (err as Error).message);
      await this.telegram.notifyError(`Cycle error: ${(err as Error).message?.slice(0, 100)}`);
    }
  }

  /**
   * Market-Neutral rebalancing - called by cron every 4 hours.
   */
  async rebalanceMarketNeutral(): Promise<void> {
    if (!this.config.enableMarketNeutral) return;

    console.log('[Engine] Market-Neutral rebalance start');

    await this.exchange.loadExchangeInfo();

    try {
      // Get current account state
      const account = await this.getAccount();
      const balance = parseFloat(account.availableBalance);

      // Build sentiment snapshots per asset
      const assetSignals = new Map<string, SentimentSignal[]>();
      for (const signal of this.sentimentHistory) {
        if (signal.asset === 'MARKET') continue;
        const list = assetSignals.get(signal.asset) || [];
        list.push(signal);
        assetSignals.set(signal.asset, list);
      }

      const now = Date.now();
      const snapshots: SentimentSnapshot[] = [];
      for (const [asset, signals] of assetSignals) {
        const snapshot = aggregateSignals(signals, now);
        snapshot.asset = asset;
        if (snapshot.signalCount > 0) snapshots.push(snapshot);
      }

      if (snapshots.length < 4) {
        console.log(`[Engine] Not enough sentiment data (${snapshots.length} assets)`);
        return;
      }

      // Rank and select
      const ranked = rankBySentiment(snapshots);
      const { longs, shorts } = selectMarketNeutralLegs(ranked, 2, 2, 0.1);

      console.log(`[Engine] Longs: ${longs.map((s) => s.asset).join(', ')}`);
      console.log(`[Engine] Shorts: ${shorts.map((s) => s.asset).join(', ')}`);

      // Execute longs
      for (const snap of longs) {
        await this.executeSentimentTrade(snap, 'LONG', balance);
      }

      // Execute shorts
      for (const snap of shorts) {
        await this.executeSentimentTrade(snap, 'SHORT', balance);
      }
    } catch (err) {
      console.error('[Engine] Rebalance error:', (err as Error).message);
      await this.telegram.notifyError(`Rebalance error: ${(err as Error).message?.slice(0, 100)}`);
    }
  }

  /**
   * Pre-identify the most likely asset from a news item using keyword matching.
   * Returns the ticker (e.g. "BTC") so we can fetch its price context BEFORE the LLM call.
   * If no clear asset is found, returns null and the LLM runs without price context.
   */
  private quickIdentifyAsset(item: RawTextItem): string | null {
    if (item.relatedAssets && item.relatedAssets.length > 0) {
      return item.relatedAssets[0];
    }
    const t = item.text.toLowerCase();
    const map: Array<[string, string]> = [
      ['bitcoin', 'BTC'], ['btc', 'BTC'],
      ['ethereum', 'ETH'], ['ether', 'ETH'], [' eth ', 'ETH'],
      ['solana', 'SOL'], [' sol ', 'SOL'],
      ['binance coin', 'BNB'], [' bnb ', 'BNB'],
      ['ripple', 'XRP'], [' xrp ', 'XRP'],
      ['dogecoin', 'DOGE'], [' doge ', 'DOGE'],
      ['cardano', 'ADA'], [' ada ', 'ADA'],
      ['avalanche', 'AVAX'], [' avax ', 'AVAX'],
      ['polkadot', 'DOT'], [' dot ', 'DOT'],
      ['chainlink', 'LINK'], [' link ', 'LINK'],
      ['polygon', 'POL'], [' matic ', 'POL'],
      ['litecoin', 'LTC'], [' ltc ', 'LTC'],
      ['toncoin', 'TON'], [' ton ', 'TON'],
      ['aave', 'AAVE'],
      ['sui', 'SUI'], ['arbitrum', 'ARB'], ['optimism', 'OP'],
      ['uniswap', 'UNI'], ['near protocol', 'NEAR'],
    ];
    for (const [kw, ticker] of map) {
      if (t.includes(kw)) return ticker;
    }
    return null;
  }

  /**
   * Build a PriceContext for the LLM sensor by fetching klines on multiple timeframes.
   * Returns null if any fetch fails (LLM falls back to text-only mode).
   */
  private async buildPriceContext(asset: string): Promise<PriceContext | null> {
    const symbol = asset + 'USDT';
    if (!this.exchange.isSymbolAvailable(symbol)) return null;
    try {
      // Fetch in parallel: 5m (60 bars = 5h), 1h (24 bars = 1d), no 4h needed (covered by 1h)
      const [k5m, k1h] = await Promise.all([
        this.exchange.getKlines(symbol, '5m', 60),
        this.exchange.getKlines(symbol, '1h', 25),
      ]);
      if (!k5m?.length || !k1h?.length) return null;

      const close5m = (idx: number) => parseFloat((k5m[k5m.length - 1 - idx] || [])[4] as any);
      const close1h = (idx: number) => parseFloat((k1h[k1h.length - 1 - idx] || [])[4] as any);
      const current = close5m(0);
      const p5mAgo = close5m(1);
      const p1hAgo = close5m(12);  // 12 × 5m = 1h
      const p4hAgo = close1h(4);
      const p24hAgo = close1h(24);

      const pct = (now: number, then: number) => then > 0 ? ((now - then) / then) * 100 : 0;

      // Volume ratio: last 24h vol / 7-day average (use 1h klines: last 24 vs avg of all 25)
      const vols = k1h.map((k: any) => parseFloat(k[5]));
      const last24Vol = vols.slice(-24).reduce((a, b) => a + b, 0);
      const avgPer24 = vols.reduce((a, b) => a + b, 0) * (24 / vols.length);
      const volRatio24h = avgPer24 > 0 ? last24Vol / avgPer24 : 1;

      return {
        asset,
        current,
        pct5m: pct(current, p5mAgo),
        pct1h: pct(current, p1hAgo),
        pct4h: pct(current, p4hAgo),
        pct24h: pct(current, p24hAgo),
        volRatio24h,
      };
    } catch (e) {
      console.warn(`[PriceContext] ${asset} failed: ${(e as Error).message?.slice(0, 60)}`);
      return null;
    }
  }

  /**
   * Check if the trend has reversed against an open position.
   * Returns flipped=true if 2 of 3 signals point opposite to the trade direction:
   *   1. MACD histogram has flipped opposite
   *   2. RSI has crossed 50 against the trade
   *   3. Price has crossed EMA20 against the trade
   * Used by checkSoftOrders to early-exit profitable positions before they decay.
   */
  /**
   * Macro regime check: looks at BTC 24h % change as the dominant market direction.
   * Returns one of:
   *   - 'BULL': BTC 24h > +1.5%
   *   - 'BEAR': BTC 24h < -1.5%
   *   - 'NEUTRAL': otherwise
   *
   * Cached for 10 minutes via Cache API to avoid duplicate fetches per cron cycle.
   * Returns 'NEUTRAL' on any fetch error (fail-safe: never block trades on infra issues).
   */
  private async checkMacroRegime(): Promise<{ regime: 'BULL' | 'BEAR' | 'NEUTRAL'; btcPct24h: number }> {
    const cacheKey = 'https://aria-internal.cache/macro-btc-24h';
    const cache = (caches as any).default as Cache | undefined;

    if (cache) {
      try {
        const cached = await cache.match(cacheKey);
        if (cached) {
          const json = await cached.json() as { btcPct24h: number };
          return classifyRegime(json.btcPct24h);
        }
      } catch { /* fall through */ }
    }

    try {
      const klines = await this.exchange.getKlines('BTCUSDT', '1h', 25);
      if (!klines || klines.length < 25) return { regime: 'NEUTRAL', btcPct24h: 0 };
      const closes = klines.map((k: any) => parseFloat(k[4]));
      const now = closes[closes.length - 1];
      const ago24h = closes[0];
      const btcPct24h = ago24h > 0 ? ((now - ago24h) / ago24h) * 100 : 0;

      if (cache) {
        try {
          const resp = new Response(JSON.stringify({ btcPct24h }), {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=600' },
          });
          await cache.put(cacheKey, resp);
        } catch { /* best effort */ }
      }

      return classifyRegime(btcPct24h);
    } catch {
      return { regime: 'NEUTRAL', btcPct24h: 0 };
    }

    function classifyRegime(btcPct24h: number): { regime: 'BULL' | 'BEAR' | 'NEUTRAL'; btcPct24h: number } {
      const regime: 'BULL' | 'BEAR' | 'NEUTRAL' =
        btcPct24h > 1.5 ? 'BULL'
        : btcPct24h < -1.5 ? 'BEAR'
        : 'NEUTRAL';
      return { regime, btcPct24h };
    }
  }

  private async checkTrendReversal(
    symbol: string,
    direction: 'LONG' | 'SHORT',
    currentPrice: number,
  ): Promise<{ flipped: boolean; signals: string }> {
    try {
      const klines = await this.exchange.getKlines(symbol, '1h', 30);
      if (!klines?.length || klines.length < 26) return { flipped: false, signals: 'insufficient-data' };

      const closes = klines.map((k: any) => parseFloat(k[4]));
      const rsi = calculateRSI(closes);
      const macd = calculateMACD(closes);
      const ema20Arr = calculateEMA(closes, 20);
      const ema20 = ema20Arr[ema20Arr.length - 1];

      const isLong = direction === 'LONG';

      // Signal 1: MACD histogram flipped against us
      const macdAgainst = isLong ? macd.histogram < 0 : macd.histogram > 0;

      // Signal 2: RSI crossed 50 against us (LONG: RSI<50 = momentum lost; SHORT: RSI>50)
      const rsiAgainst = isLong ? rsi < 50 : rsi > 50;

      // Signal 3: Price crossed EMA20 against us
      const priceAgainst = isLong ? currentPrice < ema20 : currentPrice > ema20;

      const flips = [macdAgainst, rsiAgainst, priceAgainst].filter(Boolean).length;
      const signalNames = [
        macdAgainst ? 'MACD' : null,
        rsiAgainst ? 'RSI' : null,
        priceAgainst ? 'EMA20' : null,
      ].filter(Boolean).join('+');

      return { flipped: flips >= 2, signals: signalNames || 'none' };
    } catch (e) {
      console.warn(`[TrendReversal] ${symbol} check failed: ${(e as Error).message?.slice(0, 60)}`);
      return { flipped: false, signals: 'error' };
    }
  }

  // ====================================================================
  // STEP 1 — Capital preservation gates (daily loss + funding)
  // ====================================================================

  /**
   * Check if today's UTC daily loss limit has been breached.
   * Returns { allowed: false } to block NEW entries. Existing positions are
   * unaffected — checkSoftOrders continues to manage them.
   *
   * Fail-safe: if anything goes wrong (no DB, fetch error), returns allowed=true
   * (do not block on infrastructure issues).
   */
  private async checkDailyLossLimit(): Promise<{ allowed: boolean; lossPct?: number }> {
    if (!this.experience) return { allowed: true };
    const db = this.experience.getDb();
    if (!db) return { allowed: true };

    const limitPct = this.config.dailyLossLimitPct ?? 2.0;

    try {
      const account = await this.getAccount();
      const equity = parseFloat(account.totalWalletBalance) + parseFloat(account.totalUnrealizedProfit || '0');

      const state = await getOrCreateDailyState(db, equity);
      if (!state) return { allowed: true }; // fail-safe: DB write failed, do not block

      // Already halted earlier today
      if (state.halted) {
        await logGate(db, {
          gateId: 'daily_loss',
          passed: false,
          value: ((equity - state.equityStart) / state.equityStart) * 100,
          threshold: -limitPct,
          reason: 'DAILY_LOSS_HALT (already halted)',
        });
        return { allowed: false };
      }

      const { halted, lossPct } = isOverDailyLossLimit(state, equity, limitPct);
      if (halted) {
        await setHalted(db);
        logEvent('daily_loss_limit_breached', {
          equity_start: state.equityStart,
          equity_now: equity,
          loss_pct: lossPct,
          limit_pct: limitPct,
        });
        await this.telegram.sendMessage(
          `🛑 <b>DAILY LOSS HALT</b>\n\n` +
          `Equity start: $${state.equityStart.toFixed(2)}\n` +
          `Equity now: $${equity.toFixed(2)}\n` +
          `Loss: ${lossPct.toFixed(2)}% (limit -${limitPct}%)\n\n` +
          `New entries blocked until 00:00 UTC. Existing positions unaffected.`
        );
        await logGate(db, {
          gateId: 'daily_loss',
          passed: false,
          value: lossPct,
          threshold: -limitPct,
          reason: 'DAILY_LOSS_HALT (newly triggered)',
        });
        return { allowed: false, lossPct };
      }

      await logGate(db, {
        gateId: 'daily_loss',
        passed: true,
        value: lossPct,
        threshold: -limitPct,
      });
      return { allowed: true, lossPct };
    } catch (err) {
      logError('daily_loss_check_failed', err);
      return { allowed: true }; // fail-safe
    }
  }

  /**
   * Funding-rate entry gate. Asymmetric thresholds account for the ~11.6% APR
   * baseline that LONGs structurally pay on Hyperliquid:
   *   - LONG threshold:  +X% APR  (default +50)
   *   - SHORT threshold: -(X-15)% APR  (default -35)
   * The 15% offset normalizes the "real cost above baseline" between sides.
   *
   * Fail-safe: if funding fetch fails or exchange doesn't expose it, allow trade.
   */
  private async checkFundingGate(
    asset: string,
    direction: 'LONG' | 'SHORT',
  ): Promise<{ allowed: boolean; fundingAnnualPct?: number }> {
    if (!this.exchange.getFundingRate) return { allowed: true };
    const db = this.experience?.getDb();

    let funding: number | null;
    try {
      funding = await this.exchange.getFundingRate(asset);
    } catch (err) {
      logError('funding_fetch_failed', err, { asset });
      return { allowed: true };
    }
    if (funding == null) return { allowed: true };

    const fundingAnnualPct = funding * 24 * 365 * 100;
    const baseThr = this.config.fundingGateThresholdPct ?? 50;
    const longThr = baseThr;          // e.g. +50
    const shortThr = -(baseThr - 15); // e.g. -35

    // Extreme funding alert (>500% absolute) — log but does not by itself reject
    if (Math.abs(fundingAnnualPct) > 500) {
      logEvent('extreme_funding_detected', { asset, funding_annual_pct: fundingAnnualPct, funding_hourly: funding });
    }

    const gateId = direction === 'LONG' ? 'funding_long' : 'funding_short';
    if (direction === 'LONG' && fundingAnnualPct > longThr) {
      logEvent('funding_gate_reject', { asset, direction, funding_annual_pct: fundingAnnualPct, threshold: longThr });
      await logGate(db, {
        gateId, asset, direction, passed: false,
        value: fundingAnnualPct, threshold: longThr,
        reason: 'FUNDING_TOO_HIGH_LONG',
      });
      return { allowed: false, fundingAnnualPct };
    }
    if (direction === 'SHORT' && fundingAnnualPct < shortThr) {
      logEvent('funding_gate_reject', { asset, direction, funding_annual_pct: fundingAnnualPct, threshold: shortThr });
      await logGate(db, {
        gateId, asset, direction, passed: false,
        value: fundingAnnualPct, threshold: shortThr,
        reason: 'FUNDING_TOO_LOW_SHORT',
      });
      return { allowed: false, fundingAnnualPct };
    }

    await logGate(db, {
      gateId, asset, direction, passed: true,
      value: fundingAnnualPct,
      threshold: direction === 'LONG' ? longThr : shortThr,
    });
    return { allowed: true, fundingAnnualPct };
  }

  /**
   * Mid-trade emergency funding exit. Returns true if the position must be force-closed.
   * Fail-safe: on fetch error, returns false (no action) — never close on missing data.
   * Always logs to gate_telemetry as 'funding_monitor' (passed=true if no exit).
   */
  private async checkEmergencyFundingExit(
    asset: string,
    direction: 'LONG' | 'SHORT',
  ): Promise<{ exit: boolean; fundingAnnualPct?: number }> {
    if (!this.exchange.getFundingRate) return { exit: false };
    const db = this.experience?.getDb();

    let funding: number | null;
    try {
      funding = await this.exchange.getFundingRate(asset);
    } catch (err) {
      logError('funding_monitor_fetch_failed', err, { asset });
      return { exit: false }; // fail-safe: never force-close on missing data
    }
    if (funding == null) return { exit: false };

    const fundingAnnualPct = funding * 24 * 365 * 100;
    const emergencyThr = this.config.fundingEmergencyExitPct ?? 500;

    const triggered = (direction === 'LONG' && fundingAnnualPct > emergencyThr) ||
                      (direction === 'SHORT' && fundingAnnualPct < -emergencyThr);

    await logGate(db, {
      gateId: 'funding_monitor',
      asset,
      direction,
      passed: !triggered,
      value: fundingAnnualPct,
      threshold: direction === 'LONG' ? emergencyThr : -emergencyThr,
      reason: triggered ? 'EMERGENCY_FUNDING_EXIT' : null,
    });

    if (triggered) {
      logEvent('emergency_funding_exit_triggered', { asset, direction, funding_annual_pct: fundingAnnualPct, threshold: emergencyThr });
    }
    return { exit: triggered, fundingAnnualPct };
  }

  /**
   * Process a high-impact event through the full pipeline.
   */
  private async processEventDriven(item: RawTextItem): Promise<void> {
    console.log(`[Event] Processing: ${item.text.slice(0, 80)}...`);

    // STEP 1.1 — Daily loss limit check (fail-fast, blocks all NEW entries).
    const dailyCheck = await this.checkDailyLossLimit();
    if (!dailyCheck.allowed) {
      console.log(`[Event] DAILY_LOSS_HALT — new entries blocked${dailyCheck.lossPct != null ? ` (loss ${dailyCheck.lossPct.toFixed(2)}%)` : ''}`);
      return;
    }

    // Pre-identify asset to fetch price context before the LLM call (Sprint 1A).
    const preAsset = this.quickIdentifyAsset(item);
    let priceContext: PriceContext | null = null;
    if (preAsset) {
      priceContext = await this.buildPriceContext(preAsset);
      if (priceContext) {
        console.log(`[Event] Price context for ${preAsset}: 5m=${priceContext.pct5m.toFixed(2)}% 1h=${priceContext.pct1h.toFixed(2)}% 4h=${priceContext.pct4h.toFixed(2)}% 24h=${priceContext.pct24h.toFixed(2)}%`);
      }
    }

    // LLM Sensor: Workers AI gpt-oss-120b → gpt-oss-20b → llama-4-scout (all free).
    // Pass priceContext so the LLM can detect already-priced-in news vs fresh edge.
    const signal = await processHighImpactItem(this.ai, item, priceContext ?? undefined);

    if (!signal) {
      console.log('[Event] LLM returned no signal');
      return;
    }

    this.sentimentHistory.push(signal);

    // Enrich the corresponding news_events row with the LLM sentiment (A1.1).
    if (this.experience) {
      try {
        await this.experience.enrichNewsByTitle(
          item.text,
          signal.asset !== 'MARKET' ? signal.asset : undefined,
          signal.sentimentScore,
          signal.confidence,
          signal.magnitude,
          signal.category,
        );
      } catch { /* ignore */ }
    }

    // MARKET signals are for general sentiment, not tradeable
    if (signal.asset === 'MARKET') {
      console.log('[Event] General market signal, added to sentiment history only');
      return;
    }

    const symbol = signal.asset + 'USDT';

    // Check if symbol exists on exchange
    if (!this.exchange.isSymbolAvailable(symbol)) {
      console.log(`[Event] ${symbol} not available on ${this.exchange.name}, skipping trade`);
      return;
    }

    // ---- TOP-CAP WHITELIST (re-introduced 2026-04-30) ----
    // The $2M 24h volume floor proved insufficient: low-cap pairs like CHIPUSDT
    // pass it but have outsized SL hit rates (CHIPUSDT lost -$0.30 in 2h vs the
    // typical -$0.08 on majors). Restrict event-driven trades to assets with
    // meaningful market structure and orderbook depth.
    const TOP_CAP_WHITELIST = new Set([
      'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT',
      'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT',
      'SUIUSDT', 'AAVEUSDT', 'ARBUSDT', 'OPUSDT', 'NEARUSDT',
      'HYPEUSDT', 'LTCUSDT', 'TONUSDT', 'POLUSDT', 'ATOMUSDT',
    ]);
    if (!TOP_CAP_WHITELIST.has(symbol)) {
      console.log(`[Event] ${symbol} not in top-cap whitelist, skipping (low-cap risk too high)`);
      logEvent('whitelist_reject', { asset: signal.asset, symbol });
      const dbForWhitelist = this.experience?.getDb();
      if (dbForWhitelist) {
        await logGate(dbForWhitelist, {
          gateId: 'top_cap_whitelist',
          asset: signal.asset,
          direction: null,
          passed: false,
          value: null,
          threshold: null,
          reason: 'not_in_top_cap_whitelist',
        });
      }
      return;
    }

    // Get kline data for quant filter — fetch 1h + 4h in parallel for multi-timeframe analysis (Sprint 1B)
    const [klines, klines4h] = await Promise.all([
      this.exchange.getKlines(symbol, '1h', 48),
      this.exchange.getKlines(symbol, '4h', 48),
    ]);

    // Volume filter: require minimum 24h notional volume ($5M)
    const last24hKlines = klines.slice(-24);
    const last24hCloses = last24hKlines.map((k: any) => parseFloat(k[4]));
    const last24hVols = last24hKlines.map((k: any) => parseFloat(k[5]));
    const notionalVol24h = last24hCloses.reduce((sum, c, i) => sum + c * last24hVols[i], 0);
    const MIN_VOLUME_24H = 2_000_000; // $2M minimum (A1.6: lowered from $5M to widen tradable universe)
    if (notionalVol24h < MIN_VOLUME_24H) {
      console.log(`[Event] ${symbol} 24h volume $${(notionalVol24h / 1e6).toFixed(1)}M below min $${MIN_VOLUME_24H / 1e6}M, skipping`);
      return;
    }

    // Cooldown: skip asset if last trade on it was a loss within 2 hours
    if (this.experience) {
      try {
        const recentTrade = await this.experience.getLastTrade(symbol);
        if (recentTrade && recentTrade.pnl < 0) {
          const closedAt = new Date(recentTrade.closed_at).getTime();
          const cooldownMs = 1 * 60 * 60 * 1000; // 1 hour
          if (Date.now() - closedAt < cooldownMs) {
            const minsLeft = Math.ceil((cooldownMs - (Date.now() - closedAt)) / 60000);
            console.log(`[Event] ${symbol} on cooldown after loss (${minsLeft}min left), skipping`);
            return;
          }
        }
      } catch (e) {
        console.warn(`[Event] Cooldown check failed: ${(e as Error).message}`);
      }
    }

    const highs = klines.map((k: any) => parseFloat(k[2]));
    const lows = klines.map((k: any) => parseFloat(k[3]));
    const closes = klines.map((k: any) => parseFloat(k[4]));
    const volumes = klines.map((k: any) => parseFloat(k[5]));
    const currentPrice = closes[closes.length - 1];

    // Quant filter
    const setup = evaluateEventSignal(signal, highs, lows, closes, volumes, currentPrice);

    // Flush per-gate telemetry from the quant filter (Step 2 prep).
    // Each GateCheck carries its own direction (null for pre-direction gates G1-G3).
    const dbForGates = this.experience?.getDb();
    if (dbForGates) {
      for (const g of setup.gateChecks) {
        await logGate(dbForGates, {
          gateId: g.gateId,
          asset: signal.asset,
          direction: g.direction,
          passed: g.passed,
          value: g.value,
          threshold: g.threshold,
          reason: g.reason,
        });
      }
    }

    await this.telegram.notifyEvent({
      asset: signal.asset,
      sentiment: signal.sentimentScore,
      magnitude: signal.magnitude,
      headline: item.text.slice(0, 200),
      action: setup.approved ? `${setup.direction} TRADE` : `SKIP: ${setup.reason}`,
    });

    if (!setup.approved) {
      console.log(`[Event] Filtered: ${setup.reason}`);
      return;
    }

    // ---- MACRO REGIME OVERRIDE (Strada 3 + Strada 1, 2026-05-02) ----
    // Two consecutive bearish weeks with 0% WR on LONGs proved the LLM sensor
    // misreads news polarity in directional macro markets. Use BTC 24h trend as
    // the dominant compass:
    //   - BEAR macro (BTC 24h < -1.5%) + LONG setup:
    //       * if asset is also down >0.5% in 4h → INVERT to SHORT (market confirms)
    //       * else → SKIP (asset not yet confirming, too uncertain)
    //   - BULL macro (BTC 24h > +1.5%) + SHORT setup: symmetric
    //   - NEUTRAL macro: no override, original direction stands
    //
    // The "double confirmation" (macro + asset 4h) prevents random inversions
    // when only the macro is moving but the specific asset isn't.
    const macro = await this.checkMacroRegime();
    const assetPct4h = priceContext?.pct4h ?? 0;
    let macroAction: 'inverted' | 'skipped' | 'pass' = 'pass';
    let originalDirection: 'LONG' | 'SHORT' = setup.direction;

    if (macro.regime === 'BEAR' && setup.direction === 'LONG') {
      if (assetPct4h < -0.5) {
        // Asset confirms bear momentum → invert to SHORT
        setup.direction = 'SHORT';
        // Recompute SL/TP for the inverted direction (mirror around current price)
        const slDist = Math.abs(currentPrice - setup.stopLoss);
        const tpDist = Math.abs(setup.takeProfit - currentPrice);
        setup.stopLoss = currentPrice + slDist;
        setup.takeProfit = currentPrice - tpDist;
        macroAction = 'inverted';
        console.log(`[Macro] BEAR regime (BTC 24h ${macro.btcPct24h.toFixed(2)}%) + asset 4h ${assetPct4h.toFixed(2)}% → INVERT LONG→SHORT for ${symbol}`);
      } else {
        macroAction = 'skipped';
        console.log(`[Macro] BEAR regime (BTC 24h ${macro.btcPct24h.toFixed(2)}%) but asset 4h ${assetPct4h.toFixed(2)}% not confirming → SKIP LONG ${symbol}`);
      }
    } else if (macro.regime === 'BULL' && setup.direction === 'SHORT') {
      if (assetPct4h > 0.5) {
        setup.direction = 'LONG';
        const slDist = Math.abs(setup.stopLoss - currentPrice);
        const tpDist = Math.abs(currentPrice - setup.takeProfit);
        setup.stopLoss = currentPrice - slDist;
        setup.takeProfit = currentPrice + tpDist;
        macroAction = 'inverted';
        console.log(`[Macro] BULL regime (BTC 24h ${macro.btcPct24h.toFixed(2)}%) + asset 4h ${assetPct4h.toFixed(2)}% → INVERT SHORT→LONG for ${symbol}`);
      } else {
        macroAction = 'skipped';
        console.log(`[Macro] BULL regime (BTC 24h ${macro.btcPct24h.toFixed(2)}%) but asset 4h ${assetPct4h.toFixed(2)}% not confirming → SKIP SHORT ${symbol}`);
      }
    }

    // Telemetry: log every macro check (pass/inverted/skipped) for calibration
    if (dbForGates) {
      await logGate(dbForGates, {
        gateId: 'macro_regime',
        asset: signal.asset,
        direction: setup.direction,
        passed: macroAction !== 'skipped',
        value: macro.btcPct24h,
        threshold: macro.regime === 'BEAR' ? -1.5 : macro.regime === 'BULL' ? 1.5 : 0,
        reason: macroAction === 'pass'
          ? `${macro.regime}_no_override`
          : macroAction === 'inverted'
            ? `inverted_${originalDirection}_to_${setup.direction}_asset4h_${assetPct4h.toFixed(2)}`
            : `skipped_${originalDirection}_in_${macro.regime}_asset4h_${assetPct4h.toFixed(2)}`,
      });
    }

    if (macroAction === 'skipped') {
      await this.telegram.sendMessage(
        `⛔ <b>${signal.asset} ${originalDirection} SKIPPED — Macro override</b>\n\n` +
        `Macro: <code>${macro.regime}</code> (BTC 24h ${macro.btcPct24h.toFixed(2)}%)\n` +
        `Asset 4h: <code>${assetPct4h.toFixed(2)}%</code> (not confirming)\n` +
        `<b>Reason:</b> direction conflicts with macro, asset not confirming`
      );
      return;
    }

    if (macroAction === 'inverted') {
      await this.telegram.sendMessage(
        `🔄 <b>${signal.asset} DIRECTION INVERTED — Macro override</b>\n\n` +
        `Original: <code>${originalDirection}</code> → New: <code>${setup.direction}</code>\n` +
        `Macro: <code>${macro.regime}</code> (BTC 24h ${macro.btcPct24h.toFixed(2)}%)\n` +
        `Asset 4h: <code>${assetPct4h.toFixed(2)}%</code> (confirms inversion)\n` +
        `New SL: $${setup.stopLoss.toFixed(4)} | TP: $${setup.takeProfit.toFixed(4)}`
      );
    }

    // ---- F&G ASYMMETRIC GATE (Sprint 2A) ----
    // Data 2026-04-19→24: in EXTREME_FEAR (F&G<35) i LONG vincono 80%, gli SHORT solo 50%
    // con loss avg 4x il win avg. Il regime adjusta size ma non blocca direzione.
    // Blocca SHORT in F&G<35 (lascia LONG passare).
    if (setup.direction === 'SHORT' && this.lastFearGreed < 35) {
      const reason = `SHORT blocked in EXTREME_FEAR (F&G=${this.lastFearGreed}, LONG-favored regime)`;
      console.log(`[Event] ${reason}`);
      if (dbForGates) {
        await logGate(dbForGates, {
          gateId: 'fg_short_block', asset: signal.asset, direction: 'SHORT',
          passed: false, value: this.lastFearGreed, threshold: 35,
          reason: 'fg_extreme_fear_short_blocked',
        });
      }
      await this.telegram.notifyEvent({
        asset: signal.asset,
        sentiment: signal.sentimentScore,
        magnitude: signal.magnitude,
        headline: item.text.slice(0, 200),
        action: `SKIP: ${reason}`,
      });
      return;
    }
    // Log F&G pass for both directions
    if (dbForGates) {
      await logGate(dbForGates, {
        gateId: 'fg_short_block', asset: signal.asset, direction: setup.direction,
        passed: true, value: this.lastFearGreed, threshold: 35,
      });
    }

    // ---- STEP 1.2 — Funding rate entry gate ----
    // Asymmetric thresholds: LONG +50% APR, SHORT -35% APR (15% offset accounts
    // for the ~11.6% APR baseline that LONGs structurally pay on Hyperliquid).
    const fundingCheck = await this.checkFundingGate(signal.asset, setup.direction);
    if (!fundingCheck.allowed) {
      const reason = `Funding ${setup.direction === 'LONG' ? 'too high' : 'too low'} (${fundingCheck.fundingAnnualPct?.toFixed(0)}% APR)`;
      console.log(`[Event] ${reason}`);
      await this.telegram.notifyEvent({
        asset: signal.asset,
        sentiment: signal.sentimentScore,
        magnitude: signal.magnitude,
        headline: item.text.slice(0, 200),
        action: `SKIP: ${reason}`,
      });
      return;
    }

    // ---- COMPOSITE SCORE (multi-factor quality gate) ----
    const composite = calculateCompositeScore(
      signal, highs, lows, closes, volumes,
      setup.direction,
      this.currentRegime?.regime,
    );

    console.log(`[Composite] ${symbol} ${setup.direction}: ${composite.score}/100 ` +
      `(Sent:${composite.breakdown.sentiment} Mom:${composite.breakdown.momentum} ` +
      `Vol:${composite.breakdown.volatility} Trend:${composite.breakdown.trend} ` +
      `Reg:${composite.breakdown.regime}) size=${composite.sizeMultiplier}x`);

    if (dbForGates) {
      await logGate(dbForGates, {
        gateId: 'composite_score',
        asset: signal.asset,
        direction: setup.direction,
        passed: composite.approved,
        value: composite.score,
        threshold: 65,
        reason: composite.approved ? null : 'composite_below_threshold',
      });
    }

    if (!composite.approved) {
      console.log(`[Composite] REJECTED: ${composite.reason}`);
      await this.telegram.notifyEvent({
        asset: signal.asset,
        sentiment: signal.sentimentScore,
        magnitude: signal.magnitude,
        headline: item.text.slice(0, 200),
        action: `SKIP: Composite ${composite.score}/100 (min 65)`,
      });
      return;
    }

    // ---- KIMI K2 STRATEGIST (Workers AI — free, fast) ----
    if (this.ai) {
      try {
        // Build context from experience DB
        let historicalContext = '';
        if (this.experience) {
          historicalContext = await this.experience.buildLLMContext(
            symbol,
            signal.category,
            this.currentRegime?.regime
          );
        }

        // Multi-timeframe technical analysis (Sprint 1B): compute 1h + 4h indicators
        // so the strategist can detect timeframe disagreement (= likely bounce trap).
        const closes4h = klines4h.map((k: any) => parseFloat(k[4]));
        const highs4h = klines4h.map((k: any) => parseFloat(k[2]));
        const lows4h = klines4h.map((k: any) => parseFloat(k[3]));
        const rsi1h = setup.indicators.rsi;
        const adx1h = setup.indicators.adx;
        const ema20_1h = calculateEMA(closes, 20);
        const macd1h = calculateMACD(closes);
        const trend1h = currentPrice > ema20_1h[ema20_1h.length - 1] ? 'BULLISH' : 'BEARISH';

        const rsi4h = calculateRSI(closes4h);
        const adx4hRes = calculateADX(highs4h, lows4h, closes4h);
        const ema20_4h = calculateEMA(closes4h, 20);
        const macd4h = calculateMACD(closes4h);
        const last4hPrice = closes4h[closes4h.length - 1];
        const trend4h = last4hPrice > ema20_4h[ema20_4h.length - 1] ? 'BULLISH' : 'BEARISH';

        // Direction agreement: does the requested trade direction align with each timeframe?
        const dirBullish = setup.direction === 'LONG';
        const align1h = (trend1h === 'BULLISH') === dirBullish;
        const align4h = (trend4h === 'BULLISH') === dirBullish;
        const alignmentLabel = align1h && align4h
          ? '✅ FULL ALIGNMENT (1h + 4h confirm)'
          : align1h !== align4h
            ? '⚠️ MIXED — timeframes disagree (likely bounce/trap)'
            : '❌ COUNTER-TREND (both timeframes oppose)';

        const mtfBlock = [
          'MULTI-TIMEFRAME ANALYSIS:',
          `- 1H: RSI=${rsi1h.toFixed(0)} ADX=${adx1h.toFixed(0)} MACD=${macd1h.histogram > 0 ? 'bullish' : 'bearish'} Trend=${trend1h} (price ${currentPrice > ema20_1h[ema20_1h.length - 1] ? '>' : '<'} EMA20)`,
          `- 4H: RSI=${rsi4h.toFixed(0)} ADX=${adx4hRes.adx.toFixed(0)} MACD=${macd4h.histogram > 0 ? 'bullish' : 'bearish'} Trend=${trend4h} (price ${last4hPrice > ema20_4h[ema20_4h.length - 1] ? '>' : '<'} EMA20)`,
          `- ALIGNMENT for ${setup.direction}: ${alignmentLabel}`,
        ].join('\n');

        const strategistPrompt = [
          `ASSET: ${symbol} @ $${currentPrice.toFixed(4)}`,
          `SIGNAL: ${setup.direction} | Sentiment: ${signal.sentimentScore.toFixed(2)} | Confidence: ${signal.confidence.toFixed(2)} | Magnitude: ${signal.magnitude.toFixed(2)}`,
          `COMPOSITE SCORE: ${composite.score}/100 (Sentiment:${composite.breakdown.sentiment} Momentum:${composite.breakdown.momentum} Volatility:${composite.breakdown.volatility} Trend:${composite.breakdown.trend} Regime:${composite.breakdown.regime})`,
          `SIZE MULTIPLIER: ${composite.sizeMultiplier}x`,
          `QUANT: ATR=$${setup.atr?.toFixed(4) || '?'}`,
          `REGIME: ${this.currentRegime?.regime || 'UNKNOWN'} (F&G: ${this.currentRegime ? 'active' : 'n/a'})`,
          '',
          mtfBlock,
          '',
          `NEWS: "${item.text.slice(0, 300)}"`,
          `PROPOSED SL: $${setup.stopLoss.toFixed(4)} | TP: $${setup.takeProfit.toFixed(4)}`,
          historicalContext ? `\n${historicalContext}` : '',
          '',
          'Analyze this trade setup. The composite score already factors momentum, volatility, trend, and regime.',
          'The composite gate has already filtered out anything below 60.',
          'REJECT if: (a) MULTI-TIMEFRAME ALIGNMENT is COUNTER-TREND, OR (b) MIXED + composite score < 75 (mixed without strong score = bounce trap), OR (c) historical context shows a losing pattern, OR (d) news content contradicts the direction.',
          'If MIXED but composite ≥75, you may approve but consider tighter SL.',
          'Respond with JSON: {"execute": true/false, "reasoning": "...", "adjustedSL": number|null, "adjustedTP": number|null, "riskScore": 1-10}',
        ].join('\n');

        console.log(`[Strategist] Calling Kimi K2 for ${symbol} ${setup.direction}...`);

        type StrategistDecision = {
          execute?: boolean;
          reasoning?: string;
          reason?: string;
          adjustedSL?: number;
          adjusted_sl?: number;
          adjustedTP?: number;
          adjusted_tp?: number;
          riskScore?: number;
          risk_score?: number;
          risk?: number;
        };

        const strategistSystemPrompt = `You are an expert crypto trading strategist managing a small account ($60). The composite quality gate (>=60/100) has already filtered the candidate. Rules:
1. PRIORITY: Multi-timeframe alignment is the strongest filter. If 1H and 4H both oppose the trade direction (COUNTER-TREND), REJECT — you are about to short into an uptrend or long into a downtrend.
2. If MIXED (1H and 4H disagree) AND composite score is below 75, REJECT — disagreement signals a likely bounce trap.
3. If MIXED but composite ≥75, you may approve but tighten the SL by 30% (the trade is fragile).
4. The setup is technically sound. Approve unless news content contradicts the direction or history shows a clear losing pattern.
5. REJECT if historical context shows repeated losses on this asset/direction/regime (e.g. 0 wins in 3+ trades).
6. REJECT if the news content is actually neutral/ambiguous despite the LLM score (re-read the headline).
7. Do NOT add extra confidence/magnitude thresholds — those are already in the gate.
Respond ONLY with a JSON object: {"execute": true/false, "reasoning": "1-2 sentences", "riskScore": 1-10, "adjustedSL": number_or_null, "adjustedTP": number_or_null}. No other text.`;

        if (!this.ai) throw new Error('No AI binding for strategist');

        const stratResult = await callStrategist(this.ai, {
          prompt: strategistPrompt,
          systemPrompt: strategistSystemPrompt,
          temperature: 0.3,
          maxTokens: 768, // bumped from 512 — prompt grew with MTF block
        });

        console.log(`[Strategist] ${stratResult.model} responded in ${stratResult.inferenceMs}ms`);
        console.log(`[Strategist] Content: ${stratResult.text?.slice(0, 300)}`);

        // Parse strategist decision
        let decision = extractJson(stratResult.text) as StrategistDecision | null;
        if (!decision) {
          console.log(`[Strategist] JSON extraction FAILED. Content: ${stratResult.text?.slice(0, 500)}`);
        }

        console.log(`[Strategist] Parsed decision: ${JSON.stringify(decision)?.slice(0, 300)}`);

        // Normalize field names
        if (decision) {
          if (!decision.reasoning && decision.reason) decision.reasoning = decision.reason;
          if (!decision.riskScore && decision.risk_score) decision.riskScore = decision.risk_score;
          if (!decision.riskScore && decision.risk) decision.riskScore = decision.risk;
          if (!decision.adjustedSL && decision.adjusted_sl) decision.adjustedSL = decision.adjusted_sl;
          if (!decision.adjustedTP && decision.adjusted_tp) decision.adjustedTP = decision.adjusted_tp;
        }

        if (!decision) {
          console.log(`[Strategist] Could not parse decision, skipping trade`);
          await this.telegram.sendMessage(
            `⚠️ <b>Strategist (${stratResult.model}) PARSE FAILED</b>\n\n` +
            `<b>Trade:</b> ${setup.direction} ${symbol}\n` +
            `<b>Raw:</b> <i>${stratResult.text?.slice(0, 200) || 'empty'}</i>\n` +
            `Trade NOT executed`
          );
          return;
        }

        if (dbForGates) {
          await logGate(dbForGates, {
            gateId: 'strategist_llm',
            asset: signal.asset,
            direction: setup.direction,
            passed: !!decision.execute,
            value: decision.riskScore ?? null,
            threshold: null,
            reason: decision.execute ? null : (decision.reasoning?.slice(0, 100) ?? 'rejected'),
          });
        }

        if (!decision.execute) {
          console.log(`[Strategist] REJECTED: ${decision.reasoning?.slice(0, 100)}`);
          await this.telegram.sendMessage(
            `🧠 <b>Strategist (${stratResult.model}) REJECTED</b>\n\n` +
            `<b>Trade:</b> ${setup.direction} ${symbol}\n` +
            `<b>Reason:</b> <i>${decision.reasoning?.slice(0, 200)}</i>\n` +
            `<b>Risk Score:</b> ${decision.riskScore || '?'}/10`
          );
          return;
        }

        // Apply strategist adjustments
        if (decision?.adjustedSL && decision.adjustedSL > 0) {
          setup.stopLoss = this.exchange.roundPrice(symbol, decision.adjustedSL);
          console.log(`[Strategist] Adjusted SL: $${setup.stopLoss}`);
        }
        if (decision?.adjustedTP && decision.adjustedTP > 0) {
          setup.takeProfit = this.exchange.roundPrice(symbol, decision.adjustedTP);
          console.log(`[Strategist] Adjusted TP: $${setup.takeProfit}`);
        }

        if (decision?.reasoning) {
          console.log(`[Strategist] Approved: ${decision.reasoning.slice(0, 100)}`);
        }

        // Notify
        await this.telegram.sendMessage(
          `🧠 <b>Strategist (${stratResult.model}) APPROVED</b>\n\n` +
          `<b>Trade:</b> ${setup.direction} ${symbol} @ $${currentPrice.toFixed(4)}\n` +
          `<b>SL:</b> $${setup.stopLoss.toFixed(4)} | <b>TP:</b> $${setup.takeProfit.toFixed(4)}\n` +
          `<b>Score:</b> ${composite.score}/100 (S:${composite.breakdown.sentiment} M:${composite.breakdown.momentum} V:${composite.breakdown.volatility} T:${composite.breakdown.trend} R:${composite.breakdown.regime})\n` +
          `<b>Size:</b> ${composite.sizeMultiplier}x | <b>Risk:</b> ${decision?.riskScore || '?'}/10\n` +
          `<b>Reasoning:</b> <i>${decision?.reasoning?.slice(0, 200) || 'N/A'}</i>\n` +
          `⏱ ${stratResult.inferenceMs}ms | FREE (Workers AI)`
        );
      } catch (stratErr) {
        // If strategist fails, DO NOT proceed (fail-closed)
        const errMsg = (stratErr as Error).message?.slice(0, 100) || 'unknown';
        console.warn(`[Strategist] Kimi K2 failed, skipping trade: ${errMsg}`);
        await this.telegram.sendMessage(
          `⚠️ <b>Strategist FAILED</b>\n\n` +
          `<b>Trade:</b> ${setup.direction} ${symbol}\n` +
          `<b>Error:</b> <i>${errMsg}</i>\n` +
          `Trade NOT executed (fail-closed)`
        );
        return;
      }
    }

    console.log(`[Event] Strategist done, proceeding to trade execution for ${symbol}...`);

    // Check position limits
    const account = await this.getAccount();
    const openCount = account.positions.filter(
      (p: any) => parseFloat(p.positionAmt) !== 0
    ).length;

    if (openCount >= this.config.maxPositions) {
      console.log(`[Event] Max positions reached (${openCount}/${this.config.maxPositions})`);
      await this.telegram.sendMessage(
        `⏸ <b>${symbol} ${setup.direction} SKIPPED</b>\n` +
        `Max positions reached (${openCount}/${this.config.maxPositions})`
      );
      return;
    }

    // Check if already have a position on this symbol (Hyperliquid merges same-direction positions)
    const hasPosition = account.positions.some(
      (p: any) => p.symbol === symbol && parseFloat(p.positionAmt) !== 0
    );
    if (hasPosition) {
      console.log(`[Event] Already have position on ${symbol}, skipping`);
      return;
    }

    // Execute trade
    console.log(`[Event] Executing trade: ${setup.direction} ${symbol}, balance: ${account.availableBalance}`);
    const balance = parseFloat(account.availableBalance);
    await this.executeTrade(symbol, setup.direction, currentPrice, setup.stopLoss, setup.takeProfit, balance, 'event-driven', signal, composite.sizeMultiplier, setup.indicators, setup.timeoutHours);
  }

  /**
   * Execute a sentiment-based trade (market-neutral leg).
   */
  private async executeSentimentTrade(
    snap: SentimentSnapshot,
    direction: 'LONG' | 'SHORT',
    balance: number
  ): Promise<void> {
    const symbol = snap.asset + 'USDT';

    // Verify symbol exists on exchange
    if (!this.exchange.isSymbolAvailable(symbol)) {
      console.log(`[MktNeutral] ${symbol} not available on exchange, skipping`);
      return;
    }

    // Check if already have position on this symbol
    const account = await this.getAccount();
    const hasPosition = account.positions.some(
      (p: any) => p.symbol === symbol && parseFloat(p.positionAmt) !== 0
    );
    if (hasPosition) return;

    // Get kline data for quant filter
    const klines = await this.exchange.getKlines(symbol, '1h', 48);
    const highs = klines.map((k: any) => parseFloat(k[2]));
    const lows = klines.map((k: any) => parseFloat(k[3]));
    const closes = klines.map((k: any) => parseFloat(k[4]));
    const volumes = klines.map((k: any) => parseFloat(k[5]));
    const currentPrice = closes[closes.length - 1];

    // Quant filter
    const filter = shouldExecuteSentimentSignal(
      snap, highs, lows, closes, volumes, currentPrice, direction, this.currentRegime
    );

    if (!filter.approved) {
      console.log(`[MktNeutral] ${symbol} ${direction} filtered: ${filter.reason}`);
      return;
    }

    // Build a minimal signal from the snapshot for experience DB
    const syntheticSignal: SentimentSignal = {
      asset: snap.asset,
      sentimentScore: snap.compositeScore,
      confidence: snap.avgConfidence,
      magnitude: snap.avgMagnitude,
      direction: snap.compositeScore > 0 ? 'positive' : 'negative',
      source: 'aggregated',
      category: 'sentiment_aggregate',
      timestamp: snap.timestamp,
    };
    await this.executeTrade(symbol, direction, currentPrice, filter.stopLoss, filter.takeProfit, balance, 'market-neutral', syntheticSignal);
  }

  /**
   * Execute a trade on Binance.
   * Uses dynamic precision from exchangeInfo (loaded at startup).
   */
  private async executeTrade(
    symbol: string,
    direction: 'LONG' | 'SHORT',
    price: number,
    stopLoss: number,
    takeProfit: number,
    balance: number,
    strategy: string,
    signal?: SentimentSignal,
    compositeMultiplier: number = 1.0,
    indicators?: { rsi: number; adx: number; atr: number; volumeRatio: number },
    timeoutHours?: number,
  ): Promise<void> {
    try {
      // Dynamic parameters based on market regime
      const regime = this.currentRegime;
      const effectiveRisk = regime
        ? this.config.riskPerTrade * regime.sizeMultiplier
        : this.config.riskPerTrade;
      const effectiveLeverage = regime
        ? Math.max(1, Math.round(this.config.leverage * regime.leverageMultiplier))
        : this.config.leverage;
      const effectiveMaxPos = regime
        ? regime.maxPositions
        : this.config.maxPositions;

      // Check position limit (regime-aware)
      const account2 = await this.getAccount();
      const currentOpenCount = account2.positions.filter(
        (p: any) => parseFloat(p.positionAmt) !== 0
      ).length;
      if (currentOpenCount >= effectiveMaxPos) {
        console.log(`[Trade] ${symbol} skipped: ${currentOpenCount}/${effectiveMaxPos} positions (regime: ${regime?.regime || 'none'})`);
        return;
      }

      // Position sizing with regime-adjusted risk + composite score scaling
      const adjustedMaxSize = this.config.maxPositionSizeUsdt * compositeMultiplier;
      const posSize = calculatePositionSize(
        balance,
        effectiveRisk * compositeMultiplier,
        price,
        stopLoss,
        effectiveLeverage,
        adjustedMaxSize
      );

      if (posSize <= 0) {
        console.log(`[Trade] ${symbol} size=0, skipping`);
        return;
      }

      console.log(`[Trade] ${symbol} composite size multiplier: ${compositeMultiplier}x → max $${adjustedMaxSize.toFixed(0)}`);

      // Verify symbol exists on exchange
      if (!this.exchange.isSymbolAvailable(symbol)) {
        console.log(`[Trade] ${symbol} not available on exchange, skipping`);
        return;
      }

      const rawQty = posSize / price;
      let quantity = this.exchange.roundQuantity(symbol, rawQty);
      const roundedSL = this.exchange.roundPrice(symbol, stopLoss);
      const roundedTP = this.exchange.roundPrice(symbol, takeProfit);
      const side = direction === 'LONG' ? 'BUY' : 'SELL';

      // Clamp to max quantity allowed by Binance
      const info = this.exchange.getSymbolPrecision(symbol);
      if (info && quantity > info.maxQty) {
        console.log(`[Trade] ${symbol} qty ${quantity} exceeds maxQty ${info.maxQty}, clamping`);
        quantity = info.maxQty;
      }

      // Bump quantity up to minNotional if we're close (within 30%).
      // The rounding-down step often pushes us $0.20-$0.50 below the $10 floor;
      // bumping is safer than skipping a high-conviction trade.
      if (info && quantity * price < info.minNotional) {
        const targetQty = info.minNotional / price;
        // Round UP to next step instead of down. We add one step to guarantee >= minNotional.
        const stepSize = info.stepSize || 0.000001;
        const bumpedQty = Math.ceil(targetQty / stepSize) * stepSize;
        const bumpedNotional = bumpedQty * price;
        const originalNotional = quantity * price;

        // Allow bump if increase is reasonable (<30% over original sizing)
        const bumpRatio = bumpedNotional / Math.max(originalNotional, 0.01);
        if (bumpRatio <= 1.3) {
          console.log(`[Trade] ${symbol} bumping qty ${quantity} → ${bumpedQty} ($${originalNotional.toFixed(2)} → $${bumpedNotional.toFixed(2)}) to meet minNotional`);
          quantity = this.exchange.roundQuantity(symbol, bumpedQty);
          // Sanity re-check after re-rounding (some exchanges use truncation)
          if (quantity * price < info.minNotional) {
            quantity = bumpedQty; // use unrounded bumped value
          }
        } else {
          const msg = `[Trade] ${symbol} notional $${originalNotional.toFixed(2)} below min $${info.minNotional}, bump=${bumpRatio.toFixed(1)}x too aggressive, skipping`;
          console.log(msg);
          await this.telegram.sendMessage(`⏸ <b>${symbol} ${direction} SKIPPED</b>\nNotional $${originalNotional.toFixed(2)} below $${info.minNotional} minimum (bump ${bumpRatio.toFixed(1)}x troppo aggressivo)`);
          return;
        }
      }

      if (quantity <= 0) {
        console.log(`[Trade] ${symbol} quantity rounded to 0, skipping`);
        return;
      }

      // Set leverage (regime-adjusted)
      await this.exchange.setLeverage(symbol, effectiveLeverage);

      // Place MARKET order
      console.log(`[Trade] ${side} ${symbol} qty=${quantity} @ ~$${price.toFixed(4)} lev=${effectiveLeverage}x risk=${effectiveRisk.toFixed(1)}% regime=${regime?.regime || 'none'}`);

      const order = await this.exchange.newOrder({
        symbol,
        side: side as 'BUY' | 'SELL',
        positionSide: direction as 'LONG' | 'SHORT',
        type: 'MARKET',
        quantity,
      });

      console.log(`[Trade] Order filled: ${(order as any).orderId}`);
      this.invalidateAccountCache();

      // Notify Telegram
      await this.telegram.notifyTradeOpen({
        symbol,
        direction,
        entryPrice: price,
        quantity: posSize,
        stopLoss,
        takeProfit,
        leverage: effectiveLeverage,
        strategy,
        reason: `${strategy}: ${direction} ${symbol}`,
      });

      // Try to place algo SL/TP on Binance
      let slPlaced = false;
      let tpPlaced = false;

      try {
        await this.exchange.newAlgoOrder({
          symbol,
          side: (direction === 'LONG' ? 'SELL' : 'BUY') as 'BUY' | 'SELL',
          positionSide: direction as 'LONG' | 'SHORT',
          type: 'STOP_MARKET',
          triggerPrice: roundedSL,
          quantity,
        });
        slPlaced = true;
        console.log(`[Trade] SL placed @ ${roundedSL}`);
      } catch (slErr) {
        const slErrMsg = (slErr as Error).message?.slice(0, 100);
        console.warn(`[Trade] Algo SL failed: ${slErrMsg}`);
        await this.telegram.sendMessage(`⚠️ SL order failed: ${slErrMsg}`);
      }

      try {
        await this.exchange.newAlgoOrder({
          symbol,
          side: (direction === 'LONG' ? 'SELL' : 'BUY') as 'BUY' | 'SELL',
          positionSide: direction as 'LONG' | 'SHORT',
          type: 'TAKE_PROFIT_MARKET',
          triggerPrice: roundedTP,
          closePosition: true,
          quantity,
        });
        tpPlaced = true;
        console.log(`[Trade] TP placed @ ${roundedTP}`);
      } catch (tpErr) {
        const tpErrMsg = (tpErr as Error).message?.slice(0, 100);
        console.warn(`[Trade] Algo TP failed: ${tpErrMsg}`);
        await this.telegram.sendMessage(`⚠️ TP order failed: ${tpErrMsg}`);
      }

      // Save to experience DB
      if (this.experience) {
        try {
          await this.experience.recordTradeOpen({
            symbol,
            direction,
            strategy,
            entryPrice: price,
            quantity,
            leverage: effectiveLeverage,
            stopLoss: roundedSL,
            takeProfit: roundedTP,
            regime: this.currentRegime?.regime,
            fearGreed: this.lastFearGreed,
            sentimentScore: signal?.sentimentScore,
            confidence: signal?.confidence,
            reasoning: signal?.category,
            rsi: indicators?.rsi,
            adx: indicators?.adx,
            atr: indicators?.atr,
            volumeRatio: indicators?.volumeRatio,
          });
          console.log(`[Experience] Trade recorded: ${direction} ${symbol}`);
        } catch (expErr) {
          console.warn(`[Experience] Save failed: ${(expErr as Error).message?.slice(0, 80)}`);
        }
      }

      // Always register soft SL/TP as backup (checked every cron cycle)
      const key = `${symbol}:${direction}`;
      const openedAt = Date.now();
      softOrders.set(key, {
        symbol,
        direction,
        stopLoss: roundedSL,
        takeProfit: roundedTP,
        quantity,
        entryPrice: price,
        strategy,
        openedAt,
        timeoutAt: timeoutHours ? openedAt + timeoutHours * 3600 * 1000 : undefined,
      });
      if (!slPlaced || !tpPlaced) {
        console.log(`[Trade] Software SL/TP registered for ${key} (SL=$${roundedSL}, TP=$${roundedTP})`);
      }
    } catch (err) {
      console.error(`[Trade] Error: ${(err as Error).message}`);
      await this.telegram.notifyError(`Trade error ${symbol}: ${(err as Error).message?.slice(0, 100)}`);
    }
  }

  /**
   * Software SL/TP checker - runs every cron cycle.
   * Closes positions that have hit SL or TP levels via MARKET order.
   * This is a safety net for when Binance algo orders fail.
   * Recovers soft orders from D1 if in-memory map is empty (after deploy/restart).
   */
  async checkSoftOrders(): Promise<void> {
    // Recover soft orders from D1 if in-memory map is empty (lost after deploy/restart)
    if (softOrders.size === 0 && this.experience) {
      const openTrades = await this.experience.getOpenTrades();
      const DEFAULT_TIMEOUT_HOURS = 4; // event-driven default (Sprint 0: 2→4)
      for (const t of openTrades) {
        if (t.stop_loss && t.take_profit) {
          const key = `${t.symbol}:${t.direction}`;
          const openedAt = new Date(t.opened_at).getTime();
          softOrders.set(key, {
            symbol: t.symbol,
            direction: t.direction as 'LONG' | 'SHORT',
            stopLoss: t.stop_loss,
            takeProfit: t.take_profit,
            quantity: t.quantity,
            entryPrice: t.price,
            strategy: t.strategy,
            openedAt,
            timeoutAt: openedAt + DEFAULT_TIMEOUT_HOURS * 3600 * 1000,
          });
        }
      }
      if (openTrades.length > 0) {
        console.log(`[SoftSL/TP] Recovered ${softOrders.size} orders from D1`);
      }
    }

    if (softOrders.size === 0) return;

    console.log(`[SoftSL/TP] Checking ${softOrders.size} orders...`);

    const account = await this.getAccount();
    const openPositions = account.positions.filter(
      (p: any) => parseFloat(p.positionAmt) !== 0
    );

    for (const [key, order] of softOrders) {
      // Check if position still exists
      const pos = openPositions.find((p: any) => {
        const amt = parseFloat(p.positionAmt);
        const side = amt > 0 ? 'LONG' : 'SHORT';
        return p.symbol === order.symbol && side === order.direction;
      });

      if (!pos) {
        // Position was closed externally (algo SL/TP triggered, manual close, etc.).
        // A1.4: query exchange fills to recover the real PnL instead of recording 0.
        let realizedPnl = 0;
        let exitPrice = order.entryPrice;
        try {
          const fills = await this.exchange.getUserTrades(order.symbol, 50);
          // Sum closing fills since openedAt (positionSide matches, opposite side).
          const closeSide = order.direction === 'LONG' ? 'SELL' : 'BUY';
          const relevantFills = fills.filter((f: any) =>
            f.time >= order.openedAt &&
            f.positionSide === order.direction &&
            f.side === closeSide
          );
          if (relevantFills.length > 0) {
            realizedPnl = relevantFills.reduce(
              (sum: number, f: any) => sum + parseFloat(f.realizedPnl || '0') - parseFloat(f.commission || '0'),
              0,
            );
            // Use the volume-weighted exit price for logging accuracy.
            const totalQty = relevantFills.reduce((s: number, f: any) => s + parseFloat(f.qty || '0'), 0);
            const totalNotional = relevantFills.reduce((s: number, f: any) => s + parseFloat(f.qty || '0') * parseFloat(f.price || '0'), 0);
            exitPrice = totalQty > 0 ? totalNotional / totalQty : order.entryPrice;
          }
        } catch (fillErr) {
          console.warn(`[SoftSL/TP] Could not fetch fills for ${order.symbol}: ${(fillErr as Error).message?.slice(0, 80)}`);
        }

        if (this.experience) {
          try {
            await this.experience.recordTradeClose(order.symbol, order.direction, exitPrice, realizedPnl);
            console.log(`[SoftSL/TP] Recorded external close: ${order.symbol} ${order.direction} pnl=$${realizedPnl.toFixed(4)}`);
            // Step 1.1: feed realized PnL into daily risk state for halt accounting.
            const db = this.experience.getDb();
            if (db) await addRealizedPnl(db, realizedPnl);
          } catch (e) {
            console.warn(`[SoftSL/TP] Failed to record close: ${(e as Error).message?.slice(0, 80)}`);
          }
        }

        // Notify Telegram so the close leaves a trace (was previously silent).
        // Infer the close reason: SL hit if exit moved against us, TP hit if in our favor.
        const heldH = (Date.now() - order.openedAt) / 3600000;
        const movedAgainst = order.direction === 'LONG'
          ? exitPrice <= order.stopLoss
          : exitPrice >= order.stopLoss;
        const movedFavor = order.direction === 'LONG'
          ? exitPrice >= order.takeProfit
          : exitPrice <= order.takeProfit;
        const inferredReason = movedAgainst
          ? `Algo SL hit (exchange-side)`
          : movedFavor
            ? `Algo TP hit (exchange-side)`
            : `External close (manual or algo)`;

        await this.telegram.sendMessage(
          `${realizedPnl >= 0 ? '✅' : '🛑'} <b>${order.symbol} ${order.direction} CLOSED</b>\n\n` +
          `<b>Reason:</b> ${inferredReason}\n` +
          `<b>Entry:</b> <code>$${order.entryPrice.toFixed(4)}</code>\n` +
          `<b>Exit:</b> <code>$${exitPrice.toFixed(4)}</code>\n` +
          `<b>P&L:</b> <code>${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)}</code>\n` +
          `<b>Held:</b> ${heldH.toFixed(1)}h\n` +
          `<b>Strategy:</b> ${order.strategy}`
        );

        softOrders.delete(key);
        continue;
      }

      const currentPrice = parseFloat((pos as any).markPrice || pos.entryPrice);
      const pnl = parseFloat(pos.unrealizedProfit);
      let shouldClose = false;
      let reason = '';

      // STEP 1.3 — Emergency funding exit (highest priority).
      // Strips asset prefix from symbol: 'BTCUSDT' -> 'BTC' for Hyperliquid funding lookup.
      // Note: this MUST run even when daily_loss HALT is active — it's an exit, not entry.
      const assetForFunding = order.symbol.endsWith('USDT')
        ? order.symbol.slice(0, -4)
        : order.symbol;
      const emergencyCheck = await this.checkEmergencyFundingExit(assetForFunding, order.direction);
      if (emergencyCheck.exit) {
        shouldClose = true;
        reason = `🚨 EMERGENCY funding (${emergencyCheck.fundingAnnualPct?.toFixed(0)}% APR > threshold)`;
        await this.telegram.sendMessage(
          `🚨 <b>EMERGENCY FUNDING EXIT</b>\n\n` +
          `<b>${order.direction} ${order.symbol}</b>\n` +
          `Funding: <code>${emergencyCheck.fundingAnnualPct?.toFixed(0)}% APR</code>\n` +
          `PnL at exit: <code>${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}</code>\n` +
          `Force-closing now (funding extreme, position economically unsustainable).`
        );
      }

      // Trend-reversal early-exit (Sprint 1 follow-up):
      // If position is in profit AND held >60min AND 2/3 trend signals have flipped, close now.
      // Protects winners from decaying back to break-even at the 4h timeout.
      const heldMin = (Date.now() - order.openedAt) / 60000;
      if (!shouldClose && pnl > 0 && heldMin >= 60) {
        const reversal = await this.checkTrendReversal(order.symbol, order.direction, currentPrice);

        // Telemetry: record every check so we can verify the gate is alive
        reversalChecks.push({
          symbol: order.symbol,
          direction: order.direction,
          pnl,
          heldMin,
          signals: reversal.signals,
          flipped: reversal.flipped,
          ts: Date.now(),
        });
        if (reversalChecks.length > MAX_REVERSAL_HISTORY) reversalChecks.shift();
        console.log(`[TrendReversal] ${order.symbol} ${order.direction} pnl=$${pnl.toFixed(2)} held=${heldMin.toFixed(0)}m signals=${reversal.signals} flipped=${reversal.flipped}`);

        if (reversal.flipped) {
          shouldClose = true;
          reason = `Trend reversal (${reversal.signals}, profit $${pnl.toFixed(2)} locked)`;
          await this.telegram.sendMessage(
            `🔄 <b>Trend Reversal — Early Exit</b>\n\n` +
            `<b>${order.direction} ${order.symbol}</b>\n` +
            `Held: ${heldMin.toFixed(0)} min\n` +
            `Signals flipped: <code>${reversal.signals}</code>\n` +
            `📈 Locked profit: <b>+$${pnl.toFixed(2)}</b>\n` +
            `Closing at market...`
          );
        }
      }

      // Timeout gate (A1.3): force-close after timeoutHours regardless of SL/TP
      if (!shouldClose && order.timeoutAt && Date.now() >= order.timeoutAt) {
        shouldClose = true;
        const heldH = (Date.now() - order.openedAt) / 3600000;
        reason = `Timeout (held ${heldH.toFixed(1)}h, edge decayed)`;
      }

      // SL/TP checks (only if not already closing for trend-reversal or timeout)
      if (!shouldClose) {
        if (order.direction === 'LONG') {
          if (currentPrice <= order.stopLoss) {
            shouldClose = true;
            reason = `SL hit ($${currentPrice.toFixed(4)} <= $${order.stopLoss.toFixed(4)})`;
          } else if (currentPrice >= order.takeProfit) {
            shouldClose = true;
            reason = `TP hit ($${currentPrice.toFixed(4)} >= $${order.takeProfit.toFixed(4)})`;
          }
        } else {
          if (currentPrice >= order.stopLoss) {
            shouldClose = true;
            reason = `SL hit ($${currentPrice.toFixed(4)} >= $${order.stopLoss.toFixed(4)})`;
          } else if (currentPrice <= order.takeProfit) {
            shouldClose = true;
            reason = `TP hit ($${currentPrice.toFixed(4)} <= $${order.takeProfit.toFixed(4)})`;
          }
        }
      }

      if (shouldClose) {
        const closeSide = order.direction === 'LONG' ? 'SELL' : 'BUY';
        const posAmt = Math.abs(parseFloat(pos.positionAmt));

        try {
          await this.exchange.newOrder({
            symbol: order.symbol,
            side: closeSide as 'BUY' | 'SELL',
            positionSide: order.direction as 'LONG' | 'SHORT',
            type: 'MARKET',
            quantity: posAmt,
            reduceOnly: true,
          });

          console.log(`[SoftSL/TP] CLOSED ${order.symbol} ${order.direction}: ${reason} | P&L: $${pnl.toFixed(2)}`);
          this.invalidateAccountCache();

          // Record close in experience DB
          if (this.experience) {
            try {
              await this.experience.recordTradeClose(order.symbol, order.direction, currentPrice, pnl);
              console.log(`[Experience] Trade close recorded: ${order.symbol} P&L=$${pnl.toFixed(2)}`);
              // Step 1.1: feed realized PnL into daily risk state for halt accounting.
              const db = this.experience.getDb();
              if (db) await addRealizedPnl(db, pnl);
            } catch (expErr) {
              console.warn(`[Experience] Close save failed: ${(expErr as Error).message?.slice(0, 80)}`);
            }
          }

          const closeHeldH = (Date.now() - order.openedAt) / 3600000;
          await this.telegram.sendMessage(
            `${pnl >= 0 ? '✅' : '🛑'} <b>${order.symbol} ${order.direction} CLOSED</b>\n\n` +
            `<b>Reason:</b> ${reason}\n` +
            `<b>Entry:</b> <code>$${order.entryPrice.toFixed(4)}</code>\n` +
            `<b>Exit:</b> <code>$${currentPrice.toFixed(4)}</code>\n` +
            `<b>P&L:</b> <code>${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}</code>\n` +
            `<b>Held:</b> ${closeHeldH.toFixed(1)}h\n` +
            `<b>Strategy:</b> ${order.strategy}`
          );

          softOrders.delete(key);
        } catch (err) {
          console.error(`[SoftSL/TP] Failed to close ${order.symbol}: ${(err as Error).message}`);
        }
      }
    }
  }
}
