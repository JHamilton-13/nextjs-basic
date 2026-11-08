import { describe, it, expect } from "vitest";
import { canChangeIssue, canCompleteIssue, ISSUE_KINDS_BY_CATEGORY, issueSaveBlockers, categoryOf, type IssueKind } from "../src";

describe("ISSUE_KINDS_BY_CATEGORY", () => {
  it("lists every kind once, in the category categoryOf gives it", () => {
    const all = Object.values(ISSUE_KINDS_BY_CATEGORY).flat();
    expect(all.slice().sort()).toEqual(["damaged_part", "missing_part", "pre_install_correction", "punch_item", "touch_up"]);
    for (const [cat, kinds] of Object.entries(ISSUE_KINDS_BY_CATEGORY)) for (const k of kinds) expect(categoryOf(k)).toBe(cat);
  });
  it("Service offers Punch Item, Missing part and Damaged part; the other two have one kind each", () => {
    expect(ISSUE_KINDS_BY_CATEGORY.service).toEqual(["punch_item", "missing_part", "damaged_part"]);
    expect(ISSUE_KINDS_BY_CATEGORY.pre_install_corrections).toEqual(["pre_install_correction"]);
    expect(ISSUE_KINDS_BY_CATEGORY.touch_ups).toEqual(["touch_up"]);
  });
});

const ok = (o: Partial<Parameters<typeof issueSaveBlockers>[0]> = {}) => issueSaveBlockers({ kind: "punch_item", tradeId: null, title: "Door sticks", photoCount: 0, ...o });

describe("issueSaveBlockers", () => {
  it("has nothing to say about a complete Punch Item", () => expect(ok()).toEqual([]));
  it("asks for a kind", () => expect(ok({ kind: null })).toEqual(["Choose a kind"]));
  it("asks for a title (blank and spaces count as none)", () => {
    expect(ok({ title: "" })).toEqual(["Add a title"]);
    expect(ok({ title: "   \n " })).toEqual(["Add a title"]);
  });
  it("Pre-Install needs a trade; other kinds do not", () => {
    expect(ok({ kind: "pre_install_correction" })).toEqual(["Add a trade"]);
    expect(ok({ kind: "pre_install_correction", tradeId: "t1" })).toEqual([]);
    for (const k of ["punch_item", "missing_part", "touch_up", "damaged_part"] as IssueKind[]) expect(ok({ kind: k, photoCount: 1 })).toEqual([]);
  });
  it("a Damaged part needs a photo; a Missing part does not", () => {
    expect(ok({ kind: "damaged_part" })).toEqual(["A damaged part needs a photo"]);
    expect(ok({ kind: "damaged_part", photoCount: 1 })).toEqual([]);
    expect(ok({ kind: "missing_part" })).toEqual([]);
  });
  it("lists every problem, in a stable order", () => {
    expect(ok({ kind: "pre_install_correction", title: "" })).toEqual(["Add a trade", "Add a title"]);
    expect(ok({ kind: "damaged_part", title: "" })).toEqual(["Add a title", "A damaged part needs a photo"]);
    expect(ok({ kind: null, title: "" })).toEqual(["Choose a kind", "Add a title"]);
  });
});

describe("canChangeIssue (the raiser, or a manager)", () => {
  const c = (role: string | null, isRaiser: boolean, isAdmin = false) => canChangeIssue({ role, isRaiser, isAdmin });
  it("the installer who raised it can", () => expect(c("installer", true)).toBe(true));
  it("another installer cannot", () => expect(c("installer", false)).toBe(false));
  it("every manager role can, raiser or not", () => {
    for (const r of ["production_manager", "project_manager", "installation_manager", "admin"]) { expect(c(r, false), r).toBe(true); expect(c(r, true), r).toBe(true); }
  });
  it("a global admin can even without a project role", () => expect(c(null, false, true)).toBe(true));
  it("roles without field access cannot, even if they somehow raised it", () => {
    for (const r of ["warehouse", "shop", "service_technician", "general_contractor", "client", "", null]) { expect(c(r, true), String(r)).toBe(false); expect(c(r, false), String(r)).toBe(false); }
  });
});

describe("canCompleteIssue", () => {
  it("a Damaged part needs at least one original photo", () => {
    expect(canCompleteIssue("damaged_part", 0)).toEqual({ ok: false, reason: "photo_required" });
    expect(canCompleteIssue("damaged_part", 1)).toEqual({ ok: true });
  });
  it("other kinds need none", () => {
    for (const k of ["pre_install_correction", "punch_item", "touch_up", "missing_part"] as IssueKind[]) expect(canCompleteIssue(k, 0)).toEqual({ ok: true });
  });
});
