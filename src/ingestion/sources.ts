/**
 * Data ingestion sources - fetches raw text from news/social APIs.
 * Each source returns a common RawTextItem[] format.
 * No LLM calls here - just data collection.
 */

export interface RawTextItem {
  id: string;              // unique ID for dedup
  text: string;            // headline or body
  source: string;          // "cryptocompare", "reddit", "binance", "rss"
  publishedAt: number;     // timestamp ms
  url?: string;
  relatedAssets?: string[]; // pre-tagged if the API provides it
  categories?: string[];
}

// ==========================================
// CryptoCompare News API (free, 100K/month)
// ==========================================
const CRYPTOCOMPARE_BASE = 'https://data-api.cryptocompare.com/news/v1';

export async function fetchCryptoCompareNews(
  limit: number = 50
): Promise<RawTextItem[]> {
  const url = `${CRYPTOCOMPARE_BASE}/article/list?lang=EN&limit=${limit}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`CryptoCompare error: ${res.status}`);

  const data = (await res.json()) as {
    Data: {
      ID: number;
      TITLE: string;
      BODY: string;
      PUBLISHED_ON: number;
      URL: string;
      CATEGORY_DATA?: { NAME: string }[];
      SOURCE_DATA?: { NAME: string };
    }[];
  };

  return (data.Data || []).map((item) => {
    const categories = (item.CATEGORY_DATA || []).map((c) => c.NAME).join('|');
    return {
      id: `cc_${item.ID}`,
      text: `${item.TITLE}. ${(item.BODY || '').slice(0, 300)}`,
      source: 'cryptocompare',
      publishedAt: item.PUBLISHED_ON * 1000,
      url: item.URL,
      relatedAssets: extractAssetsFromCategories(categories),
      categories: categories ? categories.split('|') : [],
    };
  });
}

/**
 * Fetch historical news from CryptoCompare (for backtesting).
 * Uses the `to_ts` parameter to paginate backward in time.
 */
export async function fetchCryptoCompareHistoricalNews(
  beforeTimestamp: number,
  limit: number = 50
): Promise<RawTextItem[]> {
  const ts = Math.floor(beforeTimestamp / 1000);
  const url = `${CRYPTOCOMPARE_BASE}/article/list?lang=EN&limit=${limit}&to_ts=${ts}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`CryptoCompare error: ${res.status}`);

  const data = (await res.json()) as {
    Data: {
      ID: number;
      TITLE: string;
      BODY: string;
      PUBLISHED_ON: number;
      URL: string;
      CATEGORY_DATA?: { NAME: string }[];
    }[];
  };

  return (data.Data || []).map((item) => {
    const categories = (item.CATEGORY_DATA || []).map((c) => c.NAME).join('|');
    return {
      id: `cc_${item.ID}`,
      text: `${item.TITLE}. ${(item.BODY || '').slice(0, 300)}`,
      source: 'cryptocompare',
      publishedAt: item.PUBLISHED_ON * 1000,
      url: item.URL,
      relatedAssets: extractAssetsFromCategories(categories),
      categories: categories ? categories.split('|') : [],
    };
  });
}

// ==========================================
// Reddit (free, no auth for public JSON)
// Filtered: only r/cryptocurrency hot posts with score >= 100,
// because lower-score posts are pure noise that wastes LLM inference.
// ==========================================
const REDDIT_MIN_SCORE = 100;

export async function fetchRedditPosts(
  subreddit: string = 'cryptocurrency',
  limit: number = 25
): Promise<RawTextItem[]> {
  const url = `https://www.reddit.com/r/${subreddit}/hot.json?limit=${limit}`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'TradingBot/1.0' },
  });
  if (!res.ok) return []; // Reddit often rate-limits, fail gracefully

  const data = (await res.json()) as {
    data: {
      children: {
        data: {
          id: string;
          title: string;
          selftext: string;
          created_utc: number;
          permalink: string;
          score: number;
          num_comments: number;
        };
      }[];
    };
  };

  return data.data.children
    .filter((post) => (post.data.score || 0) >= REDDIT_MIN_SCORE)
    .map((post) => ({
      id: `reddit_${post.data.id}`,
      text: `${post.data.title}. ${(post.data.selftext || '').slice(0, 200)}`,
      source: `reddit_${subreddit}`,
      publishedAt: post.data.created_utc * 1000,
      url: `https://reddit.com${post.data.permalink}`,
      categories: [`score:${post.data.score}`, `comments:${post.data.num_comments}`],
    }));
}

export async function fetchAllReddit(): Promise<RawTextItem[]> {
  // Single subreddit, high-signal-only. r/cryptocurrency is the largest.
  try {
    return await fetchRedditPosts('cryptocurrency', 25);
  } catch {
    return [];
  }
}

// ==========================================
// RSS feeds — Tier 1 crypto news (free, no auth)
// CoinDesk, CoinTelegraph, The Block, Decrypt, Bitcoin Magazine
// ==========================================

interface RssFeed {
  url: string;
  source: string;
}

const RSS_FEEDS: RssFeed[] = [
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', source: 'coindesk' },
  { url: 'https://cointelegraph.com/rss', source: 'cointelegraph' },
  { url: 'https://www.theblock.co/rss.xml', source: 'theblock' },
  { url: 'https://decrypt.co/feed', source: 'decrypt' },
  { url: 'https://bitcoinmagazine.com/.rss/full/', source: 'bitcoinmagazine' },
];

