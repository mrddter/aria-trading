/**
 * Binance Trading Bot - Cloudflare Worker Entry Point
 *
 * Cron triggers:
 * - Every 5 min: collect news, process through LLM, event-driven trades
 * - 23:05 UTC daily: persist daily_snapshots row
 */

import { Hono } from 'hono';
import { TelegramBot, TelegramUpdate } from './telegram/bot';
import { TradingEngine, EngineConfig, getSoftOrderKeys } from './trading/engine';
import { runAudit, formatAuditTelegram, formatAuditAlert } from './trading/audit';
import { createExchange } from './exchange/factory';
import type { IExchange } from './exchange/types';
import { generateReport, formatReportTelegram, formatReportCompact, TradeRecord } from './trading/performance';
import { costTracker, loadCosts, flushCosts, formatCostsTelegram } from './wavespeed/client';
import type { AiBinding } from './wavespeed/workers-ai';
import { ExperienceDB } from './trading/experience';

type Bindings = {
  EXCHANGE?: string;
  BINANCE_API_KEY: string;
  BINANCE_API_SECRET: string;
  HL_PRIVATE_KEY?: string;
  HL_WALLET_ADDRESS?: string;
  HL_VAULT_ADDRESS?: string;
  HL_TESTNET?: string;
  WAVESPEED_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  ENVIRONMENT: string;
  BOT_ACTIVE: string;
  AI?: AiBinding;
  NVIDIA_API_KEY?: string;
  COSTS: KVNamespace;
  DB: D1Database;
};

const app = new Hono<{ Bindings: Bindings }>();

function getStartingBalance(env: { EXCHANGE?: string }): number {
  return (env.EXCHANGE || 'binance').toLowerCase() === 'hyperliquid' ? 61.54 : 5000;
}

// Health check
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    environment: c.env.ENVIRONMENT,
    timestamp: new Date().toISOString(),
  });
});

