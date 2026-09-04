import { createRequire } from 'node:module';
import type { Options, QRCode } from 'jsqr';

/**
 * The pinned decoder, bound to a type that matches what it really is.
 *
 * `jsqr` 1.4.0 is a CommonJS package, and it sets `module.exports` to the
 * decoder function. Its declaration file instead says `export default`, so a
 * type checker reads the module as a namespace and finds no call signature on
 * it. Version 1.4.0 is the latest release, so the fault has no upstream fix to
 * take.
 *
 * The remedy is to load the module and inspect what arrived. The guard below
 * is the narrowest check available at this boundary: the module must be a
 * function, and it must take the three arguments that the decoder documents.
 * A future release that changes the shape fails here, loudly, rather than
 * where a caller uses the result.
 */
export type DecodeSymbol = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options?: Options,
) => QRCode | null;

function isDecodeSymbol(value: unknown): value is DecodeSymbol {
  return typeof value === 'function' && value.length >= 3;
}

const loaded: unknown = createRequire(import.meta.url)('jsqr');
if (!isDecodeSymbol(loaded)) {
  throw new Error('jsqr did not load a decoder function');
}

/** Read one image, and report the symbol in it. */
export const decodeSymbol: DecodeSymbol = loaded;
