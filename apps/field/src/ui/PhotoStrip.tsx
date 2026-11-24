import { useEffect, useState } from "react";
import type { AppCtx } from "../App";
import type { Shape } from "../lib/annotations";
import { browserCompress, makeThumb } from "../lib/imaging";
import { addIssuePhoto, addPhoto, ensureRemoteThumb, photoSourceBlob } from "../lib/photos";
import { supabase } from "../lib/supabase";
import type { LocalPhoto } from "../lib/types";
import { AnnotateModal } from "./AnnotateModal";

export type PhotoScope = { kind: "audit"; auditId: string; itemKey: string | null } | { kind: "issue"; issueId: string };

const mkCtx = (ctx: AppCtx) => ({ db: ctx.db, outbox: ctx.outbox, userId: ctx.identity.userId, userLabel: ctx.identity.label, newId: () => crypto.randomUUID(), now: () => new Date().toISOString() });

/** A photo taken by someone else is not on this phone: fetch a small preview when it is on screen and we are online; otherwise a plain tile. */
function Preview({ ctx, p }: { ctx: AppCtx; p: LocalPhoto }) {
  useEffect(() => {
    if (p.thumb || !supabase || !navigator.onLine) return;
    const sb = supabase;
    void ensureRemoteThumb({ db: ctx.db, makeThumb, download: async (path) => (await sb.storage.from("issue-photos").download(path)).data }, p.id).then(() => ctx.outbox.notify());
  }, [p.id, p.thumb, ctx]);
  if (!p.thumb) return <div className="tile" aria-label="Photo" data-testid="photo-tile">Photo</div>;
  return <img src={p.thumb} alt={p.annotatedFrom ? "Marked-up site photo" : "Site photo"} width={64} height={64} />;
}

/** Photos for an audit item (or the audit's room) or for an issue: add, preview, mark up. Marks always create a separate copy. */
export function PhotoStrip({ ctx, scope, photos, disabled }: { ctx: AppCtx; scope: PhotoScope; photos: LocalPhoto[]; disabled: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<{ original: LocalPhoto; source: Blob; initial: Shape[] } | null>(null);
  // A photo that has a marked-up copy is archived: kept (never deleted or changed) but not shown in the list unless asked.
  const archivedIds = new Set(photos.filter((p) => p.annotatedFrom).map((p) => p.annotatedFrom as string));
  const archivedCount = photos.filter((p) => archivedIds.has(p.id)).length;
  const visible = photos.filter((p) => showArchived || !archivedIds.has(p.id));
  const bucket = scope.kind === "issue" ? "issue-photos" : "audit-photos";
  const key = scope.kind === "issue" ? `issue-${scope.issueId}` : scope.itemKey ?? "room";

  async function onFile(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true); setError(null);
    for (const f of Array.from(files)) {
      const r = scope.kind === "issue"
        ? await addIssuePhoto({ ...mkCtx(ctx), compress: browserCompress, notify: () => ctx.outbox.notify() }, { issueId: scope.issueId, file: f })
        : await addPhoto({ ...mkCtx(ctx), compress: browserCompress }, { auditId: scope.auditId, itemKey: scope.itemKey, file: f });
      if (!r.ok) { setError(r.error.message); break; }
    }
    setBusy(false);
    void ctx.sync();
  }
  /** Marks always start from the ORIGINAL image. If it was cleaned up after upload, download it when online. */
  async function openEditor(p: LocalPhoto) {
    setError(null);
    const original = p.annotatedFrom ? photos.find((x) => x.id === p.annotatedFrom) ?? (await ctx.db.get("photos", p.annotatedFrom)) : p;
    if (!original) { setError("The original photo is not on this device."); return; }
    let source = photoSourceBlob(original);
    if (!source && supabase && navigator.onLine) {
      const { data } = await supabase.storage.from(bucket).download(original.storagePath);
      if (data) source = data;
    }
    if (!source) { setError("This photo is no longer stored on the device. Connect to the internet to mark it up."); return; }
    setEditing({ original, source, initial: p.annotatedFrom ? p.annotations ?? [] : [] });
  }
  return (
    <div className="photos">
      <div className="thumbs">
        {visible.map((p) => (
          <figure key={p.id} data-testid="photo-thumb" data-annotated={p.annotatedFrom ? "yes" : "no"} data-archived={archivedIds.has(p.id) ? "yes" : "no"}>
            <Preview ctx={ctx} p={p} />
            <figcaption className={p.confirmed ? "ok" : "wait"} data-testid="photo-status">{p.confirmed ? "Uploaded" : "On this device"}</figcaption>
            {p.annotatedFrom && <figcaption className="muted" data-testid="photo-kind">Marked up</figcaption>}
            {archivedIds.has(p.id) && <figcaption className="muted" data-testid="photo-archived">Original (archived)</figcaption>}
            {!disabled && !!p.thumb && !archivedIds.has(p.id) && <button className="small" onClick={() => void openEditor(p)} data-testid={p.annotatedFrom ? "edit-marks" : "annotate-btn"}>{p.annotatedFrom ? "Edit marks" : "Mark up"}</button>}
          </figure>
        ))}
      </div>
      {archivedCount > 0 && (
        <button className="link small" onClick={() => setShowArchived((s) => !s)} data-testid="show-archived" aria-pressed={showArchived}>
          {showArchived ? "Hide archived originals" : `Show ${archivedCount} archived original${archivedCount === 1 ? "" : "s"}`}
        </button>
      )}
      {!disabled && scope.kind === "audit" && (
        <label className="filebtn">
          {busy ? "Saving photo…" : "Add photo"}
          <input type="file" accept="image/*" capture="environment" multiple hidden data-testid={`photo-input-${key}`} onChange={(e) => { void onFile(e.target.files); e.target.value = ""; }} />
        </label>
      )}
      {!disabled && scope.kind === "issue" && (
        <div className="btnrow">
          <label className="filebtn">{busy ? "Saving photo…" : "Take a photo"}
            <input type="file" accept="image/*" capture="environment" hidden data-testid={`photo-input-${key}`} onChange={(e) => { void onFile(e.target.files); e.target.value = ""; }} />
          </label>
          <label className="filebtn">Choose from photos
            <input type="file" accept="image/*" multiple hidden data-testid={`photo-pick-${key}`} onChange={(e) => { void onFile(e.target.files); e.target.value = ""; }} />
          </label>
        </div>
      )}
      {error && <p className="chip bad" role="alert">{error}</p>}
      {editing && <AnnotateModal ctx={ctx} source={editing.source} original={editing.original} initial={editing.initial} onClose={() => setEditing(null)} />}
    </div>
  );
}
