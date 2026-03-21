/**
 * Live Trading Engine
 *
 * Pipeline: Ingestion → LLM Sensor → Quant Filter → Risk → Order
 *
 * Combines:
 * - Market Neutral Sentiment (hourly rebalancing)
 * - Event-Driven (real-time on high-impact news)
 */

import { BinanceFuturesClient } from '../binance/client';
import { TelegramBot } from '../telegram/bot';
import { collectEvents, classifyImpact } from '../ingestion/collector';
import { processHighImpactItem, processBatch } from '../sentiment/llm-sensor';
import { aggregateSignals, rankBySentiment, selectMarketNeutralLegs } from '../sentiment/aggregator';
import { evaluateEventSignal } from './strategies/event-driven';
import { shouldExecuteSentimentSignal } from './strategies/market-neutral-filter';
import { calculatePositionSize } from './risk';
import { detectRegime, RegimeParams, formatRegimeTelegram } from './regime';
import { ExperienceDB } from './experience';
import { costTracker, extractJson } from '../wavespeed/client';
import { callQwenStrategist } from '../wavespeed/nvidia';
import type { AiBinding } from '../wavespeed/workers-ai';
import type { SentimentSignal, SentimentSnapshot } from '../sentiment/types';
import type { RawTextItem } from '../ingestion/sources';

export interface EngineConfig {
  symbols: string[];
  leverage: number;
  riskPerTrade: number;
  maxPositionSizeUsdt: number;
  maxPositions: number;
  enableEventDriven: boolean;
  enableMarketNeutral: boolean;
  analystModel: string;
  highImpactModel: string;
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
}

// Persisted across cron invocations via module-level variable (same isolate)
const softOrders: Map<string, SoftOrder> = new Map();

export class TradingEngine {
  private binance: BinanceFuturesClient;
  private telegram: TelegramBot;
  private wavespeedKey: string;
  private config: EngineConfig;
  private ai?: AiBinding;
  // NOTE: Worker is stateless - these reset each invocation.
  // For MVP this is fine: we process ALL recent items each cycle.
  // In production, use KV or D1 for persistence.
  private seenIds = new Set<string>();
  private sentimentHistory: SentimentSignal[] = [];
  private currentRegime: RegimeParams | null = null;
  private lastFearGreed: number = 50;
  private firstRun = true;
  private experience?: ExperienceDB;
  private nvidiaKey?: string;

  constructor(
    binance: BinanceFuturesClient,
    telegram: TelegramBot,
    wavespeedKey: string,
    config: EngineConfig,
    ai?: AiBinding,
    db?: D1Database,
    nvidiaKey?: string
  ) {
    this.binance = binance;
    this.telegram = telegram;
    this.wavespeedKey = wavespeedKey;
    this.config = config;
    this.ai = ai;
    if (db) this.experience = new ExperienceDB(db);
    this.nvidiaKey = nvidiaKey;
  }

