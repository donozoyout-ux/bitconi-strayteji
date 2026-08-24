const env = require('../config/env');
const analyzer = require('../services/analyzer.service');
const newsService = require('../services/news.service');

let cache = { data: null, at: 0 };
const CACHE_MS = 5 * 60000;

async function buildReport() {
  const tech = await analyzer.runFullAnalysis(env.tradingSymbol, env.analysisTimeframe, {
    oversoldLevel: env.oversoldLevel,
    useRsi2: env.useRsi2,
  });
  const news = await newsService.getSentiment();

  const scores = {
    technical: tech.technicals.total,
    chart: tech.chart.total,
    news: news.score,
  };
  scores.overall = scores.technical * 0.45 + scores.chart * 0.3 + scores.news * 0.25;

  return {
    symbol: tech.symbol,
    timeframe: tech.timeframe,
    ts: tech.ts,
    ranAt: Date.now(),
    price: tech.price,
    signal: tech.signal,
    technicals: tech.technicals,
    patterns: tech.patterns,
    structure: tech.structure,
    chart: tech.chart,
    news,
    scores,
    verdict: analyzer.verdictFor(scores.overall),
  };
}

async function getAnalysis(req, res) {
  try {
    const force = req.query.force === '1';
    if (force || !cache.data || Date.now() - cache.at > CACHE_MS) {
      cache.data = await buildReport();
      cache.at = Date.now();
    }
    res.status(200).json({ success: true, ...cache.data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = { getAnalysis, buildReport };