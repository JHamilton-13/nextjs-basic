import type { AppCtx } from "../App";
import { useLive } from "./useLive";
import { supabase } from "../lib/supabase";

export function StatusBar({ ctx }: { ctx: AppCtx }) {
  const counts = useLive(ctx.tick, async () => ({ pending: await ctx.outbox.pendingCount(), attention: await ctx.outbox.attentionCount() }));
  const pending = counts?.pending ?? 0; const attention = counts?.attention ?? 0;
  const label = !ctx.online ? "Offline" : ctx.syncing ? "Syncing…" : pending > 0 ? "Waiting to sync" : "All synced";
  const cls = !ctx.online ? "chip gray" : attention > 0 ? "chip bad" : pending > 0 || ctx.syncing ? "chip progress" : "chip good";
  return (
    <header className="bar">
      <strong>PHC Field Audit</strong>
      <span className={cls} role="status" data-testid="sync-status">{label}</span>
      {pending > 0 && <span className="chip warn" data-testid="pending-count">{pending} waiting</span>}
      {attention > 0 && <span className="chip bad" data-testid="attention-count">{attention} need attention</span>}
      {!ctx.hasSession && <span className="chip warn">Sign in again to sync</span>}
      <span className="spacer" />
      <button className="small" onClick={() => void supabase?.auth.signOut()} title={ctx.identity.email}>Sign out</button>
    </header>
  );
}
