import { describe, it, expect } from "vitest";
import {
  auditState, submitAudit, setItemOutcome, grantOverride, release, reviseAudit, isEditable,
  type AuditRecord, type AuditItemOutcome, type ReadinessPolicy,
} from "../src/readiness";

const T = (n: number) => `2026-11-08T10:${String(n).padStart(2, "0")}:00.000Z`;
const policyMgr: ReadinessPolicy = { nonCriticalIssueState: "manager_review_required" };
const policyExc: ReadinessPolicy = { nonCriticalIssueState: "ready_with_exceptions" };

const item = (itemId: string, result: AuditItemOutcome["result"], o: Partial<AuditItemOutcome> = {}): AuditItemOutcome =>
  ({ itemId, critical: false, required: true, result, ...o });

const audit = (items: AuditItemOutcome[], o: Partial<AuditRecord> = {}): AuditRecord => ({
  auditId: "a1", projectId: "p1", version: 1, submitted: false, items, overrides: [], ...o,
});

const sub = (a: AuditRecord) => {
  const r = submitAudit(a, "inst1", T(1));
  if (!r.ok) throw new Error(`submit failed: ${r.error.code}`);
  return r.value.audit;
};

describe("auditState derivation", () => {
  it("not_started when nothing entered", () => {
    expect(auditState(audit([item("w1", "NOT_ENTERED")]), policyMgr)).toBe("not_started");
    expect(auditState(audit([]), policyMgr)).toBe("not_started");
  });
  it("in_progress when some entered and not submitted", () => {
    expect(auditState(audit([item("w1", "PASS"), item("w2", "NOT_ENTERED")]), policyMgr)).toBe("in_progress");
  });
  it("critical FAIL flags not_ready immediately, even before submit", () => {
    const a = audit([item("mep1", "FAIL", { critical: true }), item("w2", "NOT_ENTERED")]);
    expect(auditState(a, policyMgr)).toBe("not_ready");
  });
  it("submitted all PASS is ready", () => {
    expect(auditState(sub(audit([item("w1", "PASS"), item("mep1", "PASS", { critical: true })])), policyMgr)).toBe("ready");
  });
  it("non-critical FAIL follows policy (manager review)", () => {
    const a = sub(audit([item("w1", "FAIL"), item("mep1", "PASS", { critical: true })]));
    expect(auditState(a, policyMgr)).toBe("manager_review_required");
  });
  it("non-critical REVIEW follows policy (ready with exceptions)", () => {
    const a = sub(audit([item("w1", "REVIEW")]));
    expect(auditState(a, policyExc)).toBe("ready_with_exceptions");
  });
  it("critical REVIEW always needs manager review", () => {
    const a = sub(audit([item("mep1", "REVIEW", { critical: true })]));
    expect(auditState(a, policyExc)).toBe("manager_review_required");
  });
  it("a critical FAIL beats everything else", () => {
    const a = sub(audit([item("w1", "FAIL"), item("mep1", "FAIL", { critical: true })]));
    expect(auditState(a, policyExc)).toBe("not_ready");
  });
  it("observation items and not-applicable items never affect readiness", () => {
    const a = sub(audit([item("plumb", "OBSERVED", { required: false }), item("na", "NOT_APPLICABLE"), item("w1", "PASS")]));
    expect(auditState(a, policyMgr)).toBe("ready");
  });
});

describe("submitAudit", () => {
  it("is blocked while a required item has no result", () => {
    const r = submitAudit(audit([item("w1", "PASS"), item("w2", "NOT_ENTERED")]), "u", T(1));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("required_items_incomplete");
      expect(r.error.itemIds).toEqual(["w2"]);
    }
  });
  it("allows optional items to stay unentered", () => {
    const r = submitAudit(audit([item("w1", "PASS"), item("plumb", "NOT_ENTERED", { required: false })]), "u", T(1));
    expect(r.ok).toBe(true);
  });
  it("cannot submit twice", () => {
    const a = sub(audit([item("w1", "PASS")]));
    const r = submitAudit(a, "u", T(2));
    expect(!r.ok && r.error.code).toBe("already_submitted");
  });
  it("emits an audit_submitted event", () => {
    const r = submitAudit(audit([item("w1", "PASS")]), "inst1", T(1));
    expect(r.ok && r.value.event).toMatchObject({ type: "audit_submitted", actorId: "inst1", version: 1, auditId: "a1" });
  });
});

