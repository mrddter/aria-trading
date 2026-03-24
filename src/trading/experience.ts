/**
 * Experience Database
 *
 * Persistent memory for the trading bot.
 * Stores trades, news events, daily snapshots, and learned patterns.
 * Enables the bot to learn from its history and improve over time.
 */

export interface TradeContext {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  strategy: string;
  entryPrice: number;
  quantity: number;
  leverage: number;
  stopLoss?: number;
  takeProfit?: number;
  regime?: string;
  fearGreed?: number;
  btcPrice?: number;
  sentimentScore?: number;
  confidence?: number;
  reasoning?: string;
  rsi?: number;
  adx?: number;
  atr?: number;
  volumeRatio?: number;
}

export interface NewsEventRecord {
  source: string;
  title: string;
  body?: string;
  asset?: string;
  sentimentScore?: number;
  confidence?: number;
  magnitude?: number;
  category?: string;
  impactLevel: 'HIGH' | 'NORMAL';
  publishedAt?: string;
}

export class ExperienceDB {
  constructor(private db: D1Database) {}

  // ---- TRADES ----

  async recordTradeOpen(trade: TradeContext): Promise<number> {
    await this.db
      .prepare(
        `INSERT INTO trades (symbol, side, position_side, type, quantity, price,
        stop_loss, take_profit, status, signal_source, notes,
        regime, fear_greed, btc_price, sentiment_score, confidence,
        reasoning, rsi, adx, atr, volume_ratio, strategy, direction, leverage)
      VALUES (?, ?, ?, 'LIMIT', ?, ?, ?, ?, 'OPEN', 'llm', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        trade.symbol,
        trade.direction === 'LONG' ? 'BUY' : 'SELL',
        trade.direction,
        trade.quantity,
        trade.entryPrice,
        trade.stopLoss || null,
        trade.takeProfit || null,
        trade.reasoning?.slice(0, 500) || null,
        trade.regime || null,
        trade.fearGreed || null,
        trade.btcPrice || null,
        trade.sentimentScore || null,
        trade.confidence || null,
        trade.reasoning?.slice(0, 500) || null,
        trade.rsi || null,
        trade.adx || null,
        trade.atr || null,
        trade.volumeRatio || null,
        trade.strategy || 'live',
        trade.direction,
        trade.leverage
      )
      .run();

    const row = await this.db
      .prepare('SELECT last_insert_rowid() as id')
      .first<{ id: number }>();
    return row?.id || 0;
  }

  async recordTradeClose(
    symbol: string,
    direction: string,
    exitPrice: number,
    pnl: number
  ): Promise<void> {
    const trade = await this.db
      .prepare(
        `SELECT id, price, opened_at FROM trades
      WHERE symbol = ? AND direction = ? AND status = 'OPEN'
      ORDER BY opened_at DESC LIMIT 1`
      )
      .bind(symbol, direction)
      .first<{ id: number; price: number; opened_at: string }>();

    if (!trade) return;

    const holdingHours =
      (Date.now() - new Date(trade.opened_at).getTime()) / (1000 * 60 * 60);

    await this.db
      .prepare(
        `UPDATE trades SET
        pnl = ?, status = 'CLOSED', closed_at = datetime('now'), holding_hours = ?
      WHERE id = ?`
      )
      .bind(pnl, holdingHours, trade.id)
      .run();

    // Learn pattern from this trade
    await this.learnFromTrade(trade.id);
  }

  // ---- NEWS EVENTS ----

  /** Get recent news titles for deduplication across Worker restarts */
  async getRecentNewsTitles(hoursBack: number = 2): Promise<Set<string>> {
    const result = await this.db
      .prepare(
        `SELECT title FROM news_events
        WHERE processed_at > datetime('now', '-' || ? || ' hours')`
      )
      .bind(hoursBack)
      .all<{ title: string }>();
    return new Set((result.results || []).map(r => r.title));
  }

  async recordNewsEvent(event: NewsEventRecord): Promise<number> {
    await this.db
      .prepare(
        `INSERT INTO news_events (source, title, body, asset, sentiment_score, confidence,
        magnitude, category, impact_level, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        event.source,
        event.title,
        event.body?.slice(0, 500) || null,
        event.asset || null,
        event.sentimentScore || null,
        event.confidence || null,
        event.magnitude || null,
        event.category || null,
        event.impactLevel,
        event.publishedAt || null
      )
      .run();

    const row = await this.db
      .prepare('SELECT last_insert_rowid() as id')
      .first<{ id: number }>();
    return row?.id || 0;
  }

  /** Update news with actual price outcome (called by cron job later) */
  async updateNewsOutcomes(): Promise<number> {
    // Find news events from 1h, 4h, 24h ago that need price updates
    const pending = await this.db
      .prepare(
        `SELECT id, asset, sentiment_score, processed_at,
        price_1h_change, price_4h_change, price_24h_change
      FROM news_events
      WHERE asset IS NOT NULL
        AND (price_1h_change IS NULL OR price_4h_change IS NULL)
        AND processed_at > datetime('now', '-25 hours')
      ORDER BY processed_at DESC LIMIT 20`
      )
      .all<{
        id: number;
        asset: string;
        sentiment_score: number;
        processed_at: string;
        price_1h_change: number | null;
        price_4h_change: number | null;
        price_24h_change: number | null;
      }>();

    if (!pending.results?.length) return 0;

    let updated = 0;
    for (const event of pending.results) {
      const ageHours =
        (Date.now() - new Date(event.processed_at).getTime()) / (1000 * 60 * 60);

      // We'll need the caller to pass price data - for now mark as needing update
      // The engine will call updateNewsOutcome() with actual price data
      if (ageHours >= 4 && event.price_4h_change !== null && event.sentiment_score) {
        const wasCorrect =
          (event.sentiment_score > 0 && event.price_4h_change > 0) ||
          (event.sentiment_score < 0 && event.price_4h_change < 0);

        await this.db
          .prepare('UPDATE news_events SET was_correct = ? WHERE id = ?')
          .bind(wasCorrect ? 1 : 0, event.id)
          .run();
        updated++;
      }
    }
    return updated;
  }

  /** Set price change for a specific news event */
  async setNewsPrice(
    newsId: number,
    timeframe: '1h' | '4h' | '24h',
    priceChange: number
  ): Promise<void> {
    const col = `price_${timeframe}_change`;
    await this.db
      .prepare(`UPDATE news_events SET ${col} = ? WHERE id = ?`)
      .bind(priceChange, newsId)
      .run();
  }

  // ---- DAILY SNAPSHOTS ----

  async saveDailySnapshot(snapshot: {
    date: string;
    startingBalance: number;
    endingBalance: number;
    realizedPnl: number;
    unrealizedPnl: number;
    fees: number;
    tradesOpened: number;
    tradesClosed: number;
    wins: number;
    losses: number;
    regime: string;
    fearGreedAvg: number;
    btcChangePercent: number;
    llmCost: number;
    llmCalls: number;
  }): Promise<void> {
    const netPnl = snapshot.realizedPnl - snapshot.fees - snapshot.llmCost;
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO daily_snapshots
        (date, starting_balance, ending_balance, realized_pnl, unrealized_pnl,
         fees, trades_opened, trades_closed, wins, losses,
         regime, fear_greed_avg, btc_change_percent, llm_cost, llm_calls, net_pnl)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        snapshot.date,
        snapshot.startingBalance,
        snapshot.endingBalance,
        snapshot.realizedPnl,
        snapshot.unrealizedPnl,
        snapshot.fees,
        snapshot.tradesOpened,
        snapshot.tradesClosed,
        snapshot.wins,
        snapshot.losses,
        snapshot.regime,
        snapshot.fearGreedAvg,
        snapshot.btcChangePercent,
        snapshot.llmCost,
        snapshot.llmCalls,
        netPnl
      )
      .run();
  }

