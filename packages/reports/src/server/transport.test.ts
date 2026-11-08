import { describe, it, expect } from "vitest";
import { fakeTransport, safeFileName, gmailTransport, getTransport, type OutgoingEmail } from "./transport";

const mail: OutgoingEmail = {
  from: "Reports <sender@example.test>", to: "builder@example.test", subject: "Sample – Site Audit", text: "Hello\nPlease find the report attached.",
  attachment: { filename: "Sample Site Audit 2026-09-10.pdf", content: Buffer.from("%PDF-1.4 fake"), contentType: "application/pdf" },
};

describe("safeFileName", () => {
  it("removes slashes and quotes", () => {
    expect(safeFileName('Fulton/ "Unit 313"', "2026-09-10")).toBe("Fulton Unit 313 Site Audit 2026-09-10.pdf");
  });
  it("removes every character a file system or header could object to", () => {
    expect(safeFileName("a\\b:c*d?e<f>g|h\u0000i\r\nj", "2026-09-10")).toBe("abcdefgh i j Site Audit 2026-09-10.pdf");
  });
  it("falls back when nothing is left and caps the length", () => {
    expect(safeFileName("///", "2026-09-10")).toBe("Report Site Audit 2026-09-10.pdf");
    expect(safeFileName("x".repeat(500), "2026-09-10").length).toBeLessThan(120);
  });
  it("can name a different kind of report", () => {
    expect(safeFileName("Lot 12", "2026-09-10", "Room Status")).toBe("Lot 12 Room Status 2026-09-10.pdf");
  });
});

describe("fakeTransport", () => {
  it("records what would have been sent", async () => {
    const t = fakeTransport();
    const r = await t.send(mail);
    expect(t.sent).toHaveLength(1);
    expect(r.messageId).toMatch(/^fake-/);
  });
  it("can be told to fail", async () => {
    const t = fakeTransport({ failWith: "smtp down" });
    await expect(t.send(mail)).rejects.toThrow("smtp down");
    expect(t.sent).toHaveLength(0);
  });
});

describe("gmailTransport", () => {
  const env = { GMAIL_CLIENT_ID: "id", GMAIL_CLIENT_SECRET: "secret", GMAIL_REFRESH_TOKEN: "refresh" };
  function fakeFetch(sendStatus = 200) {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "ACCESS", expires_in: 3600 }), { status: 200 });
      if (sendStatus !== 200) return new Response(JSON.stringify({ error: { message: "Quota exceeded" } }), { status: sendStatus });
      return new Response(JSON.stringify({ id: "gmail-123" }), { status: 200 });
    }) as unknown as typeof fetch;
    return { f, calls };
  }
  it("exchanges the refresh token, then sends one multipart message with the PDF attached", async () => {
    const { f, calls } = fakeFetch();
    const r = await gmailTransport(env, f).send(mail);
    expect(r.messageId).toBe("gmail-123");
    expect(calls).toHaveLength(2);
    const tokenBody = String(calls[0]!.init.body);
    expect(tokenBody).toContain("grant_type=refresh_token");
    expect(tokenBody).toContain("refresh_token=refresh");
    expect(calls[1]!.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBe("Bearer ACCESS");
    const raw = Buffer.from(JSON.parse(String(calls[1]!.init.body)).raw, "base64url").toString("utf8");
    expect(raw).toContain("To: builder@example.test");
    expect(raw).toContain("Sender <sender@example.test>".replace("Sender", "Reports"));
    expect(raw).toContain("Sample Site Audit 2026-09-10.pdf");
    expect(raw).toContain("application/pdf");
  });
  it("throws a plain message when Gmail refuses", async () => {
    const { f } = fakeFetch(403);
    await expect(gmailTransport(env, f).send(mail)).rejects.toThrow(/Gmail.*403.*Quota exceeded/);
  });
  it("throws when the token exchange fails", async () => {
    const f = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as unknown as typeof fetch;
    await expect(gmailTransport(env, f).send(mail)).rejects.toThrow(/Google sign-in.*invalid_grant/);
  });
  it("does not accept a header-injection address", async () => {
    const { f, calls } = fakeFetch();
    await expect(gmailTransport(env, f).send({ ...mail, to: "a@b.com\nBcc: x@y.com" })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("getTransport", () => {
  it("needs the Gmail settings and says which are missing", () => {
    expect(() => getTransport({ REPORT_FROM: "x@example.test" })).toThrow(/GMAIL_CLIENT_ID/);
  });
  it("uses the fake only when asked, never in production", () => {
    expect(getTransport({ REPORT_TRANSPORT: "fake" })).toBeDefined();
    expect(() => getTransport({ REPORT_TRANSPORT: "fake", VERCEL_ENV: "production" })).toThrow(/production/);
  });
});
