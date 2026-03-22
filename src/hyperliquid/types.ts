/**
 * Hyperliquid-specific API response types.
 */

export interface HlMeta {
  universe: HlAsset[];
}

export interface HlAsset {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  isDelisted?: boolean;
}

export interface HlClearinghouseState {
  marginSummary: {
    accountValue: string;
    totalNtlPos: string;
    totalRawUsd: string;
    totalMarginUsed: string;
  };
  crossMarginSummary: {
    accountValue: string;
    totalNtlPos: string;
    totalRawUsd: string;
    totalMarginUsed: string;
  };
  withdrawable: string;
  assetPositions: HlAssetPosition[];
}

export interface HlAssetPosition {
  position: {
    coin: string;
    szi: string;
    entryPx: string;
    positionValue: string;
    unrealizedPnl: string;
    leverage: {
      type: string;
      value: number;
    };
    liquidationPx: string | null;
    returnOnEquity: string;
  };
}

export interface HlCandle {
  t: number;
  T: number;
  s: string;
  i: string;
  o: string;
  c: string;
  h: string;
  l: string;
  v: string;
  n: number;
}

export interface HlFill {
  coin: string;
  px: string;
  sz: string;
  side: 'B' | 'A';
  time: number;
  dir: string;
  closedPnl: string;
  hash: string;
  oid: number;
  fee: string;
  feeToken: string;
}

export interface HlOrderResponse {
  status: string;
  response?: {
    type: string;
    data?: {
      statuses: Array<{
        resting?: { oid: number };
        filled?: { totalSz: string; avgPx: string; oid: number };
        error?: string;
      }>;
    };
  };
}
