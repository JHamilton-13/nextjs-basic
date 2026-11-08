import type { AppCtx } from "../App";
import { useLive } from "./useLive";
import { RoomCard } from "./RoomCard";

/** One job: its rooms, each with its details and checklist. */
export function ProjectView({ ctx, projectId }: { ctx: AppCtx; projectId: string }) {
  const data = useLive(ctx.tick, async () => ({
    project: await ctx.db.get("projects", projectId),
    rooms: (await ctx.db.getAllFromIndex("rooms", "by_project", projectId)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    checks: (await ctx.db.getAll("room_checks")).filter((c) => c.projectId === projectId),
    queue: await ctx.outbox.list(),
  }), [projectId]);
  if (!data) return <p>Loading…</p>;
  if (!data.project) return <><button className="link" onClick={() => ctx.go({ name: "projects" })}>← Projects</button><p className="muted">This project is not on this device. Connect and sync to download it.</p></>;
  const { project, rooms } = data;
  return (
    <>
      <button className="link" onClick={() => ctx.go({ name: "projects" })} data-testid="back-projects">← Projects</button>
      <h1>{project.name}</h1>
      <p className="muted">{[project.customer, project.address].filter(Boolean).join(" · ") || "No customer or address"}</p>
      {rooms.length === 0 && <p className="muted">No rooms on this project yet.</p>}
      {rooms.map((room) => (
        <RoomCard key={room.id} ctx={ctx} room={room} checks={data.checks.filter((c) => c.roomId === room.id)} queue={data.queue.filter((q) => q.auditId === room.id)} />
      ))}
    </>
  );
}
