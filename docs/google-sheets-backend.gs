// BTC Bot Google Sheets backend.
// Usage: create a Google Sheet -> Extensions -> Apps Script -> paste this file.
// Set Script Properties:
//   BOT_SHEETS_SECRET     = same long random value used in Railway
//   BOT_SPREADSHEET_ID    = value between /d/ and /edit in the Google Sheet URL
// Deploy as Web app: Execute as Me, Who has access: Anyone.

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function props_() {
  return PropertiesService.getScriptProperties();
}

function secret_() {
  return props_().getProperty('BOT_SHEETS_SECRET') || '';
}

function spreadsheet_() {
  var id = props_().getProperty('BOT_SPREADSHEET_ID') || '';
  if (!id) throw new Error('BOT_SPREADSHEET_ID missing');
  return SpreadsheetApp.openById(id);
}

function sheet_(name) {
  var ss = spreadsheet_();
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}

function decode_(v) {
  if (typeof v !== 'string') return v;
  var s = v.trim();
  if (!s) return v;
  if ((s[0] === '{' && s[s.length - 1] === '}') || (s[0] === '[' && s[s.length - 1] === ']')) {
    try { return JSON.parse(s); } catch (e) {}
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  return v;
}

function encode_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

function headers_(sh, data) {
  var lastCol = sh.getLastColumn();
  var headers = [];
  if (sh.getLastRow() > 0 && lastCol > 0) {
    headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  }
  var keys = Object.keys(data || {});
  if (!headers.length) {
    headers = keys;
    if (headers.length) sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    return headers;
  }
  var changed = false;
  keys.forEach(function(k) {
    if (headers.indexOf(k) === -1) { headers.push(k); changed = true; }
  });
  if (changed) sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  return headers;
}

function listObjects_(name) {
  var sh = sheet_(name);
  var rows = sh.getDataRange().getValues();
  if (!rows || rows.length < 2) return [];
  var headers = rows[0].map(String);
  return rows.slice(1).filter(function(r) {
    return r.some(function(v) { return v !== ''; });
  }).map(function(r) {
    var o = {};
    headers.forEach(function(h, i) { if (h) o[h] = decode_(r[i]); });
    return o;
  });
}

function append_(name, data) {
  var sh = sheet_(name);
  var headers = headers_(sh, data);
  var row = headers.map(function(h) { return encode_(data[h]); });
  if (headers.length) sh.appendRow(row);
  return { success: true, appended: true };
}

function findRow_(sh, keyField, keyValue) {
  if (sh.getLastRow() < 2 || sh.getLastColumn() < 1) return -1;
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  var col = headers.indexOf(String(keyField));
  if (col < 0) return -1;
  var vals = sh.getRange(2, col + 1, sh.getLastRow() - 1, 1).getValues();
  var target = String(keyValue);
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) === target) return i + 2;
  }
  return -1;
}

function appendUnique_(name, keyField, keyValue, data) {
  var sh = sheet_(name);
  headers_(sh, data);
  var row = findRow_(sh, keyField, keyValue);
  if (row > 0) return { success: true, appended: false, duplicate: true };
  return append_(name, data);
}

function stateGet_(key) {
  var sh = sheet_('STATE');
  headers_(sh, { key: '', value: '', updatedAt: '' });
  var row = findRow_(sh, 'key', key);
  if (row < 0) return { success: true, value: null };
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  var valueCol = headers.indexOf('value');
  return { success: true, value: decode_(sh.getRange(row, valueCol + 1).getValue()) };
}

function stateSet_(key, value) {
  var sh = sheet_('STATE');
  var data = { key: key, value: value, updatedAt: new Date().toISOString() };
  var headers = headers_(sh, data);
  var row = findRow_(sh, 'key', key);
  var values = headers.map(function(h) { return encode_(data[h]); });
  if (row < 0) sh.appendRow(values);
  else sh.getRange(row, 1, 1, headers.length).setValues([values]);
  return { success: true };
}

function pruneByDate_(name, field, before) {
  var sh = sheet_(name);
  if (sh.getLastRow() < 2) return { success: true, deleted: 0 };
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  var col = headers.indexOf(String(field));
  if (col < 0) return { success: true, deleted: 0 };
  var cutoff = new Date(before).getTime();
  var deleted = 0;
  for (var row = sh.getLastRow(); row >= 2; row--) {
    var ts = new Date(sh.getRange(row, col + 1).getValue()).getTime();
    if (!isNaN(ts) && ts < cutoff) { sh.deleteRow(row); deleted++; }
  }
  return { success: true, deleted: deleted };
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!secret_() || body.secret !== secret_()) return json_({ success: false, error: 'UNAUTHORIZED' });
    var action = String(body.action || '');

    if (action === 'health') {
      var ss = spreadsheet_();
      ['STATE','TRADES','ORDERS','DECISIONS','CHECKPOINTS','CANDIDATES'].forEach(sheet_);
      return json_({ success: true, spreadsheetName: ss.getName(), spreadsheetId: ss.getId() });
    }
    if (action === 'state:get') return json_(stateGet_(body.key));
    if (action === 'state:set') return json_(stateSet_(body.key, body.value));
    if (action === 'append') return json_(append_(body.sheet, body.data || {}));
    if (action === 'appendUnique') return json_(appendUnique_(body.sheet, body.keyField, body.keyValue, body.data || {}));
    if (action === 'list') return json_({ success: true, rows: listObjects_(body.sheet) });
    if (action === 'pruneByDate') return json_(pruneByDate_(body.sheet, body.field, body.before));

    return json_({ success: false, error: 'UNKNOWN_ACTION' });
  } catch (err) {
    return json_({ success: false, error: String(err && err.message ? err.message : err) });
  }
}
