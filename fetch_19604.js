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
  // Fetch from Feb 11, 2026 to Aug 23, 2026
  // Feb 11 2026 in ms: 1770854400000 (approx)
  // Aug 23 2026 in ms: 1787500800000 (approx)
  const startTime = 1770854400000;
  const endTime = 1787500800000;
  
  const allCandles = [];
  let remaining = 19604;
  let currentStartTime = startTime;
  
  while (remaining > 0) {
    const limit = Math.min(1000, remaining);
    const data = await fetchCandles(limit, currentStartTime, endTime);
    if (data.length === 0) {
      console.log('No more data, breaking. Collected:', allCandles.length);
      break;
    }
    // Binance returns newest first, so we need to reverse or prepend
    // For simplicity, just collect and we'll dedup later
    allCandles.push(...data);
    remaining -= data.length;
    console.log('Fetched batch of', data.length, '. Total so far:', allCandles.length);
    
    // Move startTime back for next batch
    if (data.length > 0) {
      currentStartTime = data[data.length - 1][0] - 1;
    }
    
    if (data.length < 1000) break; // no more data available
  }
  
  // Dedup by timestamp
  const uniqueTimestamps = new Set();
  const deduped = allCandles.filter(c => {
    if (uniqueTimestamps.has(c[0])) return false;
    uniqueTimestamps.add(c[0]);
    return true;
  });
  
  // Sort by timestamp ascending
  const sorted = deduped.sort((a, b) => a[0] - b[0]);
  
  // Keep only first 19604 (earliest)
  const finalCandles = sorted.slice(0, 19604);
  
  const fs = require('fs');
  fs.writeFileSync('C:\\Users\\PC\\OneDrive\\bitconi-strayteji-main\\expected_19604_data.json', JSON.stringify({candles: finalCandles}));
  console.log('\nFinal candle count:', finalCandles.length);
  console.log('First timestamp:', new Date(finalCandles[0][0]).toISOString());
  console.log('Last timestamp:', new Date(finalCandles[finalCandles.length-1][0]).toISOString());
}

main().catch(e => { console.error('Error:', e); });