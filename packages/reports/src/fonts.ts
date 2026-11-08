import { Font } from "@react-pdf/renderer";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FONT_FAMILY } from "./tokens";

/**
 * Where the fonts and logo live. Found from the working directory (works in tests, the sample script and a Vercel function, where the
 * assets are shipped with the function by `includeFiles`), so no module-system specific path tricks are needed. REPORT_ASSETS_DIR overrides.
 */
function assetsDir(): string {
  const cwd = process.cwd();
  const candidates = [process.env.REPORT_ASSETS_DIR, join(cwd, "assets"), join(cwd, "packages/reports/assets"), join(cwd, "../../packages/reports/assets"), join(cwd, "../reports/assets")];
  for (const c of candidates) if (c && existsSync(join(c, "fonts", "Geist-Regular.ttf"))) return c;
  return join(cwd, "packages/reports/assets");
}
const dir = assetsDir();
export const FONT_FILES = {
  regular: join(dir, "fonts", "Geist-Regular.ttf"),
  semibold: join(dir, "fonts", "Geist-SemiBold.ttf"),
} as const;
export const LOGO_FILE = join(dir, "PHC_LOGO.png");

let done = false;
export function registerFonts(): void {
  if (done) return;
  Font.register({
    family: FONT_FAMILY,
    fonts: [
      { src: FONT_FILES.regular, fontWeight: 400 },
      { src: FONT_FILES.semibold, fontWeight: 600 },
    ],
  });
  Font.registerHyphenationCallback((w) => [w]);   // never break words with hyphens
  done = true;
}
