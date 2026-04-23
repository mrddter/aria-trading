/**
 * Telegram bot for trade notifications and interactive commands.
 * Uses HTML parse mode to avoid MarkdownV2 escaping issues.
 */

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
    from?: { id: number; first_name?: string };
  };
}

export class TelegramBot {
  private token: string;
  private chatId: string;
  private baseUrl: string;

  constructor(token: string, chatId: string) {
    this.token = token;
    this.chatId = chatId;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async sendMessage(text: string): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) {
        console.error('Telegram send failed:', res.status);
      }
    } catch (err) {
      console.error('Telegram error:', (err as Error).message);
    }
  }

  private formatPrice(price: number): string {
    if (price >= 1000) return price.toFixed(2);
    if (price >= 1) return price.toFixed(4);
    if (price >= 0.01) return price.toFixed(6);
    return price.toFixed(8);
  }

  async notifyTradeOpen(trade: {
    symbol: string;
    direction: string;
    entryPrice: number;
    quantity: number;
    stopLoss: number;
    takeProfit: number;
    leverage: number;
    reason?: string;
    strategy?: string;
  }): Promise<void> {
    const emoji = trade.direction === 'LONG' ? '🟢' : '🔴';
    let msg = `${emoji} <b>NEW ${trade.direction}</b>\n\n`;
    msg += `<b>Symbol:</b> <code>${trade.symbol}</code>\n`;
    msg += `<b>Price:</b> <code>${this.formatPrice(trade.entryPrice)}</code>\n`;
    msg += `<b>Size:</b> <code>$${trade.quantity.toFixed(0)}</code>\n`;
    msg += `<b>Leverage:</b> <code>${trade.leverage}x</code>\n`;
    msg += `<b>SL:</b> <code>${this.formatPrice(trade.stopLoss)}</code>\n`;
    msg += `<b>TP:</b> <code>${this.formatPrice(trade.takeProfit)}</code>\n`;
    if (trade.strategy) msg += `<b>Strategy:</b> <code>${trade.strategy}</code>\n`;
    if (trade.reason) msg += `\n<i>${trade.reason.slice(0, 150)}</i>`;
    await this.sendMessage(msg);
  }

  async notifyTradeClose(trade: {
    symbol: string;
    direction: string;
    entryPrice: number;
    exitPrice: number;
    pnl: number;
    pnlPercent: number;
    reason: string;
  }): Promise<void> {
    const emoji = trade.pnl >= 0 ? '✅' : '❌';
    let msg = `${emoji} <b>CLOSED ${trade.direction}</b>\n\n`;
    msg += `<b>Symbol:</b> <code>${trade.symbol}</code>\n`;
    msg += `<b>Entry:</b> <code>${this.formatPrice(trade.entryPrice)}</code>\n`;
    msg += `<b>Exit:</b> <code>${this.formatPrice(trade.exitPrice)}</code>\n`;
    msg += `<b>P&L:</b> <code>${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)} (${trade.pnlPercent.toFixed(1)}%)</code>\n`;
    msg += `<b>Reason:</b> <code>${trade.reason}</code>`;
    await this.sendMessage(msg);
  }

  async notifyEvent(event: {
    asset: string;
    sentiment: number;
    magnitude: number;
    headline: string;
    action: string;
  }): Promise<void> {
    const emoji = event.sentiment > 0 ? '📈' : event.sentiment < 0 ? '📉' : '📊';
    let msg = `${emoji} <b>EVENT DETECTED</b>\n\n`;
    msg += `<b>Asset:</b> <code>${event.asset}</code>\n`;
    msg += `<b>Sentiment:</b> <code>${event.sentiment > 0 ? '+' : ''}${event.sentiment.toFixed(2)}</code>\n`;
    msg += `<b>Magnitude:</b> <code>${(event.magnitude * 100).toFixed(0)}%</code>\n`;
    msg += `<b>Action:</b> <code>${event.action}</code>\n`;
    msg += `\n<i>${event.headline.slice(0, 200)}</i>`;
    await this.sendMessage(msg);
  }

  async notifyError(error: string): Promise<void> {
    await this.sendMessage(`⚠️ <b>ERROR</b>\n\n<code>${error.slice(0, 300)}</code>`);
  }

  async setWebhook(url: string): Promise<void> {
    await fetch(`https://api.telegram.org/bot${this.token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, allowed_updates: ['message'] }),
    });

    // Register bot commands menu
    await fetch(`https://api.telegram.org/bot${this.token}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands: [
          { command: 'status', description: 'Account balance & status' },
          { command: 'pos', description: 'Open positions with SL/TP' },
          { command: 'perf', description: 'Performance report' },
          { command: 'audit', description: 'System health check' },
          { command: 'costs', description: 'LLM costs & net P&L' },
          { command: 'exp', description: 'Experience database stats' },
          { command: 'close', description: 'Close a position: /close BTC' },
          { command: 'help', description: 'All commands' },
        ],
      }),
    });
  }

  async handleUpdate(update: TelegramUpdate, chatId: string): Promise<string | null> {
    // Security: only respond to authorized chat
    if (update.message?.chat?.id?.toString() !== chatId) {
      return null; // Ignore unauthorized messages
    }

    const text = update.message?.text?.trim();
    if (!text) return null;

    const parts = text.trim().split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ').trim();
    return args ? `${command} ${args}` : command;
  }
}
