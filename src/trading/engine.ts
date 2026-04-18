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
import { processHighImpactItem, processBatch } from '../sentiment/llm-sensor';
import { aggregateSignals, rankBySentiment, selectMarketNeutralLegs } from '../sentiment/aggregator';
import { evaluateEventSignal } from './strategies/event-driven';
import { shouldExecuteSentimentSignal } from './strategies/market-neutral-filter';
import { calculatePositionSize } from './risk';
import { detectRegime, RegimeParams, formatRegimeTelegram } from './regime';
import { ExperienceDB } from './experience';
import { calculateCompositeScore } from './composite-score';
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

/** Get current soft order keys for audit */
export function getSoftOrderKeys(): string[] {
  return [...softOrders.keys()];
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
   * Process a high-impact event through the full pipeline.
   */
  private async processEventDriven(item: RawTextItem): Promise<void> {
    console.log(`[Event] Processing: ${item.text.slice(0, 80)}...`);

    // LLM Sensor: Workers AI gpt-oss-120b → gpt-oss-20b → llama-4-scout (all free).
    const signal = await processHighImpactItem(this.ai, item);

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

    // Get kline data for quant filter
    const klines = await this.exchange.getKlines(symbol, '1h', 48);

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

    if (!composite.approved) {
      console.log(`[Composite] REJECTED: ${composite.reason}`);
      await this.telegram.notifyEvent({
        asset: signal.asset,
        sentiment: signal.sentimentScore,
        magnitude: signal.magnitude,
        headline: item.text.slice(0, 200),
        action: `SKIP: Composite ${composite.score}/100 (min 40)`,
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

        const strategistPrompt = [
          `ASSET: ${symbol} @ $${currentPrice.toFixed(4)}`,
          `SIGNAL: ${setup.direction} | Sentiment: ${signal.sentimentScore.toFixed(2)} | Confidence: ${signal.confidence.toFixed(2)} | Magnitude: ${signal.magnitude.toFixed(2)}`,
          `COMPOSITE SCORE: ${composite.score}/100 (Sentiment:${composite.breakdown.sentiment} Momentum:${composite.breakdown.momentum} Volatility:${composite.breakdown.volatility} Trend:${composite.breakdown.trend} Regime:${composite.breakdown.regime})`,
          `SIZE MULTIPLIER: ${composite.sizeMultiplier}x`,
          `QUANT: ATR=$${setup.atr?.toFixed(4) || '?'}`,
          `REGIME: ${this.currentRegime?.regime || 'UNKNOWN'} (F&G: ${this.currentRegime ? 'active' : 'n/a'})`,
          `NEWS: "${item.text.slice(0, 300)}"`,
          `PROPOSED SL: $${setup.stopLoss.toFixed(4)} | TP: $${setup.takeProfit.toFixed(4)}`,
          historicalContext ? `\n${historicalContext}` : '',
          '',
          'Analyze this trade setup. The composite score already factors momentum, volatility, trend, and regime.',
          'The composite gate has already filtered out anything below 60.',
          'REJECT only if historical context shows a clear losing pattern for this asset/direction/regime, or if the news content contradicts the proposed direction.',
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
1. The setup is technically sound. Approve unless news content contradicts the direction or history shows a clear losing pattern.
2. REJECT if historical context shows repeated losses on this asset/direction/regime (e.g. 0 wins in 3+ trades).
3. REJECT if the news content is actually neutral/ambiguous despite the LLM score (re-read the headline).
4. Do NOT add extra confidence/magnitude thresholds — those are already in the gate.
Respond ONLY with a JSON object: {"execute": true/false, "reasoning": "1-2 sentences", "riskScore": 1-10, "adjustedSL": number_or_null, "adjustedTP": number_or_null}. No other text.`;

        if (!this.ai) throw new Error('No AI binding for strategist');

        const stratResult = await callStrategist(this.ai, {
          prompt: strategistPrompt,
          systemPrompt: strategistSystemPrompt,
          temperature: 0.3,
          maxTokens: 512,
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

      // Check minimum notional
      if (info && quantity * price < info.minNotional) {
        const msg = `[Trade] ${symbol} notional $${(quantity * price).toFixed(2)} below min $${info.minNotional}, skipping`;
        console.log(msg);
        await this.telegram.sendMessage(`⏸ <b>${symbol} ${direction} SKIPPED</b>\nNotional $${(quantity * price).toFixed(2)} below $${info.minNotional} minimum`);
        return;
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
      const DEFAULT_TIMEOUT_HOURS = 2; // event-driven default
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
          } catch (e) {
            console.warn(`[SoftSL/TP] Failed to record close: ${(e as Error).message?.slice(0, 80)}`);
          }
        }
        softOrders.delete(key);
        continue;
      }

      const currentPrice = parseFloat((pos as any).markPrice || pos.entryPrice);
      const pnl = parseFloat(pos.unrealizedProfit);
      let shouldClose = false;
      let reason = '';

      // Timeout gate (A1.3): force-close after timeoutHours regardless of SL/TP
      if (order.timeoutAt && Date.now() >= order.timeoutAt) {
        shouldClose = true;
        const heldH = (Date.now() - order.openedAt) / 3600000;
        reason = `Timeout (held ${heldH.toFixed(1)}h, edge decayed)`;
      } else if (order.direction === 'LONG') {
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
            } catch (expErr) {
              console.warn(`[Experience] Close save failed: ${(expErr as Error).message?.slice(0, 80)}`);
            }
          }

          await this.telegram.sendMessage(
            `${pnl >= 0 ? '✅' : '🛑'} <b>${order.symbol} ${order.direction} CLOSED</b>\n\n` +
            `<b>Reason:</b> ${reason}\n` +
            `<b>Entry:</b> <code>$${order.entryPrice.toFixed(4)}</code>\n` +
            `<b>Exit:</b> <code>$${currentPrice.toFixed(4)}</code>\n` +
            `<b>P&L:</b> <code>${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}</code>\n` +
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
