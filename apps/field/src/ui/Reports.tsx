import { useCallback, useEffect, useState } from "react";
import { isValidEmail } from "@phc/domain";
import { loadRoomStatusData } from "@phc/reports/src/server/loadReportData";
import { supabaseDb } from "@phc/reports/src/server/supabaseAdapters";
import type { RoomStatusRow } from "@phc/reports/src/RoomStatusDocument";
import type { ReportRow } from "@phc/reports/src/server/ports";
import type { AppCtx } from "../App";
import { supabase } from "../lib/supabase";
import { loadRoles } from "../lib/issues";
import { callReportsApi, canManageReports, describeReportProblem, reportStatusLabel, stuckQueued, type ReportsRequest } from "../lib/reportsApi";
import { useLive } from "./useLive";
import { fmtWhen } from "./when";

interface Contact { name: string; email: string; address: string }
const TYPE_LABEL: Record<ReportRow["report_type"], string> = { builder_site_audit: "Builder site audit", room_status: "Room status" };
const STATUS_CLASS: Record<ReportRow["status"], string> = { built: "info", queued: "progress", sent: "good", failed: "bad" };

/** Manager screen for one job: builder contact, room status, build / preview / send reports. Online only; managers only. */
export function Reports({ ctx, projectId }: { ctx: AppCtx; projectId: string }) {
  const roles = useLive(ctx.tick, () => loadRoles(ctx.db));
  const project = useLive(ctx.tick, () => ctx.db.get("projects", projectId), [projectId]);
  const allowed = canManageReports(roles, projectId);
  const [contact, setContact] = useState<Contact>({ name: "", email: "", address: "" });
  const [saved, setSaved] = useState<Contact | null>(null);
  const [rooms, setRooms] = useState<RoomStatusRow[] | null>(null);
  const [reports, setReports] = useState<ReportRow[] | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmSend, setConfirmSend] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    try {
      const sb = supabase;
      const [p, r, list] = await Promise.all([
        sb.from("projects").select("prepared_for_name,prepared_for_email,address").eq("id", projectId).maybeSingle(),
        loadRoomStatusData(supabaseDb(sb), projectId),
        sb.from("reports").select("*").eq("project_id", projectId).order("built_at", { ascending: false }),
      ]);
      if (p.error) throw new Error(p.error.message);
      if (list.error) throw new Error(list.error.message);
      const c = { name: p.data?.prepared_for_name ?? "", email: p.data?.prepared_for_email ?? "", address: p.data?.address ?? "" };
      setSaved(c); setContact((cur) => (cur.name || cur.email || cur.address ? cur : c));
      setRooms(r); setReports((list.data ?? []) as ReportRow[]);
    } catch (e) {
      setMessage({ kind: "bad", text: `Could not load this job's report data: ${e instanceof Error ? e.message : "unknown error"}` });
    }
  }, [projectId]);
  useEffect(() => { if (allowed && ctx.online) void load(); }, [allowed, ctx.online, load]);

  if (!roles || !project) return <p>Loading…</p>;
  const back = <button className="link" onClick={() => ctx.go({ name: "project", projectId })} data-testid="back-project">← {project.name}</button>;
  if (!allowed) return <>{back}<h1>Reports</h1><p className="muted">Only managers of this job can build and send reports.</p></>;
  if (!ctx.online) return <>{back}<h1>Reports</h1><p className="muted" data-testid="reports-offline">Reports need a connection. Try again when you are online.</p></>;

  const dirty = saved !== null && (contact.name !== saved.name || contact.email !== saved.email || contact.address !== saved.address);
  const emailOk = contact.email === "" || isValidEmail(contact.email.trim());

  async function saveContact() {
    if (!supabase) return;
    setBusy("save"); setMessage(null);
    const { error } = await supabase.from("projects").update({
      prepared_for_name: contact.name.trim() || null, prepared_for_email: contact.email.trim() || null, address: contact.address.trim() || null,
    }).eq("id", projectId);
    setBusy(null);
    if (error) { setMessage({ kind: "bad", text: `Could not save: ${error.message}` }); return; }
    await load(); setMessage({ kind: "ok", text: "Saved." }); void ctx.sync();
  }

  async function call(label: string, body: ReportsRequest, okText: (d: Record<string, unknown>) => string) {
    if (!supabase) return;
    setBusy(label); setMessage(null);
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    const r = token ? await callReportsApi(fetch, token, body) : ({ ok: false, status: 401, code: "not_signed_in", message: "" } as const);
    setBusy(null); setConfirmSend(null);
    if (r.ok) setMessage({ kind: "ok", text: okText(r.data) }); else setMessage({ kind: "bad", text: describeReportProblem(r) });
    await load();
  }

  async function preview(report: ReportRow) {
    if (!supabase) return;
    const { data, error } = await supabase.storage.from("reports").createSignedUrl(report.storage_path, 300);
    if (error || !data) { setMessage({ kind: "bad", text: `Could not open the PDF: ${error?.message ?? "unknown error"}` }); return; }
    window.open(data.signedUrl, "_blank", "noopener");
  }

  const canSendToBuilder = !!saved?.email && isValidEmail(saved.email) && !dirty;
  const now = Date.now();

  return (
    <>
      {back}
      <h1>Reports · {project.name}</h1>
      {message && <p className={`chip ${message.kind === "ok" ? "good" : "bad"}`} role={message.kind === "ok" ? "status" : "alert"} data-testid="reports-message">{message.text}</p>}

      <section className="card" data-testid="builder-contact">
        <h2>Builder contact</h2>
        <p className="muted small">Shown on the cover. The site audit is emailed to this address, so check it carefully.</p>
        <label>Prepared for (name)<input value={contact.name} maxLength={200} onChange={(e) => setContact({ ...contact, name: e.target.value })} data-testid="contact-name" /></label>
        <label>Builder email<input type="email" inputMode="email" autoCapitalize="none" value={contact.email} maxLength={254} onChange={(e) => setContact({ ...contact, email: e.target.value })} data-testid="contact-email" /></label>
        {!emailOk && <p className="err" data-testid="contact-email-error">That email address does not look right.</p>}
        <label>Site address<input value={contact.address} maxLength={300} onChange={(e) => setContact({ ...contact, address: e.target.value })} data-testid="contact-address" /></label>
        <button className="primary" disabled={!dirty || !emailOk || busy === "save"} onClick={() => void saveContact()} data-testid="contact-save">{busy === "save" ? "Saving…" : "Save contact"}</button>
      </section>

      <section className="card" data-testid="room-status">
        <h2>Room status</h2>
        <p className="muted small">A room is Completed when every checklist item is Done or N/A. Open issues do not change that; the count is shown beside it.</p>
        {rooms === null && <p className="muted">Loading…</p>}
        {rooms?.length === 0 && <p className="muted">No rooms on this job.</p>}
        <ul className="plain">
          {rooms?.map((r) => (
            <li key={r.roomName} className="row static" data-testid="room-status-row">
              <strong>{r.roomName}</strong>{" "}
              <span className={`chip ${r.completed ? "good" : "warn"}`}>{r.completed ? "Completed" : "Not completed"}</span>{" "}
              <span className="chip gray">{r.openIssues} open {r.openIssues === 1 ? "issue" : "issues"}</span>
              {r.byWho && r.at && <div className="muted small">Last checked by {r.byWho} · {fmtWhen(r.at)}</div>}
              {r.outstanding.length > 0 && <ul className="small">{r.outstanding.map((o) => <li key={o}>{o}</li>)}</ul>}
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Build a report</h2>
        <div className="btnrow">
          <button className="primary" disabled={busy !== null} onClick={() => void call("build-audit", { action: "build", projectId, type: "builder_site_audit" }, (d) => `Site audit built (${d.identified} identified, ${d.incomplete} incomplete${Number(d.photosMissing) > 0 ? `, ${d.photosMissing} photo(s) could not be loaded` : ""}). Preview it before sending.`)} data-testid="build-audit">{busy === "build-audit" ? "Building…" : "Build site audit PDF"}</button>
          <button disabled={busy !== null} onClick={() => void call("build-status", { action: "build", projectId, type: "room_status" }, () => "Status PDF built.")} data-testid="build-status">{busy === "build-status" ? "Building…" : "Create status PDF"}</button>
        </div>
        <p className="muted small">Building takes a few seconds. Nothing is emailed until you press Send.</p>
      </section>

      <section className="card" data-testid="report-list">
        <h2>Reports</h2>
        {reports === null && <p className="muted">Loading…</p>}
        {reports?.length === 0 && <p className="muted">No reports built yet.</p>}
        <ul className="plain">
          {reports?.map((r) => {
            const stuck = stuckQueued(r, now);
            return (
              <li key={r.id} className="row static" data-testid="report-row" data-status={r.status}>
                <strong>{TYPE_LABEL[r.report_type]}</strong>{" "}<span className={`chip ${STATUS_CLASS[r.status]}`}>{reportStatusLabel(r.status)}</span>
                <div className="muted small">Built {fmtWhen(r.built_at)} · {(r.file_size / 1024 / 1024).toFixed(1)} MB{r.sent_at ? ` · Sent ${fmtWhen(r.sent_at)} to ${r.recipient_email}` : ""}</div>
                {r.status === "failed" && r.error && <p className="err small" data-testid="report-error">{r.error}</p>}
                {stuck && <p className="small" data-testid="report-stuck">Still sending after 10 minutes. Check the Sent folder first: the email may have gone out. If it did not, you can try again.</p>}
                <div className="btnrow">
                  <button onClick={() => void preview(r)} data-testid="report-preview">Preview PDF</button>
                  <button disabled={busy !== null} onClick={() => void call(`test-${r.id}`, { action: "sendTest", reportId: r.id }, (d) => `Test copy sent to ${d.to}.`)} data-testid="report-test">Send test to me</button>
                  {r.report_type === "builder_site_audit" && (r.status === "built" || r.status === "failed" || stuck) && (
                    <button className="primary" disabled={busy !== null || !canSendToBuilder} onClick={() => setConfirmSend(r.id)} data-testid="report-send">{r.status === "failed" || stuck ? "Retry send" : "Send to builder"}</button>
                  )}
                </div>
                {r.report_type === "builder_site_audit" && r.status !== "sent" && !canSendToBuilder && <p className="muted small">{dirty ? "Save the builder contact first." : "Add the builder's email above to enable sending."}</p>}
                {confirmSend === r.id && saved && (
                  <div className="panel" role="alertdialog" aria-label="Confirm send" data-testid="send-confirm">
                    <p><strong>Send this report to {saved.name || "the builder"} ({saved.email})?</strong><br />It goes out immediately and can only be sent once.</p>
                    <div className="btnrow">
                      <button className="primary" disabled={busy !== null} onClick={() => void call(`send-${r.id}`, { action: "send", reportId: r.id }, (d) => `Sent to ${d.to}.`)} data-testid="send-confirm-yes">{busy === `send-${r.id}` ? "Sending…" : "Yes, send"}</button>
                      <button onClick={() => setConfirmSend(null)} data-testid="send-confirm-no">Cancel</button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}
