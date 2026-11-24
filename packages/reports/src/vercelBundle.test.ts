import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

describe("api/reports.mjs (the file Vercel runs)", () => {
  it("is up to date with the source (run `npm run build:api -w @phc/reports` if this fails)", () => {
    const out = join(mkdtempSync(join(tmpdir(), "api-bundle-")), "reports.mjs");
    execFileSync("node", [resolve("scripts/build-api.mjs"), out], { stdio: "pipe" });
    const committed = readFileSync(resolve("../../api/reports.mjs"), "utf8");
    expect(readFileSync(out, "utf8")).toBe(committed);
  });
  it("contains no secrets and no service key", () => {
    const txt = readFileSync(resolve("../../api/reports.mjs"), "utf8");
    expect(txt).not.toMatch(/service_role|SERVICE_ROLE|sb_secret|eyJ[A-Za-z0-9_-]{20,}/);
  });
});
