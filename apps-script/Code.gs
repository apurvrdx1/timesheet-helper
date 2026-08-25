var SECRET = 'REPLACE_WITH_YOUR_SHARED_SECRET';
var TABS = ['OTLs','People','StatHolidays','Allocations','Leave','Overrides','Schedule','Meta'];

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  if (e.parameter.secret !== SECRET) return json_({ ok: false, error: 'unauthorized' });
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var out = {};
  TABS.forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    out[name] = sheet ? sheet.getDataRange().getDisplayValues() : [];
  });
  return json_({ ok: true, payload: out });
}

function doPost(e) {
  var body = JSON.parse(e.postData.contents);
  if (body.secret !== SECRET) return json_({ ok: false, error: 'unauthorized' });

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);   // two tabs must never interleave mid-write
  try {
    Object.keys(body.payload).forEach(function (name) {
      var rows = body.payload[name];
      var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
      sheet.clear();
      if (rows.length) {
        sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
        sheet.getRange(1, 1, 1, rows[0].length).setFontWeight('bold');
        sheet.setFrozenRows(1);
      }
    });
    return json_({ ok: true });
  } finally {
    lock.releaseLock();
  }
}
