import { useCallback, useEffect, useRef, useState } from "react";
import { isValidEmail, PRESET_OPTIONS, type ChecklistMode, type IssueKind, type IssueStatusFilter, type PhotoMode, type ReportOptions, type ReportPreset } from "@phc/domain";
import { loadReportData } from "@phc/reports/src/server/loadReportData";
import { supabaseDb } from "@phc/reports/src/server/supabaseAdapters";
import type { ReportRow } from "@phc/reports/src/server/ports";
import type { AppCtx } from "../App";
import { supabase } from "../lib/supabase";
import { loadRoles } from "../lib/issues";
import { callReportsApi, canManageReports, describeReportProblem, reportStatusLabel, savedLabel, stuckQueued, type ReportsRequest } from "../lib/reportsApi";
import { applyPreset, change, KIND_PLURAL, optionsProblem, PRESET_LABEL, setKind, summarizeOptions } from "../lib/reportOptionsUi";
import { useLive } from "./useLive";
import { fmtWhen } from "./when";

interface Contact { name: string; email: string; address: string }
const SOURCE_NOTE: Record<string, string> = { cockpit: "Filled in from Cockpit. Edit anything that is wrong; your change is kept.", manual: "Entered by hand." };
const TYPE_LABEL: Record<ReportRow["report_type"], string> = { builder_site_audit: "Builder site audit", room_status: "Room status", service: "Service report", custom: "Custom report" };
const KIND_LIST: IssueKind[] = ["pre_install_correction", "punch_item", "missing_part", "damaged_part", "touch_up"];
const PRESETS: ReportPreset[] = ["builder_site_audit", "service", "room_status", "custom"];
interface RoomLine { roomName: string; completed: boolean; byWho: string | null; at: string | null; outstanding: string[]; openIssues: number }
const STATUS_CLASS: Record<ReportRow["status"], string> = { built: "info", queued: "progress", sent: "good", failed: "bad" };

/**
 * Manager screen for one job: builder contact, room status, and the reports. Opening it builds the site audit from the latest data.
 * Only a report that was emailed or printed is kept (the latest of each kind); everything else is a throw-away preview.
 * Online only; managers only.
 */
