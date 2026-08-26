# Microsoft 365 setup

The Microsoft 365 backend signs you in with your own Microsoft account and
reads/writes an Excel workbook in your OneDrive or SharePoint through the
Microsoft Graph API. There is no shared secret — access is governed entirely
by who you sign in as and what the workbook is shared with.

1. Go to the [Microsoft Entra admin centre](https://entra.microsoft.com) ->
   **App registrations** -> **New registration**.
   - Name: `Timesheet Helper` (or anything you like).
   - Supported account types: pick to match your workbook's account.
     - Personal OneDrive -> "Personal Microsoft accounts only".
     - Work/school -> "Accounts in this organizational directory only".
   - Redirect URI:
     - **Platform: Single-page application (SPA). Not "Web".**
       **This is the single most common way this setup breaks.** A
       "Web" redirect URI rejects the PKCE flow a static page must use to
       sign in, and Microsoft's resulting error does not tell you that's the
       problem — you just get an opaque failure.
     - Value: your GitHub Pages URL, e.g.
       `https://<user>.github.io/timesheet-helper/` (note the trailing
       slash — it must match exactly what the app sends, which is
       `location.origin` + the app's base path).
2. Copy the **Application (client) ID** from the app registration's
   overview page. This is `clientId` in the app's connection form.
3. Go to **API permissions** -> **Add a permission** -> **Microsoft Graph**
   -> **Delegated permissions**, and add `Files.ReadWrite` and `User.Read`.
   Click **Grant admin consent** if you can.

   **If this is a work or school account, an administrator may have to
   approve the app before sign-in will work at all.** That's a policy
   decision on Microsoft's side, not something the app can route around.
   Personal Microsoft accounts self-consent on first sign-in and are not
   affected by this.
4. Create an empty `.xlsx` workbook in OneDrive or SharePoint (or reuse an
   existing one — the app creates its own tabs on write and leaves anything
   else alone). Share it, and copy the sharing link. This is `location` in
   the app's connection form.
5. Authority — which Microsoft accounts are allowed to sign in:
   - `consumers` for a personal Microsoft account.
   - your tenant id (or `organizations`) for a work/school account.
   - `common` to accept either.

## Troubleshooting

- **"AADSTS9002326" or a redirect-mismatch error on sign-in** — the redirect
  URI registered in step 1 doesn't exactly match the URL the app is running
  at, or it was registered as "Web" instead of "SPA". Re-check both.
- **Sign-in fails with a message about an administrator needing to
  approve the app** — see step 3. Ask your Microsoft 365 administrator to
  grant admin consent for the app registration.
- **"Could not find that workbook"** — the sharing link is wrong, or the
  signed-in account doesn't have access to the file it points to. Re-copy
  the link from the file's own **Share** dialog.
