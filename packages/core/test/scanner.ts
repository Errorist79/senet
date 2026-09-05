import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';

/**
 * The pinned decoder, with its WebAssembly taken from this checkout.
 *
 * This is the decoder that the application ships. A test that used a different
 * decoder would prove a property of that other library. The product would then
 * rest on a claim that nothing checks.
 *
 * `zxing-wasm` fetches its WebAssembly from a public network address unless a
 * caller hands it the bytes. A test that reaches the network measures the
 * network as well as the decoder, and it fails where there is none. This reads
 * the file that the pinned release installed instead.
 */
const wasmFile = readFileSync(
  createRequire(import.meta.url).resolve('zxing-wasm/reader/zxing_reader.wasm'),
);
const wasmBinary = new ArrayBuffer(wasmFile.byteLength);
new Uint8Array(wasmBinary).set(wasmFile);

/** The decoder, once it is ready. One load serves every later image. */
let loading: Promise<unknown> | null = null;

function decoder(): Promise<unknown> {
  loading ??= prepareZXingModule({ overrides: { wasmBinary }, fireImmediately: true });
  return loading;
}

/** What one scan of one image found. */
export interface ScannedSymbol {
  /** The payload bytes, which a voucher needs unchanged. */
  readonly bytes: Uint8Array;
  /** The version that the decoder read out of the symbol. */
  readonly version: number;
}

/** Read one image, and report the symbol in it. */
export async function decodeSymbol(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<ScannedSymbol | null> {
  await decoder();
  // `ImageData` holds its pixels in a plain `ArrayBuffer` and never a shared
  // one. A rasterizer makes no such promise about its own buffer. This copy
  // carries the promise, where a cast would only claim it.
  const buffer = new ArrayBuffer(data.length);
  const pixels = new Uint8ClampedArray(buffer);
  pixels.set(data);
  const found = await readBarcodes(
    { data: pixels, width, height, colorSpace: 'srgb' },
    { formats: ['QRCode'], maxNumberOfSymbols: 1, tryHarder: true, tryInvert: true },
  );
  const first = found[0];
  if (first === undefined) return null;
  const version = Number.parseInt(first.version, 10);
  return { bytes: first.bytes, version: Number.isFinite(version) ? version : 0 };
}
