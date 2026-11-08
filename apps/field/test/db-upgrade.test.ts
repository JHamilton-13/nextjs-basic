import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { openDB } from "idb";
import { openPhcDb } from "../src/lib/db";

/** Builds a database exactly as the previous app version (v2) left it, with unsynced work in it. */
async function makeV2(name: string) {
  const db = await openDB(name, 2, {
    upgrade(d) {
      d.createObjectStore("meta"); d.createObjectStore("projects", { keyPath: "id" });
      d.createObjectStore("rooms", { keyPath: "id" }).createIndex("by_project", "project_id");
      d.createObjectStore("templates", { keyPath: "id" });
      d.createObjectStore("audits", { keyPath: "auditId" });
      d.createObjectStore("items", { keyPath: "key" }).createIndex("by_audit", "auditId");
      d.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true }).createIndex("by_audit", "auditId");
      d.createObjectStore("photos", { keyPath: "id" }).createIndex("by_audit", "auditId");
    }
  });
  await db.put("audits", { auditId: "A", version: 1, projectId: "P", roomId: null, templateId: "T", createdBy: "u1", createdAt: "2026-11-08T10:00:00Z", submittedAt: "2026-11-08T11:00:00Z" });
  await db.put("items", { key: "A:1:outlets", auditId: "A", itemKey: "outlets", sectionKey: "mep", sectionTitle: "MEP", label: "Outlets", kind: "check", critical: true, requires: {}, result: "FAIL", pending: true, nextBase: 1 });
  await db.put("photos", { id: "ph1", auditId: "A", projectId: "P", itemKey: "outlets", thumb: "t", mime: "image/jpeg", bytes: 5, sha256: "a".repeat(64), capturedAt: "2026-11-08T10:30:00Z", capturedBy: "u1", storagePath: "P/A/ph1.jpg", confirmed: false, blob: new Blob([new Uint8Array(5)]) });
  await db.add("outbox", { auditId: "A", op: { opId: "o1", entity: "audit_item", entityId: "A:1:outlets", baseVersion: 0, payload: { result: "FAIL" }, createdAt: "2026-11-08T10:30:00Z", actor: "u1" }, state: { opId: "o1", status: "pending", attempts: 0 }, nextAttemptAt: 0 });
  await db.put("meta", { userId: "u1", email: "a@b.c" }, "identity");
  db.close();
}

describe("device database upgrade v2 -> v3 (version-aware audits)", () => {
  it("keeps all unsynced work: audits, items, photos (with their blobs) and the whole outbox", async () => {
    await makeV2("upg-1");
    const db = await openPhcDb("upg-1");
    expect(await db.get("audits", "A:1")).toMatchObject({ auditId: "A", version: 1, key: "A:1", submittedAt: "2026-11-08T11:00:00Z", createdByLabel: "" });
    expect(await db.getAllFromIndex("audits", "by_audit_id", "A")).toHaveLength(1);
    const items = await db.getAllFromIndex("items", "by_audit", "A:1");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: "A:1:outlets", version: 1, auditKey: "A:1", result: "FAIL", pending: true, nextBase: 1 });
    const photos = await db.getAllFromIndex("photos", "by_audit", "A");
    expect(photos[0]).toMatchObject({ id: "ph1", version: 1, confirmed: false });
    expect(photos[0]?.blob?.size).toBe(5);
    const q = await db.getAll("outbox");
    expect(q).toHaveLength(1);
    expect(q[0]?.op.opId).toBe("o1"); expect(q[0]?.state.status).toBe("pending");
    expect(await db.get("meta", "identity")).toMatchObject({ userId: "u1" });
  });
  it("a fresh install gets every store directly (v4 adds room_checks, v5 adds trades and issues)", async () => {
    const db = await openPhcDb("fresh-1");
    expect([...db.objectStoreNames].sort()).toEqual(["audits", "issues", "items", "meta", "outbox", "photos", "projects", "room_checks", "rooms", "templates", "trades"]);
    await db.put("audits", { key: "X:2", auditId: "X", version: 2, projectId: "P", roomId: null, templateId: "T", createdBy: "u", createdByLabel: "U", createdAt: "t" });
    expect((await db.getAllFromIndex("audits", "by_audit_id", "X"))[0]?.version).toBe(2);
  });
});

