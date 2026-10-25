# Google Sheets and Lead From CTWA: setup

This guide covers two Bot Builder features added in migration 051:

| Feature | Where it appears | What it does |
|---|---|---|
| On New Row Google Sheet | Triggers → Google Sheets | Starts a flow once for each new row added to a sheet tab. |
| Google Sheets | Actions → Data | Adds a row to a sheet tab: success and failure outputs. |
| Lead From CTWA | Triggers → Leads | Starts a flow when a new lead's first message comes from a Click-to-WhatsApp ad. |

Lead From CTWA needs no extra setup. It uses the ad details that Meta already sends with each message.

Google Sheets needs migration 051, a Google Cloud OAuth client, and two Vercel variables.

## 1. Run migration 051

In the Supabase SQL Editor, run `supabase/migrations/051_google_sheets_ctwa_lead.sql`.

It is safe to run twice. To confirm it worked, run this query; both columns should be filled:

```sql
SELECT to_regclass('public.google_connections') AS connections,
       to_regclass('public.google_sheet_watches') AS watches;
```

## 2. Create the Google OAuth client (one time)

1. Open https://console.cloud.google.com and create a project, for example "Bluetick".
2. Go to **APIs & Services → Library**, search for **Google Sheets API** and click **Enable**.
3. Go to **APIs & Services → OAuth consent screen** (called "Google Auth Platform" in newer consoles):
   1. Set the user type to **External**, the app name to **Bluetick**, and add your support email.
   2. Under **Data access / Scopes**, add `.../auth/spreadsheets`, `openid` and `email`.
   3. Under **Audience**, add the Google accounts that will connect as **Test users**, or publish the app (see the note below).
4. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   1. Set the application type to **Web application**.
   2. Add this exact URL under **Authorised redirect URIs**:
      `https://bluetick-blond.vercel.app/api/integrations/google/callback`.
      If you later use your own domain, add that domain's callback URL as well.
   3. Copy the **Client ID** and the **Client secret**.

**Testing mode versus published:** while the app is in **Testing** mode, Google expires the connection after 7 days, and only the listed test users can connect. For long-term use, click **Publish app**. Google may then ask you to verify the app, because the spreadsheets scope is sensitive. Until it is verified, users see an "unverified app" warning that they can click through, and the app is limited to 100 users.

## 3. Add the Vercel environment variables

Go to **Vercel → Project → Settings → Environment Variables**, add these for Production, then **Redeploy**:

| Name | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | the Client ID from step 2 |
| `GOOGLE_CLIENT_SECRET` | the Client secret from step 2 |

`NEXT_PUBLIC_SITE_URL` must already be `https://bluetick-blond.vercel.app`, because the callback URL is built from it.

Tokens are stored encrypted with the existing `ENCRYPTION_KEY`. If you change that key, an admin must reconnect Google.

## 4. Connect Google in Bluetick

1. As an admin, open **Settings → Integrations → Connect Google account**.
2. Sign in and allow access to Google Sheets.
3. Share each spreadsheet your flows use with that Google account as **Editor**. It only needs **Viewer** if the sheet is used only for the new-row trigger.

## 5. Use it in a flow

**Start a flow on new rows (On New Row Google Sheet):**

1. Pick the trigger, paste the spreadsheet link, click **Load**, and choose the tab.
2. Pick the **WhatsApp number column**. Optionally pick a **Name column** and set a **Default country code**, such as 91, for numbers written without one.
3. Turn the flow on. The flows cron checks the sheet every 5 minutes:
   - Only rows added after the flow is turned on start it. Rows that were already there never do.
   - Each row finds or creates the contact and its conversation.
   - Row values are available as `{{trigger.row.<column>}}`. The column key is the header in lower case, with spaces turned into `_`; for example "Phone Number" becomes `{{trigger.row.phone_number}}`. The trigger card lists the exact keys.
   - WhatsApp's 24-hour rule applies: a new contact can only receive an approved **template** first.
   - The trigger card shows the last check, how many rows have started the flow, and any problem, such as a missing phone number in a row.

**Add a row (Google Sheets action):**

1. Pick the spreadsheet and tab. The header row (row 1) is loaded, and each column gets a value box where you can use variables.
2. Values are written as plain text, so formulas never run.
3. The row number is saved as `{{vars.sheet_row}}`.
4. Connect the **Failure** output to handle errors such as a revoked connection or a renamed column. If Failure is left unconnected, the run stops and the reason appears in the run log.

## Lead From CTWA

The trigger fires when a message carries Click-to-WhatsApp ad details and the sender is a new lead:

- **New contacts only** (the default): the message created the contact, or it is the contact's first message ever.
- **New contacts, and known contacts coming from a new ad**: this also fires the first time an existing contact messages from a given ad.

Optionally, list ad or post IDs to react only to those ads.

The ad details are available in later steps as `{{trigger.headline}}`, `{{trigger.source_id}}`, `{{trigger.source_url}}` and `{{trigger.body}}`.

"Message from CTWA" still fires on every message that comes from an ad.
