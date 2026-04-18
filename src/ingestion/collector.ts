/**
 * Event collector - orchestrates all ingestion sources.
 * Deduplicates by ID, filters by recency, and passes items
 * to the LLM sensor for structured extraction.
 */

import {
  RawTextItem,
  fetchCryptoCompareNews,
  fetchAllReddit,
  fetchBinanceAnnouncements,
  fetchFearAndGreed,
  fetchAllRss,
} from './sources';

export interface CollectorResult {
  newItems: RawTextItem[];
  fearGreed: { value: number; classification: string; timestamp: number };
  totalFetched: number;
  duplicatesSkipped: number;
}

/**
 * Collect events from all sources.
 * Uses a seen-IDs set for dedup (pass from previous call for persistence).
 */
export async function collectEvents(
  seenIds: Set<string>,
  maxAgeMs: number = 30 * 60 * 1000 // 30 minutes default
): Promise<CollectorResult> {
  const now = Date.now();
  const allItems: RawTextItem[] = [];

  // Fetch from all sources in parallel
  const [ccNews, reddit, binanceAnn, rss, fearGreed] = await Promise.allSettled([
    fetchCryptoCompareNews(30),
    fetchAllReddit(),
    fetchBinanceAnnouncements(10),
    fetchAllRss(),
    fetchFearAndGreed(),
  ]);

  if (ccNews.status === 'fulfilled') allItems.push(...ccNews.value);
  if (reddit.status === 'fulfilled') allItems.push(...reddit.value);
  if (binanceAnn.status === 'fulfilled') allItems.push(...binanceAnn.value);
  if (rss.status === 'fulfilled') allItems.push(...rss.value);

  const fg = fearGreed.status === 'fulfilled'
    ? fearGreed.value
    : { value: 50, classification: 'Neutral', timestamp: now };

  // Dedup and filter by recency
  const totalFetched = allItems.length;
  let duplicatesSkipped = 0;

  const newItems = allItems.filter((item) => {
    if (seenIds.has(item.id)) {
      duplicatesSkipped++;
      return false;
    }
    // Skip items older than maxAge
    if (now - item.publishedAt > maxAgeMs) return false;

    seenIds.add(item.id);
    return true;
  });

  // Sort by most recent first
  newItems.sort((a, b) => b.publishedAt - a.publishedAt);

  return {
    newItems,
    fearGreed: fg,
    totalFetched,
    duplicatesSkipped,
  };
}

/**
 * Filter items by magnitude/importance heuristics.
 * High-impact items get processed by the LLM immediately.
 */
export function classifyImpact(item: RawTextItem): 'high' | 'medium' | 'low' {
  const text = item.text.toLowerCase();

  // High impact keywords
  const highImpact = [
    'hack', 'exploit', 'breach', 'stolen',
    'sec ', 'lawsuit', 'regulation', 'ban',
    'etf ', 'approval', 'approved', 'reject',
    'listing', 'delisting',
    'partnership', 'acquisition', 'merge',
    'crash', 'flash crash', 'liquidation',
    'halving', 'fork', 'upgrade',
    'blackrock', 'grayscale', 'fidelity',
  ];

  // Medium impact keywords
  const mediumImpact = [
    'whale', 'accumulation', 'outflow', 'inflow',
    'report', 'earnings', 'revenue',
    'airdrop', 'token', 'launch',
    'update', 'release', 'mainnet',
    'staking', 'yield', 'defi',
  ];

  if (highImpact.some((kw) => text.includes(kw))) return 'high';
  if (mediumImpact.some((kw) => text.includes(kw))) return 'medium';
  if (item.source === 'binance_announcement') return 'high'; // Binance announcements are always relevant
  return 'low';
}
