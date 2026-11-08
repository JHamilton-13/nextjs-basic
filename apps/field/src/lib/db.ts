import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Identity, LocalAudit, LocalItem, OutboxRecord, ProjectRow, RoomRow, TemplateRow } from "./types";

interface PhcDB extends DBSchema {
  meta: { key: string; value: unknown };
  projects: { key: string; value: ProjectRow };
  rooms: { key: string; value: RoomRow; indexes: { by_project: string } };
  templates: { key: string; value: TemplateRow };
  audits: { key: string; value: LocalAudit };
  items: { key: string; value: LocalItem; indexes: { by_audit: string } };
  outbox: { key: number; value: OutboxRecord; indexes: { by_audit: string } };
}

export type Db = IDBPDatabase<PhcDB>;

/** Durable local store. Every write the user makes lands here (and in `outbox`) before any network call. */
export function openPhcDb(name = "phc-field"): Promise<Db> {
  return openDB<PhcDB>(name, 1, {
    upgrade(db) {
      db.createObjectStore("meta");
      db.createObjectStore("projects", { keyPath: "id" });
      db.createObjectStore("rooms", { keyPath: "id" }).createIndex("by_project", "project_id");
      db.createObjectStore("templates", { keyPath: "id" });
      db.createObjectStore("audits", { keyPath: "auditId" });
      db.createObjectStore("items", { keyPath: "key" }).createIndex("by_audit", "auditId");
      db.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true }).createIndex("by_audit", "auditId");
    }
  });
}

export const getIdentity = async (db: Db): Promise<Identity | undefined> => (await db.get("meta", "identity")) as Identity | undefined;
export const setIdentity = (db: Db, i: Identity) => db.put("meta", i, "identity");

/** Replace the cached read-only reference data (projects the user belongs to, their rooms, active templates). */
export async function replaceCache(db: Db, data: { projects: ProjectRow[]; rooms: RoomRow[]; templates: TemplateRow[] }) {
  const tx = db.transaction(["projects", "rooms", "templates", "meta"], "readwrite");
  await Promise.all([tx.objectStore("projects").clear(), tx.objectStore("rooms").clear(), tx.objectStore("templates").clear()]);
  await Promise.all([
    ...data.projects.map((p) => tx.objectStore("projects").put(p)),
    ...data.rooms.map((r) => tx.objectStore("rooms").put(r)),
    ...data.templates.map((t) => tx.objectStore("templates").put(t)),
    tx.objectStore("meta").put(new Date().toISOString(), "cacheRefreshedAt")
  ]);
  await tx.done;
}