  // ---- PATTERNS ----

  private async learnFromTrade(tradeId: number): Promise<void> {
    const trade = await this.db
      .prepare(
        `SELECT symbol, direction, pnl, regime, sentiment_score, rsi, strategy
      FROM trades WHERE id = ?`
      )
      .bind(tradeId)
      .first<{
        symbol: string;
        direction: string;
        pnl: number;
        regime: string;
        sentiment_score: number;
        rsi: number;
        strategy: string;
      }>();

    if (!trade || trade.pnl === null) return;

    const asset = trade.symbol.replace('USDT', '');
    const success = trade.pnl > 0;
    const patternName = `${asset}_${trade.direction}_${trade.regime || 'unknown'}`;

    await this.recordOrUpdatePattern({
      name: patternName,
      description: `${trade.direction} ${asset} during ${trade.regime}`,
      asset,
      regime: trade.regime,
      direction: trade.direction,
      success,
      pnlPercent: trade.pnl,
    });
  }

  async recordOrUpdatePattern(pattern: {
    name: string;
    description?: string;
    asset?: string;
    category?: string;
    regime?: string;
    direction?: string;
    success: boolean;
    pnlPercent: number;
  }): Promise<void> {
    const existing = await this.db
      .prepare(
        `SELECT id, occurrences, successes, avg_pnl_percent FROM patterns
      WHERE name = ?`
      )
      .bind(pattern.name)
      .first<{
        id: number;
        occurrences: number;
        successes: number;
        avg_pnl_percent: number;
      }>();

    if (existing) {
      const occ = existing.occurrences + 1;
      const succ = existing.successes + (pattern.success ? 1 : 0);
      const avgPnl =
        (existing.avg_pnl_percent * existing.occurrences + pattern.pnlPercent) / occ;
      await this.db
        .prepare(
          `UPDATE patterns SET
          occurrences = ?, successes = ?, avg_pnl_percent = ?,
          win_rate = CAST(? AS REAL) / ?, last_seen = datetime('now')
        WHERE id = ?`
        )
        .bind(occ, succ, avgPnl, succ, occ, existing.id)
        .run();
    } else {
      await this.db
        .prepare(
          `INSERT INTO patterns (name, description, asset, category, regime, direction,
          occurrences, successes, avg_pnl_percent, win_rate, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, datetime('now'))`
        )
        .bind(
          pattern.name,
          pattern.description || null,
          pattern.asset || null,
          pattern.category || null,
          pattern.regime || null,
          pattern.direction || null,
          pattern.success ? 1 : 0,
          pattern.pnlPercent,
          pattern.success ? 1.0 : 0.0
        )
        .run();
    }
  }