// Account info (for debugging)
app.get('/account', async (c) => {
  const exchange = createExchange(c.env);
  try {
    // Direct spot test for debugging
    if (c.env.EXCHANGE === 'hyperliquid' && c.env.HL_WALLET_ADDRESS) {
      const spotRes = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'spotClearinghouseState', user: c.env.HL_WALLET_ADDRESS }),
      });
      const spotData = await spotRes.json() as any;
      console.log(`[Debug] Direct spot fetch: ${JSON.stringify(spotData).slice(0, 300)}`);
    }
    const account = await exchange.getAccountInfo();
    const positions = account.positions.filter(
      (p: any) => parseFloat(p.positionAmt) !== 0
    );
    return c.json({
      exchange: c.env.EXCHANGE || 'binance',
      walletAddress: c.env.HL_WALLET_ADDRESS || 'not set',
      balance: account.totalWalletBalance,
      unrealizedPnl: account.totalUnrealizedProfit,
      available: account.availableBalance,
      openPositions: positions.length,
      positions: positions.map((p: any) => ({
        symbol: p.symbol,
        side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
        size: p.positionAmt,
        entry: p.entryPrice,
        pnl: (p as any).unRealizedProfit || (p as any).unrealizedProfit,
        leverage: p.leverage,
      })),
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// Telegram webhook handler - interactive commands
app.post('/webhook/telegram/:secret', async (c) => {
  const secret = c.req.param('secret');

  // Validate secret matches the bot token (prevents abuse)
  if (secret !== c.env.TELEGRAM_BOT_TOKEN) {
    return c.json({ error: 'Unauthorized' }, 403);
  }

  const telegram = new TelegramBot(c.env.TELEGRAM_BOT_TOKEN, c.env.TELEGRAM_CHAT_ID);

  let update: TelegramUpdate;
  try {
    update = await c.req.json<TelegramUpdate>();
  } catch {
    return c.json({ error: 'Invalid payload' }, 400);
  }

  const command = await telegram.handleUpdate(update, c.env.TELEGRAM_CHAT_ID);
  if (!command) {
    return c.json({ ok: true }); // Ignore unauthorized or empty messages
  }

  try {
    switch (command) {
      case '/status': {
        const binance = createExchange(c.env);
        const account = await binance.getAccountInfo();
        const positions = account.positions.filter(
          (p: any) => parseFloat(p.positionAmt) !== 0
        );
        const exchangeName = (c.env.EXCHANGE || 'binance').toUpperCase();
        const msg =
          `🤖 <b>Bot Status</b>\n\n` +
          `<b>Exchange:</b> <code>${exchangeName}</code>\n` +
          `<b>Balance:</b> <code>$${parseFloat(account.totalWalletBalance).toFixed(2)}</code>\n` +
          `<b>Unrealized:</b> <code>$${parseFloat(account.totalUnrealizedProfit).toFixed(2)}</code>\n` +
          `<b>Available:</b> <code>$${parseFloat(account.availableBalance).toFixed(2)}</code>\n` +
          `<b>Positions:</b> ${positions.length}\n` +
          `<b>Bot Active:</b> ${c.env.BOT_ACTIVE === 'true' ? '✅' : '❌'}`;
        await telegram.sendMessage(msg);
        break;
      }

      case '/positions':
      case '/pos': {
        const binance = createExchange(c.env);
        const positions = await binance.getPositionRisk();

        if (positions.length === 0) {
          await telegram.sendMessage('📊 <b>No open positions</b>');
          break;
        }

        // Load open trades from D1 for SL/TP/leverage data
        // Use most recent trade per symbol:direction (has best data after fixes)
        const experience = c.env.DB ? new ExperienceDB(c.env.DB) : null;
        const openTrades = experience ? await experience.getOpenTrades() : [];
        const tradeMap = new Map<string, (typeof openTrades)[number]>();
        for (const t of openTrades) {
          const key = `${t.symbol}:${t.direction}`;
          const existing = tradeMap.get(key);
          // Prefer trade with SL/TP, or most recent
          if (!existing || (t.stop_loss && !existing.stop_loss)) {
            tradeMap.set(key, t);
          }
        }

        let totalPnl = 0;
        let msg = `📊 <b>Open Positions (${positions.length})</b>\n\n`;
        for (const p of positions) {
          const amt = parseFloat(p.positionAmt);
          const direction = amt > 0 ? 'LONG' : 'SHORT';
          const side = amt > 0 ? '🟢 LONG' : '🔴 SHORT';
          const pnl = parseFloat((p as any).unRealizedProfit || (p as any).unrealizedProfit || '0');
          const entry = parseFloat(p.entryPrice);
          const mark = parseFloat(p.markPrice);
          const decimals = entry >= 100 ? 2 : entry >= 1 ? 4 : 6;

          // Get SL/TP/leverage from D1 or Binance (v3 may use 'initialLeverage')
          const trade = tradeMap.get(`${p.symbol}:${direction}`);
          const lev = p.leverage || (p as any).initialLeverage || trade?.leverage || '?';
          const sl = trade?.stop_loss;
          const tp = trade?.take_profit;

          const pnlPct = entry > 0 ? ((mark - entry) / entry * 100 * (amt > 0 ? 1 : -1)) : 0;
          const pnlEmoji = pnl >= 0 ? '📈' : '📉';
          totalPnl += pnl;

          msg += `${side} <b>${p.symbol}</b> (${lev}x)\n`;
          msg += `  Entry: <code>$${entry.toFixed(decimals)}</code> → <code>$${mark.toFixed(decimals)}</code>\n`;
          msg += `  Size: <code>${Math.abs(amt)}</code>\n`;

          // Show SL/TP with distance
          if (sl || tp) {
            let slTpLine = '  ';
            if (sl) {
              const slDist = ((mark - sl) / mark * 100 * (amt > 0 ? 1 : -1));
              slTpLine += `SL: <code>$${sl.toFixed(decimals)}</code> (${slDist.toFixed(1)}%)`;
            }
            if (sl && tp) slTpLine += ' | ';
            if (tp) {
              const tpDist = ((tp - mark) / mark * 100 * (amt > 0 ? 1 : -1));
              slTpLine += `TP: <code>$${tp.toFixed(decimals)}</code> (${tpDist.toFixed(1)}%)`;
            }
            msg += slTpLine + '\n';
          }

          msg += `  ${pnlEmoji} P&L: <code>${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)</code>\n\n`;
        }
        msg += `<b>Totale P&L: <code>${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}</code></b>`;
        await telegram.sendMessage(msg);
        break;
      }

      case '/performance':
      case '/perf': {
        const binance = createExchange(c.env);
        const account = await binance.getAccountInfo();
        const positions = account.positions.filter(
          (p: any) => parseFloat(p.positionAmt) !== 0
        );

        // Build trade list from D1 (primary) + Binance fills for fee data
        const expDb = c.env.DB ? new ExperienceDB(c.env.DB) : null;

        // Get all traded symbols from D1 to ensure we fetch their Binance fills too
        const allDbTrades = expDb ? await expDb.getAllTrades() : [];
        const dbSymbols = new Set(allDbTrades.map(t => t.symbol));

        // Fetch fills from Binance for all known symbols
        const activeSymbols = new Set<string>();
        for (const p of positions) {
          if (parseFloat((p as any).positionAmt || '0') !== 0) activeSymbols.add((p as any).symbol);
        }
        for (const s of dbSymbols) activeSymbols.add(s);
        // Common symbols as fallback
        for (const s of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) activeSymbols.add(s);

        let totalFeesBySymbol = new Map<string, number>();
        for (const sym of activeSymbols) {
          try {
            const fills = await binance.getUserTrades(sym, 500);
            const fee = fills.reduce((sum: number, f: any) => sum + parseFloat(f.commission || '0'), 0);
            totalFeesBySymbol.set(sym, fee);
          } catch { /* symbol might not have trades */ }
        }

        // Build TradeRecords from D1 (individual trades, not grouped fills)
        const trades: TradeRecord[] = allDbTrades.map(t => {
          const isOpen = t.status === 'OPEN';
          return {
            id: `${t.symbol}-${t.direction}-${t.id}`,
            symbol: t.symbol,
            direction: t.direction as 'LONG' | 'SHORT',
            entryPrice: t.price,
            exitPrice: isOpen ? undefined : t.price, // approx
            quantity: t.quantity,
            leverage: t.leverage || 3,
            strategy: t.strategy || 'live',
            pnl: isOpen ? undefined : (t.pnl || 0),
            fee: 0, // fees tracked at symbol level
            status: isOpen ? 'OPEN' : 'CLOSED',
            openedAt: new Date(t.opened_at).getTime(),
            closedAt: t.closed_at ? new Date(t.closed_at).getTime() : undefined,
          };
        });

        // Distribute fees proportionally across trades per symbol
        const tradesBySymbol = new Map<string, TradeRecord[]>();
        for (const t of trades) {
          const list = tradesBySymbol.get(t.symbol) || [];
          list.push(t);
          tradesBySymbol.set(t.symbol, list);
        }
        for (const [sym, symTrades] of tradesBySymbol) {
          const totalFee = totalFeesBySymbol.get(sym) || 0;
          const perTrade = symTrades.length > 0 ? totalFee / symTrades.length : 0;
          for (const t of symTrades) t.fee = perTrade;
        }

        const startingBalance = getStartingBalance(c.env);
        const currentBalance = parseFloat(account.totalWalletBalance);
        const unrealizedPnl = parseFloat(account.totalUnrealizedProfit);

        const report = generateReport(trades, startingBalance, currentBalance, unrealizedPnl);
        await telegram.sendMessage(formatReportTelegram(report));
        break;
      }

      case '/costs': {
        const binance = createExchange(c.env);
        const account = await binance.getAccountInfo();
        const realizedPnl = parseFloat(account.totalWalletBalance) - getStartingBalance(c.env);
        const unrealizedPnl = parseFloat(account.totalUnrealizedProfit);
        const totalPnl = realizedPnl + unrealizedPnl;

        // Load persistent costs from KV
        const costs = c.env.COSTS ? await loadCosts(c.env.COSTS) : null;
        if (costs) {
          const msg = formatCostsTelegram(costs, realizedPnl, unrealizedPnl);
          await telegram.sendMessage(msg);
        } else {
          await telegram.sendMessage('⚠️ KV COSTS non configurato. I costi non sono ancora tracciati.');
        }
        break;
      }

      case '/audit': {
        const binance = createExchange(c.env);
        await binance.loadExchangeInfo();
        if (!c.env.DB) {
          await telegram.sendMessage('⚠️ D1 not configured.');
          break;
        }
        const expDb = new ExperienceDB(c.env.DB);
        const report = await runAudit(binance, expDb, getSoftOrderKeys(), getStartingBalance(c.env));
        await telegram.sendMessage(formatAuditTelegram(report));
        break;
      }

      case '/closeold': {
        // One-time command: close old positions without SL/TP and clean D1
        const binance = createExchange(c.env);

        const toClose = [
          { symbol: 'PENDLEUSDT', side: 'BUY' as const, positionSide: 'SHORT' as const, qty: 411 },
          { symbol: 'TAOUSDT', side: 'SELL' as const, positionSide: 'LONG' as const, qty: 1.835 },
          { symbol: 'PAXGUSDT', side: 'BUY' as const, positionSide: 'SHORT' as const, qty: 0.107 },
        ];

        let closeMsg = '🧹 <b>Closing old positions...</b>\n\n';
        for (const p of toClose) {
          try {
            await binance.newOrder({
              symbol: p.symbol,
              side: p.side,
              positionSide: p.positionSide,
              type: 'MARKET',
              quantity: p.qty,
            });
            closeMsg += `✅ ${p.positionSide} ${p.symbol} — closed\n`;
          } catch (e) {
            closeMsg += `❌ ${p.positionSide} ${p.symbol} — ${(e as Error).message?.slice(0, 80)}\n`;
          }
        }

        // Clean D1: mark orphan trades as CLOSED
        if (c.env.DB) {
          const db = c.env.DB;
          const orphanIds = [14, 15, 16, 17, 18]; // HYPE, PAXG, SOL, old BTC, HBAR
          // Also close PENDLE and TAO (not in D1 but the Binance positions)
          for (const id of orphanIds) {
            await db.prepare(
              `UPDATE trades SET status = 'CLOSED', closed_at = datetime('now'), pnl = 0 WHERE id = ? AND status = 'OPEN'`
            ).bind(id).run();
          }
          closeMsg += `\n🗃 D1: marked ${orphanIds.length} orphan trades as CLOSED`;
        }

        await telegram.sendMessage(closeMsg);
        break;
      }

      case '/stop': {
        await telegram.sendMessage(
          '⚠️ Runtime toggle is not supported. Use the Cloudflare dashboard to set <code>BOT_ACTIVE=false</code>.'
        );
        break;
      }

      case '/experience':
      case '/exp': {
        if (c.env.DB) {
          const expDb = new ExperienceDB(c.env.DB);
          const stats = await expDb.getOverallStats();
          await telegram.sendMessage(stats);
        } else {
          await telegram.sendMessage('⚠️ Experience DB not configured.');
        }
        break;
      }

      case '/help': {
        const msg =
          `🤖 <b>Trading Bot Commands</b>\n\n` +
          `/status - Account balance & status\n` +
          `/pos - Open positions\n` +
          `/perf - Performance report\n` +
          `/costs - Costi LLM & P&L netto\n` +
          `/exp - Experience database stats\n` +
          `/audit - System health check\n` +
          `/stop - Stop info\n` +
          `/help - This message`;
        await telegram.sendMessage(msg);
        break;
      }

      default: {
        await telegram.sendMessage(
          `Unknown command: <code>${command}</code>\nSend /help for available commands.`
        );
      }
    }
  } catch (err) {
    await telegram.sendMessage(`⚠️ Command error: <code>${(err as Error).message?.slice(0, 200)}</code>`);
  }

  return c.json({ ok: true });
});

// Setup info route - shows the webhook URL to configure
app.get('/webhook/telegram/setup', (c) => {
  const webhookUrl = `https://binance-trading-bot.vividoai.workers.dev/webhook/telegram/${c.env.TELEGRAM_BOT_TOKEN}`;
  console.log(`[Telegram] Webhook URL: ${webhookUrl}`);
  return c.json({
    message: 'Use this URL to set the Telegram webhook',
    url: webhookUrl,
    instruction: 'Call POST /webhook/telegram/register to auto-register the webhook with Telegram',
  });
});

// Auto-register the webhook with Telegram
app.post('/webhook/telegram/register', async (c) => {
  const telegram = new TelegramBot(c.env.TELEGRAM_BOT_TOKEN, c.env.TELEGRAM_CHAT_ID);
  const webhookUrl = `https://binance-trading-bot.vividoai.workers.dev/webhook/telegram/${c.env.TELEGRAM_BOT_TOKEN}`;
  await telegram.setWebhook(webhookUrl);
  return c.json({ ok: true, webhookUrl });
});

// Keep engine instance alive between cron invocations (per Worker isolate)
let engine: TradingEngine | null = null;
let lastRebalance = 0;

function getEngine(env: Bindings): TradingEngine {
  if (!engine) {
    const exchange = createExchange(env);

    const telegram = new TelegramBot(
      env.TELEGRAM_BOT_TOKEN,
      env.TELEGRAM_CHAT_ID
    );

    const isHyperliquid = (env.EXCHANGE || 'binance').toLowerCase() === 'hyperliquid';
    const config: EngineConfig = {
      symbols: isHyperliquid ? [
        'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'HYPEUSDT',
        'BNBUSDT', 'DOGEUSDT', 'SUIUSDT', 'AVAXUSDT', 'LINKUSDT',
        'ARBUSDT', 'OPUSDT', 'NEARUSDT', 'AAVEUSDT',
      ] : [
        'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
        'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT',
      ],
      leverage: isHyperliquid ? 3 : 10,
      riskPerTrade: isHyperliquid ? 2 : 2,
      maxPositionSizeUsdt: isHyperliquid ? 15 : 500,
      maxPositions: isHyperliquid ? 3 : 6,
      enableEventDriven: true,
      enableMarketNeutral: !isHyperliquid, // Disable for now (no hedge mode)
      analystModel: 'anthropic/claude-haiku-4.5',
      highImpactModel: 'anthropic/claude-sonnet-4.5',
    };

    engine = new TradingEngine(exchange, telegram, env.WAVESPEED_API_KEY, config, env.AI, env.DB, env.NVIDIA_API_KEY);
  }
  return engine;
}

export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext): Promise<void> {
    // Kill switch
    if (env.BOT_ACTIVE !== 'true') {
      console.log('[Cron] Bot is not active, skipping');
      return;
    }

    console.log(`[Cron] ${event.cron} triggered`);

    // Daily snapshot cron (A1.7): runs at 23:05 UTC, separate from trading cycle.
    if (event.cron === '5 23 * * *') {
      if (!env.DB) return;
      try {
        const exchange = createExchange(env);
        await exchange.loadExchangeInfo();
        const account = await exchange.getAccountInfo();
        const btcTicker = await exchange.getTicker24hr('BTCUSDT').catch(() => ({ priceChangePercent: '0' }));
        const exp = new ExperienceDB(env.DB);
        const today = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
        await exp.computeAndSaveDailySnapshot({
          date: today,
          endingBalance: parseFloat(account.totalWalletBalance || '0'),
          startingBalance: getStartingBalance(env),
          regime: 'UNKNOWN', // populated when we have intraday tracking
          fearGreed: 50,
          btcChangePercent: parseFloat(btcTicker.priceChangePercent || '0'),
          llmCost: costTracker.totalCostUsd,
          llmCalls: costTracker.totalCalls,
        });
        console.log(`[DailySnapshot] Saved snapshot for ${today}`);
      } catch (e) {
        console.error(`[DailySnapshot] Failed:`, (e as Error).message);
      }
      return;
    }

    const eng = getEngine(env);
    const now = Date.now();

    // Setup: load exchange info + enable hedge mode on first run
    try {
      const binance = createExchange(env);
      await binance.loadExchangeInfo();
      await binance.setPositionMode(true);
    } catch {
      // Ignore - already set or not supported on testnet
    }

    // Collect + process + rebalance in same invocation
    // (Worker is stateless - must do everything in one shot)

    try {
      // 1. Check software SL/TP first (safety net for failed algo orders)
      await eng.checkSoftOrders();

      // 2. Collect news + process through LLM + event-driven trades
      await eng.runCycle();

      // 3. Market-neutral rebalance (engine handles timing internally)
      await eng.rebalanceMarketNeutral();
    } catch (err) {
      console.error(`[Cron] Error:`, (err as Error).message);
    } finally {
      // 4. Always flush LLM costs to KV, even if errors occurred
      if (env.COSTS) {
        try {
          await flushCosts(env.COSTS);
          console.log(`[Costs] Flushed: ${costTracker.totalCalls} calls, $${costTracker.totalCostUsd.toFixed(4)}`);
        } catch (e) {
          console.error(`[Costs] Flush failed:`, (e as Error).message);
        }
      }

      // 5. Auto audit — only run every 30 min (Hyperliquid rate limits aggressively)
      const minuteNow = new Date().getMinutes();
      if (env.DB && minuteNow < 5) { // runs once per ~30min (at :00 and :30)
        try {
          const auditExp = new ExperienceDB(env.DB);
          const auditReport = await runAudit(eng.getExchange(), auditExp, getSoftOrderKeys(), getStartingBalance(env));
          const alert = formatAuditAlert(auditReport.issues);
          if (alert) {
            const auditTelegram = new TelegramBot(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID);
            await auditTelegram.sendMessage(alert);
          }
          console.log(`[Audit] ${auditReport.issues.length} issues (${auditReport.issues.filter(i => i.severity === 'CRITICAL').length} critical)`);
        } catch (e) {
          console.error(`[Audit] Failed:`, (e as Error).message);
        }
      }
    }
  },
};
