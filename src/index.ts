/**
 * Binance Trading Bot - Cloudflare Worker Entry Point
 *
 * Cron triggers:
 * - Every 2 min: collect news, process through LLM, event-driven trades
 * - Every 4 hours: market-neutral rebalancing
 */

import { Hono } from 'hono';
import { BinanceFuturesClient } from './binance/client';
import { TelegramBot, TelegramUpdate } from './telegram/bot';
import { TradingEngine, EngineConfig } from './trading/engine';
import { generateReport, formatReportTelegram, formatReportCompact, TradeRecord } from './trading/performance';
import { costTracker, loadCosts, flushCosts, formatCostsTelegram } from './wavespeed/client';
import type { AiBinding } from './wavespeed/workers-ai';
import { ExperienceDB } from './trading/experience';

type Bindings = {
  BINANCE_API_KEY: string;
  BINANCE_API_SECRET: string;
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
  const binance = new BinanceFuturesClient({
    BINANCE_API_KEY: c.env.BINANCE_API_KEY,
    BINANCE_API_SECRET: c.env.BINANCE_API_SECRET,
    ENVIRONMENT: c.env.ENVIRONMENT,
  });
  try {
    const account = await binance.getAccountInfo();
    const positions = account.positions.filter(
      (p: any) => parseFloat(p.positionAmt) !== 0
    );
    return c.json({
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
        const binance = new BinanceFuturesClient({
          BINANCE_API_KEY: c.env.BINANCE_API_KEY,
          BINANCE_API_SECRET: c.env.BINANCE_API_SECRET,
          ENVIRONMENT: c.env.ENVIRONMENT,
        });
        const account = await binance.getAccountInfo();
        const positions = account.positions.filter(
          (p: any) => parseFloat(p.positionAmt) !== 0
        );
        const msg =
          `🤖 <b>Bot Status</b>\n\n` +
          `<b>Balance:</b> <code>$${parseFloat(account.totalWalletBalance).toFixed(2)}</code>\n` +
          `<b>Unrealized:</b> <code>$${parseFloat(account.totalUnrealizedProfit).toFixed(2)}</code>\n` +
          `<b>Available:</b> <code>$${parseFloat(account.availableBalance).toFixed(2)}</code>\n` +
          `<b>Positions:</b> ${positions.length}\n` +
          `<b>Environment:</b> <code>${c.env.ENVIRONMENT}</code>\n` +
          `<b>Bot Active:</b> ${c.env.BOT_ACTIVE === 'true' ? '✅' : '❌'}`;
        await telegram.sendMessage(msg);
        break;
      }

      case '/positions':
      case '/pos': {
        const binance = new BinanceFuturesClient({
          BINANCE_API_KEY: c.env.BINANCE_API_KEY,
          BINANCE_API_SECRET: c.env.BINANCE_API_SECRET,
          ENVIRONMENT: c.env.ENVIRONMENT,
        });
        const positions = await binance.getPositionRisk();

        if (positions.length === 0) {
          await telegram.sendMessage('📊 <b>No open positions</b>');
          break;
        }

        // Load open trades from D1 for SL/TP/leverage data
        const experience = c.env.DB ? new ExperienceDB(c.env.DB) : null;
        const openTrades = experience ? await experience.getOpenTrades() : [];
        const tradeMap = new Map(openTrades.map(t => [`${t.symbol}:${t.direction}`, t]));

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

          // Get SL/TP/leverage from D1
          const trade = tradeMap.get(`${p.symbol}:${direction}`);
          const lev = p.leverage || trade?.leverage || '?';
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
        const binance = new BinanceFuturesClient({
          BINANCE_API_KEY: c.env.BINANCE_API_KEY,
          BINANCE_API_SECRET: c.env.BINANCE_API_SECRET,
          ENVIRONMENT: c.env.ENVIRONMENT,
        });
        const account = await binance.getAccountInfo();
        const positions = account.positions.filter(
          (p: any) => parseFloat(p.positionAmt) !== 0
        );

        // Fetch real trade history from Binance
        const rawTrades = await binance.getAllUserTrades(200);

        // Group trades by symbol+side to reconstruct open/close pairs
        // Each Binance "trade" is a fill - we need to pair opens with closes
        const tradesBySymbolSide = new Map<string, any[]>();
        for (const t of rawTrades) {
          const key = `${t.symbol}:${t.positionSide || (t.side === 'BUY' ? 'LONG' : 'SHORT')}`;
          const list = tradesBySymbolSide.get(key) || [];
          list.push(t);
          tradesBySymbolSide.set(key, list);
        }

        const trades: TradeRecord[] = [];
        for (const [key, fills] of tradesBySymbolSide) {
          const [symbol, side] = key.split(':');
          const direction = (side === 'LONG' ? 'LONG' : 'SHORT') as 'LONG' | 'SHORT';
          const totalPnl = fills.reduce((sum: number, f: any) => sum + parseFloat(f.realizedPnl || '0'), 0);
          const totalFee = fills.reduce((sum: number, f: any) => sum + parseFloat(f.commission || '0'), 0);
          const firstFill = fills[0];
          const lastFill = fills[fills.length - 1];

          // Check if position is still open
          const isOpen = positions.some((p: any) => {
            const amt = parseFloat(p.positionAmt);
            const pSide = amt > 0 ? 'LONG' : 'SHORT';
            return p.symbol === symbol && pSide === side && amt !== 0;
          });

          trades.push({
            id: `${symbol}-${side}-${firstFill.id}`,
            symbol,
            direction,
            entryPrice: parseFloat(firstFill.price),
            exitPrice: isOpen ? undefined : parseFloat(lastFill.price),
            quantity: Math.abs(parseFloat(firstFill.qty)),
            leverage: 3,
            strategy: 'live',
            pnl: isOpen ? undefined : totalPnl,
            fee: totalFee,
            status: isOpen ? 'OPEN' : 'CLOSED',
            openedAt: firstFill.time,
            closedAt: isOpen ? undefined : lastFill.time,
          });
        }

        const startingBalance = 5000;
        const currentBalance = parseFloat(account.totalWalletBalance);
        const unrealizedPnl = parseFloat(account.totalUnrealizedProfit);

        const report = generateReport(trades, startingBalance, currentBalance, unrealizedPnl);
        await telegram.sendMessage(formatReportTelegram(report));
        break;
      }

      case '/costs': {
        const binance = new BinanceFuturesClient({
          BINANCE_API_KEY: c.env.BINANCE_API_KEY,
          BINANCE_API_SECRET: c.env.BINANCE_API_SECRET,
          ENVIRONMENT: c.env.ENVIRONMENT,
        });
        const account = await binance.getAccountInfo();
        const realizedPnl = parseFloat(account.totalWalletBalance) - 5000;
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
    const binance = new BinanceFuturesClient({
      BINANCE_API_KEY: env.BINANCE_API_KEY,
      BINANCE_API_SECRET: env.BINANCE_API_SECRET,
      ENVIRONMENT: env.ENVIRONMENT,
    });

    const telegram = new TelegramBot(
      env.TELEGRAM_BOT_TOKEN,
      env.TELEGRAM_CHAT_ID
    );

    const config: EngineConfig = {
      symbols: [
        'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
        'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT',
      ],
      leverage: 10,          // Base leverage - regime adjusts dynamically (3x-15x)
      riskPerTrade: 2,       // Base risk % - regime adjusts dynamically
      maxPositionSizeUsdt: 500,
      maxPositions: 6,
      enableEventDriven: true,
      enableMarketNeutral: true,
      analystModel: 'anthropic/claude-haiku-4.5',
      highImpactModel: 'anthropic/claude-sonnet-4.5',
    };

    engine = new TradingEngine(binance, telegram, env.WAVESPEED_API_KEY, config, env.AI, env.DB, env.NVIDIA_API_KEY);
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

    const eng = getEngine(env);
    const now = Date.now();

    // Setup: load exchange info + enable hedge mode on first run
    try {
      const binance = new BinanceFuturesClient({
        BINANCE_API_KEY: env.BINANCE_API_KEY,
        BINANCE_API_SECRET: env.BINANCE_API_SECRET,
        ENVIRONMENT: env.ENVIRONMENT,
      });
      await binance.loadExchangeInfo();
      await binance.setPositionMode(true);
    } catch {
      // Ignore - already set or not supported on testnet
    }

    // Collect + process + rebalance in same invocation
    // (Worker is stateless - must do everything in one shot)
    console.log(`[Cron] ${event.cron} triggered`);

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
    }
  },
};