describe("device database upgrade v3 -> v4 (room checklist)", () => {
  it("adds the room_checks store and keeps everything already on the device", async () => {
    await makeV2("upg-v4");
    (await openPhcDb("upg-v4")).close();                    // now at v4 from v2 (passes through the v3 step)
    const db = await openPhcDb("upg-v4");
    expect([...db.objectStoreNames]).toContain("room_checks");
    expect(await db.get("audits", "A:1")).toMatchObject({ auditId: "A" });
    expect(await db.getAll("outbox")).toHaveLength(1);
    await db.put("room_checks", { key: "R:shelves", roomId: "R", projectId: "P", itemKey: "shelves", state: "done", pending: true, nextBase: 1 });
    expect((await db.getAllFromIndex("room_checks", "by_room", "R"))).toHaveLength(1);
  });
});

describe("device database upgrade v4 -> v5 (issues and trades)", () => {
  it("adds trades, issues and the photo-by-issue index and keeps everything already on the device (including audit photos and queued work)", async () => {
    await makeV2("upg-v5");
    (await openPhcDb("upg-v5")).close();                    // v2 -> v5 in one step (passes through v3 and v4)
    const db = await openPhcDb("upg-v5");
    expect([...db.objectStoreNames]).toEqual(expect.arrayContaining(["trades", "issues", "room_checks"]));
    expect(await db.get("audits", "A:1")).toMatchObject({ auditId: "A" });
    const photos = await db.getAllFromIndex("photos", "by_audit", "A");
    expect(photos[0]).toMatchObject({ id: "ph1" });
    expect(photos[0]?.blob?.size).toBe(5);
    expect(await db.getAll("outbox")).toHaveLength(1);
    await db.put("trades", { id: "t1", name: "Plumbing", sort_order: 10, active: true });
    await db.put("issues", { id: "i1", projectId: "P", roomId: "R", kind: "punch_item", tradeId: null, title: "x", description: "", raisedBy: "u", raisedByLabel: "U", raisedAt: "t", pending: true, nextBase: 1 });
    await db.put("photos", { id: "ip1", auditId: "", issueId: "i1", version: 0, projectId: "P", itemKey: null, thumb: "t", mime: "image/jpeg", bytes: 1, sha256: "a".repeat(64), capturedAt: "t", capturedBy: "u", storagePath: "x", confirmed: false });
    expect((await db.getAllFromIndex("photos", "by_issue", "i1")).map((p) => p.id)).toEqual(["ip1"]);
    expect((await db.getAllFromIndex("issues", "by_room", "R")).map((i) => i.id)).toEqual(["i1"]);
  });
  it("upgrades a v4 device (with a checklist tick) without losing it", async () => {
    const old = await openDB("upg-v4only", 4, { upgrade(d) {
      d.createObjectStore("meta"); d.createObjectStore("projects", { keyPath: "id" }); d.createObjectStore("rooms", { keyPath: "id" }).createIndex("by_project", "project_id"); d.createObjectStore("templates", { keyPath: "id" });
      d.createObjectStore("audits", { keyPath: "key" }).createIndex("by_audit_id", "auditId"); d.createObjectStore("items", { keyPath: "key" }).createIndex("by_audit", "auditKey");
      d.createObjectStore("photos", { keyPath: "id" }).createIndex("by_audit", "auditId"); d.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true }).createIndex("by_audit", "auditId");
      d.createObjectStore("room_checks", { keyPath: "key" }).createIndex("by_room", "roomId");
    } });
    await old.put("room_checks", { key: "R:shelves", roomId: "R", projectId: "P", itemKey: "shelves", state: "done", pending: true, nextBase: 1 });
    old.close();
    const db = await openPhcDb("upg-v4only");
    expect(await db.get("room_checks", "R:shelves")).toMatchObject({ state: "done", pending: true });
    expect([...db.objectStoreNames]).toEqual(expect.arrayContaining(["trades", "issues"]));
  });
});
