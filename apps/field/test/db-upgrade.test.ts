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
  it("a fresh install gets the v3 stores directly", async () => {
    const db = await openPhcDb("fresh-1");
    expect([...db.objectStoreNames].sort()).toEqual(["audits", "items", "meta", "outbox", "photos", "projects", "rooms", "templates"]);
    await db.put("audits", { key: "X:2", auditId: "X", version: 2, projectId: "P", roomId: null, templateId: "T", createdBy: "u", createdByLabel: "U", createdAt: "t" });
    expect((await db.getAllFromIndex("audits", "by_audit_id", "X"))[0]?.version).toBe(2);
  });
});
