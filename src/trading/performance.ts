/**
 * Performance Tracker
 * Calculates real-time trading metrics from Binance account data.
 * Stateless - computed fresh each time from trade history.
 */

export interface PerformanceReport {
  // Summary
  totalTrades: number;
  openTrades: number;
  closedTrades: number;

  // P&L
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  totalFees: number;
  netPnl: number;

  // Win/Loss
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  profitFactor: number;

  // Risk metrics
  sharpeRatio: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  calmarRatio: number;

  // Time
  avgHoldingHours: number;
  tradingDays: number;
  tradesPerDay: number;

  // Strategy breakdown
  byStrategy: Record<string, {
    trades: number;
    pnl: number;
    winRate: number;
  }>;

  // Daily P&L for charting
  dailyPnl: Array<{ date: string; pnl: number; cumulative: number; trades: number }>;

  // Meta
  generatedAt: string;
  startingBalance: number;
  currentBalance: number;
  returnPercent: number;
}

export interface TradeRecord {
  id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice?: number;
  quantity: number;
  leverage: number;
  strategy: string;
  pnl?: number;
  fee: number;
  status: 'OPEN' | 'CLOSED';
  openedAt: number;
  closedAt?: number;
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

export function generateReport(
  trades: TradeRecord[],
  startingBalance: number,
  currentBalance: number,
  unrealizedPnl: number
): PerformanceReport {
  const closed = trades.filter((t) => t.status === 'CLOSED');
  const open = trades.filter((t) => t.status === 'OPEN');

  // P&L
  const realizedPnl = closed.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  const totalFees = trades.reduce((sum, t) => sum + t.fee, 0);
  const totalPnl = realizedPnl + unrealizedPnl;
  const netPnl = totalPnl - totalFees;

  // Win / loss
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0);
  const losses = closed.filter((t) => (t.pnl ?? 0) < 0);

  const grossWins = wins.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const grossLosses = Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0));

  const winRate = closed.length > 0 ? wins.length / closed.length : 0;
  const avgWin = wins.length > 0 ? grossWins / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLosses / losses.length : 0;
  const largestWin = wins.length > 0 ? Math.max(...wins.map((t) => t.pnl ?? 0)) : 0;
  const largestLoss = losses.length > 0 ? Math.min(...losses.map((t) => t.pnl ?? 0)) : 0;
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;

  // Daily P&L bucketing
  const dailyMap = new Map<string, { pnl: number; trades: number }>();
  for (const t of closed) {
    const date = new Date(t.closedAt ?? t.openedAt).toISOString().slice(0, 10);
    const entry = dailyMap.get(date) ?? { pnl: 0, trades: 0 };
    entry.pnl += t.pnl ?? 0;
    entry.trades += 1;
    dailyMap.set(date, entry);
  }

  const sortedDates = [...dailyMap.keys()].sort();
  let cumulative = 0;
  const dailyPnl = sortedDates.map((date) => {
    const d = dailyMap.get(date)!;
    cumulative += d.pnl;
    return { date, pnl: d.pnl, cumulative, trades: d.trades };
  });

  // Risk metrics
  const dailyReturns = sortedDates.map((date) => {
    const d = dailyMap.get(date)!;
    return startingBalance > 0 ? d.pnl / startingBalance : 0;
  });

  const sharpeRatio = computeSharpe(dailyReturns);
  const { maxDrawdown, maxDrawdownPercent } = computeMaxDrawdown(dailyPnl, startingBalance);

  const annualReturn = startingBalance > 0
    ? (currentBalance - startingBalance) / startingBalance
    : 0;
  const calmarRatio = maxDrawdownPercent > 0
    ? annualReturn / (maxDrawdownPercent / 100)
    : 0;

  // Time metrics
  const holdingHours = closed
    .filter((t) => t.closedAt != null)
    .map((t) => (t.closedAt! - t.openedAt) / (1000 * 60 * 60));
  const avgHoldingHours = holdingHours.length > 0
    ? holdingHours.reduce((a, b) => a + b, 0) / holdingHours.length
    : 0;

  const tradingDays = sortedDates.length;
  const tradesPerDay = tradingDays > 0 ? closed.length / tradingDays : 0;

  // Strategy breakdown
  const byStrategy: PerformanceReport['byStrategy'] = {};
  for (const t of closed) {
    const key = t.strategy || 'unknown';
    if (!byStrategy[key]) byStrategy[key] = { trades: 0, pnl: 0, winRate: 0 };
    byStrategy[key].trades += 1;
    byStrategy[key].pnl += t.pnl ?? 0;
  }
  for (const key of Object.keys(byStrategy)) {
    const stratTrades = closed.filter((t) => (t.strategy || 'unknown') === key);
    const stratWins = stratTrades.filter((t) => (t.pnl ?? 0) > 0).length;
    byStrategy[key].winRate = stratTrades.length > 0 ? stratWins / stratTrades.length : 0;
  }

  const returnPercent = startingBalance > 0
    ? ((currentBalance - startingBalance) / startingBalance) * 100
    : 0;

  return {
    totalTrades: trades.length,
    openTrades: open.length,
    closedTrades: closed.length,
    realizedPnl,
    unrealizedPnl,
    totalPnl,
    totalFees,
    netPnl,
    wins: wins.length,
    losses: losses.length,
    winRate,
    avgWin,
    avgLoss,
    largestWin,
    largestLoss,
    profitFactor,
    sharpeRatio,
    maxDrawdown,
    maxDrawdownPercent,
    calmarRatio,
    avgHoldingHours,
    tradingDays,
    tradesPerDay,
    byStrategy,
    dailyPnl,
    generatedAt: new Date().toISOString(),
    startingBalance,
    currentBalance,
    returnPercent,
  };
}

