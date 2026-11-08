import { useEffect, useState } from "react";
import type { AppCtx } from "../App";
import { useLive } from "./useLive";
import { RoomCard } from "./RoomCard";
import { loadRoles } from "../lib/issues";
import { canManageReports } from "../lib/reportsApi";

/** One job: its rooms, each with its details and checklist. */
export function ProjectView({ ctx, projectId }: { ctx: AppCtx; projectId: string }) {
  // Which rooms are folded away on this phone (remembered per job; nothing here is shared or synced).
  const storeKey = `phc-rooms-collapsed:${projectId}`;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem(storeKey) ?? "[]") as string[]); } catch { return new Set(); } });
  useEffect(() => { try { localStorage.setItem(storeKey, JSON.stringify([...collapsed])); } catch { /* private window: it just will not be remembered */ } }, [collapsed, storeKey]);
  const toggle = (id: string) => setCollapsed((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const data = useLive(ctx.tick, async () => ({
    project: await ctx.db.get("projects", projectId),
    rooms: (await ctx.db.getAllFromIndex("rooms", "by_project", projectId)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    checks: (await ctx.db.getAll("room_checks")).filter((c) => c.projectId === projectId),
    issues: (await ctx.db.getAll("issues")).filter((i) => i.projectId === projectId),
    queue: await ctx.outbox.list(),
    roles: await loadRoles(ctx.db),
  }), [projectId]);
  if (!data) return <p>Loading…</p>;
  if (!data.project) return <><button className="link" onClick={() => ctx.go({ name: "projects" })}>← Projects</button><p className="muted">This project is not on this device. Connect and sync to download it.</p></>;
  const { project, rooms } = data;
  return (
    <>
      <button className="link" onClick={() => ctx.go({ name: "projects" })} data-testid="back-projects">← Projects</button>
      <h1>{project.name}</h1>
      <p className="muted">{[project.customer, project.address].filter(Boolean).join(" · ") || "No customer or address"}</p>
      {canManageReports(data.roles, projectId) && <div className="btnrow"><button onClick={() => ctx.go({ name: "reports", projectId })} data-testid="open-reports">Reports and builder contact</button></div>}
      {rooms.length > 1 && (
        <div className="btnrow">
          <button onClick={() => setCollapsed(new Set(rooms.map((r) => r.id)))} data-testid="collapse-all">Collapse all rooms</button>
          <button onClick={() => setCollapsed(new Set())} data-testid="expand-all">Expand all rooms</button>
        </div>
      )}
      {rooms.length === 0 && <p className="muted">No rooms on this project yet.</p>}
      {rooms.map((room) => (
        <RoomCard key={room.id} ctx={ctx} room={room} collapsed={collapsed.has(room.id)} onToggle={() => toggle(room.id)} checks={data.checks.filter((c) => c.roomId === room.id)} issues={data.issues.filter((i) => i.roomId === room.id)} queue={data.queue.filter((q) => q.auditId === room.id)} />
      ))}
    </>
  );
}
