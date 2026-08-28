const fs = require('fs');
const c1 = JSON.parse(fs.readFileSync('./full_6month_data.json', 'utf8'));
const c2 = JSON.parse(fs.readFileSync('./reports/btc_usdt_15m_converted.json', 'utf8'));

console.log('full_6month_data:', c1.candles.length, 'candles');
console.log('btc_usdt_15m_converted:', c2.candles.length, 'candles');

const d1 = new Date(c1.candles[0][0]);
const d2 = new Date(c2.candles[0][0]);
console.log('full start:', d1.toISOString());
console.log('converted start:', d2.toISOString());

const d1e = new Date(c1.candles[c1.candles.length-1][0]);
const d2e = new Date(c2.candles[c2.candles.length-1][0]);
console.log('full end:', d1e.toISOString());
console.log('converted end:', d2e.toISOString());

// Check if full dataset starts earlier
console.log('\nFull dataset first 3 candles:');
c1.candles.slice(0, 3).forEach(c => console.log('  ', new Date(c[0]).toISOString(), 'open:', c[1], 'high:', c[2], 'low:', c[3], 'close:', c[4]));

console.log('\nConverted dataset first 3 candles:');
c2.candles.slice(0, 3).forEach(c => console.log('  ', new Date(c[0]).toISOString(), 'open:', c[1], 'high:', c[2], 'low:', c[3], 'close:', c[4]));

// Check if there's overlap or the converted is a subset
console.log('\nFull dataset last 3 candles:');
c1.candles.slice(-3).forEach(c => console.log('  ', new Date(c[0]).toISOString(), 'open:', c[1], 'high:', c[2], 'low:', c[3], 'close:', c[4]));

console.log('\nConverted dataset last 3 candles:');
c2.candles.slice(-3).forEach(c => console.log('  ', new Date(c[0]).toISOString(), 'open:', c[1], 'high:', c[2], 'low:', c[3], 'close:', c[4]));