const https = require('https');

function fetchCandles(limit, startTime, endTime) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.binance.com',
      path: `/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=${limit}&startTime=${startTime}&endTime=${endTime}`,
      method: 'GET'
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch(e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const allCandles = [];
  let startTime = 1770672000000; // Feb 11 2026
  let endTime = 1787500800000; // Aug 23 2026
  
  // We'll fetch in batches of 1000
  while (true) {
    const data = await fetchCandles(1000, startTime, endTime);
    if (data.length === 0) break;
    
    // Prepend since API returns newest first
    allCandles.unshift(...data);
    
    // Update startTime for next batch (go earlier)
    startTime = data[data.length - 1][0] - 1;
    
    console.log('Fetched:', data.length, 'candles. Total so far:', allCandles.length);
    
    if (allCandles.length >= 19604) break;
    if (data.length < 1000) break; // no more data
  }
  
  // Deduplicate and trim
  const uniqueTimestamps = new Set();
  const deduped = allCandles.filter(c => {
    if (uniqueTimestamps.has(c[0])) return false;
    uniqueTimestamps.add(c[0]);
    return true;
  });
  
  // Keep only up to 19604 candles, earliest first
  const sorted = deduped.sort((a, b) => a[0] - b[0]);
  const finalCandles = sorted.slice(0, 19604);
  
  const fs = require('fs');
  fs.writeFileSync('C:\\Users\\PC\\OneDrive\\bitconi-strayteji-main\\full_6month_data.json', JSON.stringify({candles: finalCandles}));
  console.log('Final candle count:', finalCandles.length);
  console.log('First timestamp:', new Date(finalCandles[0][0]).toISOString());
  console.log('Last timestamp:', new Date(finalCandles[finalCandles.length-1][0]).toISOString());
}

main().catch(e => { console.error('Error:', e); });