export function Reports({ ctx, projectId }: { ctx: AppCtx; projectId: string }) {
  const roles = useLive(ctx.tick, () => loadRoles(ctx.db));
  const project = useLive(ctx.tick, () => ctx.db.get("projects", projectId), [projectId]);
  const allowed = canManageReports(roles, projectId);
  const [contact, setContact] = useState<Contact>({ name: "", email: "", address: "" });
  const [saved, setSaved] = useState<Contact | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [rooms, setRooms] = useState<RoomLine[] | null>(null);
  const [opts, setOpts] = useState<ReportOptions>(applyPreset("builder_site_audit"));
  const [shareFor, setShareFor] = useState<string | null>(null);
  const [emails, setEmails] = useState("");
  const [reports, setReports] = useState<ReportRow[] | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmSend, setConfirmSend] = useState<string | null>(null);
  const [pdfLink, setPdfLink] = useState<string | null>(null);
  const autoBuilt = useRef(false);

  const load = useCallback(async () => {
    if (!supabase) return;
    try {
      const sb = supabase;
      const [p, r, list] = await Promise.all([
        sb.from("projects").select("prepared_for_name,prepared_for_email,address,contact_source").eq("id", projectId).maybeSingle(),
        loadReportData(supabaseDb(sb), projectId, { preset: "custom", kinds: ["pre_install_correction", "punch_item", "missing_part", "damaged_part", "touch_up"], issueStatus: "open", checklist: "all", emptyRooms: true, photos: "none" }),
        sb.from("reports").select("*").eq("project_id", projectId).order("built_at", { ascending: false }),
      ]);
      if (p.error) throw new Error(p.error.message);
      if (list.error) throw new Error(list.error.message);
      const c = { name: p.data?.prepared_for_name ?? "", email: p.data?.prepared_for_email ?? "", address: p.data?.address ?? "" };
      setSource((p.data as { contact_source?: string | null } | null)?.contact_source ?? null);
      setSaved(c); setContact((cur) => (cur.name || cur.email || cur.address ? cur : c));
      setRooms(r.model.rooms.map((m) => ({ roomName: m.roomName, completed: !!m.checklist?.completed, byWho: m.checklist?.byWho ?? null, at: m.checklist?.at ?? null, outstanding: m.checklist?.outstanding ?? [], openIssues: m.issues.length })));
      setReports((list.data ?? []) as ReportRow[]);
    } catch (e) {
      setMessage({ kind: "bad", text: `Could not load this job's report data: ${e instanceof Error ? e.message : "unknown error"}` });
    }
  }, [projectId]);
  useEffect(() => { if (allowed && ctx.online) void load(); }, [allowed, ctx.online, load]);

  /** One call to the report function with the signed-in manager's token, then a reload so the screen shows what the server now holds. */
  const run = useCallback(async (label: string, body: ReportsRequest, okText: (d: Record<string, unknown>) => string): Promise<boolean> => {
    if (!supabase) return false;
    setBusy(label); setMessage(null);
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    const r = token ? await callReportsApi(fetch, token, body) : ({ ok: false, status: 401, code: "not_signed_in", message: "" } as const);
    setBusy(null); setConfirmSend(null);
    if (r.ok) setMessage({ kind: "ok", text: okText(r.data) }); else setMessage({ kind: "bad", text: describeReportProblem(r) });
    await load();
    return r.ok;
  }, [load]);

  const buildWith = useCallback((o: ReportOptions, doneText?: string) => run("build", { action: "build", projectId, options: o },
    (d) => `${doneText ?? "Report built from the latest data"} (${d.identified} issue${d.identified === 1 ? "" : "s"} listed, ${d.incomplete} incomplete${Number(d.photosMissing) > 0 ? `, ${d.photosMissing} photo(s) could not be loaded` : ""}).`), [run, projectId]);
  const buildAudit = useCallback((doneText?: string) => buildWith(PRESET_OPTIONS.builder_site_audit, doneText ?? "Site audit built from the latest data"), [buildWith]);

  // Opening the screen builds the site audit from the newest data, so what the manager previews, prints or sends is current.
  useEffect(() => {
    if (!allowed || !ctx.online || autoBuilt.current) return;
    autoBuilt.current = true;
    void buildAudit();
  }, [allowed, ctx.online, buildAudit]);

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
      prepared_for_name: contact.name.trim() || null, prepared_for_email: contact.email.trim() || null, address: contact.address.trim() || null, contact_source: "manual",
    }).eq("id", projectId);
    setBusy(null);
    if (error) { setMessage({ kind: "bad", text: `Could not save: ${error.message}` }); return; }
    await load(); void ctx.sync();
    await buildAudit("Saved. The site audit was rebuilt with the new details");   // the cover shows these details
  }

  /** Opens the stored PDF through a short-lived signed link. The window is opened inside the tap (phones block pop-ups opened later). */
  async function openPdf(report: ReportRow): Promise<boolean> {
    if (!supabase) return false;
    setPdfLink(null);
    const w = window.open("", "_blank");
    const { data, error } = await supabase.storage.from("reports").createSignedUrl(report.storage_path, 300);
    if (error || !data) { w?.close(); setMessage({ kind: "bad", text: `Could not open the PDF: ${error?.message ?? "unknown error"}` }); return false; }
    if (w) { try { w.opener = null; } catch { /* ignore */ } w.location.href = data.signedUrl; } else setPdfLink(data.signedUrl);   // pop-up blocked: show a link instead
    return true;
  }
  async function print(report: ReportRow) {
    if (!(await openPdf(report))) return;
    await run(`print-${report.id}`, { action: "print", reportId: report.id }, () => "Marked as printed. Print it from the PDF window. It replaces the previously saved report of this kind.");
  }

  async function shareWith(report: ReportRow) {
    const list = emails.split(/[\s,;]+/).filter(Boolean);
    const ok = await run(`share-${report.id}`, { action: "share", reportId: report.id, recipients: list }, (d) => `Shared with ${(d.to as string[]).join(", ")}. It replaces the previously saved report of this kind.`);
    if (ok) { setShareFor(null); setEmails(""); }
  }

  const canSendToBuilder = !!saved?.email && isValidEmail(saved.email) && !dirty;
  const now = Date.now();

  return (
    <>
      {back}
      <h1>Reports · {project.name}</h1>
      {message && <p className={`chip ${message.kind === "ok" ? "good" : "bad"}`} role={message.kind === "ok" ? "status" : "alert"} data-testid="reports-message">{message.text}</p>}
      {pdfLink && <p><a href={pdfLink} target="_blank" rel="noreferrer" data-testid="pdf-link">Open the PDF</a> <span className="muted small">(your phone blocked the pop-up)</span></p>}

      <section className="card" data-testid="builder-contact">
        <h2>Builder contact</h2>
        <p className="muted small">Shown on the cover. The site audit is emailed to this address, so check it carefully.</p>
        <label>Prepared for (name)<input value={contact.name} maxLength={200} onChange={(e) => setContact({ ...contact, name: e.target.value })} data-testid="contact-name" /></label>
        <label>Builder email<input type="email" inputMode="email" autoCapitalize="none" value={contact.email} maxLength={254} onChange={(e) => setContact({ ...contact, email: e.target.value })} data-testid="contact-email" /></label>
        {!emailOk && <p className="err" data-testid="contact-email-error">That email address does not look right.</p>}
        <label>Site address<input value={contact.address} maxLength={300} onChange={(e) => setContact({ ...contact, address: e.target.value })} data-testid="contact-address" /></label>
        {source && <p className="muted small" data-testid="contact-source">{SOURCE_NOTE[source]}</p>}
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
              <details>
                <summary data-testid="room-status-toggle"><strong>{r.roomName}</strong>&nbsp;
                  <span className={`chip ${r.completed ? "good" : "warn"}`}>{r.completed ? "Completed" : "Not completed"}</span>&nbsp;
                  <span className="chip gray">{r.openIssues} open {r.openIssues === 1 ? "issue" : "issues"}</span>
                </summary>
                {r.byWho && r.at && <div className="muted small">Last checked by {r.byWho} · {fmtWhen(r.at)}</div>}
                {r.outstanding.length > 0 && <ul className="small">{r.outstanding.map((o) => <li key={o}>{o}</li>)}</ul>}
                {r.outstanding.length === 0 && <p className="muted small">Every checklist item is done.</p>}
              </details>
            </li>
          ))}
        </ul>
      </section>

      <section className="card" data-testid="report-builder">
        <h2>Build a report</h2>
        <p className="muted small">Pick a starting point, then choose what goes on the page. The site audit is built for you when you open this screen; only the latest report you email, share or print is kept (one of each kind), previews are replaced.</p>
        <div className="btnrow" role="group" aria-label="Report type">
          {PRESETS.map((p) => <button key={p} className={opts.preset === p ? "on" : ""} aria-pressed={opts.preset === p} onClick={() => setOpts(applyPreset(p))} data-testid={`preset-${p}`}>{PRESET_LABEL[p]}</button>)}
        </div>
        <fieldset className="opts" data-testid="opt-kinds"><legend>Issues to list</legend>
          {KIND_LIST.map((k) => <label key={k} className="check"><input type="checkbox" checked={opts.kinds.includes(k)} onChange={(e) => setOpts(setKind(opts, k, e.target.checked))} data-testid={`kind-${k}`} /> {KIND_PLURAL[k]}</label>)}
        </fieldset>
        <fieldset className="opts" data-testid="opt-status"><legend>Issue status</legend>
          {([["open", "Open only"], ["completed", "Completed only"], ["both", "Open and completed"]] as [IssueStatusFilter, string][]).map(([v, l]) => <label key={v} className="check"><input type="radio" name="issue-status" checked={opts.issueStatus === v} onChange={() => setOpts(change(opts, { issueStatus: v }))} data-testid={`status-${v}`} /> {l}</label>)}
        </fieldset>
        <fieldset className="opts" data-testid="opt-checklist"><legend>Room status</legend>
          {([["none", "Do not show"], ["incomplete", "Rooms not completed only"], ["all", "All rooms (completed and not)"]] as [ChecklistMode, string][]).map(([v, l]) => <label key={v} className="check"><input type="radio" name="checklist" checked={opts.checklist === v} onChange={() => setOpts(change(opts, { checklist: v }))} data-testid={`checklist-${v}`} /> {l}</label>)}
          <label className="check"><input type="checkbox" checked={opts.emptyRooms} onChange={(e) => setOpts(change(opts, { emptyRooms: e.target.checked }))} data-testid="opt-empty-rooms" /> Also list rooms with nothing to show</label>
        </fieldset>
        <fieldset className="opts" data-testid="opt-photos"><legend>Photos (one or the other)</legend>
          {([["annotated", "Marked-up photos (the original if never marked up)"], ["original", "Original photos only"], ["none", "No photos"]] as [PhotoMode, string][]).map(([v, l]) => <label key={v} className="check"><input type="radio" name="photos" checked={opts.photos === v} onChange={() => setOpts(change(opts, { photos: v }))} data-testid={`photos-${v}`} /> {l}</label>)}
        </fieldset>
        {optionsProblem(opts) && <p className="err" data-testid="opts-problem">{optionsProblem(opts)}</p>}
        <button className="primary" disabled={busy !== null || optionsProblem(opts) !== null} onClick={() => void buildWith(opts)} data-testid="build-report">{busy === "build" ? "Building…" : `Build ${PRESET_LABEL[opts.preset].toLowerCase()} report`}</button>
      </section>

      <section className="card" data-testid="report-list">
        {reports === null && <p className="muted">Loading…</p>}
        {reports?.length === 0 && <p className="muted">{busy === "build" ? "Building the report from the latest data…" : "No reports yet."}</p>}
        <ul className="plain">
          {reports?.map((r) => {
            const stuck = stuckQueued(r, now);
            const kind = savedLabel(r);
            return (
              <li key={r.id} className="row static" data-testid="report-row" data-status={r.status} data-saved={kind === "preview" ? "no" : "yes"}>
                <strong>{TYPE_LABEL[r.report_type]}</strong>{" "}
                {kind === "preview" ? <span className="chip gray" data-testid="report-kind">Preview, not saved</span> : <span className="chip good" data-testid="report-kind">{kind === "sent" ? "Sent" : kind === "printed" ? "Printed" : kind === "shared" ? "Shared" : "Sent and printed"}</span>}{" "}
                {(r.status === "queued" || r.status === "failed") && <span className={`chip ${STATUS_CLASS[r.status]}`}>{reportStatusLabel(r.status)}</span>}
                <div className="muted small">
                  Built {fmtWhen(r.built_at)} · {(r.file_size / 1024 / 1024).toFixed(1)} MB
                  {r.sent_at ? ` · Sent ${fmtWhen(r.sent_at)} to ${r.recipient_email}` : ""}{r.printed_at ? ` · Printed ${fmtWhen(r.printed_at)}` : ""}{r.shared_at && r.shared_to ? ` · Shared ${fmtWhen(r.shared_at)} with ${r.shared_to.join(", ")}` : ""}
                </div>
                {r.options && <p className="muted small" data-testid="report-options">{summarizeOptions(r.options)}</p>}
                {r.status === "failed" && r.error && <p className="err small" data-testid="report-error">{r.error}</p>}
                {stuck && <p className="small" data-testid="report-stuck">Still sending after 10 minutes. Check the Sent folder first: the email may have gone out. If it did not, you can try again.</p>}
                <div className="btnrow">
                  <button onClick={() => void openPdf(r)} data-testid="report-preview">Preview PDF</button>
                  <button disabled={busy !== null || r.status === "queued"} onClick={() => void print(r)} data-testid="report-print">Print</button>
                  <button disabled={busy !== null} onClick={() => void run(`test-${r.id}`, { action: "sendTest", reportId: r.id }, (d) => `Test copy sent to ${d.to}.`)} data-testid="report-test">Send test to me</button>
                  <button disabled={busy !== null || r.status === "queued"} onClick={() => { setShareFor(shareFor === r.id ? null : r.id); setMessage(null); }} data-testid="report-share" aria-expanded={shareFor === r.id}>Email colleagues</button>
                  {(r.status === "built" || r.status === "failed" || stuck) && (
                    <button className="primary" disabled={busy !== null || !canSendToBuilder} onClick={() => setConfirmSend(r.id)} data-testid="report-send">{r.status === "failed" || stuck ? "Retry send" : "Send to builder"}</button>
                  )}
                </div>
                {shareFor === r.id && (
                  <div className="panel" data-testid="share-panel">
                    <label>PHC email addresses <small className="muted">(separate with commas or spaces; PHC addresses only, up to 10)</small>
                      <input value={emails} inputMode="email" autoCapitalize="none" onChange={(e) => setEmails(e.target.value)} placeholder="name@company-address" data-testid="share-emails" />
                    </label>
                    <p className="muted small">Each person gets their own copy, marked internal. Sharing does not use up the builder email. It replaces the previously saved report of this kind.</p>
                    <div className="btnrow">
                      <button className="primary" disabled={busy !== null || emails.trim() === ""} onClick={() => void shareWith(r)} data-testid="share-send">{busy === `share-${r.id}` ? "Sending…" : "Send to colleagues"}</button>
                      <button onClick={() => setShareFor(null)}>Cancel</button>
                    </div>
                  </div>
                )}
                {r.status !== "sent" && !canSendToBuilder && <p className="muted small">{dirty ? "Save the builder contact first." : "Add the builder's email above to enable sending."}</p>}
                {confirmSend === r.id && saved && (
                  <div className="panel" role="alertdialog" aria-label="Confirm send" data-testid="send-confirm">
                    <p><strong>Send this {TYPE_LABEL[r.report_type].toLowerCase()} to {saved.name || "the builder"} ({saved.email})?</strong><br />It goes out immediately and can only be sent once. It replaces the previously saved report of this kind.</p>
                    <div className="btnrow">
                      <button className="primary" disabled={busy !== null} onClick={() => void run(`send-${r.id}`, { action: "send", reportId: r.id }, (d) => `Sent to ${d.to}.`)} data-testid="send-confirm-yes">{busy === `send-${r.id}` ? "Sending…" : "Yes, send"}</button>
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
