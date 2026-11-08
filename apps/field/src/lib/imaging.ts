import type { Compressor } from "./photos";

const MAX_EDGE = 2048;
const QUALITY = 0.8;

/** Browser compressor: decodes the camera file, scales the long edge to 2048 px, encodes JPEG, and makes a 160 px preview. */
export const browserCompress: Compressor = async (file) => {
  // 'from-image': honour the camera's rotation flag (EXIF) so a portrait shot is not stored sideways
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  const draw = (w: number, h: number) => { const c = document.createElement("canvas"); c.width = w; c.height = h; c.getContext("2d")!.drawImage(bmp, 0, 0, w, h); return c; };
  const main = draw(Math.max(1, Math.round(bmp.width * scale)), Math.max(1, Math.round(bmp.height * scale)));
  const blob = await new Promise<Blob | null>((r) => main.toBlob(r, "image/jpeg", QUALITY));
  if (!blob) throw new Error("JPEG encoding failed");
  const ts = Math.min(1, 160 / Math.max(bmp.width, bmp.height));
  const thumb = draw(Math.max(1, Math.round(bmp.width * ts)), Math.max(1, Math.round(bmp.height * ts))).toDataURL("image/jpeg", 0.6);
  bmp.close();
  return { blob, thumb, mime: "image/jpeg", original: file };
};

import { drawShapes, type Shape } from "./annotations";

/** Draws the marks onto the image at its own resolution (long edge capped at 2048 px) and encodes the flattened JPEG for reports. */
export async function flattenAnnotated(base: Blob, shapes: Shape[]): Promise<{ blob: Blob; thumb: string; mime: string }> {
  const bmp = await createImageBitmap(base, { imageOrientation: "from-image" });
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale)); const h = Math.max(1, Math.round(bmp.height * scale));
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d")!;
  g.drawImage(bmp, 0, 0, w, h);
  drawShapes(g, shapes, w, h);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", 0.85));
  if (!blob) throw new Error("JPEG encoding failed");
  const ts = Math.min(1, 160 / Math.max(w, h));
  const t = document.createElement("canvas"); t.width = Math.max(1, Math.round(w * ts)); t.height = Math.max(1, Math.round(h * ts));
  t.getContext("2d")!.drawImage(c, 0, 0, t.width, t.height);
  bmp.close();
  return { blob, thumb: t.toDataURL("image/jpeg", 0.6), mime: "image/jpeg" };
}

/** A 160 px JPEG preview (data URL) of a downloaded photo. */
export async function makeThumb(blob: Blob): Promise<string> {
  const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
  const ts = Math.min(1, 160 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(bmp.width * ts)); c.height = Math.max(1, Math.round(bmp.height * ts));
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c.toDataURL("image/jpeg", 0.6);
}