describe("submitted audits are immutable", () => {
  it("cannot change an item outcome after submit", () => {
    const a = sub(audit([item("w1", "FAIL")]));
    expect(isEditable(a)).toBe(false);
    const r = setItemOutcome(a, item("w1", "PASS"));
    expect(!r.ok && r.error.code).toBe("audit_submitted");
  });
  it("can change outcomes before submit, without mutating the input", () => {
    const a = audit([item("w1", "NOT_ENTERED")]);
    const r = setItemOutcome(a, item("w1", "PASS"));
    expect(r.ok).toBe(true);
    expect(a.items[0]?.result).toBe("NOT_ENTERED");
    if (r.ok) expect(r.value.items[0]?.result).toBe("PASS");
  });
  it("rejects outcomes for unknown items", () => {
    const r = setItemOutcome(audit([item("w1", "PASS")]), item("zzz", "PASS"));
    expect(!r.ok && r.error.code).toBe("unknown_item");
  });
});

describe("release: clear audit", () => {
  it("manager can release a ready audit", () => {
    const a = sub(audit([item("w1", "PASS")]));
    const r = release(a, { userId: "pm1", role: "project_manager" }, T(5), policyMgr);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(auditState(r.value.audit, policyMgr)).toBe("released_for_installation");
      expect(r.value.audit.release).toMatchObject({ releasedBy: "pm1", basis: "clear", auditVersion: 1 });
      expect(r.value.event.type).toBe("released");
    }
  });
  it("roles outside the release set cannot release (e.g. client, warehouse)", () => {
    const a = sub(audit([item("w1", "PASS")]));
    for (const role of ["client", "general_contractor", "warehouse", "shop", "service_technician"] as const) {
      const r = release(a, { userId: "x", role }, T(5), policyMgr);
      expect(!r.ok && r.error.code).toBe("role_not_authorized");
    }
  });
  it("cannot release before the inspection is complete", () => {
    const r = release(audit([item("w1", "PASS"), item("w2", "NOT_ENTERED")]), { userId: "pm1", role: "project_manager" }, T(5), policyMgr);
    expect(!r.ok && r.error.code).toBe("inspection_not_complete");
  });
  it("cannot release twice", () => {
    const a = sub(audit([item("w1", "PASS")]));
    const r1 = release(a, { userId: "pm1", role: "project_manager" }, T(5), policyMgr);
    if (!r1.ok) throw new Error("setup");
    const r2 = release(r1.value.audit, { userId: "pm1", role: "project_manager" }, T(6), policyMgr);
    expect(!r2.ok && r2.error.code).toBe("already_released");
  });
});

describe("release: stop-gate (scenarios 3, 4, 5, 19)", () => {
  const failed = () => sub(audit([item("mep1", "FAIL", { critical: true }), item("mep2", "PASS", { critical: true }), item("w1", "PASS")]));

  it("blocks release after a critical FAIL, listing the failed items", () => {
    const r = release(failed(), { userId: "pm1", role: "project_manager" }, T(5), policyMgr);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("override_required");
      expect(r.error.failedItemIds).toEqual(["mep1"]);
    }
  });
  it("blocks an installer from proceeding without authorization", () => {
    const r = release(failed(), { userId: "inst1", role: "installer" }, T(5), policyMgr);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("override_required");
  });
  it("installer cannot grant an override", () => {
    const g = grantOverride(failed(), { id: "o1", grantedBy: "inst1", role: "installer", reason: "need to work", at: T(6) }, policyMgr);
    expect(!g.ok && g.error.code).toBe("role_not_authorized");
  });
  it.each(["admin", "production_manager", "project_manager", "installation_manager"] as const)("%s can grant an override", (role) => {
    const g = grantOverride(failed(), { id: "o1", grantedBy: "m1", role, reason: "GC fixing rough-in Monday", at: T(6) }, policyMgr);
    expect(g.ok).toBe(true);
  });
  it("override needs a non-empty reason", () => {
    for (const reason of ["", "   ", "\n\t"]) {
      const g = grantOverride(failed(), { id: "o1", grantedBy: "pm1", role: "project_manager", reason, at: T(6) }, policyMgr);
      expect(!g.ok && g.error.code).toBe("reason_required");
    }
  });
  it("override needs a submitted audit", () => {
    const g = grantOverride(audit([item("mep1", "FAIL", { critical: true })]), { id: "o1", grantedBy: "pm1", role: "project_manager", reason: "r", at: T(6) }, policyMgr);
    expect(!g.ok && g.error.code).toBe("audit_not_submitted");
  });
  it("override is not needed (and refused) on a clear audit", () => {
    const g = grantOverride(sub(audit([item("w1", "PASS")])), { id: "o1", grantedBy: "pm1", role: "project_manager", reason: "r", at: T(6) }, policyMgr);
    expect(!g.ok && g.error.code).toBe("override_not_needed");
  });
  it("override is recorded with who/why/when/version and is frozen", () => {
    const g = grantOverride(failed(), { id: "o1", grantedBy: "pm1", role: "project_manager", reason: "GC fixing Monday", supportingDocIds: ["d1"], at: T(6) }, policyMgr);
    if (!g.ok) throw new Error("setup");
    const o = g.value.audit.overrides[0]!;
    expect(o).toMatchObject({ id: "o1", auditId: "a1", auditVersion: 1, grantedBy: "pm1", role: "project_manager", reason: "GC fixing Monday", supportingDocIds: ["d1"], at: T(6) });
    expect(Object.isFrozen(o)).toBe(true);
    expect(g.value.event).toMatchObject({ type: "override_granted", actorId: "pm1" });
  });
  it("granting an override does not release, and does not change the audit state", () => {
    const g = grantOverride(failed(), { id: "o1", grantedBy: "pm1", role: "project_manager", reason: "r", at: T(6) }, policyMgr);
    if (!g.ok) throw new Error("setup");
    expect(auditState(g.value.audit, policyMgr)).toBe("not_ready");
    expect(g.value.audit.release).toBeUndefined();
  });
  it("after an override, release succeeds and records the override as the basis", () => {
    const g = grantOverride(failed(), { id: "o1", grantedBy: "pm1", role: "project_manager", reason: "r", at: T(6) }, policyMgr);
    if (!g.ok) throw new Error("setup");
    const r = release(g.value.audit, { userId: "inst1", role: "installer" }, T(7), policyMgr);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.audit.release).toMatchObject({ basis: "override", overrideId: "o1", releasedBy: "inst1", auditVersion: 1 });
      expect(auditState(r.value.audit, policyMgr)).toBe("released_for_installation");
    }
  });
  it("manager-review and exception states also need an override", () => {
    for (const [policy, items] of [
      [policyMgr, [item("w1", "FAIL")]],
      [policyExc, [item("w1", "REVIEW")]],
    ] as const) {
      const a = sub(audit([...items]));
      const r = release(a, { userId: "pm1", role: "project_manager" }, T(5), policy);
      expect(!r.ok && r.error.code).toBe("override_required");
    }
  });
});

