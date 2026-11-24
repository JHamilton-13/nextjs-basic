import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { prepareImage } from "./prepareImage";

const jpeg = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 120, g: 90, b: 60 } } }).jpeg().toBuffer();

describe("prepareImage (resize photos before they go into the PDF)", () => {
  it("turns a 3000x2000 JPEG into a 1400x933 JPEG", async () => {
    const out = await prepareImage(await jpeg(3000, 2000));
    const m = await sharp(out).metadata();
    expect(m.format).toBe("jpeg");
    expect([m.width, m.height]).toEqual([1400, 933]);
  });
  it("scales a portrait photo by its long edge", async () => {
    const m = await sharp(await prepareImage(await jpeg(2000, 3000))).metadata();
    expect([m.width, m.height]).toEqual([933, 1400]);
  });
  it("never enlarges a small photo", async () => {
    const m = await sharp(await prepareImage(await jpeg(800, 600))).metadata();
    expect([m.width, m.height]).toEqual([800, 600]);
  });
  it("applies the camera's rotation flag (a sideways phone photo comes out upright)", async () => {
    const sideways = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const m = await sharp(await prepareImage(sideways)).metadata();
    expect(m.height).toBeGreaterThan(m.width!);
  });
  it("re-encodes a PNG as JPEG", async () => {
    const png = await sharp({ create: { width: 500, height: 500, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer();
    expect((await sharp(await prepareImage(png)).metadata()).format).toBe("jpeg");
  });
  it("keeps the output small (quality 75)", async () => {
    const noisy = await sharp(Buffer.from(Array.from({ length: 3000 * 2000 * 3 }, (_, i) => (i * 2654435761) % 251)), { raw: { width: 3000, height: 2000, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    const out = await prepareImage(noisy);
    expect(out.length).toBeLessThan(noisy.length);
  });
  it("rejects a corrupt buffer", async () => {
    await expect(prepareImage(Buffer.from("this is not an image"))).rejects.toThrow();
    await expect(prepareImage(Buffer.alloc(0))).rejects.toThrow();
  });
});
