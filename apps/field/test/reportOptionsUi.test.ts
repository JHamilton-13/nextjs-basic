import { describe, it, expect } from "vitest";
import { PRESET_OPTIONS } from "@phc/domain";
import { applyPreset, optionsProblem, setKind, summarizeOptions } from "../src/lib/reportOptionsUi";

describe("report builder helpers", () => {
  it("a preset button sets every option to that preset's defaults", () => {
    expect(applyPreset("service")).toEqual(PRESET_OPTIONS.service);
    expect(applyPreset("custom")).toEqual(PRESET_OPTIONS.custom);
  });
  it("ticking and unticking an issue type keeps the fixed order, and any change turns the preset into 'custom'", () => {
    const a = setKind(PRESET_OPTIONS.service, "touch_up", true);
    expect(a.kinds).toEqual(["punch_item", "missing_part", "damaged_part", "touch_up"]);
    expect(a.preset).toBe("custom");
    const b = setKind(PRESET_OPTIONS.service, "punch_item", false);
    expect(b.kinds).toEqual(["missing_part", "damaged_part"]);
  });
  it("says what is missing before the manager presses Build", () => {
    expect(optionsProblem(PRESET_OPTIONS.builder_site_audit)).toBeNull();
    expect(optionsProblem({ ...PRESET_OPTIONS.custom, kinds: [], checklist: "none" })).toMatch(/Choose at least one/);
  });
  it("summarises in plain words", () => {
    expect(summarizeOptions(PRESET_OPTIONS.builder_site_audit)).toBe("Pre-Install Corrections, open and completed · marked-up photos");
    expect(summarizeOptions(PRESET_OPTIONS.room_status)).toBe("Punch Items, Missing Parts, Damaged Parts, open only · room status for every room · no photos");
    expect(summarizeOptions({ ...PRESET_OPTIONS.custom, kinds: [], checklist: "incomplete", photos: "original", emptyRooms: true })).toBe("rooms not yet completed · original photos · includes rooms with nothing to list");
  });
});
