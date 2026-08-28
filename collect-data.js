const fs = require('fs');

const SYMBOL = 'BTCUSDT';
const INTERVAL = '15m';
const LIMIT = 1000;

let allCandles = [];
let totalFetched = 0;
let requestNum = 0;

const START_DATE = new Date('2026-02-01T00:00:00.000Z').getTime();

console.log('Starting paginated collection:');
console.log('From:', new Date(START_DATE).toISOString());
console.log('Batch size:', LIMIT);
console.log('Fetching 6 months (~90 days) of 15m data, ~1000 candles/batch');
console.log('Expected batches: ~13 (90 days * 24/4 / 1000 ≈ 5.4, but with gaps/overlap may need more)');
console.log('');

// Async batch fetcher
async function fetchBatch(startTime) {
  requestNum++;
  const url = 'https://data-api.binance.vision/api/v3/klines?symbol=' + SYMBOL + '&interval=' + INTERVAL + '&limit=' + LIMIT + '&startTime=' + startTime;
  console.log('Request', requestNum, ': fetching from', new Date(startTime).toISOString().substring(0,16));
  const res = await fetch(url, { timeout: 60000 });
  if (!res.ok) {
    console.log('HTTP', res.status, 'error - stopping pagination');
    return [];
  }
  const data = await res.json();
  return data;
}

// Recursive fetcher
async function fetchAllBatches(startTime) {
  let batch = await fetchBatch(startTime);
  
  if (!batch || batch.length === 0) {
    console.log('No more data fetchable at', new Date(startTime).toISOString());
    return;
  }
  
  // Binance returns DESC, reverse to ASC
  batch = batch.reverse();
  
  // Number() normalization
  const normalized = batch.map(c => ({
    timestamp: Number(c[0]),
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[5])
  }));
  
  // Validity check
  let valid = true;
  for (const c of normalized) {
    if (!Number.isFinite(c.open) || !Number.isFinite(c.high) || !Number.isFinite(c.low) || !Number.isFinite(c.close) || !Number.isFinite(c.volume)) {
      valid = false;
      break;
    }
  }
  
  if (!valid) {
    console.log('Invalid data at batch', requestNum, '- stopping');
    return;
  }
  
  // Add to collection (candles are in ASC order now since we reverse each batch)
  // But we need to ensure chronological order across batches
  // The new batch's last candle should be just before the first batch's first candle
  if (allCandles.length > 0) {
    // Check for overlap/continuity
    const lastExisting = allCandles[allCandles.length-1].timestamp;
    const firstNew = normalized[0].timestamp;
    if (firstNew >= lastExisting) {
      // There's a gap or overlap - just concat
      allCandles = allCandles.concat(normalized);
    } else {
      // Overlap - only add candles that are before the existing data
      const uniqueNew = normalized.filter(c => c.timestamp < allCandles[0].timestamp);
      allCandles = uniqueNew.concat(allCandles);
    }
  } else {
    allCandles = normalized;
  }
  
  totalFetched += batch.length;
  console.log('Batch', requestNum, ': ', batch.length, 'candles (total valid:', allCandles.length + ', running total fetched:', totalFetched + ')');
  console.log('  Range:', new Date(normalized[0].timestamp).toISOString().substring(0,16), 'to', new Date(normalized[normalized.length-1].timestamp).toISOString().substring(0,16));
  
  // Continue fetching with startTime just before the first candle of this batch
  const nextStartTime = normalized[0].timestamp - 1;
  
  if (nextStartTime > 0 && requestNum < 50) {  // safety limit
    await fetchAllBatches(nextStartTime);
  } else {
    console.log('Reached batch limit or early date, stopping');
    console.log('Total batches:', requestNum);
    console.log('Total fetched:', totalFetched);
    console.log('Valid candles in collection:', allCandles.length);
    
    // Save data
    const data = {
      candles: allCandles,
      fetched: totalFetched,
      firstTimestamp: allCandles.length > 0 ? allCandles[0].timestamp : null,
      lastTimestamp: allCandles.length > 0 ? allCandles[allCandles.length-1].timestamp : null,
      dateRange: allCandles.length > 0 ? [new Date(allCandles[0].timestamp).toISOString(), new Date(allCandles[allCandles.length-1].timestamp).toISOString()] : null,
      batchCount: requestNum
    };
    fs.writeFileSync('reports/btc_usdt_15m_3m6m_raw.json', JSON.stringify(data, null, 2));
    console.log('\\nData saved to reports/btc_usdt_15m_3m6m_raw.json');
    console.log('First candle:', allCandles.length > 0 ? new Date(allCandles[0].timestamp).toISOString() : 'none');
    console.log('Last candle:', allCandles.length > 0 ? new Date(allCandles[allCandles.length-1].timestamp).toISOString() : 'none');
    console.log('Total unique valid candles:', allCandles.length);
  }
}

// Start the fetch chain
fetchAllBatches(START_DATE);