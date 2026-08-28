const fs = require('fs');
const data = JSON.parse(fs.readFileSync('./reports/btc_usdt_15m_converted.json', 'utf8'));
const candles = data.candles;
console.log('Total candles:', candles.length);
console.log('First timestamp:', candles[0][0]);
console.log('Last timestamp:', candles[candles.length-1][0]);
console.log('First close:', candles[0][4]);
console.log('Last close:', candles[candles.length-1][4]);
console.log('Expected 19604:', candles.length === 19604);