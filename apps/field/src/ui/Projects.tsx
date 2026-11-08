import type { AppCtx } from "../App";
import { auditSummary } from "../lib/audits";
import { useLive } from "./useLive";

export function Projects({ ctx }: { ctx: AppCtx }) {
  const data = useLive(ctx.tick, async () => {
    const projects = await ctx.db.getAll("projects");
    const rooms = await ctx.db.getAll("rooms");
    const everyVersion = await ctx.db.getAll("audits");
    const audits = [...new Map(everyVersion.sort((x, y) => x.version - y.version).map((a) => [a.auditId, a] as const)).values()]; // latest version of each audit
    const queue = await ctx.outbox.list();
    const sums = new Map(await Promise.all(audits.map(async (a) => [a.auditId, await auditSummary(ctx.db, a.auditId)] as const)));
    return { projects, rooms, audits, queue, sums };
  });
  if (!data) return <p>Loading…</p>;
  if (data.projects.length === 0) {
    return (
      <>
        <h1>Projects</h1>
        <p className="muted">No projects on this device yet. {ctx.hasSession ? "Connect to the internet and tap Sync." : "Sign in again to download your projects."}</p>
        <button disabled={!ctx.hasSession || ctx.syncing} onClick={() => void ctx.sync(true)}>Sync now</button>
      </>
    );
  }
  return (
    <>
      <h1>Projects</h1>
      {data.projects.map((p) => (
        <section className="card" key={p.id} data-testid="project-card">
          <h2>{p.name}</h2>
          <p className="muted">{[p.customer, p.address].filter(Boolean).join(" · ") || "No customer or address"}</p>
          <button className="primary" onClick={() => ctx.go({ name: "start", projectId: p.id })}>Start site audit</button>
          {data.audits.filter((a) => a.projectId === p.id).map((a) => {
            const s = data.sums.get(a.auditId);
            const created = data.queue.find((q) => q.auditId === a.auditId && q.op.entity === "audit" && q.op.entityId === a.key && (q.op.payload.action === "create" || q.op.payload.action === "revise"));
            const room = data.rooms.find((r) => r.id === a.roomId)?.name ?? "No room";
            return (
              <button className="row" key={a.auditId} onClick={() => ctx.go({ name: "audit", auditId: a.auditId })} data-testid="audit-row">
                <span>{room}<small> · {s?.entered ?? 0}/{s?.total ?? 0} items{a.version > 1 ? ` · version ${a.version}` : ""}</small></span>
                <span className={`chip ${created?.state.status === "confirmed" ? "good" : "warn"}`}>{created?.state.status === "confirmed" ? "On server" : "Not synced yet"}</span>
              </button>
            );
          })}
        </section>
      ))}
    </>
  );
}
