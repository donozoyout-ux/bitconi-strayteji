const db = require('../db');
const logger = require('../utils/logger');

// Statistical report over the recorded strategy decisions + closed trades.
// Pure SQL/aggregation — no AI. Degrades gracefully when the DB is unreachable.
async function getStats(req, res) {
  const rangeDays = Math.min(365, Math.max(1, parseInt(req.query.days) || 30));

  const num = (v) => (v == null ? null : Number(v));
  const empty = () => ({
    success: true,
    rangeDays,
    decisions: { total: 0, breakdown: [], byRegime: [] },
    trades: { total: 0, wins: 0, losses: 0, winRate: 0, totalPnl: null, avgPnl: null },
    waitReasons: [],
    scoreBuckets: [],
    recent: [],
    dbConnected: false,
  });

  try {
    const interval = `NOW() - ${Number(rangeDays)} days`;

    const decisionsRes = await db.query(
      `SELECT decision, COUNT(*) AS cnt, AVG(signal_score) AS avg_score
       FROM strategy_decisions WHERE timestamp > ${interval}
       GROUP BY decision ORDER BY cnt DESC`
    );
    const decisionsTotalRes = await db.query(
      `SELECT COUNT(*) AS total FROM strategy_decisions WHERE timestamp > ${interval}`
    );
    const byRegimeRes = await db.query(
      `SELECT regime, COUNT(*) AS cnt, AVG(signal_score) AS avg_score
       FROM strategy_decisions WHERE timestamp > ${interval} AND regime IS NOT NULL
       GROUP BY regime ORDER BY cnt DESC`
    );

    const tradesRes = await db.query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN pnl_usdt > 0 THEN 1 ELSE 0 END) AS wins,
              SUM(CASE WHEN pnl_usdt <= 0 THEN 1 ELSE 0 END) AS losses,
              SUM(pnl_usdt) AS total_pnl,
              AVG(pnl_usdt) AS avg_pnl,
              AVG(pnl_percent) AS avg_pnl_pct
       FROM trades WHERE exit_time > ${interval}`
    );

    const byRegimeTradesRes = await db.query(
      `SELECT market_regime AS regime, COUNT(*) AS cnt, SUM(pnl_usdt) AS pnl, AVG(pnl_usdt) AS avg_pnl
       FROM trades WHERE exit_time > ${interval} AND market_regime IS NOT NULL
       GROUP BY market_regime ORDER BY pnl DESC NULLS LAST`
    );

    const waitRes = await db.query(
      `SELECT COALESCE(reasons->>'reason', reasons->'filters'->>0) AS reason_label, COUNT(*) AS cnt
       FROM strategy_decisions
       WHERE decision IN ('WAIT','NO_TRADE') AND timestamp > ${interval}
       GROUP BY reason_label ORDER BY cnt DESC`
    );

    const bucketsRes = await db.query(
      `SELECT WIDTH_BUCKET(signal_score, 0, 100, 10) AS bucket,
              COUNT(*) AS cnt, AVG(pnl_usdt) AS avg_pnl
       FROM trades WHERE exit_time > ${interval} AND signal_score IS NOT NULL
       GROUP BY bucket ORDER BY bucket`
    );

    const recentRes = await db.query(
      `SELECT id, decision, signal_score, regime, chop, reasons, timestamp
       FROM strategy_decisions WHERE timestamp > ${interval}
       ORDER BY timestamp DESC LIMIT 25`
    );

    const t = tradesRes.rows[0] || {};
    const totalTrades = num(t.total) || 0;
    const wins = num(t.wins) || 0;

    res.status(200).json({
      success: true,
      rangeDays,
      dbConnected: true,
      decisions: {
        total: num(decisionsTotalRes.rows[0] && decisionsTotalRes.rows[0].total) || 0,
        breakdown: decisionsRes.rows.map((r) => ({
          decision: r.decision,
          cnt: num(r.cnt) || 0,
          avgScore: num(r.avg_score),
        })),
        byRegime: byRegimeRes.rows.map((r) => ({
          regime: r.regime,
          cnt: num(r.cnt) || 0,
          avgScore: num(r.avg_score),
        })),
      },
      trades: {
        total: totalTrades,
        wins,
        losses: num(t.losses) || 0,
        winRate: totalTrades ? Math.round((wins / totalTrades) * 1000) / 10 : 0,
        totalPnl: num(t.total_pnl),
        avgPnl: num(t.avg_pnl),
        avgPnlPct: num(t.avg_pnl_pct),
      },
      tradesByRegime: byRegimeTradesRes.rows.map((r) => ({
        regime: r.regime,
        cnt: num(r.cnt) || 0,
        pnl: num(r.pnl),
        avgPnl: num(r.avg_pnl),
      })),
      waitReasons: waitRes.rows
        .map((r) => ({ reason: r.reason_label || 'DIGER', cnt: num(r.cnt) || 0 }))
        .filter((r) => r.reason),
      scoreBuckets: bucketsRes.rows.map((r) => ({
        bucket: num(r.bucket),
        cnt: num(r.cnt) || 0,
        avgPnl: num(r.avg_pnl),
      })),
      recent: recentRes.rows.map((r) => ({
        id: r.id,
        decision: r.decision,
        score: num(r.signal_score),
        regime: r.regime,
        chop: !!r.chop,
        reason:
          (r.reasons && (r.reasons.reason || (Array.isArray(r.reasons.filters) ? r.reasons.filters[0] : null))) ||
          null,
        ts: r.timestamp,
      })),
    });
  } catch (err) {
    logger.warn('[DECISION-STATS] sorgu basarisiz:', err.message);
    const e = empty();
    e.error = err.message;
    res.status(200).json(e);
  }
}

module.exports = { getStats };
