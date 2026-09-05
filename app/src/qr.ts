import qrcode from 'qrcode-generator';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import type { ReadResult, ReaderOptions } from 'zxing-wasm/reader';

/**
 * QR symbols, in raw binary byte mode.
 *
 * A voucher is an authorization entry, which is binary. Base64url would make
 * it about a third longer in characters. Its lower case letters also rule out
 * the alphanumeric mode, so it would cost full byte mode anyway. The bytes
 * themselves are therefore strictly smaller.
 *
 * Two consequences follow, and both decide how this file works:
 *
 * - The platform's own barcode reader cannot read these codes. Its result
 *   carries a string, so any byte above 127 comes back through a decode that
 *   destroys it. A voucher reader must never use it.
 * - The decoder must hand back the bytes. This one does, as `bytes`.
 *
 * The decoder is the C++ ZXing library, through its WebAssembly build. The
 * choice rests on a measurement rather than on a preference. Six decoders read
 * the same modelled frames of a real voucher. Each one passed a frame only
 * when it returned all 792 bytes unchanged.
 *
 * The frames carried two pixels for each module, at a lens blur of a third of
 * a module. This decoder read eight frames of eight, in five milliseconds
 * each. The previous decoder read three of eight, in eighty seven. This one is
 * the faster reader and the better one at the same time. The previous decoder
 * also had no release after April 2021.
 */

/** The error correction levels that this build can draw. */
export type ErrorCorrection = 'M' | 'L';

/** The error correction level that a voucher code uses. */
export const ERROR_CORRECTION: ErrorCorrection = 'M';

/** The quiet zone around a symbol, in modules. The standard asks for four. */
const QUIET_MODULES = 4;

/**
 * The largest symbol version that this build expects to draw.
 *
 * A passkey voucher takes version 23, and version 24 when the browser adds an
 * optional field to the client data that it signs. A version above this means
 * something grew that nobody measured: a longer name, a different browser, or
 * a larger signature. The code still works, and it is denser than anything a
 * measurement covered, so the screen says so rather than letting it pass.
 */
export const PLANNED_MAX_VERSION = 24;

/** One QR symbol, ready to draw. */
export interface Symbol_ {
  readonly isDark: (row: number, column: number) => boolean;
  readonly moduleCount: number;
  readonly version: number;
}

/**
 * Encode bytes as a symbol.
 *
 * `qrcode-generator` reads a string and encodes it as UTF-8. Its documented
 * way to carry other data is a replacement for `stringToBytes`. The bytes
 * travel through a latin1 string that maps one character to one byte, and the
 * replacement hands them back unchanged.
 */
export function encodeBytes(
  bytes: Uint8Array,
  level: ErrorCorrection = ERROR_CORRECTION,
): Symbol_ {
  qrcode.stringToBytes = (text: string) =>
    Array.from(text, (character) => character.charCodeAt(0) & 0xff);
  let latin1 = '';
  for (const byte of bytes) latin1 += String.fromCharCode(byte);

  // Type 0 selects the smallest version that holds the payload.
  const symbol = qrcode(0, level);
  symbol.addData(latin1, 'Byte');
  symbol.make();
  const moduleCount = symbol.getModuleCount();
  return {
    isDark: (row, column) => symbol.isDark(row, column),
    moduleCount,
    // A symbol of version v has 4v + 17 modules on a side.
    version: (moduleCount - 17) / 4,
  };
}

/**
 * Paint a symbol at the largest whole module scale that fits.
 *
 * The scale is a whole number of device pixels per module on purpose. A
 * fractional scale makes the renderer blend one module into its neighbour. A
 * blurred module edge is the most common reason that a camera fails to read a
 * screen.
 */
