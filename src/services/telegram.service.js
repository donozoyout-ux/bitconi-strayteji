// Telegram Service for Dip Hunter Crypto Bot
// Handles Telegram bot communication for notifications and commands

// Telegram bot configuration
const env = require('../config/env');
const TELEGRAM_BOT_TOKEN = env.telegramBotToken || '';
const TELEGRAM_CHAT_ID = env.telegramChatId || '';

// Bot instance (will be initialized when needed)
let botInstance = null;

// Initialize Telegram bot
function initBot() {
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID && !botInstance) {
    // In production, this would use the Telegram Bot API
    // For now, we'll use the existing webhook-based system
    botInstance = true;
    console.log('Telegram bot initialized');
  }
}

// Send a message to Telegram chat
async function sendTelegramMessage(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[TELEGRAM] Bildirim gönderilemedi: Token veya Chat ID yapılandırmamış');
    console.log('[MESSAGE]', message);
    return { success: false, reason: 'not_configured' };
  }

  // In a real implementation, this would use the Telegram Bot API
  // For now, we'll log the message and return success
  console.log('[TELEGRAM MESSAGE]', message);
  
  // Simulate successful send
  return { success: true };
}

// Format order notification for Telegram
function formatOrderNotification(order) {
  return `<b>${order.action} ${order.symbol}</b>\n`
    + `<b>Fiyat:</b> ${order.averagePrice}\n`
    + `<b>Miktar:</b> ${order.filled}\n`
    + `<b>Toplam:</b> ${order.spent} USDT\n`
    + `<b>Kar/Zarar:</b> ${order.pnl} ${order.pnl >= 0 ? '+' : ''}${order.pnlPercent}%\n`
    + `<b>İdare:</b> ${order.mode}`;
}

// Handle Telegram commands from web panel
function handleTelegramCommand(command) {
  switch (command) {
    case '/start':
      return 'Bot başlatıldı';
    case '/status':
      return 'Sistem durumu: ' + (env.tradingEnabled ? 'AKTIF' : 'KAPALI');
    case '/analiz':
      return 'Son analiz yapılıyor...';
    case '/fiyat':
      return 'Fiyat bilgisi: ' + (env.budgetUsdt || 'Yok');
    case '/signals':
      return 'Sinyal detayları';
    case '/regime':
      return 'Piyasay regimi';
    case '/risk':
      return 'Risk durumu';
    case '/backtest':
        return 'Tarihsel veri yukleme';
    case '/help':
        return 'Yardım: /start, /status, /analiz, /fiyat, /signals, /regime, /risk, /backtest';
    default:
      return 'Bilinmeyen komut';
  }
}

// Get all available commands
function getAvailableCommands() {
  return [
    '/start',
    '/status',
    '/analiz',
    '/fiyat',
    '/signals',
    '/regime',
    '/risk',
    '/backtest',
    '/help'
  ];
}

module.exports = {
  sendTelegramMessage,
  formatOrderNotification,
  handleTelegramCommand,
  getAvailableCommands,
  initBot
};