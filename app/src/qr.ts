import jsQR from 'jsqr';
import qrcode from 'qrcode-generator';

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
 * - The decoder must hand back the bytes. `jsqr` does, as `binaryData`.
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
}

/** Read one camera frame. */
export function decodeFrame(frame: ImageData): Scanned | null {
  const found = jsQR(frame.data, frame.width, frame.height, {
    inversionAttempts: 'attemptBoth',
  });
  if (found === null) return null;
  return { bytes: Uint8Array.from(found.binaryData), text: found.data };
}
