import type { SupabaseClient } from "@supabase/supabase-js";
import type { Db } from "./db";
import { getIdentity, setIdentity } from "./db";
import type { Identity } from "./types";

/** Email one-time code. shouldCreateUser stays true: first sign-in of an invited person creates the account, and the
 *  server-side before-user-created hook refuses anyone who is not on the invite list. */
export async function sendCode(sb: SupabaseClient, email: string): Promise<string | null> {
  const { error } = await sb.auth.signInWithOtp({ email: email.trim().toLowerCase(), options: { shouldCreateUser: true } });
  return error ? friendly(error.message) : null;
}

export async function verifyCode(sb: SupabaseClient, email: string, token: string): Promise<string | null> {
  const { error } = await sb.auth.verifyOtp({ email: email.trim().toLowerCase(), token: token.trim(), type: "email" });
  return error ? friendly(error.message) : null;
}

export async function signInWithGoogle(sb: SupabaseClient): Promise<string | null> {
  const { error } = await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.origin } });
  return error ? friendly(error.message) : null;
}

const friendly = (m: string) => (/not been invited/i.test(m) ? "This email has not been invited. Ask your project manager to invite you." : m);

/**
 * Who is using the app. Online: the live session (and remember it). Offline or token not refreshable: the last
 * identity stored on this device, so an installer with no signal can keep working. Syncing still needs a valid session.
 */
export async function resolveIdentity(sb: SupabaseClient | null, db: Db): Promise<{ identity: Identity | undefined; hasSession: boolean }> {
  if (sb) {
    try {
      const { data } = await sb.auth.getSession();
      const u = data.session?.user;
      if (u?.email) {
        const meta = (u.user_metadata ?? {}) as { full_name?: string; name?: string };
        const id = { userId: u.id, email: u.email, label: (meta.full_name || meta.name || u.email).trim() };
        await setIdentity(db, id);
        return { identity: id, hasSession: true };
      }
    } catch { /* fall through to the stored identity */ }
  }
  const stored = await getIdentity(db);
  return { identity: stored ? { ...stored, label: stored.label || stored.email } : undefined, hasSession: false };
}
