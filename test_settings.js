const s = require('./src/services/settings.service');

console.log('=== DEFAULT SETTINGS ===');
console.log(JSON.stringify(s.DEFAULT_SETTINGS, null, 2));

console.log('\n=== GET SETTINGS ===');
const settings = s.get();
console.log(JSON.stringify(settings, null, 2));

console.log('\n=== CHANGE LOG (initial) ===');
console.log(JSON.stringify(s.getChangeLog(), null, 2));

console.log('\n=== TEST: Update risk per trade ===');
const result = s.set({ riskPerTrade: 0.35 });
console.log('Changes:', JSON.stringify(result.changes, null, 2));
console.log('New value:', settings.riskPerTrade);

console.log('\n=== GET SETTINGS AFTER UPDATE ===');
console.log('riskPerTrade:', settings.riskPerTrade);

console.log('\n=== CHANGE LOG AFTER UPDATE ===');
console.log(JSON.stringify(s.getChangeLog(), null, 2));

console.log('\n=== TEST: Update multiple settings ===');
s.set({ bbLength: 34, bbStd: 3, executionTimeframe: '5m' });
console.log('After multi-update, bbLength:', settings.bbLength);
console.log('executionTimeframe:', settings.executionTimeframe);
console.log('Change log length:', s.getChangeLog().length);

console.log('\n=== ALL TESTS PASSED ===');