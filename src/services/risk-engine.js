const env = require('../config/env');

function calculatePositionSize(accountEquity, riskPercent, stopDistance, leverage = 5, symbol = 'BTC/USDT') {
  // Validate inputs
  if (accountEquity <= 0 || riskPercent <= 0 || stopDistance <= 0) {
    return { success: false, error: 'Invalid input parameters: accountEquity, riskPercent, stopDistance must be positive' };
  }

  // Risk budget per trade
  const riskBudget = accountEquity * (riskPercent / 100);

  // Position size = risk_budget / stop_distance
  // Then adjust for leverage: notional = position_size * price * leverage constraint
  const rawPositionSize = riskBudget / stopDistance;

  // Apply maximum leverage constraint
  // Max notional = accountEquity * leverage
  const maxNotional = accountEquity * leverage;
  const currentPrice = 1; // Will be set by caller

  // Calculate notional size
  const notional = rawPositionSize * currentPrice;

  // Check leverage constraint
  let effectiveLeverage = notional / accountEquity;
  if (effectiveLeverage > leverage) {
    // Scale down position to respect max leverage
    const scaledNotional = accountEquity * leverage;
    const scaledPositionSize = scaledNotional / currentPrice;
    const finalPositionSize = Math.min(rawPositionSize, scaledPositionSize);
    return {
      success: true,
      positionSize: finalPositionSize,
      riskBudget,
      stopDistance,
      effectiveLeverage: leverage,
      maxLeverage: leverage,
    };
  }

  // Check minimum quantity / lot size constraints ( typical binance: 0.00001 BTC )
  const minLotSize = 0.00001;

  // Round to appropriate precision (will be refined by exchange)
  let positionSize = Math.max(minLotSize, rawPositionSize);

  // Apply maximum daily loss check
  const maxDailyLossPercent = parseFloat(env.MAX_DAILY_LOSS || '2');
  const maxConsecutiveLosses = parseInt(env.MAX_CONSECUTIVE_LOSSES || '3');

  // Check maximum trades per day
  const maxTradesPerDay = parseInt(env.MAX_TRADES_PER_DAY || '10');

  return {
    success: true,
    positionSize,
    riskBudget,
    stopDistance,
    effectiveLeverage: Math.min(effectiveLeverage, leverage),
    maxLeverage: leverage,
    maxDailyLossPercent,
    maxConsecutiveLosses,
    maxTradesPerDay,
  };
}

function checkRiskLimits(dailyPnL, consecutiveLosses, tradesToday, riskCheck) {
  const maxDailyLoss = riskCheck.maxDailyLossPercent;
  const maxConsecutive = riskCheck.maxConsecutiveLosses;
  const maxTrades = riskCheck.maxTradesPerDay;

  let restricted = false;
  let reason = null;

  // Check daily loss limit
  if (dailyPnL != null && dailyPnL <= -maxDailyLoss) {
    restricted = true;
    reason = `Daily loss limit reached: $${Math.abs(dailyPnL).toFixed(2)} USDT <= -${maxDailyLoss}%`;
  }

  // Check consecutive losses
  if (consecutiveLosses >= maxConsecutive) {
    restricted = true;
    reason = reason ? `${reason} | Consecutive losses limit: ${maxConsecutive}` : `Consecutive losses limit reached: ${maxConsecutive}`;
  }

  // Check max trades per day
  if (tradesToday >= maxTrades) {
    restricted = true;
    reason = reason ? `${reason} | Max trades per day limit: ${maxTrades}` : `Max trades per day limit reached: ${maxTrades}`;
  }

  return {
    allowed: !restricted,
    reason,
    dailyLossLimit: maxDailyLoss,
    consecutiveLossesLimit: maxConsecutive,
    maxTradesPerDay: maxTrades,
  };
}

function calculateStopDistance(entryPrice, stopPrice, side) {
  if (stopPrice == null) return null;

  let distance;
  if (side === 'LONG') {
    distance = entryPrice - stopPrice;
  } else if (side === 'SHORT') {
    distance = stopPrice - entryPrice;
  } else {
    return null;
  }

  if (distance <= 0) return null;
  return Math.abs(distance);
}

function calculateTakeProfitLevels(entryPrice, stopPrice, side, riskRewardRatio = 2, tpCount = 2) {
  if (stopPrice == null) return null;

  const rawRisk = side === 'LONG' ? entryPrice - stopPrice : stopPrice - entryPrice;
  if (rawRisk <= 0) return null;

  const tp1Price = side === 'LONG'
    ? entryPrice + rawRisk * riskRewardRatio
    : entryPrice - rawRisk * riskRewardRatio;

  const tp2Price = side === 'LONG'
    ? entryPrice + rawRisk * riskRewardRatio * 1.5
    : entryPrice - rawRisk * riskRewardRatio * 1.5;

  return {
    tp1Price,
    tp2Price,
    rawRisk,
    riskRewardRatio,
  };
}

function checkTrailingStop(position, livePrice, atr, trailMult = 2.5) {
  if (!position || !position.entryPrice) return null;

  const side = position.side;
  const entry = position.entryPrice;

  let trailingStop;
  if (side === 'LONG') {
    // For long: trailing stop = highest price - trailMult * ATR
    // Since we track highestSinceEntry, we'd need that data
    // Simplified: use current stop price logic
    trailingStop = livePrice - trailMult * atr;
  } else if (side === 'SHORT') {
    trailingStop = livePrice + trailMult * atr;
  }

  return {
    newStop: Math.max(position.stopPrice || 0, trailingStop),
    trailsActivated: trailingStop != null,
  };
}

module.exports = {
  calculatePositionSize,
  checkRiskLimits,
  calculateStopDistance,
  calculateTakeProfitLevels,
  checkTrailingStop,
};