// ---------------------------------------------------------------------------
// Sharpe ratio (annualized, risk-free = 0)
// ---------------------------------------------------------------------------

function computeSharpe(dailyReturns: number[]): number {
  // Need at least 7 days for a meaningful Sharpe ratio
  if (dailyReturns.length < 7) return 0;

  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const variance =
    dailyReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (dailyReturns.length - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return 0;

  const sharpe = (mean / stdDev) * Math.sqrt(365);
  // Cap to reasonable range to avoid nonsense values with small samples
  return Math.max(-10, Math.min(10, sharpe));
}

// ---------------------------------------------------------------------------
// Max drawdown from daily cumulative P&L
// ---------------------------------------------------------------------------

function computeMaxDrawdown(
  dailyPnl: Array<{ cumulative: number }>,
  startingBalance: number
): { maxDrawdown: number; maxDrawdownPercent: number } {
  if (dailyPnl.length === 0) return { maxDrawdown: 0, maxDrawdownPercent: 0 };

  let peak = startingBalance;
  let maxDD = 0;
  let maxDDPercent = 0;

  for (const day of dailyPnl) {
    const equity = startingBalance + day.cumulative;
    if (equity > peak) peak = equity;

    const dd = peak - equity;
    if (dd > maxDD) {
      maxDD = dd;
      maxDDPercent = peak > 0 ? (dd / peak) * 100 : 0;
    }
  }

  return { maxDrawdown: maxDD, maxDrawdownPercent: maxDDPercent };
}

// ---------------------------------------------------------------------------
// Telegram HTML format
// ---------------------------------------------------------------------------

export function formatReportTelegram(report: PerformanceReport): string {
  const pnlEmoji = report.netPnl >= 0 ? '\u{1F7E2}' : '\u{1F534}';

  let msg = '';
  msg += `\u{1F4CA} <b>Performance Report</b>\n`;
  msg += `\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\n\n`;

  // Balance
  const equity = report.currentBalance + report.unrealizedPnl;
  const equityReturn = ((equity - report.startingBalance) / report.startingBalance) * 100;
  const equityEmoji = equityReturn >= 0 ? '\u{1F4C8}' : '\u{1F4C9}';
  msg += `\u{1F4B0} <b>Balance</b>\n`;
  msg += `  Start: <code>$${report.startingBalance.toFixed(2)}</code>\n`;
  msg += `  Balance: <code>$${report.currentBalance.toFixed(2)}</code>\n`;
  msg += `  Unrealized: <code>${fmtPnl(report.unrealizedPnl)}</code>\n`;
  msg += `  <b>Equity: <code>$${equity.toFixed(2)}</code></b>\n`;
  msg += `  ${equityEmoji} Return: ${equityReturn >= 0 ? '+' : ''}${equityReturn.toFixed(2)}%\n\n`;

  // P&L
  msg += `${pnlEmoji} <b>P&L</b>\n`;
  msg += `  Realized: ${fmtPnl(report.realizedPnl)}\n`;
  msg += `  Fees: -$${report.totalFees.toFixed(2)}\n`;
  msg += `  <b>Net realized: ${fmtPnl(report.realizedPnl - report.totalFees)}</b>\n\n`;

  // Win / Loss
  msg += `\u{1F3AF} <b>Win/Loss</b>\n`;
  msg += `  Trades: ${report.closedTrades} closed, ${report.openTrades} open\n`;
  msg += `  Win Rate: ${(report.winRate * 100).toFixed(1)}% (${report.wins}W / ${report.losses}L)\n`;
  msg += `  Avg Win: $${report.avgWin.toFixed(2)} | Avg Loss: $${report.avgLoss.toFixed(2)}\n`;
  msg += `  Best: ${fmtPnl(report.largestWin)} | Worst: ${fmtPnl(report.largestLoss)}\n`;
  msg += `  Profit Factor: ${report.profitFactor === Infinity ? '\u{221E}' : report.profitFactor.toFixed(2)}\n\n`;

  // Risk
  msg += `\u{26A0}\u{FE0F} <b>Risk</b>\n`;
  if (report.tradingDays < 7) {
    msg += `  Sharpe: <i>min 7 giorni (${report.tradingDays}/7)</i>\n`;
    msg += `  Max DD: $${report.maxDrawdown.toFixed(2)} (${report.maxDrawdownPercent.toFixed(2)}%)\n`;
    msg += `  Calmar: <i>min 7 giorni</i>\n\n`;
  } else {
    msg += `  Sharpe: ${report.sharpeRatio.toFixed(2)}${report.sharpeRatio >= 1 ? ' \u{2705}' : report.sharpeRatio >= 0.5 ? ' \u{1F7E1}' : ' \u{1F534}'}\n`;
    msg += `  Max DD: $${report.maxDrawdown.toFixed(2)} (${report.maxDrawdownPercent.toFixed(2)}%)\n`;
    msg += `  Calmar: ${report.calmarRatio.toFixed(2)}\n\n`;
  }

  // Time
  msg += `\u{23F0} <b>Time</b>\n`;
  msg += `  Avg Hold: ${report.avgHoldingHours.toFixed(1)}h\n`;
  msg += `  Trading Days: ${report.tradingDays}\n`;
  msg += `  Trades/Day: ${report.tradesPerDay.toFixed(1)}\n\n`;

  // Strategy breakdown
  const strategies = Object.keys(report.byStrategy);
  if (strategies.length > 0) {
    msg += `\u{1F9E0} <b>Strategies</b>\n`;
    for (const key of strategies) {
      const s = report.byStrategy[key];
      msg += `  ${key}: ${s.trades} trades | ${fmtPnl(s.pnl)} | WR: ${(s.winRate * 100).toFixed(0)}%\n`;
    }
    msg += '\n';
  }

  // Recent daily P&L (last 7 days)
  if (report.dailyPnl.length > 0) {
    msg += `\u{1F4C5} <b>Recent Daily P&L</b>\n`;
    const recent = report.dailyPnl.slice(-7);
    for (const day of recent) {
      const bar = day.pnl >= 0 ? '\u{1F7E9}' : '\u{1F7E5}';
      msg += `  ${bar} ${day.date}: ${fmtPnl(day.pnl)} (${day.trades} trades)\n`;
    }
    msg += '\n';
  }

  msg += `<i>Generated: ${report.generatedAt}</i>`;
  return msg;
}

// ---------------------------------------------------------------------------
// Compact one-liner
// ---------------------------------------------------------------------------

export function formatReportCompact(report: PerformanceReport): string {
  const pnlSign = report.netPnl >= 0 ? '+' : '';
  const sharpe = report.sharpeRatio.toFixed(1);
  const wr = (report.winRate * 100).toFixed(0);
  const dd = report.maxDrawdownPercent.toFixed(1);
  const pf = report.profitFactor === Infinity ? '\u{221E}' : report.profitFactor.toFixed(1);

  return (
    `\u{1F4CA} ${report.closedTrades} trades | ` +
    `WR: ${wr}% | ` +
    `PnL: ${pnlSign}$${report.netPnl.toFixed(2)} | ` +
    `PF: ${pf} | ` +
    `Sharpe: ${sharpe} | ` +
    `DD: -${dd}%`
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtPnl(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}$${value.toFixed(2)}`;
}
