import * as assert from "node:assert/strict";
import {
  convertToPng,
  resizeImage
} from "@earendil-works/pi-coding-agent";

export { default } from "../src/main";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

export async function runPiImageProductionBundleProbe(): Promise<{
  readonly resizedMimeType: string;
  readonly convertedMimeType: string;
}> {
  const resized = await resizeImage(PNG_1X1, "image/png");
  assert.ok(resized, "production bundle must execute Pi resizeImage");
  assert.equal(resized.mimeType, "image/png");

  const converted = await convertToPng(
    bmp(1, 1).toString("base64"),
    "image/bmp"
  );
  assert.ok(converted, "production bundle must execute Pi convertToPng");
  assert.equal(converted.mimeType, "image/png");
  assert.ok(converted.data.length > 0);

  return {
    resizedMimeType: resized.mimeType,
    convertedMimeType: converted.mimeType
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
