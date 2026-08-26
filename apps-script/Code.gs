/**
 * Timesheet Helper — Google Sheets backend.
 *
 * SECURITY — THE SHARED SECRET IS NOT IN THIS FILE, AND MUST NEVER BE PASTED
 * INTO IT. It lives in this script project's own Script Properties, under the
 * key SHARED_SECRET: in the Apps Script editor, Project Settings (the gear
 * icon) → Script properties → Add script property.
 *
 * That is deliberate, and it is why this file is safe to copy in and out of a
 * public repository: the copy you paste here and the copy in the repo are
 * byte-for-byte identical, so there is no local edit that could be committed
 * and published by accident. It also means rotating the secret is a one-field
 * change that takes effect on the very next request — no new deployment
 * version, which is the step everyone forgets.
 *
 * If you are tempted to hardcode it here "just for a minute": that minute is
 * how the secret ends up in a screenshot, a support thread, or a commit. The
 * endpoint is deployed with access "Anyone"; the secret is the only gate on
 * your timesheet data.
 */
var SECRET_PROPERTY = 'SHARED_SECRET';

/** A setup mistake, not a rejected password — and it must not read like one. */
var SECRET_MISSING_ERROR =
  'This Apps Script has no shared secret set yet, so it cannot check requests. ' +
  'In the Apps Script editor open Project Settings (the gear icon) → Script ' +
  'properties → Add script property, name it ' + SECRET_PROPERTY + ', and set ' +
  'it to the same secret you entered in Timesheet Helper\'s connection ' +
  'settings. This is a setup step you have not done yet, not a wrong secret.';

var TABS = ['OTLs','People','StatHolidays','Allocations','Leave','Overrides','Schedule','Meta'];

/**
 * Reads the shared secret per request rather than once at file scope.
 *
 * Apps Script re-evaluates the whole file on every invocation, so a top-level
 * read would pick up a rotated value just as promptly — but it would run
 * BEFORE doGet/doPost is entered, which means a missing property, a missing
 * authorization scope, or a PropertiesService hiccup would surface as an
 * opaque script error instead of the explicit, actionable JSON reply this
 * function makes possible. Keeping the read inside the request also keeps the
 * failure handling in one place. The cost is one property read per request,
 * which is nothing beside the SpreadsheetApp calls that follow.
 *
 * Returns null when the property is unset or empty — never a default, and
 * never a value that could accidentally match a submitted secret.
 */
function getSecret_() {
  var secret = PropertiesService.getScriptProperties().getProperty(SECRET_PROPERTY);
  return (secret === null || secret === '') ? null : secret;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  // Both checks precede every read of the spreadsheet. The rejection never
  // echoes the submitted secret back.
  var secret = getSecret_();
  if (secret === null) return json_({ ok: false, error: SECRET_MISSING_ERROR });
  if (e.parameter.secret !== secret) return json_({ ok: false, error: 'unauthorized' });
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
  // Ordered so that nothing touches the spreadsheet — no lock, no sheet, no
  // clear — until the secret has been checked. The rejection never echoes the
  // submitted secret back.
  var secret = getSecret_();
  if (secret === null) return json_({ ok: false, error: SECRET_MISSING_ERROR });

  var body = JSON.parse(e.postData.contents);
  if (body.secret !== secret) return json_({ ok: false, error: 'unauthorized' });

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
