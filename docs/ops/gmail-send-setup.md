# Gmail sending setup (owner action, one time)

Reports are emailed by one Vercel server function (`api/reports.ts`) through the Gmail API. It can only send; it cannot read mail.
Nothing here goes in the repo. The values go in **Vercel > Project `nextjs-basic` > Settings > Environment Variables** (Production and Preview).

## Variables to add in Vercel

| Name | Value | Required |
| --- | --- | --- |
| `REPORT_FROM` | The sender, for example `PHC Reports <your-sending-address>` (must be the Google account you authorise below, or an alias of it) | **Yes** (no default) |
| `GMAIL_CLIENT_ID` | OAuth client id from step 2 | Yes |
| `GMAIL_CLIENT_SECRET` | OAuth client secret from step 2 | Yes |
| `GMAIL_REFRESH_TOKEN` | Refresh token from step 3 | Yes |
| `REPORT_TIMEZONE` | e.g. `America/Phoenix` (that is also the default) | No |
| `REPORT_TRANSPORT` | leave unset (Gmail). `fake` is for tests and is refused in production | No |

The function also needs the Supabase address and publishable key. It reads the `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` values the app build already uses, so there is nothing extra to add (`SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` are accepted instead if you prefer). **Never add a Supabase service-role key.**

## 1. Google Cloud project
1. console.cloud.google.com, create (or pick) a project, then **APIs & Services > Library > Gmail API > Enable**.
2. **OAuth consent screen**: user type Internal if your Google Workspace allows it (otherwise External with yourself as a test user). Add only the scope `https://www.googleapis.com/auth/gmail.send`.

## 2. OAuth client
**APIs & Services > Credentials > Create credentials > OAuth client ID > Web application.** Add the authorised redirect URI `https://developers.google.com/oauthplayground`. Copy the client id and secret into Vercel.

## 3. Refresh token
1. Open https://developers.google.com/oauthplayground. Click the gear icon, tick **Use your own OAuth credentials**, paste the client id and secret.
2. In the scope box enter `https://www.googleapis.com/auth/gmail.send` only, click **Authorize APIs** and sign in as the sending account.
3. Click **Exchange authorization code for tokens** and copy the **Refresh token** into Vercel as `GMAIL_REFRESH_TOKEN`.
4. If the consent screen is External and in "Testing", the token expires after 7 days; publish the app or use Internal.

## 4. Check
Redeploy so the new settings apply. On a job, build a report and press **Send test to me**. The test goes only to your own address and does not use up the real send.

## Notes
- A shared mailbox (for example a reports@ address) is better than one person's account, so sending does not stop if that person leaves.
- Only the four manager roles can build or send. A report sends once. If a send fails the report shows Failed with Retry. If it shows Queued for a long time, check the Sent folder first: the email may have gone out.
