import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

/** false when the build has no Supabase settings (see .env.example); the UI then says so instead of failing silently. */
export const configured = Boolean(url && key);

export const supabase: SupabaseClient | null = configured
  ? createClient(url!, key!, { auth: { storageKey: "phc-auth", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null;
