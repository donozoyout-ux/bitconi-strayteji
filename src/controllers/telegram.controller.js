const telegramService = require('../../services/telegram.service');
const tradingEngine = require('../../services/trading.engine');
const stateService = require('../../services/state.service');
const env = require('../../config/env');
const orderService = require('../../services/order.service');
const logger = require('../../utils/logger');

async function sendTest(req, res) {
  try {
    const result = await telegramService.sendTelegramMessage(
      '<b>Dip Hunter Crypto Bot</b>\nTelegram baglantisi basarili! Test mesaji.'
    );

    if (result.success) {
      return res.status(200).json({ success: true, message: 'Test mesaji gonderildi.' });
    }
    if (result.reason === 'not_configured') {
      return res
        .status(400)
        .json({ success: false, error: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID .env icerisinde tanimli degil.' });
    }
    return res.status(500).json({ success: false, error: result.error });
  } catch (err) {
    logger.error('Telegram test hatasi', { error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
}

async function status(req, res) {
  try {
    const state = stateService.get();
    const regime = state.regime || 'Bilinmiyor';
    const chop = state.chop !== undefined ? (state.chop ? 'CHOPPY' : 'Normal') : 'Bilinmiyor';
    const score = state.lastAnalysis ? state.lastAnalysis.signalScore : 'Yok';
    const decision = state.lastAnalysis ? state.lastAnalysis.decision : 'Yok';

    const message = `🤖 <b>SİSTEM DURUMU</b>\n\n`
      + `<b>Mod:</b> ${env.tradingEnabled ? 'AKTIF' : 'KAPALI'}\n`
      + `<b>Dry Run:</b> ${env.dryRun ? 'SIMULASYON' : 'GERÇEK TESTNET'}\n`
      + `<b>Zaman Çerçevesi:</b> ${env.analysisTimeframe}\n`
      + `<b>Kontrol Aralığı:</b> ${env.checkIntervalMin} dk\n`
      + `<b>Bütçe:</b> ${env.budgetUsdt} USDT\n`
      + `<b>Piyasay Regimi:</b> ${regime}\n`
      + `<b>Chop Durumu:</b> ${chop}\n`
      + `<b>Sinyal Skoru:</b> ${score}\n`
      + `<b>Karar:</b> ${decision}\n`
      + `<b>Pozisyon:</b> ${state.position ? 'AÇIK' : 'YOK'}\n`
      + `<b>Güncel Fiyat:</b> ${state.price || 'Yok'}\n`
      + `<b>Son Kontrol:</b> ${state.lastCheck ? new Date(state.lastCheck).toLocaleString('tr-TR') : 'Yok'}\n`
      + `<b>Risk Durumu:</b> ${state.riskCheck ? state.riskCheck.reason : 'Bilgi yok'}`;

    await telegramService.sendTelegramMessage(message);

    return res.status(200).json({ success: true, message: 'Durum gönderildi.' });
  } catch (err) {
    logger.error('Telegram status hatasi', { error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
}

async function analyzeNow(req, res) {
  try {
    stateService.update({ busy: false });
    await tradingEngine.runCycle();
    const state = stateService.get();

    const message = `📊 <b>SON ANALİZ</b>\n\n`
      + `<b>Sinyal:</b> ${state.lastAnalysis ? state.lastAnalysis.signal : 'Yok'}\n`
      + `<b>Sinyal Tipi:</b> ${state.lastAnalysis ? state.lastAnalysis.entryType : 'Yok'}\n`
      + `<b>Fiyat:</b> ${state.lastAnalysis ? state.lastAnalysis.price : 'Yok'}\n`
      + `<b>Regime:</b> ${state.lastAnalysis ? state.lastAnalysis.regime : 'Yok'}\n`
      + `<b>Chop:</b> ${state.lastAnalysis ? (state.lastAnalysis.chop ? 'EVET' : 'HAYIR') : 'Yok'}\n`
      + `<b>Crossover Count:</b> ${state.lastAnalysis ? state.lastAnalysis.crossoverCount : 'Yok'}\n`
      + `<b>Valid Crossovers:</b> ${state.lastAnalysis ? state.lastAnalysis.validCrossovers : 'Yok'}\n`
      + `<b>BB Width:</b> ${state.lastAnalysis ? state.lastAnalysis.bbWidth : 'Yok'}\n`
      + `<b>BB Squeeze:</b> ${state.lastAnalysis ? (state.lastAnalysis.bbSqueeze ? 'EVET' : 'HAYIR') : 'Yok'}\n`
      + `<b>Adx:</b> ${state.lastAnalysis ? state.lastAnalysis.adx : 'Yok'}\n`
      + `<b>Dı Ok:</b> ${state.lastAnalysis ? (state.lastAnalysis.diOk ? 'EVET' : 'HAYIR') : 'Yok'}\n`
      + `<b>Makro:</b> ${state.lastAnalysis ? state.lastAnalysis.trendUp : 'Yok'}\n`
      + `<b>Hist:</b> ${state.lastAnalysis ? state.lastAnalysis.macdHist : 'Yok'}\n`
      + `<b>Hist Rising:</b> ${state.lastAnalysis ? state.lastAnalysis.histRising : 'Yok'}\n`
      + `<b>Support Touch:</b> ${state.lastAnalysis ? (state.lastAnalysis.supportTouch ? 'EVET' : 'HAYIR') : 'Yok'}\n`
      + `<b>Resistance:</b> ${state.lastAnalysis ? state.lastAnalysis.resistance : 'Yok'}\n`
      + `<b>Squeeze:</b> ${state.lastAnalysis ? state.lastAnalysis.squeeze : 'Yok'}\n`
      + `<b>Breakout:</b> ${state.lastAnalysis ? state.lastAnalysis.breakoutCond : 'Yok'}\n`
      + `<b>Pullback:</b> ${state.lastAnalysis ? state.lastAnalysis.pullbackCond : 'Yok'}\n`
      + `<b>Fib Levels:</b> ${state.lastAnalysis ? state.lastAnalysis.fibLevels : 'Yok'}\n`
      + `<b>Psych Block:</b> ${state.lastAnalysis ? (state.lastAnalysis.psychBlock ? 'EVET' : 'HAYIR') : 'Yok'}\n`
      + `<b>Stop Price:</b> ${state.lastAnalysis ? state.lastAnalysis.stopPrice : 'Yok'}\n`
      + `<b>TP1:</b> ${state.lastAnalysis ? state.lastAnalysis.tp1 : 'Yok'}\n`
      + `<b>TP2:</b> ${state.lastAnalysis ? state.lastAnalysis.tp2 : 'Yok'}\n`
      + `<b>Price:</b> ${state.lastAnalysis ? state.lastAnalysis.price : 'Yok'}\n`
      + `<b>Rejection Reason:</b> ${state.lastAnalysis ? state.lastAnalysis.rejectionReasons : 'Yok'}`;

    await telegramService.sendTelegramMessage(message);

    return res.status(200).json({ success: true, message: 'Analiz gönderildi.', analysis: state.lastAnalysis });
  } catch (err) {
    logger.error('Telegram analyze hatasi', { error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
}

async function riskInfo(req, res) {
  try {
    const riskEngine = require('../services/risk-engine');
    const riskCheck = riskEngine.checkRisk(100000, 98000, 'LONG', 100000);

    const message = `⚠️ <b>RİSK ENGİNİ</b>\n\n`
      + `<b>Risk Kontrolü:</b> ${riskCheck.allowed ? 'ONAYLI' : 'REDDEDILDI'}\n`
      + `<b>Neden:</b> ${riskCheck.reason}\n`
      + `<b>Risk Bütçesi:</b> ${riskCheck.riskBudget} USDT\n`
      + `<b>Leverage:</b> ${riskCheck.leverage}x\n`
      + `<b>Stop Distansı:</b> ${riskCheck.stopDistance}\n`
      + `<b>Pozisyon Büyüklüğü:</b> ${riskCheck.positionSize}\n`
      + `<b>Günlük Kayıp Limit:</b> ${riskEngine.DEFAULT_RISK.maxDailyLoss} TRY\n`
      + `<b>Ardıza Zarar S.S.:</b> ${riskEngine.DEFAULT_RISK.maxConsecutiveLosses}\n`
      + `<b>Günlük Trade S.S.:</b> ${riskEngine.DEFAULT_RISK.maxTradesPerDay}\n`
      + `<b>Cooldown Kalan:</b> ${riskCheck.cooldownMin} dk`;

    await telegramService.sendTelegramMessage(message);

    return res.status(200).json({ success: true, message: 'Risk bilgisi gönderildi.', riskCheck });
  } catch (err) {
    logger.error('Telegram risk hatasi', { error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
}

async function help(req, res) {
  const message = `🛟 <b>Dip Hunter Bot - Telegram Komutları</b>\n\n`
    + `<b>/start</b> - Botu başlat/kapat\n`
    + `<b>/status</b> - Sistem durumunu göster\n`
    + `<b>/analiz</b> - Son analizi gönder\n`
    + `<b>/fiyat</b> - Güncel fiyat bilgisi\n`
    + `<b>/signals</b> - Sinyal detayları\n`
    + `<b>/regime</b> - Piyasay regimine\n`
    + `<b>/risk</b> - Risk durumu\n`
    + `<b>/backtest</b> - Tarihsel veri yükleme\n`
    + `<b>/help</b> - Bu yardım>\n\n`
    + `<i>Sistem: Dip Hunter Crypto Bot</i>`;

    await telegramService.sendTelegramMessage(message);

    return res.status(200).json({ success: true, message: 'Yardım gönderildi.' });
}

module.exports = { sendTest, status, analyzeNow, riskInfo, help };