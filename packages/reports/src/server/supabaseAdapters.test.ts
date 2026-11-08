import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PRESET_OPTIONS } from "@phc/domain";
import { supabaseDb, supabaseStorage } from "./supabaseAdapters";

/** A stand-in client that records the calls (names and parameters must match migration 1700 exactly). */
function stub(responses: Record<string, { data?: unknown; error?: { message: string } | null }> = {}) {
  const calls: { fn: string; args: unknown }[] = [];
  const query = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order"]) q[m] = (...a: unknown[]) => { calls.push({ fn: `${table}.${m}`, args: a }); return q; };
    q.maybeSingle = async () => { calls.push({ fn: `${table}.maybeSingle`, args: [] }); return { data: null, error: null, ...(responses[table] ?? {}) }; };
    q.then = (res: (v: unknown) => unknown) => res({ data: [], error: null, ...(responses[table] ?? {}) });
    return q;
  };
  const sb = {
    from: query,
    rpc: async (fn: string, args: unknown) => { calls.push({ fn: `rpc.${fn}`, args }); return { data: { id: "r1" }, error: null, ...(responses[`rpc.${fn}`] ?? {}) }; },
    storage: { from: (b: string) => ({
      download: async (p: string) => { calls.push({ fn: `storage.${b}.download`, args: [p] }); return responses.download ?? { data: new Blob([new Uint8Array([1, 2, 3])]), error: null }; },
      upload: async (p: string, _bytes: unknown, o: unknown) => { calls.push({ fn: `storage.${b}.upload`, args: [p, o] }); return responses.upload ?? { data: {}, error: null }; },
      createSignedUrl: async (p: string, s: number) => { calls.push({ fn: `storage.${b}.sign`, args: [p, s] }); return { data: { signedUrl: "https://x/y" }, error: null }; },
    }) },
  } as unknown as SupabaseClient;
  return { sb, calls };
}

