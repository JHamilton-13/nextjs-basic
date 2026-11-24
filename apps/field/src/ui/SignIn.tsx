import { useState } from "react";
import { sendCode, signInWithGoogle, verifyCode } from "../lib/auth";
import { supabase } from "../lib/supabase";

export function SignIn() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sb = supabase!;
  const offline = !navigator.onLine;

  async function send() {
    setBusy(true); setError(null);
    const e = await sendCode(sb, email);
    setBusy(false);
    if (e) setError(e); else setSent(true);
  }
  async function verify() {
    setBusy(true); setError(null);
    const e = await verifyCode(sb, email, code);
    setBusy(false);
    if (e) setError(e);
  }

  return (
    <main className="screen signin">
      <h1>PHC Field Audit</h1>
      <p className="muted">Sign in with your company account. You must be invited first.</p>
      {offline && <p className="chip warn" role="status">You are offline. Signing in needs a connection the first time.</p>}
      <button className="primary" disabled={busy || offline} onClick={async () => { const e = await signInWithGoogle(sb); if (e) setError(e); }}>Continue with Google</button>
      <p className="divider">or use an email code</p>
      {!sent ? (
        <>
          <label>Email<input type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <button disabled={busy || offline || !email.includes("@")} onClick={send}>Send me a code</button>
        </>
      ) : (
        <>
          <p>We sent a 6-digit code to <strong>{email}</strong>.</p>
          <label>Code<input inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} /></label>
          <button className="primary" disabled={busy || code.trim().length < 6} onClick={verify}>Sign in</button>
          <button className="link" onClick={() => { setSent(false); setCode(""); }}>Use a different email</button>
        </>
      )}
      {error && <p className="chip bad" role="alert">{error}</p>}
    </main>
  );
}