/**
 * Minimal RSS parser using regex — Cloudflare Workers has no DOMParser.
 * Extracts <item> blocks and pulls title/link/pubDate/description.
 * Handles CDATA and basic HTML entity decoding.
 */
function parseRss(xml: string, source: string, maxItems = 30): RawTextItem[] {
  const items: RawTextItem[] = [];
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;
  let count = 0;

  while ((match = itemRegex.exec(xml)) !== null && count < maxItems) {
    const block = match[1];
    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link');
    const pubDate = extractTag(block, 'pubDate');
    const description = extractTag(block, 'description');
    const guid = extractTag(block, 'guid');

    if (!title) continue;

    const ts = pubDate ? Date.parse(pubDate) : Date.now();
    if (isNaN(ts)) continue;

    const id = `${source}_${guid || link || title.slice(0, 60)}`.replace(/\s+/g, '_').slice(0, 200);
    const cleanDesc = description ? stripHtml(description).slice(0, 300) : '';
    const text = cleanDesc ? `${title}. ${cleanDesc}` : title;

    items.push({
      id,
      text,
      source,
      publishedAt: ts,
      url: link || undefined,
      relatedAssets: extractAssetsFromText(text),
    });
    count++;
  }
  return items;
}

function extractTag(block: string, tag: string): string {
  // Match either <tag>...</tag> or <tag><![CDATA[...]]></tag>
  const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i');
  const m = block.match(re);
  if (!m) return '';
  return decodeEntities(m[1].trim());
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Numeric entities (decimal and hex), e.g. &#8217; &#x2019;
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

export async function fetchRssFeed(feed: RssFeed, limit = 30): Promise<RawTextItem[]> {
  try {
    const res = await fetch(feed.url, {
      headers: { 'User-Agent': 'AriaBot/1.0 (+news aggregator)' },
      // Workers fetch has 30s default; keep RSS calls snappy
      cf: { cacheTtl: 60 } as any,
    });
    if (!res.ok) {
      console.warn(`[RSS] ${feed.source} HTTP ${res.status}`);
      return [];
    }
    const xml = await res.text();
    return parseRss(xml, feed.source, limit);
  } catch (err) {
    console.warn(`[RSS] ${feed.source} failed: ${(err as Error).message?.slice(0, 80)}`);
    return [];
  }
}

export async function fetchAllRss(): Promise<RawTextItem[]> {
  const results = await Promise.allSettled(RSS_FEEDS.map((f) => fetchRssFeed(f, 25)));
  const items: RawTextItem[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') items.push(...r.value);
  }
  return items;
}

// ==========================================
// Binance Announcements (free, no auth)
// ==========================================
export async function fetchBinanceAnnouncements(
  limit: number = 20
): Promise<RawTextItem[]> {
  const url = `https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=${limit}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return [];

    const data = (await res.json()) as {
      data: {
        catalogs: {
          articles: {
            id: number;
            title: string;
            releaseDate: number;
          }[];
        }[];
      };
    };

    const articles = data.data?.catalogs?.flatMap((c) => c.articles) || [];

    return articles.map((a) => ({
      id: `binance_${a.id}`,
      text: a.title,
      source: 'binance_announcement',
      publishedAt: a.releaseDate,
      relatedAssets: extractAssetsFromText(a.title),
    }));
  } catch {
    return [];
  }
}

// ==========================================
// Fear & Greed Index (free, no auth)
// ==========================================
export async function fetchFearAndGreed(): Promise<{
  value: number;
  classification: string;
  timestamp: number;
}> {
  const res = await fetch('https://api.alternative.me/fng/?limit=1&format=json');
  if (!res.ok) throw new Error(`Fear&Greed error: ${res.status}`);

  const data = (await res.json()) as {
    data: { value: string; value_classification: string; timestamp: string }[];
  };

  const point = data.data[0];
  return {
    value: parseInt(point.value),
    classification: point.value_classification,
    timestamp: parseInt(point.timestamp) * 1000,
  };
}

// ==========================================
// Helpers
// ==========================================

/** Map of common crypto names/tickers to standard symbols */
const ASSET_MAP: Record<string, string> = {
  bitcoin: 'BTC', btc: 'BTC',
  ethereum: 'ETH', eth: 'ETH', ether: 'ETH',
  solana: 'SOL', sol: 'SOL',
  bnb: 'BNB', binance: 'BNB',
  xrp: 'XRP', ripple: 'XRP',
  dogecoin: 'DOGE', doge: 'DOGE',
  cardano: 'ADA', ada: 'ADA',
  avalanche: 'AVAX', avax: 'AVAX',
  polkadot: 'DOT', dot: 'DOT',
  chainlink: 'LINK', link: 'LINK',
  polygon: 'MATIC', matic: 'MATIC',
  litecoin: 'LTC', ltc: 'LTC',
  toncoin: 'TON', ton: 'TON',
  sui: 'SUI',
};

function extractAssetsFromCategories(categories: string): string[] {
  if (!categories) return [];
  const parts = categories.split('|').map((c) => c.trim().toLowerCase());
  const assets = new Set<string>();
  for (const part of parts) {
    const mapped = ASSET_MAP[part];
    if (mapped) assets.add(mapped);
  }
  return Array.from(assets);
}

function extractAssetsFromText(text: string): string[] {
  const lower = text.toLowerCase();
  const assets = new Set<string>();
  for (const [keyword, symbol] of Object.entries(ASSET_MAP)) {
    if (lower.includes(keyword)) assets.add(symbol);
  }
  return Array.from(assets);
}