describe("supabaseDb sends the exact function names and parameters the migration defines", () => {
  it("create_report", async () => {
    const { sb, calls } = stub();
    await supabaseDb(sb).createReport({ id: "i", projectId: "p", type: "room_status", path: "p/i.pdf", bytes: 5, options: PRESET_OPTIONS.room_status });
    expect(calls).toEqual([{ fn: "rpc.create_report", args: { p_id: "i", p_project: "p", p_type: "room_status", p_path: "p/i.pdf", p_bytes: 5, p_options: PRESET_OPTIONS.room_status } }]);
  });
  it("queue_report_send, mark_report_sent, mark_report_failed", async () => {
    const { sb, calls } = stub();
    const db = supabaseDb(sb);
    await db.queueReportSend("r", "Name", "a@b.test"); await db.markReportSent("r", "m1"); await db.markReportFailed("r", "boom");
    expect(calls).toEqual([
      { fn: "rpc.queue_report_send", args: { p_report_id: "r", p_recipient_name: "Name", p_recipient_email: "a@b.test" } },
      { fn: "rpc.mark_report_sent", args: { p_report_id: "r", p_message_id: "m1" } },
      { fn: "rpc.mark_report_failed", args: { p_report_id: "r", p_error: "boom" } },
    ]);
  });
  it("mark_report_printed and prune_reports use the migration's names and parameters", async () => {
    const { sb, calls } = stub({ "rpc.prune_reports": { data: ["p/a.pdf"] } });
    const db = supabaseDb(sb);
    await db.markReportPrinted("r");
    expect(await db.pruneReports("P", "room_status", "k")).toEqual(["p/a.pdf"]);
    expect(calls).toEqual([
      { fn: "rpc.mark_report_printed", args: { p_report_id: "r" } },
      { fn: "rpc.prune_reports", args: { p_project: "P", p_type: "room_status", p_keep: "k" } },
    ]);
  });
  it("mark_report_shared uses the migration's name and parameters", async () => {
    const { sb, calls } = stub();
    await supabaseDb(sb).markReportShared("r", ["a@phc.example", "b@phc.example"]);
    expect(calls).toEqual([{ fn: "rpc.mark_report_shared", args: { p_report_id: "r", p_emails: ["a@phc.example", "b@phc.example"] } }]);
  });
  it("turns the database's refusal words into error codes", async () => {
    for (const code of ["report_already_queued", "report_already_sent", "report_not_queued", "invalid_recipient", "forbidden"]) {
      const { sb } = stub({ "rpc.queue_report_send": { data: null, error: { message: `${code}` } } });
      await expect(supabaseDb(sb).queueReportSend("r", null, "a@b.test")).rejects.toMatchObject({ code });
    }
    const { sb } = stub({ "rpc.create_report": { data: null, error: { message: "boom" } } });
    await expect(supabaseDb(sb).createReport({ id: "i", projectId: "p", type: "room_status", path: "x", bytes: 1, options: PRESET_OPTIONS.room_status })).rejects.toMatchObject({ code: "db_error" });
  });
  it("reads only this job's rows", async () => {
    const { sb, calls } = stub();
    const db = supabaseDb(sb);
    await db.listRooms("P"); await db.listIssues("P"); await db.listIssuePhotos("P"); await db.listRoomChecks("P");
    for (const t of ["rooms", "room_issues", "issue_photos", "room_checks"]) expect(calls).toContainEqual({ fn: `${t}.eq`, args: ["project_id", "P"] });
    expect((calls.find((c) => c.fn === "room_issues.select")!.args as string[])[0]).toContain("trades(name)");
  });
  it("does not ask for profiles when there are none to look up", async () => {
    const { sb, calls } = stub();
    expect(await supabaseDb(sb).listProfiles([])).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("supabaseStorage", () => {
  it("download gives a Buffer, or null when the file cannot be read", async () => {
    const ok = stub();
    expect((await supabaseStorage(ok.sb).download("issue-photos", "a/b.jpg"))!.length).toBe(3);
    const bad = stub({ download: { data: null, error: { message: "not found" } } });
    expect(await supabaseStorage(bad.sb).download("issue-photos", "a/b.jpg")).toBeNull();
  });
  it("upload never overwrites and says what went wrong", async () => {
    const { sb, calls } = stub();
    await supabaseStorage(sb).upload("reports", "p/i.pdf", Buffer.from("x"));
    expect(calls[0]).toEqual({ fn: "storage.reports.upload", args: ["p/i.pdf", { contentType: "application/pdf", upsert: false }] });
    const bad = stub({ upload: { data: null, error: { message: "quota" } } });
    await expect(supabaseStorage(bad.sb).upload("reports", "p/i.pdf", Buffer.from("x"))).rejects.toMatchObject({ code: "upload_failed" });
  });
  it("remove counts the files that were not removed; list gives full paths and skips folders", async () => {
    const calls: unknown[] = [];
    const sb = { storage: { from: () => ({
      remove: async (p: string[]) => { calls.push(p); return { data: [{ name: p[0] }], error: null }; },
      list: async () => ({ data: [{ id: "x", name: "a.pdf", created_at: "2026-01-01T00:00:00Z" }, { id: null, name: "sub" }], error: null }),
    }) } } as unknown as SupabaseClient;
    const s = supabaseStorage(sb);
    expect(await s.remove("reports", ["p/a.pdf", "p/b.pdf"])).toBe(1);
    expect(await s.list("reports", "p")).toEqual([{ path: "p/a.pdf", createdAt: "2026-01-01T00:00:00Z" }]);
  });
  it("signs a link for the requested number of seconds", async () => {
    const { sb, calls } = stub();
    expect(await supabaseStorage(sb).signedUrl("reports", "p/i.pdf", 300)).toBe("https://x/y");
    expect(calls[0]).toEqual({ fn: "storage.reports.sign", args: ["p/i.pdf", 300] });
  });
});