  /**
   * Main cycle - called by cron every 2 minutes.
   * 1. Collect news events
   * 2. Process through LLM sensor
   * 3. Event-driven: trade on high-impact news immediately
   * 4. Accumulate sentiment for market-neutral rebalancing
   */
  async runCycle(): Promise<void> {
    console.log(`[Engine] Cycle start: ${new Date().toISOString()}`);

    // Load exchange info for dynamic precision (cached after first call)
    await this.binance.loadExchangeInfo();

    try {
      // 1. Collect events (on stateless Worker, always process fresh)
      const { newItems, fearGreed } = await collectEvents(
        this.seenIds,
        60 * 60 * 1000 // 1 hour lookback
      );
      this.lastFearGreed = fearGreed.value;
      console.log(`[Engine] Collected ${newItems.length} new items, F&G: ${fearGreed.value}`);

      // Detect market regime
      try {
        const btcTicker = await this.binance.publicGet('/fapi/v1/ticker/24hr', { symbol: 'BTCUSDT' }) as { priceChangePercent?: string };
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

      // 3. Event-Driven: process high-impact items with Sonnet 4.5
      if (this.config.enableEventDriven && highImpact.length > 0) {
        for (const item of highImpact.slice(0, 3)) { // Max 3 per cycle
          await this.processEventDriven(item);
        }
      }

      // 4. Process normal items - Llama 4 Scout (free) if available, else Haiku 4.5
      if (normalItems.length > 0) {
        const signals = await processBatch(
          this.wavespeedKey,
          normalItems.slice(0, 15), // Max 15 per cycle for cost control
          this.config.analystModel,
          this.ai // Pass Workers AI binding (Llama 4 Scout) if available
        );
        this.sentimentHistory.push(...signals);
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

    await this.binance.loadExchangeInfo();

    try {
      // Get current account state
      const account = await this.binance.getAccountInfo();
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

    // LLM Sensor: Qwen 3.5 (NVIDIA, free) → fallback WaveSpeed Haiku 4.5
    const signal = await processHighImpactItem(
      this.wavespeedKey,
      item,
      this.config.highImpactModel,
      this.nvidiaKey
    );

    if (!signal) {
      console.log('[Event] LLM returned no signal');
      return;
    }

    this.sentimentHistory.push(signal);

    // MARKET signals are for general sentiment, not tradeable
    if (signal.asset === 'MARKET') {
      console.log('[Event] General market signal, added to sentiment history only');
      return;
    }

    const symbol = signal.asset + 'USDT';

    // Check if symbol exists on Binance (dynamic, from exchangeInfo)
    if (!this.binance.isSymbolAvailable(symbol)) {
      console.log(`[Event] ${symbol} not available on Binance, skipping trade`);
      return;
    }

    // Get kline data for quant filter
    const klines = await this.binance.getKlines(symbol, '1h', 48);
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

    // ---- QWEN 3.5 STRATEGIST (Chain-of-Thought reasoning) ----
    if (this.nvidiaKey) {
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
          `QUANT: ATR=$${setup.atr?.toFixed(4) || '?'}`,
          `REGIME: ${this.currentRegime?.regime || 'UNKNOWN'} (F&G: ${this.currentRegime ? 'active' : 'n/a'})`,
          `NEWS: "${item.text.slice(0, 300)}"`,
          `PROPOSED SL: $${setup.stopLoss.toFixed(4)} | TP: $${setup.takeProfit.toFixed(4)}`,
          historicalContext ? `\n${historicalContext}` : '',
          '',
          'Analyze this trade setup. Should we execute? If yes, suggest adjustments to SL/TP if needed.',
          'Respond with JSON: {"execute": true/false, "reasoning": "...", "adjustedSL": number|null, "adjustedTP": number|null, "riskScore": 1-10}',
        ].join('\n');

        console.log(`[Strategist] Calling Qwen3.5 for ${symbol} ${setup.direction}...`);

        const strategistResult = await callQwenStrategist(this.nvidiaKey, {
          prompt: strategistPrompt,
          systemPrompt: `You are an expert crypto trading strategist. Analyze the trade setup and decide whether to execute. Be conservative - only approve trades with clear edge. IMPORTANT: Your response MUST be a JSON object with these fields: {"execute": true/false, "reasoning": "1-2 sentences why", "riskScore": 1-10, "adjustedSL": number_or_null, "adjustedTP": number_or_null}. Keep thinking brief.`,
          temperature: 0.3,
          maxTokens: 4096,
          enableThinking: true,
        });

        console.log(`[Strategist] Qwen3.5 responded in ${strategistResult.inferenceMs}ms, cost: $${strategistResult.estimatedCost.toFixed(4)}`);
        console.log(`[Strategist] Raw text: ${strategistResult.text?.slice(0, 300)}`);

        // Parse strategist decision
        const decision = extractJson(strategistResult.text) as {
          execute?: boolean;
          reasoning?: string;
          reason?: string;      // Qwen sometimes uses "reason" instead of "reasoning"
          adjustedSL?: number;
          adjusted_sl?: number; // snake_case variant
          adjustedTP?: number;
          adjusted_tp?: number;
          riskScore?: number;
          risk_score?: number;  // snake_case variant
          risk?: number;        // short variant
        } | null;

        // Normalize field names (Qwen3.5 sometimes uses different casing/names)
        if (decision) {
          if (!decision.reasoning && decision.reason) decision.reasoning = decision.reason;
          if (!decision.riskScore && decision.risk_score) decision.riskScore = decision.risk_score;
          if (!decision.riskScore && decision.risk) decision.riskScore = decision.risk;
          if (!decision.adjustedSL && decision.adjusted_sl) decision.adjustedSL = decision.adjusted_sl;
          if (!decision.adjustedTP && decision.adjusted_tp) decision.adjustedTP = decision.adjusted_tp;
        }

        if (decision && !decision.execute) {
          console.log(`[Strategist] REJECTED: ${decision.reasoning?.slice(0, 100)}`);
          await this.telegram.sendMessage(
            `🧠 <b>Strategist (Qwen3.5) REJECTED</b>\n\n` +
            `<b>Trade:</b> ${setup.direction} ${symbol}\n` +
            `<b>Reason:</b> <i>${decision.reasoning?.slice(0, 200)}</i>\n` +
            `<b>Risk Score:</b> ${decision.riskScore || '?'}/10`
          );
          return;
        }

        // Apply strategist adjustments
        if (decision?.adjustedSL && decision.adjustedSL > 0) {
          setup.stopLoss = this.binance.roundPrice(symbol, decision.adjustedSL);
          console.log(`[Strategist] Adjusted SL: $${setup.stopLoss}`);
        }
        if (decision?.adjustedTP && decision.adjustedTP > 0) {
          setup.takeProfit = this.binance.roundPrice(symbol, decision.adjustedTP);
          console.log(`[Strategist] Adjusted TP: $${setup.takeProfit}`);
        }

        if (decision?.reasoning) {
          console.log(`[Strategist] Approved: ${decision.reasoning.slice(0, 100)}`);
        }

        // Notify with thinking trace
        await this.telegram.sendMessage(
          `🧠 <b>Strategist (Qwen3.5) APPROVED</b>\n\n` +
          `<b>Trade:</b> ${setup.direction} ${symbol} @ $${currentPrice.toFixed(4)}\n` +
          `<b>SL:</b> $${setup.stopLoss.toFixed(4)} | <b>TP:</b> $${setup.takeProfit.toFixed(4)}\n` +
          `<b>Risk:</b> ${decision?.riskScore || '?'}/10\n` +
          `<b>Reasoning:</b> <i>${decision?.reasoning?.slice(0, 200) || 'N/A'}</i>\n` +
          (strategistResult.thinkingText ? `\n💭 <b>Thinking:</b> <i>${strategistResult.thinkingText.slice(0, 300)}...</i>` : '') +
          `\n⏱ ${strategistResult.inferenceMs}ms | FREE (NVIDIA)`
        );
      } catch (stratErr) {
        // If strategist fails, proceed with original setup (fail-open)
        console.warn(`[Strategist] Qwen3.5 failed, proceeding with original: ${(stratErr as Error).message?.slice(0, 80)}`);
      }
    }

    // Check position limits
    const account = await this.binance.getAccountInfo();
    const openCount = account.positions.filter(
      (p: any) => parseFloat(p.positionAmt) !== 0
    ).length;

    if (openCount >= this.config.maxPositions) {
      console.log('[Event] Max positions reached');
      return;
    }

    // Execute trade
    const balance = parseFloat(account.availableBalance);
    await this.executeTrade(symbol, setup.direction, currentPrice, setup.stopLoss, setup.takeProfit, balance, 'event-driven');
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
    if (!this.binance.isSymbolAvailable(symbol)) {
      console.log(`[MktNeutral] ${symbol} not available on exchange, skipping`);
      return;
    }

    // Check if already have position on this symbol
    const account = await this.binance.getAccountInfo();
    const hasPosition = account.positions.some(
      (p: any) => p.symbol === symbol && parseFloat(p.positionAmt) !== 0
    );
    if (hasPosition) return;

    // Get kline data for quant filter
    const klines = await this.binance.getKlines(symbol, '1h', 48);
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

    await this.executeTrade(symbol, direction, currentPrice, filter.stopLoss, filter.takeProfit, balance, 'market-neutral');
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
    strategy: string
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
      const account2 = await this.binance.getAccountInfo();
      const currentOpenCount = account2.positions.filter(
        (p: any) => parseFloat(p.positionAmt) !== 0
      ).length;
      if (currentOpenCount >= effectiveMaxPos) {
        console.log(`[Trade] ${symbol} skipped: ${currentOpenCount}/${effectiveMaxPos} positions (regime: ${regime?.regime || 'none'})`);
        return;
      }

      // Position sizing with regime-adjusted risk
      const posSize = calculatePositionSize(
        balance,
        effectiveRisk,
        price,
        stopLoss,
        effectiveLeverage,
        this.config.maxPositionSizeUsdt
      );

      if (posSize <= 0) {
        console.log(`[Trade] ${symbol} size=0, skipping`);
        return;
      }

      // Verify symbol exists on exchange
      if (!this.binance.isSymbolAvailable(symbol)) {
        console.log(`[Trade] ${symbol} not available on exchange, skipping`);
        return;
      }

      const rawQty = posSize / price;
      let quantity = this.binance.roundQuantity(symbol, rawQty);
      const roundedSL = this.binance.roundPrice(symbol, stopLoss);
      const roundedTP = this.binance.roundPrice(symbol, takeProfit);
      const side = direction === 'LONG' ? 'BUY' : 'SELL';

      // Check minimum notional
      const info = this.binance.getSymbolPrecision(symbol);
      if (info && quantity * price < info.minNotional) {
        console.log(`[Trade] ${symbol} notional $${(quantity * price).toFixed(2)} below min $${info.minNotional}, skipping`);
        return;
      }

      if (quantity <= 0) {
        console.log(`[Trade] ${symbol} quantity rounded to 0, skipping`);
        return;
      }

      // Set leverage (regime-adjusted)
      await this.binance.setLeverage(symbol, effectiveLeverage);

      // Place MARKET order
      console.log(`[Trade] ${side} ${symbol} qty=${quantity} @ ~$${price.toFixed(4)} lev=${effectiveLeverage}x risk=${effectiveRisk.toFixed(1)}% regime=${regime?.regime || 'none'}`);

      const order = await this.binance.newOrder({
        symbol,
        side: side as 'BUY' | 'SELL',
        positionSide: direction as 'LONG' | 'SHORT',
        type: 'MARKET',
        quantity,
      });

      console.log(`[Trade] Order filled: ${(order as any).orderId}`);

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
        await this.binance.newAlgoOrder({
          symbol,
          side: (direction === 'LONG' ? 'SELL' : 'BUY') as 'BUY' | 'SELL',
          positionSide: direction as 'LONG' | 'SHORT',
          type: 'STOP_MARKET',
          triggerPrice: roundedSL,
          closePosition: true,
        });
        slPlaced = true;
        console.log(`[Trade] SL placed on Binance @ ${roundedSL}`);
      } catch (slErr) {
        console.warn(`[Trade] Algo SL failed: ${(slErr as Error).message?.slice(0, 80)}`);
      }

      try {
        await this.binance.newAlgoOrder({
          symbol,
          side: (direction === 'LONG' ? 'SELL' : 'BUY') as 'BUY' | 'SELL',
          positionSide: direction as 'LONG' | 'SHORT',
          type: 'TAKE_PROFIT_MARKET',
          triggerPrice: roundedTP,
          closePosition: true,
        });
        tpPlaced = true;
        console.log(`[Trade] TP placed on Binance @ ${roundedTP}`);
      } catch (tpErr) {
        console.warn(`[Trade] Algo TP failed: ${(tpErr as Error).message?.slice(0, 80)}`);
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
          });
          console.log(`[Experience] Trade recorded: ${direction} ${symbol}`);
        } catch (expErr) {
          console.warn(`[Experience] Save failed: ${(expErr as Error).message?.slice(0, 80)}`);
        }
      }

      // Always register soft SL/TP as backup (checked every cron cycle)
      const key = `${symbol}:${direction}`;
      softOrders.set(key, {
        symbol,
        direction,
        stopLoss: roundedSL,
        takeProfit: roundedTP,
        quantity,
        entryPrice: price,
        strategy,
        openedAt: Date.now(),
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
   */
  async checkSoftOrders(): Promise<void> {
    if (softOrders.size === 0) return;

    console.log(`[SoftSL/TP] Checking ${softOrders.size} orders...`);

    const account = await this.binance.getAccountInfo();
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
        // Position was closed (by Binance algo order or rebalance)
        softOrders.delete(key);
        continue;
      }

      const currentPrice = parseFloat((pos as any).markPrice || pos.entryPrice);
      const pnl = parseFloat(pos.unrealizedProfit);
      let shouldClose = false;
      let reason = '';

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

      if (shouldClose) {
        const closeSide = order.direction === 'LONG' ? 'SELL' : 'BUY';
        const posAmt = Math.abs(parseFloat(pos.positionAmt));

        try {
          await this.binance.newOrder({
            symbol: order.symbol,
            side: closeSide as 'BUY' | 'SELL',
            positionSide: order.direction as 'LONG' | 'SHORT',
            type: 'MARKET',
            quantity: posAmt,
          });

          console.log(`[SoftSL/TP] CLOSED ${order.symbol} ${order.direction}: ${reason} | P&L: $${pnl.toFixed(2)}`);

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
