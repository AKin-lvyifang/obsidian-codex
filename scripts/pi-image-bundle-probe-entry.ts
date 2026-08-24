import * as assert from "node:assert/strict";
import {
  convertToPng,
  resizeImage
} from "@earendil-works/pi-coding-agent";

export { default } from "../src/main";

export async function runPiImageProductionBundleProbe(): Promise<{
  readonly resizedMimeType: string;
  readonly convertedMimeType: string;
  readonly originalSize: string;
  readonly resizedSize: string;
}> {
  const resized = await resizeImage(
    bmp(4, 2),
    "image/bmp",
    { maxWidth: 2, maxHeight: 2 }
  );
  assert.ok(resized, "production bundle must execute Pi resizeImage");
  assert.equal(resized.wasResized, true);
  assert.equal(resized.originalWidth, 4);
  assert.equal(resized.originalHeight, 2);
  assert.equal(resized.width, 2);
  assert.equal(resized.height, 1);
  assert.equal(resized.mimeType, "image/png");
  assert.ok(resized.data.length > 0);

  const converted = await convertToPng(
    bmp(1, 1).toString("base64"),
    "image/bmp"
  );
  assert.ok(converted, "production bundle must execute Pi convertToPng");
  assert.equal(converted.mimeType, "image/png");
  assert.ok(converted.data.length > 0);

  return {
    resizedMimeType: resized.mimeType,
    convertedMimeType: converted.mimeType,
    originalSize: `${resized.originalWidth}x${resized.originalHeight}`,
    resizedSize: `${resized.width}x${resized.height}`
  };
}

function bmp(width: number, height: number): Buffer {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowSize * height;
  const bytes = Buffer.alloc(54 + pixelBytes);
  bytes.write("BM", 0);
  bytes.writeUInt32LE(bytes.byteLength, 2);
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(width, 18);
  bytes.writeInt32LE(height, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(24, 28);
  bytes.writeUInt32LE(pixelBytes, 34);
  bytes.fill(0x66, 54);
  return bytes;
}
