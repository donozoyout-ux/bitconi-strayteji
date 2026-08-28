const env = require('../config/env');
const startup = require('../services/startup');
const settingsService = require('../services/settings.service');
const stateService = require('../services/state.service');

function getRuntime(req, res) {
  const effective = settingsService.get();
  const parity = settingsService.assertConfigParity(effective);
  const gate = startup.getGate();
  const state = stateService.get();

  const orderPipeline = gate && !gate.blockReason && env.useTestnet && !env.emergencyStop
    ? (env.dryRun ? 'SIMULATION' : 'REAL_TESTNET')
    : 'BLOCKED';

  res.status(200).json({
    success: true,
    timestamp: new Date().toISOString(),
    uptimeSec: Math.floor(process.uptime()),
    environment: env.environment,
    deployMode: settingsService.isDeployMode(),
    useTestnet: Boolean(env.useTestnet),
    dryRun: Boolean(env.dryRun),
    emergencyStop: Boolean(env.emergencyStop),
    tradingEnabled: Boolean(env.tradingEnabled),
    adminApiLocked: !Boolean(env.adminApiToken),
    strategy: {
      name: effective.strategy,
      version: effective.strategyVersion,
      executionTimeframe: effective.executionTimeframe,
      higherTimeframe: effective.higherTimeframe,
      regimeTimeframe: effective.regimeTimeframe,
      riskPerTrade: effective.riskPerTrade,
      maxLeverage: effective.maxLeverage,
      shortAdxFloor: effective.shortAdxFloor,
      exitStrategy: effective.exitStrategy,
      trendTrailingAtrMult: effective.trendTrailingAtrMult,
      trendUseTP: effective.trendUseTP,
      trendTimeExitCandles: effective.trendTimeExitCandles,
      slPercent: effective.slPercent,
      commissionRate: effective.commissionRate,
    },
    configParity: {
      ok: parity.ok,
      mismatchCount: parity.mismatches.length,
      mismatches: parity.mismatches,
    },
    startupGate: gate
      ? {
          dbOk: Boolean(gate.dbOk),
          configOk: Boolean(gate.configOk),
          blockReason: gate.blockReason || null,
        }
      : {
          dbOk: false,
          configOk: false,
          blockReason: 'STARTUP_CHECKS_NOT_RUN',
        },
    engine: {
      busy: Boolean(state.busy),
      hasOpenPosition: Boolean(state.position),
      lastError: state.lastError || null,
    },
    orderPipeline,
  });
}

module.exports = { getRuntime };
