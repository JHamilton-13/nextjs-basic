import { useState } from "react";
import type { AppCtx } from "../App";
import { useLive } from "./useLive";

export function StatusBar({ ctx }: { ctx: AppCtx }) {
  const counts = useLive(ctx.tick, async () => ({ pending: await ctx.outbox.pendingCount(), attention: await ctx.outbox.attentionCount() }));
  const [confirmOut, setConfirmOut] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const pending = counts?.pending ?? 0; const attention = counts?.attention ?? 0;
  const label = !ctx.online ? "Offline" : ctx.syncing ? "Syncing…" : pending > 0 ? "Waiting to sync" : "All synced";
  const cls = !ctx.online ? "chip gray" : attention > 0 ? "chip bad" : pending > 0 || ctx.syncing ? "chip progress" : "chip good";
  const unsent = pending + attention;
  return (
    <header className="bar">
      <strong>PHC Field Audit</strong>
      <span className={cls} role="status" data-testid="sync-status">{label}</span>
      {pending > 0 && <span className="chip warn" data-testid="pending-count">{pending} waiting</span>}
      {attention > 0 && <span className="chip bad" data-testid="attention-count">{attention} need attention</span>}
      {!ctx.hasSession && (
        <button className="small" disabled={!ctx.online} onClick={async () => { setSignInError(null); const e = await ctx.signIn(); if (e) setSignInError(e); }} data-testid="resign" title={ctx.online ? "" : "Needs a connection"}>
          Sign in again to sync
        </button>
      )}
      <span className="spacer" />
      <button className="small" onClick={() => { if (unsent > 0) setConfirmOut(true); else void ctx.signOut(); }} title={ctx.identity.email} data-testid="signout">Sign out</button>
      {signInError && <p className="chip bad" role="alert" style={{ width: "100%" }}>{signInError}</p>}
      {confirmOut && (
        <div className="signout-confirm" role="alertdialog" aria-label="Sign out with unsent changes" data-testid="signout-dialog">
          <p><strong>{unsent} {unsent === 1 ? "change is" : "changes are"} still waiting to send.</strong> They stay on this phone and send after you sign back in.</p>
          <div className="btnrow">
            <button className="primary" onClick={() => void ctx.signOut()} data-testid="signout-confirm">Sign out anyway</button>
            <button onClick={() => setConfirmOut(false)} data-testid="signout-cancel">Stay signed in</button>
          </div>
        </div>
      )}
    </header>
  );
}
