const http = require('http');

const server = require('./src/server');

// Wait for server to start, then test
setTimeout(() => {
  // Test health endpoint
  const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/health',
    method: 'GET'
  };

  const req = http.request(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      console.log('Health check:', data);

      // Test settings API
      const settingsReq = http.request({
        hostname: 'localhost',
        port: 3000,
        path: '/api/settings',
        method: 'GET'
      }, (res2) => {
        let data2 = '';
        res2.on('data', chunk => data2 += chunk);
        res2.on('end', () => {
          console.log('Settings GET:', data2);

          // Test settings PUT
          const settingsPut = http.request({
            hostname: 'localhost',
            port: 3000,
            path: '/api/settings',
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' }
          }, (res3) => {
            let data3 = '';
            res3.on('data', chunk => data3 += chunk);
            res3.on('end', () => {
              console.log('Settings PUT:', data3);
              console.log('\nAll API tests completed!');
              process.exit(0);
            });
          });
          settingsPut.on('error', (e) => { console.error('Error:', e); process.exit(1); });
          settingsPut.write(JSON.stringify({ riskPerTrade: 0.35, maxLeverage: 10 }));
          settingsPut.end();
        });
      });
      req.on('error', (e) => { console.error('Error:', e); process.exit(1); });
      req.end();
    });
}, 2000);

server.listen(3000, () => {
  console.log('Server started on port 3000');
});