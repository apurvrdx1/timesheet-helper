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

/**
 * Spec §5: header rows are protected ranges. The app reads a tab by matching
 * its header against the columns it expects, so a stray paste into row 1
 * makes the whole tab unreadable — one capital letter is enough. The
 * protection puts a confirmation in the way of that edit.
 *
 * Warning-only on purpose: the owner of a Sheet can always edit their own
 * protected ranges, so a hard editor lock would change nothing for the one
 * person who can actually break this, while risking locking out a
 * collaborator or the script itself. A warning makes breaking the header a
 * deliberate act rather than an accident, which is what the failure mode
 * needs.
 *
 * Idempotent: every write removes the protection it previously added before
 * adding it again, so repeated pushes never pile up duplicates.
 */
var HEADER_PROTECTION = 'Timesheet Helper header row — the app reads these column names';

function protectHeader_(sheet, width) {
  var existing = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
  for (var i = 0; i < existing.length; i += 1) {
    if (existing[i].getDescription() === HEADER_PROTECTION) existing[i].remove();
  }
  sheet.getRange(1, 1, 1, width)
    .protect()
    .setDescription(HEADER_PROTECTION)
    .setWarningOnly(true);
}

function doPost(e) {
  var body = JSON.parse(e.postData.contents);
  if (body.secret !== SECRET) return json_({ ok: false, error: 'unauthorized' });

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);   // two tabs must never interleave mid-write
  try {
    // Only the tabs the payload actually carries. A tab the app omitted is a
    // tab it could not read and must not replace with nothing — leaving it
    // alone here is half of that guarantee.
    Object.keys(body.payload).forEach(function (name) {
      var rows = body.payload[name];
      var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
      sheet.clear();
      if (rows.length) {
        sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
        sheet.getRange(1, 1, 1, rows[0].length).setFontWeight('bold');
        sheet.setFrozenRows(1);
        protectHeader_(sheet, rows[0].length);
      }
    });
    return json_({ ok: true });
  } finally {
    lock.releaseLock();
  }
}
