# Google Sheets backend (Apps Script)

This lets Timesheet Helper read and write its data to a Google Sheet, using a
tiny Apps Script web app as the bridge. The web app is the only thing that
needs deploying — the React app talks to it over plain HTTP.

## 1. Create the spreadsheet and the script

1. Create a new Google Sheet (or open the one you want Timesheet Helper to use).
2. In the Sheet, open **Extensions → Apps Script**. This creates a script
   project bound to the spreadsheet — the script's `SpreadsheetApp.getActiveSpreadsheet()`
   calls will always refer back to this Sheet.
3. Delete the default `Code.gs` boilerplate and paste in the contents of
   [`Code.gs`](./Code.gs) from this repo.

## 2. Set your own secret

Open the pasted script and find this line near the top:

```javascript
var SECRET = 'REPLACE_WITH_YOUR_SHARED_SECRET';
```

Replace `REPLACE_WITH_YOUR_SHARED_SECRET` with a random string only you know
(a password manager's "generate password" feature works well). This secret is
the only thing standing between your spreadsheet and anyone who finds the
deployment URL, since the web app itself is deployed as publicly reachable —
treat it like a password.

Save the script (**File → Save**, or Cmd/Ctrl+S).

## 3. Deploy as a web app

1. Click **Deploy → New deployment**.
2. Next to "Select type", click the gear icon and choose **Web app**.
3. Set:
   - **Execute as:** Me (your account)
   - **Who has access:** Anyone
4. Click **Deploy**, then authorize the script when Google prompts you.
5. Copy the **Web app URL** — it looks like
   `https://script.google.com/macros/s/AKfycb.../exec`. This is the URL
   (`location`) and the value you typed into `SECRET` (the `secret`) that you
   will enter into Timesheet Helper's connection settings.

## 4. Redeploying after you edit the script

**This is the step that catches people out every time:** editing the code in
the Apps Script editor and saving it does **not** update the live web app URL.
Apps Script deployments are frozen snapshots. To push a code change live:

1. Click **Deploy → Manage deployments**.
2. Click the pencil/edit icon on your existing deployment.
3. Under **Version**, choose **New version**.
4. Click **Deploy**.

The web app URL stays the same — you do not need to update it in Timesheet
Helper's settings after a redeploy, only after creating a brand-new
deployment.

## 5. Data layout

The script reads and writes eight tabs by name: `OTLs`, `People`,
`StatHolidays`, `Allocations`, `Leave`, `Overrides`, `Schedule`, `Meta`. You
don't need to create these tabs yourself — the first write from Timesheet
Helper creates any that are missing, sets bold header rows, and freezes row 1.
If a tab doesn't exist yet when the app reads, it's simply treated as empty.

## 6. Troubleshooting

- **"unauthorized" errors:** the `secret` sent by the app doesn't match
  `SECRET` in the script. Double-check you copied it exactly (no leading/
  trailing spaces) into Timesheet Helper's settings.
- **Requests fail entirely / CORS-like errors:** confirm the deployment's
  "Who has access" is set to **Anyone**, and that you redeployed a **new
  version** after any script edit (see step 4).
- **Changes to the script aren't showing up:** see step 4 — you edited but
  didn't create a new deployment version.
