import { Font } from "@react-pdf/renderer";
import { fileURLToPath } from "node:url";
import { FONT_FAMILY } from "./tokens";

const dir = (f: string) => fileURLToPath(new URL(`../assets/fonts/${f}`, import.meta.url));
export const FONT_FILES = {
  regular: dir("Geist-Regular.ttf"),
  semibold: dir("Geist-SemiBold.ttf"),
} as const;
export const LOGO_FILE = fileURLToPath(new URL("../assets/PHC_LOGO.png", import.meta.url));

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
