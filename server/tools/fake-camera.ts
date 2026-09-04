import { writeFileSync } from 'node:fs';
import qrcode from 'qrcode-generator';

/**
 * A video file that stands in for a camera pointed at a payer's screen.
 *
 * Chrome reads a Y4M file in place of a camera, so a check can prove the whole
 * scan path: the camera, the frame, the decoder and the reader. A check that
 * pasted the bytes instead would prove everything except the part that a
 * merchant actually uses.
 *
 * https://wiki.multimedia.cx/index.php/YUV4MPEG2
 */

/** The error correction level that a voucher code uses. */
const ERROR_CORRECTION = 'M';

/** The quiet zone around a symbol, in modules. The standard asks for four. */
const QUIET_MODULES = 4;

/** Luma of a light module, and of a dark one. */
const LIGHT = 235;
const DARK = 16;

/** Neutral chroma, which makes the picture grey. */
const NEUTRAL_CHROMA = 128;

/** Frames per second that the file declares. */
const FRAME_RATE = 10;

/** How many frames the file holds, so a reader has several tries. */
const FRAME_COUNT = 30;

/** Build the symbol for a payload, so a caller can report its version. */
function buildSymbol(bytes: Uint8Array): ReturnType<typeof qrcode> {
  qrcode.stringToBytes = (text: string) =>
    Array.from(text, (character) => character.charCodeAt(0) & 0xff);
  let latin1 = '';
  for (const byte of bytes) latin1 += String.fromCharCode(byte);
  const symbol = qrcode(0, ERROR_CORRECTION);
  symbol.addData(latin1, 'Byte');
  symbol.make();
  return symbol;
}

/** The symbol version that a payload needs. */
export function describeSymbol(bytes: Uint8Array): { version: number } {
  return { version: (buildSymbol(bytes).getModuleCount() - 17) / 4 };
}

/**
 * Write a video file that shows one QR symbol.
 *
 * The symbol takes a whole number of pixels per module. A fractional scale
 * blends one module into its neighbour. A blurred edge is the most common
 * reason that a camera fails to read a screen.
 */
export function writeSymbolVideo(
  path: string,
  bytes: Uint8Array,
  width = 720,
  height = 720,
): { version: number; modulePixels: number } {
  const symbol = buildSymbol(bytes);
  const moduleCount = symbol.getModuleCount();
  const total = moduleCount + QUIET_MODULES * 2;
  const scale = Math.max(1, Math.floor(Math.min(width, height) / total));
  const drawn = total * scale;
  const left = Math.floor((width - drawn) / 2);
  const top = Math.floor((height - drawn) / 2);

  // The luma plane holds the picture. A light background carries the quiet
  // zone, which a decoder needs as much as it needs the symbol.
  const luma = new Uint8Array(width * height).fill(LIGHT);
  for (let row = 0; row < moduleCount; row += 1) {
    for (let column = 0; column < moduleCount; column += 1) {
      if (!symbol.isDark(row, column)) continue;
      const y0 = top + (row + QUIET_MODULES) * scale;
      const x0 = left + (column + QUIET_MODULES) * scale;
      for (let y = y0; y < y0 + scale; y += 1) {
        luma.fill(DARK, y * width + x0, y * width + x0 + scale);
      }
    }
  }
  const chroma = new Uint8Array((width / 2) * (height / 2)).fill(NEUTRAL_CHROMA);

  const header = Buffer.from(`YUV4MPEG2 W${width} H${height} F${FRAME_RATE}:1 Ip A1:1 C420jpeg\n`);
  const frame = Buffer.concat([Buffer.from('FRAME\n'), luma, chroma, chroma]);
  const frames: Buffer[] = [header];
  for (let index = 0; index < FRAME_COUNT; index += 1) frames.push(frame);
  writeFileSync(path, Buffer.concat(frames));

  return { version: (moduleCount - 17) / 4, modulePixels: scale };
}
