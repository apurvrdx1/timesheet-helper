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

The secret is **not** written into `Code.gs`. It lives in the script project's
own Script Properties, and the script reads it from there:

1. In the Apps Script editor, open **Project Settings** (the gear icon in the
   left sidebar).
2. Scroll to **Script properties** and click **Add script property**.
3. **Property:** `SHARED_SECRET`
   **Value:** a random string only you know (a password manager's "generate
   password" feature works well).
4. Click **Save script properties**.

This is the same value you will type into Timesheet Helper's connection
settings. It is the only thing standing between your spreadsheet and anyone who
finds the deployment URL, since the web app is deployed as publicly reachable —
treat it like a password.

> **Never paste the secret into `Code.gs`.** This repository is public
> (<https://github.com/apurvrdx1/timesheet-helper>). A secret typed into the
> script file is one careless `git commit` away from being published, and
> anyone who finds it can read and rewrite your timesheet Sheet.

Two things this buys you beyond keeping the file safe to share:

- **Rotation is immediate.** Change the property value, update Timesheet
  Helper's settings, done — it applies to the very next request. A hardcoded
  constant would need a fresh deployment version (step 4), which is the step
  everyone forgets.
- **Nothing sensitive is on screen.** You can share, screenshot or screen-share
  the script editor without leaking anything; the property value is not part of
  the code.

Save the script (**File → Save**, or Cmd/Ctrl+S).

If you skip this step, the script does not fail with "unauthorized" — it
answers with an explicit message telling you the `SHARED_SECRET` script
property has not been set and where to set it.

## 3. Deploy as a web app

1. Click **Deploy → New deployment**.
2. Next to "Select type", click the gear icon and choose **Web app**.
3. Set:
   - **Execute as:** Me (your account)
   - **Who has access:** Anyone
4. Click **Deploy**, then authorize the script when Google prompts you.
5. Copy the **Web app URL** — it looks like
   `https://script.google.com/macros/s/AKfycb.../exec`. This is the URL
   (`location`); together with the `SHARED_SECRET` value from step 2 (the
   `secret`), it is what you enter into Timesheet Helper's connection
   settings.

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
Helper creates any that are missing, sets bold header rows, freezes row 1, and
protects the header row. If a tab doesn't exist yet when the app reads, it's
simply treated as empty.

### Protected header rows

Timesheet Helper matches each tab's header row against the column names it
expects. If the header doesn't match, the app cannot tell which column is
which, so it reads nothing from that tab — a single renamed column (`role` to
`Role`) is enough to hide every person from the app.

Each write therefore protects the header row of the tab it wrote, with a
warning: editing row 1 now raises a "you're editing a protected range"
confirmation instead of just happening. You can still edit it — you own the
Sheet — but not by accident.

If the app reports that a tab could not be read, restore that tab's header row
to exactly the column names the app writes (the fastest way is to look at
another copy, or delete the whole tab and let the next write recreate it). The
app will not overwrite a tab it cannot read, so your rows are still there while
you fix the header.

**This protection only appears once you redeploy** — see step 4. An existing
deployment keeps running the code version it was deployed with, so a Sheet set
up before this change has unprotected headers until you push a new version.

## 6. Troubleshooting

- **"This Apps Script has no shared secret set yet":** the `SHARED_SECRET`
  script property is missing or empty. See step 2 — this is a setup step, not a
  wrong secret. No redeployment is needed after setting it.
- **"unauthorized" errors:** the `secret` sent by the app doesn't match the
  `SHARED_SECRET` script property. Double-check you copied it exactly (no
  leading/trailing spaces) into Timesheet Helper's settings. Changing the
  property takes effect on the next request — no redeployment needed.
- **Requests fail entirely / CORS-like errors:** confirm the deployment's
  "Who has access" is set to **Anyone**, and that you redeployed a **new
  version** after any script edit (see step 4).
- **Changes to the script aren't showing up:** see step 4 — you edited but
  didn't create a new deployment version.
- **The app says a tab could not be read:** its header row no longer matches
  the column names the app writes. Nothing is lost — the app refuses to write
  over a tab it cannot read — so fix row 1 and reload the app (see
  "Protected header rows" in step 5).
- **Row 1 lets you edit it with no warning:** the header protection ships with
  the script, and an existing deployment runs the code version it was deployed
  with. Redeploy a new version (step 4), then let the app save once.
