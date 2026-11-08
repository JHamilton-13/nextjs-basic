import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { openPhcDb, getIdentity, setIdentity, type Db } from "../src/lib/db";
import { signOutLocally } from "../src/lib/auth";

let db: Db; let n = 0;
beforeEach(async () => { db = await openPhcDb(`auth-${++n}`); await setIdentity(db, { userId: "u1", email: "a@b.test", label: "Pat" }); });

describe("signOutLocally (the Sign out button must always work, with or without a connection)", () => {
  it("ends only THIS phone's session (not every device) and forgets the saved identity", async () => {
    const calls: unknown[] = [];
    const sb = { auth: { signOut: async (o: unknown) => { calls.push(o); return { error: null }; } } };
    await signOutLocally(sb as never, db);
    expect(calls).toEqual([{ scope: "local" }]);
    expect(await getIdentity(db)).toBeUndefined();
  });
  it("still forgets the identity when the server cannot be reached or refuses", async () => {
    await signOutLocally({ auth: { signOut: async () => { throw new Error("Failed to fetch"); } } } as never, db);
    expect(await getIdentity(db)).toBeUndefined();
    await setIdentity(db, { userId: "u1", email: "a@b.test", label: "Pat" });
    await signOutLocally({ auth: { signOut: async () => ({ error: { message: "session not found" } }) } } as never, db);
    expect(await getIdentity(db)).toBeUndefined();
  });
  it("works with no Supabase client at all", async () => {
    await signOutLocally(null, db);
    expect(await getIdentity(db)).toBeUndefined();
  });
  it("keeps everything the person did on the phone (queued changes survive a sign out)", async () => {
    await db.add("outbox", { auditId: "R", op: { opId: "o1", entity: "room_check", entityId: "R:shelves", baseVersion: 0, payload: { state: "done" }, createdAt: "2026-11-08T10:00:00Z", actor: "u1" }, state: { opId: "o1", status: "pending", attempts: 0 }, nextAttemptAt: 0 });
    await db.put("room_checks", { key: "R:shelves", roomId: "R", projectId: "P", itemKey: "shelves", state: "done", pending: true, nextBase: 1 });
    await signOutLocally({ auth: { signOut: async () => ({ error: null }) } } as never, db);
    expect(await db.getAll("outbox")).toHaveLength(1);
    expect(await db.get("room_checks", "R:shelves")).toMatchObject({ pending: true });
  });
});
