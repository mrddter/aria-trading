/**
 * Exchange factory — creates the right exchange client based on environment config.
 */

import { BinanceFuturesClient } from '../binance/client';
import type { IExchange } from './types';

export interface ExchangeEnv {
  EXCHANGE?: string;
  // Binance
  BINANCE_API_KEY?: string;
  BINANCE_API_SECRET?: string;
  // Hyperliquid (future)
  HL_PRIVATE_KEY?: string;
  HL_VAULT_ADDRESS?: string;
  HL_TESTNET?: string;
  // Common
  ENVIRONMENT?: string;
}

export function createExchange(env: ExchangeEnv): IExchange {
  const exchange = (env.EXCHANGE || 'binance').toLowerCase();

  switch (exchange) {
    case 'binance':
      if (!env.BINANCE_API_KEY || !env.BINANCE_API_SECRET) {
        throw new Error('BINANCE_API_KEY and BINANCE_API_SECRET required');
      }
      return new BinanceFuturesClient({
        BINANCE_API_KEY: env.BINANCE_API_KEY,
        BINANCE_API_SECRET: env.BINANCE_API_SECRET,
        ENVIRONMENT: env.ENVIRONMENT || 'mainnet',
      });

    case 'hyperliquid':
      throw new Error('Hyperliquid not yet implemented — coming soon');

    default:
      throw new Error(`Unknown exchange: ${exchange}`);
  }
}
