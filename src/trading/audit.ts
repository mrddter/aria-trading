/**
 * Audit & Health Check System
 *
 * Monitors trading bot integrity:
 * - Position/D1 consistency
 * - SL/TP coverage
 * - Balance anomalies
 * - Soft order coverage
 *
 * Runs silently every cycle, alerts only on issues.
 * Full report available via /audit command.
 */

import type { IExchange, AccountInfo } from '../exchange/types';
import { ExperienceDB } from './experience';

export interface AuditIssue {
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  message: string;
}

export interface AuditReport {
  issues: AuditIssue[];
  positionCount: number;
  d1OpenCount: number;
  softOrderCount: number;
  balance: number;
  timestamp: string;
}

/**
 * Run a full audit check. Returns issues found.
 */
export async function runAudit(
  exchange: IExchange,
  experience: ExperienceDB,
  softOrderKeys: string[],
  startingBalance: number
): Promise<AuditReport> {
  const issues: AuditIssue[] = [];

  // 1. Get Binance positions
  let account: AccountInfo;
  let binancePositions: Array<{ symbol: string; direction: string; amt: number; pnl: number; markPrice: number }> = [];
  try {
    account = await exchange.getAccountInfo();
    const posRisk = await exchange.getPositionRisk();
    binancePositions = posRisk.map(p => {
      const amt = parseFloat(p.positionAmt);
      return {
        symbol: p.symbol,
        direction: amt > 0 ? 'LONG' : 'SHORT',
        amt: Math.abs(amt),
        pnl: parseFloat((p as any).unRealizedProfit || (p as any).unrealizedProfit || '0'),
        markPrice: parseFloat(p.markPrice),
      };
    });
  } catch (e) {
    issues.push({ severity: 'CRITICAL', message: `Binance API error: ${(e as Error).message?.slice(0, 100)}` });
    return { issues, positionCount: 0, d1OpenCount: 0, softOrderCount: 0, balance: 0, timestamp: new Date().toISOString() };
  }

  const balance = parseFloat(account.totalWalletBalance);

  // 2. Get D1 open trades
  const d1Open = await experience.getOpenTrades();

  // 3. Check: Binance positions without D1 record
  for (const pos of binancePositions) {
    const inD1 = d1Open.some(t => t.symbol === pos.symbol && t.direction === pos.direction);
    if (!inD1) {
      issues.push({
        severity: 'WARNING',
        message: `${pos.direction} ${pos.symbol} on Binance but NOT in D1 (untracked position)`,
      });
    }
  }

  // 4. Check: D1 OPEN trades without Binance position (ghost trades)
  for (const trade of d1Open) {
    const onBinance = binancePositions.some(p => p.symbol === trade.symbol && p.direction === trade.direction);
    if (!onBinance) {
      issues.push({
        severity: 'WARNING',
        message: `${trade.direction} ${trade.symbol} OPEN in D1 but NOT on Binance (ghost trade, id=${trade.symbol})`,
      });
    }
  }

  // 5. Check: Positions without SL/TP
  for (const trade of d1Open) {
    const onBinance = binancePositions.some(p => p.symbol === trade.symbol && p.direction === trade.direction);
    if (onBinance && (!trade.stop_loss || !trade.take_profit)) {
      issues.push({
        severity: 'CRITICAL',
        message: `${trade.direction} ${trade.symbol} has NO SL/TP — unprotected position!`,
      });
    }
  }

  // 6. Check: Positions without soft order backup
  for (const pos of binancePositions) {
    const key = `${pos.symbol}:${pos.direction}`;
    if (!softOrderKeys.includes(key)) {
      issues.push({
        severity: 'WARNING',
        message: `${pos.direction} ${pos.symbol} has no soft order backup`,
      });
    }
  }

  // 7. Check: Balance anomaly (>5% drop from starting)
  const drawdown = ((startingBalance - balance) / startingBalance) * 100;
  if (drawdown > 10) {
    issues.push({
      severity: 'CRITICAL',
      message: `Balance $${balance.toFixed(2)} is ${drawdown.toFixed(1)}% below starting ($${startingBalance})`,
    });
  } else if (drawdown > 5) {
    issues.push({
      severity: 'WARNING',
      message: `Balance $${balance.toFixed(2)} is ${drawdown.toFixed(1)}% below starting ($${startingBalance})`,
    });
  }

  // 8. Check: Large unrealized loss on any single position (>2% of balance)
  for (const pos of binancePositions) {
    if (pos.pnl < 0) {
      const lossPct = (Math.abs(pos.pnl) / balance) * 100;
      if (lossPct > 5) {
        issues.push({
          severity: 'CRITICAL',
          message: `${pos.direction} ${pos.symbol} has -$${Math.abs(pos.pnl).toFixed(2)} unrealized loss (${lossPct.toFixed(1)}% of balance)`,
        });
      } else if (lossPct > 2) {
        issues.push({
          severity: 'WARNING',
          message: `${pos.direction} ${pos.symbol} has -$${Math.abs(pos.pnl).toFixed(2)} unrealized loss (${lossPct.toFixed(1)}% of balance)`,
        });
      }
    }
  }

  // 9. Check: SL/TP levels make sense (SL not too far, TP not too close)
  for (const trade of d1Open) {
    if (trade.stop_loss && trade.take_profit) {
      const pos = binancePositions.find(p => p.symbol === trade.symbol && p.direction === trade.direction);
      if (pos) {
        const slDist = Math.abs(pos.markPrice - trade.stop_loss) / pos.markPrice * 100;
        const tpDist = Math.abs(trade.take_profit - pos.markPrice) / pos.markPrice * 100;

        if (slDist > 10) {
          issues.push({
            severity: 'WARNING',
            message: `${trade.symbol} SL is ${slDist.toFixed(1)}% away from mark price — too far?`,
          });
        }

        const rrRatio = tpDist / slDist;
        if (rrRatio < 1 && slDist > 0) {
          issues.push({
            severity: 'INFO',
            message: `${trade.symbol} R:R is ${rrRatio.toFixed(2)} (TP ${tpDist.toFixed(1)}% vs SL ${slDist.toFixed(1)}%)`,
          });
        }
      }
    }
  }

  return {
    issues,
    positionCount: binancePositions.length,
    d1OpenCount: d1Open.length,
    softOrderCount: softOrderKeys.length,
    balance,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Format audit report for Telegram
 */
export function formatAuditTelegram(report: AuditReport): string {
  const criticals = report.issues.filter(i => i.severity === 'CRITICAL');
  const warnings = report.issues.filter(i => i.severity === 'WARNING');
  const infos = report.issues.filter(i => i.severity === 'INFO');

  let statusEmoji = '✅';
  if (criticals.length > 0) statusEmoji = '🚨';
  else if (warnings.length > 0) statusEmoji = '⚠️';

  let msg = `${statusEmoji} <b>Audit Report</b>\n`;
  msg += `────────────────────\n\n`;

  msg += `<b>Status</b>\n`;
  msg += `  Binance positions: <code>${report.positionCount}</code>\n`;
  msg += `  D1 open trades: <code>${report.d1OpenCount}</code>\n`;
  msg += `  Soft orders: <code>${report.softOrderCount}</code>\n`;
  msg += `  Balance: <code>$${report.balance.toFixed(2)}</code>\n\n`;

  if (report.issues.length === 0) {
    msg += `✅ <b>All checks passed — no issues found</b>\n`;
  } else {
    if (criticals.length > 0) {
      msg += `🚨 <b>Critical (${criticals.length})</b>\n`;
      for (const i of criticals) msg += `  • ${i.message}\n`;
      msg += '\n';
    }
    if (warnings.length > 0) {
      msg += `⚠️ <b>Warnings (${warnings.length})</b>\n`;
      for (const i of warnings) msg += `  • ${i.message}\n`;
      msg += '\n';
    }
    if (infos.length > 0) {
      msg += `ℹ️ <b>Info (${infos.length})</b>\n`;
      for (const i of infos) msg += `  • ${i.message}\n`;
      msg += '\n';
    }
  }

  msg += `<i>${report.timestamp}</i>`;
  return msg;
}

/**
 * Format a short alert for critical/warning issues (used in auto-check)
 */
export function formatAuditAlert(issues: AuditIssue[]): string | null {
  const actionable = issues.filter(i => i.severity === 'CRITICAL' || i.severity === 'WARNING');
  if (actionable.length === 0) return null;

  const criticals = actionable.filter(i => i.severity === 'CRITICAL');
  const emoji = criticals.length > 0 ? '🚨' : '⚠️';

  let msg = `${emoji} <b>Audit Alert</b>\n\n`;
  for (const i of actionable) {
    const icon = i.severity === 'CRITICAL' ? '🔴' : '🟡';
    msg += `${icon} ${i.message}\n`;
  }
  return msg;
}