  // ---- CONTEXT QUERIES (for LLM enrichment) ----

  /** Get recent trade history for a symbol to provide context to LLM */
  async getSymbolHistory(symbol: string, limit: number = 5): Promise<string> {
    const trades = await this.db
      .prepare(
        `SELECT direction, price, pnl, regime, sentiment_score, rsi, holding_hours, opened_at
      FROM trades WHERE symbol = ? AND status = 'CLOSED'
      ORDER BY closed_at DESC LIMIT ?`
      )
      .bind(symbol, limit)
      .all<{
        direction: string;
        price: number;
        pnl: number;
        regime: string;
        sentiment_score: number;
        rsi: number;
        holding_hours: number;
        opened_at: string;
      }>();

    if (!trades.results?.length) return `No previous trades on ${symbol}.`;

    let ctx = `Last ${trades.results.length} trades on ${symbol}:\n`;
    for (const t of trades.results) {
      const emoji = (t.pnl || 0) >= 0 ? 'WIN' : 'LOSS';
      ctx += `- ${emoji} ${t.direction} | $${(t.pnl || 0).toFixed(2)} | regime=${t.regime || '?'} | RSI=${t.rsi?.toFixed(0) || '?'} | held ${t.holding_hours?.toFixed(1) || '?'}h\n`;
    }
    return ctx;
  }

  /** Get relevant patterns for a given context */
  async getRelevantPatterns(
    asset: string,
    regime?: string
  ): Promise<string> {
    let query = `SELECT name, direction, occurrences, win_rate, avg_pnl_percent
      FROM patterns WHERE asset = ? AND occurrences >= 3`;
    const params: unknown[] = [asset];

    if (regime) {
      query += ` AND regime = ?`;
      params.push(regime);
    }
    query += ` ORDER BY occurrences DESC LIMIT 5`;

    const patterns = await this.db
      .prepare(query)
      .bind(...params)
      .all<{
        name: string;
        direction: string;
        occurrences: number;
        win_rate: number;
        avg_pnl_percent: number;
      }>();

    if (!patterns.results?.length) return '';

    let ctx = `Known patterns for ${asset}:\n`;
    for (const p of patterns.results) {
      ctx += `- "${p.name}" (${p.direction}): ${p.occurrences} times, WR=${(p.win_rate * 100).toFixed(0)}%, avg=$${p.avg_pnl_percent.toFixed(2)}\n`;
    }
    return ctx;
  }

  /** Get news prediction accuracy for a category */
  async getNewsPredictionAccuracy(
    category: string
  ): Promise<{ total: number; correct: number; accuracy: number }> {
    const result = await this.db
      .prepare(
        `SELECT COUNT(*) as total, SUM(CASE WHEN was_correct = 1 THEN 1 ELSE 0 END) as correct
      FROM news_events WHERE category = ? AND was_correct IS NOT NULL`
      )
      .bind(category)
      .first<{ total: number; correct: number }>();

    const total = result?.total || 0;
    const correct = result?.correct || 0;
    return { total, correct, accuracy: total > 0 ? correct / total : 0 };
  }

  /** Build full LLM context string for enriched prompts */
  async buildLLMContext(
    symbol: string,
    category?: string,
    regime?: string
  ): Promise<string> {
    const [history, patterns] = await Promise.all([
      this.getSymbolHistory(symbol, 5),
      this.getRelevantPatterns(symbol.replace('USDT', ''), regime),
    ]);

    let ctx = '=== HISTORICAL CONTEXT ===\n';
    ctx += history + '\n';
    if (patterns) ctx += patterns + '\n';

    if (category) {
      const acc = await this.getNewsPredictionAccuracy(category);
      if (acc.total > 0) {
        ctx += `LLM accuracy on "${category}" news: ${(acc.accuracy * 100).toFixed(0)}% (${acc.correct}/${acc.total})\n`;
      }
    }

    return ctx;
  }

