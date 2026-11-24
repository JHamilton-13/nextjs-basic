import { describe, it, expect } from "vitest";
import { canComplete, resolveCompletion, type Evidence, type ItemRequirements } from "../src/evidence";

const full: ItemRequirements = { photo: 2, measurement: true, note: true, drawingRef: true, supervisorApproval: true };
const goodMeasurement = {
  expected: 1, actual: 1, plus: 0, minus: 0, source: "custom", sourceRef: "x", method: "m", userId: "u",
  timestamp: "2026-11-08T10:00:00.000Z", photoIds: [], deviation: 0, result: "PASS",
} as const;

describe("canComplete", () => {
  it("returns no missing requirements for an item with no requirements", () => {
    expect(canComplete({}, {})).toEqual([]);
  });
  it("lists every missing requirement", () => {
    const missing = canComplete(full, {});
    expect(missing.map((m) => m.kind).sort()).toEqual(["drawingRef", "measurement", "note", "photo", "supervisorApproval"]);
  });
  it("reports photo shortfall with counts", () => {
    const missing = canComplete({ photo: 3 }, { photoCount: 1 });
    expect(missing).toEqual([{ kind: "photo", required: 3, have: 1 }]);
  });
  it("is satisfied when all evidence is present", () => {
    const ev: Evidence = {
      photoCount: 2,
      measurement: goodMeasurement,
      note: "checked north wall",
      drawingRef: "A-201 rev C",
      supervisorApproval: { approvedBy: "u2", role: "installation_manager", at: "2026-11-08T11:00:00.000Z" },
    };
    expect(canComplete(full, ev)).toEqual([]);
  });
  it("treats whitespace-only notes and drawing refs as missing", () => {
    const kinds = canComplete({ note: true, drawingRef: true }, { note: "   ", drawingRef: "\n" }).map((m) => m.kind);
    expect(kinds).toEqual(["note", "drawingRef"]);
  });
  it("treats negative or NaN photo counts as zero", () => {
    expect(canComplete({ photo: 1 }, { photoCount: -3 })).toEqual([{ kind: "photo", required: 1, have: 0 }]);
    expect(canComplete({ photo: 1 }, { photoCount: Number.NaN })).toEqual([{ kind: "photo", required: 1, have: 0 }]);
  });
  it("requires supervisor approval from an authorized role", () => {
    const bad: Evidence = { supervisorApproval: { approvedBy: "u3", role: "installer", at: "2026-11-08T11:00:00.000Z" } };
    expect(canComplete({ supervisorApproval: true }, bad).map((m) => m.kind)).toEqual(["supervisorApproval"]);
  });
});

describe("resolveCompletion", () => {
  it("blocks completion when evidence is missing and no exception", () => {
    const r = resolveCompletion({ photo: 1 }, {});
    expect(r.status).toBe("blocked");
  });
  it("completes when evidence satisfied", () => {
    expect(resolveCompletion({ photo: 1 }, { photoCount: 1 }).status).toBe("complete");
  });
  it("allows an authorized exception and records it", () => {
    const exception = { userId: "pm1", role: "project_manager", reason: "Camera broken on site", at: "2026-11-08T12:00:00.000Z" } as const;
    const r = resolveCompletion({ photo: 1 }, {}, exception);
    expect(r.status).toBe("complete_with_exception");
    if (r.status === "complete_with_exception") {
      expect(r.exception).toEqual(exception);
      expect(r.missing).toEqual([{ kind: "photo", required: 1, have: 0 }]);
    }
  });
  it("rejects exceptions from unauthorized roles", () => {
    const r = resolveCompletion({ photo: 1 }, {}, { userId: "i1", role: "installer", reason: "skip", at: "2026-11-08T12:00:00.000Z" });
    expect(r.status).toBe("blocked");
    if (r.status === "blocked") expect(r.exceptionError).toBe("role_not_authorized");
  });
  it("rejects exceptions without a reason", () => {
    const r = resolveCompletion({ photo: 1 }, {}, { userId: "pm1", role: "project_manager", reason: "  ", at: "2026-11-08T12:00:00.000Z" });
    expect(r.status).toBe("blocked");
    if (r.status === "blocked") expect(r.exceptionError).toBe("reason_required");
  });
  it("does not mark an exception when nothing is missing", () => {
    const r = resolveCompletion({ photo: 1 }, { photoCount: 1 }, { userId: "pm1", role: "project_manager", reason: "x", at: "2026-11-08T12:00:00.000Z" });
    expect(r.status).toBe("complete");
  });
});
