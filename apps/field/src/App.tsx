import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openPhcDb, type Db } from "./lib/db";
import { Outbox } from "./lib/outbox";
import { supabase, configured } from "./lib/supabase";
import { supabaseTransport } from "./lib/transport";
import { resolveIdentity } from "./lib/auth";
import { syncNow, type SyncResult } from "./lib/sync";
import { requestPersistence } from "./lib/storage";
import type { Identity } from "./lib/types";
import { SignIn } from "./ui/SignIn";
import { Projects } from "./ui/Projects";
import { ProjectView } from "./ui/ProjectView";
import { StartAudit } from "./ui/StartAudit";
import { AuditView } from "./ui/AuditView";
import { Queue } from "./ui/Queue";
import { StatusBar } from "./ui/StatusBar";

export type View = { name: "projects" } | { name: "project"; projectId: string } | { name: "start"; projectId: string } | { name: "audit"; auditId: string } | { name: "queue" };

export interface AppCtx {
  db: Db; outbox: Outbox; identity: Identity; tick: number; online: boolean; syncing: boolean; hasSession: boolean;
  lastSync: SyncResult | undefined; sync: (force?: boolean) => Promise<void>; go: (v: View) => void;
}

export function App() {
  const [db, setDb] = useState<Db>();
  const [identity, setIdentity] = useState<Identity>();
  const [hasSession, setHasSession] = useState(false);
  const [tick, setTick] = useState(0);
  const [online, setOnline] = useState(navigator.onLine);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<SyncResult>();
  const [view, setView] = useState<View>({ name: "projects" });
  const identityRef = useRef<Identity>();
  identityRef.current = identity;

  const outbox = useMemo(() => {
    if (!db) return undefined;
    return new Outbox(db, supabase ? supabaseTransport(supabase, db) : { send: async () => { throw new Error("Not configured"); } }, {
      canSend: (actor) => actor === identityRef.current?.userId, onChange: () => setTick((t) => t + 1),
    });
  }, [db]);

  useEffect(() => { void openPhcDb().then(setDb); }, []);
  // First run after sign-in: ask the browser to keep our offline data (it may say no; the Sync queue screen shows the result).
  useEffect(() => { if (identity) void requestPersistence(); }, [identity]);
  useEffect(() => {
    if (!db) return;
    const refresh = () => resolveIdentity(supabase, db).then((r) => { setIdentity(r.identity); setHasSession(r.hasSession); });
    void refresh();
    const sub = supabase?.auth.onAuthStateChange(() => void refresh());
    return () => sub?.data.subscription.unsubscribe();
  }, [db]);

  const sync = useCallback(async (force = false) => {
    if (!db || !outbox || !supabase) return;
    // Never attempt a send we know cannot work: failed attempts would only inflate the retry backoff.
    if (!navigator.onLine && !force) return;
    setSyncing(true);
    try {
      const r = await syncNow({ sb: supabase, db, outbox }, { ignoreBackoff: force });
      setLastSync(r);
      setOnline(!r.networkDown);
    } finally { setSyncing(false); setTick((t) => t + 1); }
  }, [db, outbox]);

  // Drain the queue when: the app opens, connectivity returns, the app comes back to the foreground (iOS has no
  // reliable background sync), and every 10 s while anything is waiting (due retries only).
  useEffect(() => {
    if (!outbox || !identity || !hasSession) return;
    const run = () => { if (navigator.onLine) void sync(); };
    // Connectivity just came back: that is the best moment to retry, so skip any backoff left over.
    const on = () => { setOnline(true); void sync(true); };
    const off = () => setOnline(false);
    const vis = () => { if (document.visibilityState === "visible") run(); };
    window.addEventListener("online", on); window.addEventListener("offline", off); document.addEventListener("visibilitychange", vis);
    const timer = window.setInterval(async () => { if ((await outbox.pendingCount()) > 0) run(); }, 10_000);
    run();
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); document.removeEventListener("visibilitychange", vis); window.clearInterval(timer); };
  }, [outbox, identity, hasSession, sync]);

  if (!configured) return <main className="screen"><h1>Not configured</h1><p>This build has no Supabase settings. See <code>apps/field/.env.example</code>.</p></main>;
  if (!db || !outbox) return <main className="screen"><p>Loading…</p></main>;
  if (!identity) return <SignIn />;

  const ctx: AppCtx = { db, outbox, identity, tick, online, syncing, hasSession, lastSync, sync, go: setView };
  return (
    <div className="app">
      <StatusBar ctx={ctx} />
      <main className="screen">
        {view.name === "projects" && <Projects ctx={ctx} />}
        {view.name === "project" && <ProjectView ctx={ctx} projectId={view.projectId} />}
        {view.name === "start" && <StartAudit ctx={ctx} projectId={view.projectId} />}
        {view.name === "audit" && <AuditView ctx={ctx} auditId={view.auditId} />}
        {view.name === "queue" && <Queue ctx={ctx} />}
      </main>
      <nav className="tabs">
        <button className={view.name === "projects" || view.name === "project" || view.name === "start" || view.name === "audit" ? "active" : ""} onClick={() => setView({ name: "projects" })}>Projects</button>
        <button className={view.name === "queue" ? "active" : ""} onClick={() => setView({ name: "queue" })}>Sync queue</button>
      </nav>
    </div>
  );
}
