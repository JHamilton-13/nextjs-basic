import { renderToBuffer } from "@react-pdf/renderer";
import type { ReactElement } from "react";
import { registerFonts } from "./fonts";

export const MAX_PDF_BYTES = 18 * 1024 * 1024;

export async function renderReport(doc: ReactElement): Promise<Buffer> {
  registerFonts();
  // react-pdf's types want a <Document> element; ours always is one
  return renderToBuffer(doc as Parameters<typeof renderToBuffer>[0]);
}
