import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { isValidEmail } from "@phc/domain";

export type OutgoingEmail = {
  from: string; to: string; subject: string; text: string;
  attachment: { filename: string; content: Buffer; contentType: "application/pdf" };
};
export interface EmailTransport { send(m: OutgoingEmail): Promise<{ messageId: string }> }

/** "Fulton/ "Unit 313"" -> "Fulton Unit 313 Site Audit 2026-09-10.pdf". Nothing a file system, header or download dialog could object to. */
export function safeFileName(jobName: string, date: string, kind = "Site Audit"): string {
  const base = jobName
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[\\/:*?"<>|]+/g, "")
    .replace(/\s+/g, " ").trim().slice(0, 80).trim();
  return `${base || "Report"} ${kind} ${date}.pdf`;
}

export function fakeTransport(opts: { failWith?: string } = {}): EmailTransport & { sent: OutgoingEmail[] } {
  const sent: OutgoingEmail[] = [];
  let n = 0;
  return {
    sent,
    async send(m) {
      if (opts.failWith) throw new Error(opts.failWith);
      sent.push(m);
      return { messageId: `fake-${++n}` };
    },
  };
}

export interface GmailEnv { GMAIL_CLIENT_ID?: string; GMAIL_CLIENT_SECRET?: string; GMAIL_REFRESH_TOKEN?: string }

/** Gmail API with the gmail.send scope only: a refresh token is exchanged for a short access token, then one message is sent. */
export function gmailTransport(env: GmailEnv, fetchImpl: typeof fetch = fetch): EmailTransport {
  const need = (k: keyof GmailEnv) => { const v = env[k]; if (!v) throw new Error(`Missing setting ${k}`); return v; };
  return {
    async send(m) {
      if (!isValidEmail(m.to)) throw new Error("The recipient address is not valid");
      const tokenRes = await fetchImpl("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: need("GMAIL_CLIENT_ID"), client_secret: need("GMAIL_CLIENT_SECRET"), refresh_token: need("GMAIL_REFRESH_TOKEN"), grant_type: "refresh_token" }).toString(),
      });
      const tokenJson = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
      if (!tokenRes.ok || !tokenJson.access_token) throw new Error(`Google sign-in for sending failed (${tokenRes.status}): ${tokenJson.error ?? "no access token"}`);

      const raw = await new MailComposer({
        from: m.from, to: m.to, subject: m.subject, text: m.text,
        attachments: [{ filename: m.attachment.filename, content: m.attachment.content, contentType: m.attachment.contentType }],
      }).compile().build();
      const res = await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenJson.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ raw: raw.toString("base64url") }),
      });
      const json = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
      if (!res.ok || !json.id) throw new Error(`Gmail refused the message (${res.status}): ${json.error?.message ?? "no message id returned"}`);
      return { messageId: json.id };
    },
  };
}

export interface TransportEnv extends GmailEnv { REPORT_TRANSPORT?: string; REPORT_FROM?: string; VERCEL_ENV?: string }

/** Gmail by default. "fake" exists only for tests and the emulated-phone suite and is refused in production so nobody believes a report went out when it did not. */
export function getTransport(env: TransportEnv): EmailTransport {
  if (env.REPORT_TRANSPORT === "fake") {
    if (env.VERCEL_ENV === "production") throw new Error("REPORT_TRANSPORT=fake is not allowed in production");
    return fakeTransport();
  }
  for (const k of ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"] as const) {
    if (!env[k]) throw new Error(`Missing setting ${k}. See docs/ops/gmail-send-setup.md`);
  }
  return gmailTransport(env);
}