describe("reviseAudit invalidates prior overrides", () => {
  const overridden = () => {
    const a = sub(audit([item("mep1", "FAIL", { critical: true })]));
    const g = grantOverride(a, { id: "o1", grantedBy: "pm1", role: "project_manager", reason: "r", at: T(6) }, policyMgr);
    if (!g.ok) throw new Error("setup");
    return g.value.audit;
  };
  it("creates version n+1, unsubmitted, copying item outcomes", () => {
    const a = overridden();
    const r = reviseAudit(a, { userId: "inst1", role: "installer" }, T(8), "Re-measured wall");
    if (!r.ok) throw new Error("revise failed");
    expect(r.value.audit.version).toBe(2);
    expect(r.value.audit.submitted).toBe(false);
    expect(r.value.audit.items).toEqual(a.items);
    expect(r.value.event).toMatchObject({ type: "audit_revised", version: 2 });
    expect(a.version).toBe(1); // original untouched
    expect(a.submitted).toBe(true);
  });
  it("the old override cannot release the new version", () => {
    const r = reviseAudit(overridden(), { userId: "inst1", role: "installer" }, T(8), "Re-measured");
    if (!r.ok) throw new Error("setup");
    let v2 = r.value.audit;
    const set = setItemOutcome(v2, item("mep1", "FAIL", { critical: true }));
    if (!set.ok) throw new Error("setup");
    v2 = sub(set.value);
    const rel = release(v2, { userId: "pm1", role: "project_manager" }, T(9), policyMgr);
    expect(!rel.ok && rel.error.code).toBe("override_required");
    expect(v2.overrides).toHaveLength(1); // history kept
    expect(v2.overrides[0]?.auditVersion).toBe(1);
  });
  it("revising a released audit revokes the release", () => {
    const a = sub(audit([item("w1", "PASS")]));
    const rel = release(a, { userId: "pm1", role: "project_manager" }, T(5), policyMgr);
    if (!rel.ok) throw new Error("setup");
    const rev = reviseAudit(rel.value.audit, { userId: "pm1", role: "project_manager" }, T(6), "Customer moved wall");
    if (!rev.ok) throw new Error("setup");
    expect(rev.value.audit.release).toBeUndefined();
    expect(auditState(rev.value.audit, policyMgr)).toBe("in_progress");
  });
  it("requires a reason and a submitted audit", () => {
    const a = overridden();
    expect((reviseAudit(a, { userId: "i", role: "installer" }, T(8), " ") as { ok: boolean }).ok).toBe(false);
    const r = reviseAudit(audit([item("w1", "PASS")]), { userId: "i", role: "installer" }, T(8), "why");
    expect(!r.ok && r.error.code).toBe("not_submitted");
  });
});
