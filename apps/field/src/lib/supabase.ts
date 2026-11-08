import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

/** false when the build has no Supabase settings (see .env.example); the UI then says so instead of failing silently. */
export const configured = Boolean(url && key);

// The library silently retries failed GETs with growing delays (1 s, 2 s, 4 s...), which keeps an offline phone on "Syncing…" for
// about 15 s and multiplies the timeouts below. Our own queue already retries with backoff, so the library's retry is switched off.
// A phone on Wi-Fi with no real internet ("lie-fi") can leave a request hanging for minutes. Every request gets a deadline so
// the queue fails over to "will retry" instead of sitting on "Syncing…". Photo uploads get longer; the test build shortens both.
const API_TIMEOUT_MS = Number(import.meta.env.VITE_API_TIMEOUT_MS) || 20_000;
const UPLOAD_TIMEOUT_MS = Number(import.meta.env.VITE_UPLOAD_TIMEOUT_MS) || 120_000;

export const fetchWithTimeout: typeof fetch = async (input, init) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  const ms = href.includes("/storage/v1/object/") ? UPLOAD_TIMEOUT_MS : API_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException(`Request timed out after ${Math.round(ms / 1000)} s`, "TimeoutError")), ms);
  const outer = init?.signal;
  if (outer) { if (outer.aborted) ctrl.abort(outer.reason); else outer.addEventListener("abort", () => ctrl.abort(outer.reason), { once: true }); }
  try { return await fetch(input, { ...init, signal: ctrl.signal }); } finally { clearTimeout(timer); }
};

export const supabase: SupabaseClient | null = configured
  ? createClient(url!, key!, { auth: { storageKey: "phc-auth", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }, global: { fetch: fetchWithTimeout }, db: { retry: false } })
  : null;
