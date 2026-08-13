const cache = { data: null, at: 0 };
const CACHE_MS = 30 * 60000;

const BULL_WORDS = ['surge', 'rally', 'soar', 'bullish', 'gains', 'breakout', 'record', 'adoption', 'inflow', 'etf', 'all-time high', 'recover', 'jump', 'spike'];
const BEAR_WORDS = ['crash', 'plunge', 'slump', 'sell-off', 'bearish', 'drop', 'falls', 'liquidation', 'ban', 'hack', 'crackdown', 'risk', 'warning', 'outflow', 'fraud', 'sues', 'lawsuit', 'collapse'];

async function fetchText(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms || 12000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('zaman asimi');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFearGreed() {
  const raw = await fetchText('https://api.alternative.me/fng/?limit=1&format=json', 12000);
  const parsed = JSON.parse(raw);
  if (!parsed.data || !parsed.data[0]) throw new Error('Fear&Greed verisi yok');
  return {
    value: parseInt(parsed.data[0].value, 10),
    classification: parsed.data[0].value_classification || 'n/a',
  };
}

function scoreHeadlines(titles) {
  let bull = 0;
  let bear = 0;
  const hits = [];
  for (const t of titles) {
    const tl = t.toLowerCase();
    let matched = false;
    for (const w of BULL_WORDS) {
      if (tl.includes(w)) {
        bull++;
        hits.push({ title: t, word: w, dir: 1 });
        matched = true;
        break;
      }
    }
    if (matched) continue;
    for (const w of BEAR_WORDS) {
      if (tl.includes(w)) {
        bear++;
        hits.push({ title: t, word: w, dir: -1 });
        break;
      }
    }
  }
  const total = bull + bear;
  return { bull, bear, score: total ? (bull - bear) / total : 0, hits: hits.slice(0, 6) };
}

async function fetchBitcoinNews() {
  const q = encodeURIComponent('Bitcoin when:2d');
  const xml = await fetchText(`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`, 15000);
  const titles = [];
  const re = /<item>[\s\S]*?<title>(.*?)<\/title>/g;
  let m;
  while ((m = re.exec(xml))) {
    let t = m[1]
      .replace(/<!\[CDATA\[|\]\]>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
    if (t) titles.push(t);
  }
  return titles.slice(0, 12);
}

async function getSentiment(force) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;

  const result = {
    score: 0,
    label: 'bilinmiyor',
    fearGreed: null,
    headlines: [],
    bull: 0,
    bear: 0,
    headlineScore: 0,
    sources: [],
    error: null,
  };

  try {
    const fg = await fetchFearGreed();
    result.fearGreed = fg;
    result.sources.push('Crypto Fear & Greed Index');
    const fgScore = (fg.value - 50) / 50;

    try {
      const titles = await fetchBitcoinNews();
      result.headlines = titles;
      const hs = scoreHeadlines(titles);
      result.headlineScore = hs.score;
      result.bull = hs.bull;
      result.bear = hs.bear;
      result.hits = hs.hits;
      result.sources.push('Google News (Bitcoin, son 2 gun)');
      result.score = fgScore * 0.6 + hs.score * 0.4;
    } catch (e) {
      result.score = fgScore;
    }

    result.label = result.score > 0.3 ? 'OLUMLU' : result.score < -0.3 ? 'OLUMSUZ' : 'NOTR';
    cache.data = result;
    cache.at = Date.now();
  } catch (e) {
    result.error = e.message;
  }
  return result;
}

module.exports = { getSentiment };