  /** Get overall stats for /exp Telegram command */
  async getOverallStats(): Promise<string> {
    const [tradeStats, newsStats, patternCount, recentDays] = await Promise.all([
      this.db
        .prepare(
          `SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status='CLOSED' THEN 1 ELSE 0 END) as closed,
          SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses,
          SUM(CASE WHEN status='CLOSED' THEN pnl ELSE 0 END) as total_pnl,
          AVG(CASE WHEN status='CLOSED' THEN holding_hours END) as avg_hold
        FROM trades`
        )
        .first<{
          total: number;
          closed: number;
          wins: number;
          losses: number;
          total_pnl: number;
          avg_hold: number;
        }>(),
      this.db
        .prepare(
          `SELECT COUNT(*) as total,
          SUM(CASE WHEN was_correct IS NOT NULL THEN 1 ELSE 0 END) as evaluated,
          SUM(CASE WHEN was_correct=1 THEN 1 ELSE 0 END) as correct
        FROM news_events`
        )
        .first<{ total: number; evaluated: number; correct: number }>(),
      this.db
        .prepare(
          'SELECT COUNT(*) as count FROM patterns'
        )
        .first<{ count: number }>(),
      this.db
        .prepare(
          `SELECT date, net_pnl, regime, trades_closed, wins, losses
        FROM daily_snapshots ORDER BY date DESC LIMIT 7`
        )
        .all<{
          date: string;
          net_pnl: number;
          regime: string;
          trades_closed: number;
          wins: number;
          losses: number;
        }>(),
    ]);

    let msg = '📚 <b>Experience Database</b>\n\n';

    // Trade stats
    msg += `<b>Trades:</b> ${tradeStats?.total || 0} total (${tradeStats?.closed || 0} closed)\n`;
    if (tradeStats?.closed) {
      const wr = ((tradeStats.wins || 0) / tradeStats.closed) * 100;
      msg += `  WR: ${wr.toFixed(0)}% | P&L: $${(tradeStats.total_pnl || 0).toFixed(2)}\n`;
      msg += `  Avg hold: ${(tradeStats.avg_hold || 0).toFixed(1)}h\n`;
    }

    // News stats
    msg += `\n<b>News analyzed:</b> ${newsStats?.total || 0}\n`;
    if (newsStats?.evaluated) {
      msg += `  Prediction accuracy: ${(((newsStats.correct || 0) / newsStats.evaluated) * 100).toFixed(0)}% (${newsStats.evaluated} evaluated)\n`;
    }

    // Patterns
    msg += `\n<b>Patterns learned:</b> ${patternCount?.count || 0}\n`;

    // Recent days
    if (recentDays.results?.length) {
      msg += '\n<b>Last 7 days:</b>\n';
      for (const d of recentDays.results) {
        const emoji = (d.net_pnl || 0) >= 0 ? '🟩' : '🟥';
        msg += `  ${emoji} ${d.date}: $${(d.net_pnl || 0).toFixed(2)} | ${d.trades_closed || 0} trades | ${d.regime || '?'}\n`;
      }
    }

    return msg;
  }

  /** Get open trades with SL/TP for position display and soft order recovery */
  async getOpenTrades(): Promise<Array<{
    symbol: string;
    direction: string;
    price: number;
    quantity: number;
    stop_loss: number | null;
    take_profit: number | null;
    leverage: number;
    strategy: string;
    opened_at: string;
  }>> {
    const result = await this.db
      .prepare(
        `SELECT symbol, direction, price, quantity, stop_loss, take_profit, leverage, strategy, opened_at
        FROM trades WHERE status = 'OPEN' ORDER BY opened_at DESC`
      )
      .all<{
        symbol: string;
        direction: string;
        price: number;
        quantity: number;
        stop_loss: number | null;
        take_profit: number | null;
        leverage: number;
        strategy: string;
        opened_at: string;
      }>();
    return result.results || [];
  }

  /** Get all trades for performance report */
  async getAllTrades(): Promise<Array<{
    id: number;
    symbol: string;
    direction: string;
    price: number;
    quantity: number;
    pnl: number | null;
    status: string;
    leverage: number;
    strategy: string;
    opened_at: string;
    closed_at: string | null;
  }>> {
    const result = await this.db
      .prepare(
        `SELECT id, symbol, direction, price, quantity, pnl, status, leverage, strategy, opened_at, closed_at
        FROM trades ORDER BY opened_at ASC`
      )
      .all<{
        id: number;
        symbol: string;
        direction: string;
        price: number;
        quantity: number;
        pnl: number | null;
        status: string;
        leverage: number;
        strategy: string;
        opened_at: string;
        closed_at: string | null;
      }>();
    return result.results || [];
  }
}
