import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Identity, LocalAudit, LocalItem, LocalIssue, LocalPhoto, LocalRoomCheck, OutboxRecord, ProjectRow, RoomRow, TemplateRow, TradeRow } from "./types";

interface PhcDB extends DBSchema {
  meta: { key: string; value: unknown };
  projects: { key: string; value: ProjectRow };
  rooms: { key: string; value: RoomRow; indexes: { by_project: string } };
  templates: { key: string; value: TemplateRow };
  audits: { key: string; value: LocalAudit; indexes: { by_audit_id: string } };
  items: { key: string; value: LocalItem; indexes: { by_audit: string } };
  photos: { key: string; value: LocalPhoto; indexes: { by_audit: string; by_issue: string } };
  trades: { key: string; value: TradeRow };
  issues: { key: string; value: LocalIssue; indexes: { by_room: string } };
  room_checks: { key: string; value: LocalRoomCheck; indexes: { by_room: string } };
  outbox: { key: number; value: OutboxRecord; indexes: { by_audit: string } };
}

export type Db = IDBPDatabase<PhcDB>;

/** Durable local store. Every write the user makes lands here (and in `outbox`) before any network call. */
export function openPhcDb(name = "phc-field"): Promise<Db> {
  return openDB<PhcDB>(name, 5, {
    async upgrade(db, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) {
        db.createObjectStore("meta");
        db.createObjectStore("projects", { keyPath: "id" });
        db.createObjectStore("rooms", { keyPath: "id" }).createIndex("by_project", "project_id");
        db.createObjectStore("templates", { keyPath: "id" });
        db.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true }).createIndex("by_audit", "auditId");
      }
      // (v2 added the photos store; v3 recreates audits/items/photos below, so a fresh install creates them only once, there.)
      if (oldVersion < 3) {
        // v3: audits, items and photos become version-aware. Existing local data (all version 1) is carried over in place
        // so unsynced work on a device survives the upgrade; the outbox is not touched.
        const oldAudits: any[] = oldVersion >= 1 ? await tx.objectStore("audits" as never).getAll() : [];
        const oldItems: any[] = oldVersion >= 1 ? await tx.objectStore("items" as never).getAll() : [];
        const oldPhotos: any[] = oldVersion >= 2 ? await tx.objectStore("photos").getAll() : [];
        if (oldVersion >= 1) { db.deleteObjectStore("audits" as never); db.deleteObjectStore("items" as never); }
        if (oldVersion >= 2) db.deleteObjectStore("photos");
        const audits = db.createObjectStore("audits", { keyPath: "key" });
        audits.createIndex("by_audit_id", "auditId");
        const items = db.createObjectStore("items", { keyPath: "key" });
        items.createIndex("by_audit", "auditKey");
        db.createObjectStore("photos", { keyPath: "id" }).createIndex("by_audit", "auditId");
        for (const a of oldAudits) audits.put({ createdByLabel: "", ...a, key: `${a.auditId}:1`, version: 1 });
        for (const i of oldItems) items.put({ ...i, version: 1, auditKey: `${i.auditId}:1` });
        for (const p of oldPhotos) tx.objectStore("photos").put({ ...p, version: 1 });
      }
      // v4: the per-room completion checklist.
      if (oldVersion < 4) db.createObjectStore("room_checks", { keyPath: "key" }).createIndex("by_room", "roomId");
      // v5: issues (with their photos) and the trade list.
      if (oldVersion < 5) {
        db.createObjectStore("trades", { keyPath: "id" });
        db.createObjectStore("issues", { keyPath: "id" }).createIndex("by_room", "roomId");
        tx.objectStore("photos").createIndex("by_issue", "issueId");
      }
    }
  });
}

export const getIdentity = async (db: Db): Promise<Identity | undefined> => (await db.get("meta", "identity")) as Identity | undefined;
export const setIdentity = (db: Db, i: Identity) => db.put("meta", i, "identity");
export const clearIdentity = (db: Db) => db.delete("meta", "identity");

/** Replace the cached read-only reference data (projects the user belongs to, their rooms, active templates). */
export async function replaceCache(db: Db, data: { projects: ProjectRow[]; rooms: RoomRow[]; templates: TemplateRow[]; trades?: TradeRow[] }) {
  const tx = db.transaction(["projects", "rooms", "templates", "trades", "meta"], "readwrite");
  await Promise.all([tx.objectStore("projects").clear(), tx.objectStore("rooms").clear(), tx.objectStore("templates").clear(), ...(data.trades ? [tx.objectStore("trades").clear()] : [])]);
  await Promise.all([
    ...data.projects.map((p) => tx.objectStore("projects").put(p)),
    ...data.rooms.map((r) => tx.objectStore("rooms").put(r)),
    ...data.templates.map((t) => tx.objectStore("templates").put(t)),
    ...(data.trades ?? []).map((t) => tx.objectStore("trades").put(t)),
    tx.objectStore("meta").put(new Date().toISOString(), "cacheRefreshedAt")
  ]);
  await tx.done;
}
