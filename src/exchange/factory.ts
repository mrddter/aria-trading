/**
 * Exchange factory — creates the right exchange client based on environment config.
 */

import { BinanceFuturesClient } from '../binance/client';
import { HyperliquidClient } from '../hyperliquid/client';
import type { IExchange } from './types';

export interface ExchangeEnv {
  EXCHANGE?: string;
  // Binance
  BINANCE_API_KEY?: string;
  BINANCE_API_SECRET?: string;
  // Hyperliquid
  HL_PRIVATE_KEY?: string;
  HL_WALLET_ADDRESS?: string;
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
      if (!env.HL_PRIVATE_KEY) {
        throw new Error('HL_PRIVATE_KEY required for Hyperliquid');
      }
      return new HyperliquidClient({
        privateKey: env.HL_PRIVATE_KEY,
        walletAddress: env.HL_WALLET_ADDRESS,
        vaultAddress: env.HL_VAULT_ADDRESS,
        isTestnet: env.HL_TESTNET === 'true' || env.ENVIRONMENT === 'testnet',
      });

    default:
      throw new Error(`Unknown exchange: ${exchange}`);
  }
}
