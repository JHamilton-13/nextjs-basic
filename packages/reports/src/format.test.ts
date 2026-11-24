import { describe, it, expect } from "vitest";
import { formatCoverDate, formatRaised, formatStamp, safeText } from "./format";

const TZ = "America/Phoenix";

describe("formatStamp (drawn on each photo)", () => {
  it("shows the capture time and date in the report's time zone", () => {
    expect(formatStamp("2026-09-10T18:43:00Z", TZ)).toBe("11:43 9/10/26");
  });
  it("uses the local date, not the UTC date, near midnight", () => {
    expect(formatStamp("2026-09-11T06:30:00Z", TZ)).toBe("23:30 9/10/26");
  });
  it("does not pad the hour or the month/day", () => {
    expect(formatStamp("2026-01-05T16:05:00Z", TZ)).toBe("9:05 1/5/26");
  });
  it("says so instead of throwing on an unreadable time", () => {
    expect(formatStamp("not a date", TZ)).toBe("time unknown");
    expect(formatStamp("", TZ)).toBe("time unknown");
  });
});

describe("formatCoverDate", () => {
  it("is the long date in the report's time zone", () => {
    expect(formatCoverDate("2026-09-10T20:00:00Z", TZ)).toBe("Thursday, September 10, 2026");
  });
  it("uses the local day near midnight", () => {
    expect(formatCoverDate("2026-09-11T03:00:00Z", TZ)).toBe("Thursday, September 10, 2026");
  });
});

describe("formatRaised", () => {
  it("is 'Raised by: <initials> <month>/<day>'", () => {
    expect(formatRaised("RW", "2026-09-10T18:43:00Z", TZ)).toBe("Raised by: RW 9/10");
  });
  it("leaves the date off when it cannot be read", () => {
    expect(formatRaised("RW", "nope", TZ)).toBe("Raised by: RW");
  });
});

describe("safeText (characters the report font cannot draw are removed, never fatal)", () => {
  it("removes emoji and joiners but keeps ordinary text, accents and punctuation", () => {
    expect(safeText("Door chipped 😬 on delivery")).toBe("Door chipped on delivery");
    expect(safeText("Café – “quoted” 6½ in.")).toBe("Café – “quoted” 6½ in.");
    expect(safeText("👩‍🔧")).toBe("");
  });
  it("collapses the gaps it leaves and drops control characters", () => {
    expect(safeText("a 😀  😀 b")).toBe("a b");
    expect(safeText("line1\u0000\u0007 line2")).toBe("line1 line2");
  });
  it("keeps line breaks", () => {
    expect(safeText("one\ntwo")).toBe("one\ntwo");
  });
});
