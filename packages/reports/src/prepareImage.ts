import sharp from "sharp";

export const MAX_EDGE = 1400;
export const JPEG_QUALITY = 75;

/** Upright, at most 1400 px on the long edge (never enlarged), JPEG quality 75. Rejects on unreadable input. */
export async function prepareImage(input: Buffer): Promise<Buffer> {
  return sharp(input).rotate().resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true }).jpeg({ quality: JPEG_QUALITY }).toBuffer();
}
