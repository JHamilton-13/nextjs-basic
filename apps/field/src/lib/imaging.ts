import type { Compressor } from "./photos";

const MAX_EDGE = 2048;
const QUALITY = 0.8;

/** Browser compressor: decodes the camera file, scales the long edge to 2048 px, encodes JPEG, and makes a 160 px preview. */
export const browserCompress: Compressor = async (file) => {
  const bmp = await createImageBitmap(file);
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
