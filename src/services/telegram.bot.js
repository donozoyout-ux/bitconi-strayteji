const env = require('../config/env');
const logger = require('../utils/logger');
const stateService = require('./state.service');
const exchange = require('../config/binance');
const { buildReport } = require('../controllers/analysis.controller');

const API = 'https://api.telegram.org/bot';
let offset = 0;
let polling = false;

const HELP_TEXT = [
  '<b>Dip Hunter Crypto Bot - Komutlar</b>',
  '/durum - Motor ve pozisyon durumu',
  '/analiz - Strateji analizi (teknik + grafik + haber)',
  '/fiyat - Guncel BTC fiyati ve Bollinger seviyeleri',
  '/sifirla - Motor durumunu sifirla',
  '/yardim - Bu mesaj',
].join('\n');

async function api(method, params) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`${API}${env.telegramBotToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: controller.signal,
    });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function send(chatId, text) {
  const data = await api('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
  if (!data.ok) throw new Error(data.description || 'sendMessage basarisiz');
}

async function formatStatus() {
  const st = stateService.get();
  const lines = [];
  lines.push('<b>Dip Hunter Crypto Bot - Durum</b>');
  lines.push('Mod: ' + (env.dryRun ? 'DRY-RUN' : 'GERCEK TESTNET'));
  try {
    const b = await exchange.fetchBalance();
    const usdt = b.USDT ? b.USDT.total : 0;
    const btc = b.BTC ? b.BTC.total : 0;
    lines.push(`Bakiye: ${usdt.toFixed(2)} USDT | ${btc.toFixed(6)} BTC`);
  } catch (e) {
    lines.push('Bakiye alinamadi: ' + e.message);
  }

  if (st.position) {
    const entry = Number(st.position.entryPrice);
    const tp = entry * (1 + env.tpPercent / 100);
    const sl = entry * (1 - env.slPercent / 100);
    lines.push('<b>POZISYON ACIK</b>');
    lines.push(`Giris: ${entry.toFixed(2)} USDT | Miktar: ${st.position.quantity} BTC`);
    lines.push(`TP: ${tp.toFixed(2)} | SL: ${sl.toFixed(2)}`);
  } else {
    lines.push('Pozisyon: FLAT (yok)');
  }

  const last = st.lastAnalysis || {};
  lines.push('Sinyal: ' + (last.signal ? '<b>BUY SINYALI</b>' : 'yok'));

  if (st.lastReport && st.lastReport.scores) {
    const s = st.lastReport.scores;
    lines.push(
      `Strateji: Teknik %${Math.round(s.technical * 100)} | Grafik %${Math.round(s.chart * 100)} | Haber %${Math.round(s.news * 100)}`
    );
    lines.push('Verdict: ' + (st.lastReport.verdict || '-'));
  }
  if (st.lastCheck) lines.push('Son kontrol: ' + new Date(st.lastCheck).toLocaleString('tr-TR'));
  if (st.lastError) lines.push('Son hata: ' + st.lastError);
  return lines.join('\n');
}

async function formatAnalysis() {
  const d = await buildReport();
  const s = d.scores;
  const pct = (v) => Math.round(v * 100) + '%';
  const lines = [];
  lines.push('<b>Strateji Analizi</b>');
  lines.push('Parite: ' + d.symbol + ' (' + d.timeframe + ')');
  lines.push('Fiyat: ' + Number(d.price).toFixed(2) + ' USDT');
  lines.push('Teknik: ' + pct(s.technical) + ' | Grafik: ' + pct(s.chart));
  lines.push('Haber: ' + pct(s.news) + ' | Genel: ' + pct(s.overall));
  lines.push('Karar: ' + d.verdict);
  const t = d.technicals.details;
  if (t) lines.push(`RSI: ${t.rsi != null ? t.rsi.toFixed(1) : '-'} | MACD hist: ${t.macdHist != null ? t.macdHist.toFixed(1) : '-'}`);
  if (d.patterns && d.patterns.length) lines.push('Formasyon: ' + d.patterns.map((p) => p.name).join(', '));
  lines.push('Trend: ' + (d.structure ? d.structure.trend : '-'));
  const news = d.news || {};
  lines.push('Haber duygu: ' + (news.label || '-') + (news.fearGreed ? ' | Fear&Greed: ' + news.fearGreed.value + ' (' + news.fearGreed.classification + ')' : ''));
  if (d.signal) lines.push('<b>BUY SINYALI VAR</b>');
  return lines.join('\n');
}

async function formatPrice() {
  const ticker = await exchange.fetchTicker(env.tradingSymbol);
  const last = ticker.last;
  const st = stateService.get();
  const lastAn = st.lastAnalysis || {};
  const lines = [];
  lines.push('<b>BTC/USDT</b>');
  lines.push('Canli fiyat: ' + Number(last).toFixed(2) + ' USDT');
  lines.push('Son mum kapanis: ' + (lastAn.close != null ? Number(lastAn.close).toFixed(2) : '-'));
  lines.push('Bollinger alt bant: ' + (lastAn.bbLower != null ? Number(lastAn.bbLower).toFixed(2) : '-'));
  lines.push('Bollinger orta: ' + (lastAn.bbMiddle != null ? Number(lastAn.bbMiddle).toFixed(2) : '-'));
  return lines.join('\n');
}

async function handleCommand(chatId, cmd) {
  let text;
  switch (cmd) {
    case '/start':
    case '/yardim':
    case '/help':
      text = HELP_TEXT;
      break;
    case '/durum':
    case '/status':
      text = await formatStatus();
      break;
    case '/analiz':
    case '/analysis':
      text = await formatAnalysis();
      break;
    case '/fiyat':
    case '/price':
      text = await formatPrice();
      break;
    case '/sifirla':
    case '/reset':
      stateService.reset();
      text = 'Motor durumu sifirlandi.';
      break;
    default:
      text = 'Bilinmeyen komut. /yardim yazin.';
  }
  await send(chatId, text);
}

async function pollOnce() {
  const data = await api('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
  if (!data.ok) {
    logger.warn('Telegram getUpdates basarisiz: ' + (data.description || 'bilinmiyor'));
    return;
  }
  for (const u of data.result || []) {
    if (u.update_id >= offset) offset = u.update_id + 1;
    const msg = u.message;
    if (!msg || !msg.text || !msg.chat) continue;
    if (!msg.text.startsWith('/')) continue;
    const cmd = msg.text.split(/\s+/)[0].split('@')[0].toLowerCase();
    logger.info('Telegram komutu: ' + cmd + ' (chat ' + msg.chat.id + ')');
    try {
      await handleCommand(msg.chat.id, cmd);
    } catch (err) {
      logger.error('Telegram komut hatasi', { error: err.message });
      try {
        await send(msg.chat.id, 'Komut islenirken hata olustu: ' + err.message);
      } catch (e) {}
    }
  }
}

function start() {
  if (!env.telegramBotToken || !env.telegramChatId) {
    logger.warn('Telegram bilgileri eksik; komut dinleyici baslatilmadi.');
    return;
  }
  if (polling) return;
  polling = true;
  logger.info('Telegram bot komut dinleyici baslatildi.');
  const loop = async () => {
    if (!polling) return;
    try {
      await pollOnce();
    } catch (err) {
      logger.warn('Telegram polling hatasi: ' + err.message);
    }
    setTimeout(loop, 1000);
  };
  loop();
}

function stop() {
  polling = false;
}

module.exports = { start, stop, handleCommand };