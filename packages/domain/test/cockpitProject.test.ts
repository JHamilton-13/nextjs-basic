import { describe, it, expect } from "vitest";
import { mapCockpitProject, projectContactSql } from "../src";

// FAKE record shaped like Cockpit's Project model (prisma/schema.prisma: builder, address, estimateDetails JSON with projectAddress, builder, contact, contactEmail ...)
const rec = (o: Record<string, unknown> = {}) => ({
  name: "Sample Project", projectNumber: "2026-000", builder: "Sample Builder Co.", address: "9 Column Address Rd",
  estimateDetails: JSON.stringify({ builder: "Sample Builder Co. (header)", contact: "Pat Sample", contactEmail: "pat@example.test", contactPhone: "555-0100", projectAddress: "123 Header Street, Sampleville", gateCode: "1234#", specialNotes: "dog in the yard" }),
  ...o,
});

describe("mapCockpitProject", () => {
  it("takes the address and builder from the MasterFile header first, then the project columns", () => {
    expect(mapCockpitProject(rec())).toEqual({ address: "123 Header Street, Sampleville", preparedForName: "Sample Builder Co. (header)", preparedForEmail: "pat@example.test", contactSource: "cockpit" });
    expect(mapCockpitProject(rec({ estimateDetails: "{}" }))).toMatchObject({ address: "9 Column Address Rd", preparedForName: "Sample Builder Co.", preparedForEmail: null });
  });
  it("falls back to the contact name when there is no builder name", () => {
    expect(mapCockpitProject(rec({ builder: null, estimateDetails: { contact: "Pat Sample" } }))).toMatchObject({ preparedForName: "Pat Sample" });
  });
  it("never carries gate codes, notes or phone numbers (PHC-only or not needed)", () => {
    const out = JSON.stringify(mapCockpitProject(rec()));
    for (const secret of ["1234#", "dog in the yard", "555-0100", "gateCode", "specialNotes"]) expect(out).not.toContain(secret);
    expect(Object.keys(mapCockpitProject(rec())).sort()).toEqual(["address", "contactSource", "preparedForEmail", "preparedForName"]);
  });
  it("accepts details as an object or as JSON text, and survives bad input", () => {
    expect(mapCockpitProject(rec({ estimateDetails: { projectAddress: "1 Obj St" } })).address).toBe("1 Obj St");
    expect(mapCockpitProject(rec({ estimateDetails: "not json" })).address).toBe("9 Column Address Rd");
    expect(mapCockpitProject(rec({ estimateDetails: null, address: null, builder: null }))).toEqual({ address: null, preparedForName: null, preparedForEmail: null, contactSource: "cockpit" });
    expect(mapCockpitProject(rec({ estimateDetails: { projectAddress: 42, contactEmail: ["x"] } })).preparedForEmail).toBeNull();
  });
  it("drops an email that is not valid, and trims and limits text", () => {
    expect(mapCockpitProject(rec({ estimateDetails: { contactEmail: "  not an email " } })).preparedForEmail).toBeNull();
    expect(mapCockpitProject(rec({ estimateDetails: { contactEmail: "  A@B.example " } })).preparedForEmail).toBe("A@B.example");
    expect(mapCockpitProject(rec({ estimateDetails: { builder: "  x  ".padEnd(500, "y") } })).preparedForName!.length).toBeLessThanOrEqual(200);
    expect(mapCockpitProject(rec({ estimateDetails: { projectAddress: "z".repeat(900) } })).address!.length).toBeLessThanOrEqual(300);
  });
});

describe("projectContactSql (printed for the owner to review, never run by the tool)", () => {
  const id = "00000000-0000-4000-8000-000000000101";
  it("writes one update with quoted values", () => {
    const sql = projectContactSql(id, { address: "1 O'Brien St", preparedForName: "Sample Builder", preparedForEmail: "b@example.test", contactSource: "cockpit" });
    expect(sql).toBe(`update public.projects set address = '1 O''Brien St', prepared_for_name = 'Sample Builder', prepared_for_email = 'b@example.test', contact_source = 'cockpit' where id = '${id}';`);
  });
  it("uses NULL for missing values", () => {
    expect(projectContactSql(id, { address: null, preparedForName: null, preparedForEmail: null, contactSource: "cockpit" })).toContain("address = NULL, prepared_for_name = NULL, prepared_for_email = NULL");
  });
  it("refuses an id that is not a uuid", () => {
    expect(() => projectContactSql("1; drop table projects", { address: null, preparedForName: null, preparedForEmail: null, contactSource: "cockpit" })).toThrow(/uuid/);
  });
  it("cannot be tricked by control characters or semicolons in the data", () => {
    const sql = projectContactSql(id, { address: "x'; drop table projects; --", preparedForName: "a\u0000b\nc", preparedForEmail: null, contactSource: "cockpit" });
    expect(sql).toContain("'x''; drop table projects; --'");
    expect(sql).not.toMatch(/\u0000/);
    expect(sql.split("\n")).toHaveLength(1);
  });
});
