import { isValidEmail } from "./email";

/**
 * The part of Cockpit's Project record this app reads (field names as in Cockpit's prisma schema and MasterFile header fields).
 * Cockpit is read-only reference for this project: nothing here calls Cockpit; a record is given to the mapper (mock contract).
 * Only the fields below are ever read. Gate codes, notes, phone numbers and every other field are ignored on purpose.
 */
export interface CockpitProjectRecord {
  name?: string | null;
  builder?: string | null;
  address?: string | null;
  /** Cockpit stores the MasterFile header as JSON text; an already-parsed object is accepted too. */
  estimateDetails?: string | Record<string, unknown> | null;
  [other: string]: unknown;
}

export interface MappedProjectContact {
  address: string | null;
  preparedForName: string | null;
  preparedForEmail: string | null;
  contactSource: "cockpit";
}

const text = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return s === "" ? null : s.slice(0, max).trim();
};

function details(raw: CockpitProjectRecord["estimateDetails"]): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string" || raw === "") return {};
  try { const o: unknown = JSON.parse(raw); return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : {}; } catch { return {}; }
}

/** Address: MasterFile "Project Address", else the project's address column. Prepared for: "Builder Name", else the project's builder, else "Contact Name". Email: "Contact Email" if valid. */
export function mapCockpitProject(rec: CockpitProjectRecord): MappedProjectContact {
  const d = details(rec.estimateDetails);
  const email = text(d.contactEmail, 254);
  return {
    address: text(d.projectAddress, 300) ?? text(rec.address, 300),
    preparedForName: text(d.builder, 200) ?? text(rec.builder, 200) ?? text(d.contact, 200),
    preparedForEmail: email !== null && isValidEmail(email) ? email : null,
    contactSource: "cockpit",
  };
}

const lit = (v: string | null) => (v === null ? "NULL" : `'${v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/'/g, "''")}'`);

/** One UPDATE statement for the owner to read and approve; this package never runs it. */
export function projectContactSql(projectId: string, c: MappedProjectContact): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) throw new Error("projectId must be a uuid");
  return `update public.projects set address = ${lit(c.address)}, prepared_for_name = ${lit(c.preparedForName)}, prepared_for_email = ${lit(c.preparedForEmail)}, contact_source = ${lit(c.contactSource)} where id = '${projectId}';`;
}
