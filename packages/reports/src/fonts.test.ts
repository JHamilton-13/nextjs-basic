import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { FONT_FILES, registerFonts } from "./fonts";
import { COLORS, FONT_FAMILY } from "./tokens";

describe("fonts and brand tokens", () => {
  it("registerFonts can be called twice without error", () => {
    expect(() => { registerFonts(); registerFonts(); }).not.toThrow();
  });
  it("the font files and the logo are in the repo (Geist Regular and SemiBold, from the SIL Open Font License package)", () => {
    for (const f of Object.values(FONT_FILES)) expect(existsSync(f), f).toBe(true);
    expect(FONT_FAMILY).toBe("Geist");
  });
  it("uses the brand colours from the spec", () => {
    expect(COLORS).toMatchObject({ gold: "#9a7f3c", ink: "#181818", muted: "#6f6f6f", divider: "#e3e3e3", tint: "#f6f6f6" });
  });
});
