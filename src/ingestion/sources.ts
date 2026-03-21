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
// ==========================================
const REDDIT_SUBS = ['cryptocurrency', 'bitcoin', 'ethtrader', 'CryptoMarkets'];

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

  return data.data.children.map((post) => ({
    id: `reddit_${post.data.id}`,
    text: `${post.data.title}. ${(post.data.selftext || '').slice(0, 200)}`,
    source: `reddit_${subreddit}`,
    publishedAt: post.data.created_utc * 1000,
    url: `https://reddit.com${post.data.permalink}`,
    categories: [`score:${post.data.score}`, `comments:${post.data.num_comments}`],
  }));
}

export async function fetchAllReddit(): Promise<RawTextItem[]> {
  const results: RawTextItem[] = [];
  for (const sub of REDDIT_SUBS) {
    try {
      const posts = await fetchRedditPosts(sub, 15);
      results.push(...posts);
    } catch {
      // Silently skip failed subreddits
    }
    await new Promise((r) => setTimeout(r, 1000)); // Rate limit
  }
  return results;
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