export function drawToCanvas(
  canvas: HTMLCanvasElement,
  symbol: Symbol_,
  cssSize: number,
): { scale: number; pixels: number } {
  const ratio = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  const total = symbol.moduleCount + QUIET_MODULES * 2;
  const scale = Math.max(1, Math.floor((cssSize * ratio) / total));
  const pixels = total * scale;

  canvas.width = pixels;
  canvas.height = pixels;
  canvas.style.width = `${pixels / ratio}px`;
  canvas.style.height = `${pixels / ratio}px`;

  const context = canvas.getContext('2d');
  if (context === null) throw new Error('this browser draws no two dimensional canvas');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, pixels, pixels);
  context.fillStyle = '#000000';
  for (let row = 0; row < symbol.moduleCount; row += 1) {
    for (let column = 0; column < symbol.moduleCount; column += 1) {
      if (!symbol.isDark(row, column)) continue;
      context.fillRect(
        (QUIET_MODULES + column) * scale,
        (QUIET_MODULES + row) * scale,
        scale,
        scale,
      );
    }
  }
  return { scale, pixels };
}

/** What one frame held, when it held a symbol. */
export interface Scanned {
  /** The raw bytes. A voucher reader uses these. */
  readonly bytes: Uint8Array;
  /** The text form. Only a SEP-7 reader may use this. */
  readonly text: string;
  /**
   * How wide one module was in the frame, in pixels.
   *
   * This number decides whether a camera can read a code at all. A frame
   * carries the symbol at some size, and the decoder must find each module
   * inside it. The number therefore says how close to the limit a read came.
   * A measurement that omits it says only that something worked.
   *
   * The value is null when the decoder names no version for the symbol,
   * because the pitch follows from the version and the corners together.
   */
  readonly modulePixels: number | null;
}

/**
 * The decoder, as WebAssembly and in base64, which the build writes in here.
 *
 * The bytes travel inside the bundle rather than beside it. A payer mints a
 * voucher with no network, so the application must open with no network, and
 * the worker holds the shell files for that. A separate file would be a
 * request after the first paint, which is the one thing that the worker warns
 * against. The library also fetches its own WebAssembly from a public network
 * address by default, which a device with no network cannot reach.
 */
declare const ZXING_WASM_BASE64: string;

/** What the reader looks for. A voucher is a QR symbol, and one of them. */
const READER_OPTIONS: ReaderOptions = {
  formats: ['QRCode'],
  maxNumberOfSymbols: 1,
  tryHarder: true,
  tryInvert: true,
};

/** The decoder, once it is ready. One load serves every later frame. */
let loading: Promise<unknown> | null = null;

/** The decoder's own bytes, out of the base64 that the build wrote in. */
function wasmBinary(): ArrayBuffer {
  const text = window.atob(ZXING_WASM_BASE64);
  const buffer = new ArrayBuffer(text.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index);
  return buffer;
}

/**
 * Load the decoder.
 *
 * A caller does this before it opens a camera. The first frame then meets a
 * decoder that is ready, rather than one that is still starting.
 */
export function prepareDecoder(): Promise<unknown> {
  loading ??= prepareZXingModule({ overrides: { wasmBinary: wasmBinary() }, fireImmediately: true });
  return loading;
}

/**
 * How wide one module was, out of one result.
 *
 * The decoder reports the version of the symbol and the four corners of it.
 * A symbol of version v has 4v + 17 modules on a side. The length of an edge,
 * divided by that count, is the pitch. The mean of the four edges is steadier
 * than one edge when the camera looks at the screen at an angle.
 */
function modulePitch(found: ReadResult): number | null {
  const version = Number.parseInt(found.version, 10);
  if (!Number.isFinite(version) || version < 1) return null;
  const modules = 4 * version + 17;
  const at = found.position;
  const edges =
    span(at.topLeft, at.topRight) +
    span(at.topRight, at.bottomRight) +
    span(at.bottomRight, at.bottomLeft) +
    span(at.bottomLeft, at.topLeft);
  return edges / 4 / modules;
}

/** One corner that the decoder found, in frame pixels. */
interface Corner {
  readonly x: number;
  readonly y: number;
}

/** How far apart two corners are, in pixels. */
function span(from: Corner, to: Corner): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

/** Read one camera frame. */
export async function decodeFrame(frame: ImageData): Promise<Scanned | null> {
  const found = await readBarcodes(frame, READER_OPTIONS);
  const first = found[0];
  if (first === undefined) return null;
  return { bytes: first.bytes, text: first.text, modulePixels: modulePitch(first) };
}
