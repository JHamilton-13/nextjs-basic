import { useState } from "react";
import type { AppCtx } from "../App";
import { startAudit } from "../lib/audits";
import { useLive } from "./useLive";

export function StartAudit({ ctx, projectId }: { ctx: AppCtx; projectId: string }) {
  const data = useLive(ctx.tick, async () => ({
    project: await ctx.db.get("projects", projectId),
    rooms: await ctx.db.getAllFromIndex("rooms", "by_project", projectId),
    templates: await ctx.db.getAll("templates"),
  }), [projectId]);
  const [roomId, setRoomId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!data) return <p>Loading…</p>;
  const tpl = templateId || data.templates[0]?.id || "";

  async function start() {
    const auditId = crypto.randomUUID();
    const r = await startAudit(
      { db: ctx.db, outbox: ctx.outbox, userId: ctx.identity.userId, userLabel: ctx.identity.label, newId: () => crypto.randomUUID(), now: () => new Date().toISOString() },
      { auditId, projectId, roomId: roomId || null, templateId: tpl },
    );
    if (!r.ok) setError(r.error.message); else { ctx.go({ name: "audit", auditId }); void ctx.sync(); }
  }

  return (
    <>
      <button className="link" onClick={() => ctx.go({ name: "projects" })}>← Projects</button>
      <h1>Start site audit</h1>
      <p className="muted">{data.project?.name}</p>
      <label>Room
        <select value={roomId} onChange={(e) => setRoomId(e.target.value)} data-testid="room-select">
          <option value="">No specific room</option>
          {data.rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </label>
      <label>Checklist template
        <select value={tpl} onChange={(e) => setTemplateId(e.target.value)} data-testid="template-select">
          {data.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      {data.templates.length === 0 && <p className="chip warn">No template on this device yet. Connect once and tap Sync.</p>}
      <button className="primary" disabled={!tpl} onClick={start} data-testid="start-audit">Start audit</button>
      {error && <p className="chip bad" role="alert">{error}</p>}
    </>
  );
}
