// Compare QR decoders on identical frames, and count only an exact read.
//
//   node scripts/measure-decoders.mjs [payloadBytes]
//
// This is the measurement that chose the decoder that the application ships.
// `app/src/qr.ts` cites two of its numbers, so this file is what makes that
// comment checkable. A reader who doubts the choice can run this, disagree
// with it, and rerun it when a seventh decoder appears.
//
// It lives here rather than in `deploy` because it measures libraries and not
// a deployment. `deploy/scan-check.mjs` is the other instrument that measures
// the scanner, and that one drives the deployed page in a browser.
//
// WHAT COUNTS AS A READ
//
// A voucher is arbitrary binary, and many of its bytes sit above 127. A
// decoder that returns text destroys those bytes, and a decoder that returns
// the wrong bytes is worse than one that returns nothing, because a caller
// cannot tell. So a frame counts only when every payload byte comes back
// unchanged. That single rule disqualifies more candidates than any other
// measurement here.
//
// ADDING A DECODER
//
// Add one entry to `DECODERS`. Each entry names the package it needs and a
// `build` that returns a function from a frame to the payload bytes, or null.
// A package that is not installed is reported and skipped, so a seventh
// decoder needs only its own dependency and not everybody else's.

import { blur, continuousSymbol, frameAt, randomSource } from './camera-model.mjs';

/** How many bytes a passkey voucher carries, when a caller names none. */
const DEFAULT_PAYLOAD_BYTES = 792;

/** Sampling phases. Eight of them make a cell a rate rather than a coin toss. */
const PHASES = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875];

/** Lens blur, as a fraction of one module. */
const BLURS = [0.15, 0.3, 0.45];

/** Pixels for each module. The band that decides whether a phone can read. */
const RATIOS = [1.0, 1.2, 1.4, 1.6, 1.8, 2.0, 2.5, 3.0, 4.0, 6.0];

/** Greyscale for the decoders that take luminance rather than colour. */
function luma(data, width, height) {
  // A clamped array, because one reader tells a luminance buffer from a colour
  // buffer by its type as well as by its length.
  const grey = new Uint8ClampedArray(width * height);
  for (let index = 0; index < grey.length; index += 1) {
    const at = index * 4;
    grey[index] = (data[at] * 299 + data[at + 1] * 587 + data[at + 2] * 114) / 1000;
  }
  return grey;
}

/**
 * The decoders under test.
 *
 * `build` runs once. It may import, configure and warm a library, and it
 * returns the function that reads one frame. A `build` that throws means the
 * package is absent, and the run reports that decoder as not installed rather
 * than failing.
 */
const DECODERS = [
  {
    name: 'jsqr',
    package: 'jsqr',
    note: 'the decoder that this application shipped until week two',
    build: async () => {
      const { default: jsQR } = await import('jsqr');
      return (data, width, height) => {
        const found = jsQR(data, width, height, { inversionAttempts: 'attemptBoth' });
        return found === null ? null : Uint8Array.from(found.binaryData);
      };
    },
  },
  {
    name: 'zxing-wasm',
    package: 'zxing-wasm',
    note: 'ZXing C++ through WebAssembly, which the application now ships',
    build: async () => {
      const { readBarcodes } = await import('zxing-wasm/reader');
      return async (data, width, height) => {
        const found = await readBarcodes(
          { data, width, height },
          { formats: ['QRCode'], maxNumberOfSymbols: 1, tryHarder: true, tryInvert: true },
        );
        return found.length === 0 ? null : (found[0].bytes ?? null);
      };
    },
  },
  {
    name: 'rxing-wasm',
    package: 'rxing-wasm',
    note: 'a Rust port of ZXing. Its `raw_bytes` does return the payload.',
    build: async () => {
      const rxing = await import('rxing-wasm');
      return (data, width, height) =>
        rxing
          .decode_barcode(Uint8Array.from(luma(data, width, height)), width, height, true)
          .raw_bytes();
    },
  },
  {
    name: 'zbar-wasm',
    package: '@undecaf/zbar-wasm',
    note: 'ZBar. It needs its binary mode, or it converts the payload to text.',
    build: async () => {
      const zbar = await import('@undecaf/zbar-wasm');
      const scanner = await zbar.getDefaultScanner();
      scanner.setConfig(zbar.ZBarSymbolType.ZBAR_QRCODE, zbar.ZBarConfigType.ZBAR_CFG_BINARY, 1);
      return async (data, width, height) => {
        const found = await zbar.scanRGBABuffer(data.buffer, width, height, scanner);
        return found.length === 0 ? null : Uint8Array.from(found[0].data);
      };
    },
  },
  {
    name: 'nuintun',
    package: '@nuintun/qrcode',
    note: 'pure JavaScript. Its bytes are reachable only through a callback.',
    build: async () => {
      const nuintun = await import('@nuintun/qrcode');
      return (data, width, height) => {
        let bytes = null;
        const decoder = new nuintun.Decoder({
          decode: (held) => {
            bytes = Uint8Array.from(held);
            return '';
          },
        });
        const matrix = nuintun.binarize(nuintun.grayscale({ data, width, height }), width, height);
        for (const detected of new nuintun.Detector().detect(matrix)) {
          try {
            decoder.decode(detected.matrix);
            if (bytes !== null) return bytes;
          } catch {
            // Try the next place that the detector found.
          }
        }
        return null;
      };
    },
  },
  {
    name: 'zxing-js',
    package: '@zxing/library',
    note: 'the JavaScript port of ZXing. Its bytes sit in a metadata entry.',
    build: async () => {
      const loaded = await import('@zxing/library');
      // The package ships CommonJS, so its classes sit behind the default.
      const zx = loaded.default ?? loaded;
      return (data, width, height) => {
        const source = new zx.RGBLuminanceSource(luma(data, width, height), width, height);
        const bitmap = new zx.BinaryBitmap(new zx.HybridBinarizer(source));
        const hints = new Map([[zx.DecodeHintType.TRY_HARDER, true]]);
        const found = new zx.QRCodeReader().decode(bitmap, hints);
        const segments = found.getResultMetadata().get(zx.ResultMetadataType.BYTE_SEGMENTS);
        return segments === undefined || segments.length === 0
          ? null
          : Uint8Array.from(segments[0]);
      };
    },
  },
];

/** Whether a decoder handed back exactly the payload that the symbol carries. */
function exact(found, expected) {
  if (found === null || found === undefined) return false;
  if (found.length !== expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (found[index] !== expected[index]) return false;
  }
  return true;
}

async function main() {
  const payloadBytes = Number(process.argv[2] ?? DEFAULT_PAYLOAD_BYTES);
  if (!Number.isInteger(payloadBytes) || payloadBytes < 1) {
    console.error(`${process.argv[2]} is not a number of bytes`);
    process.exit(1);
  }
  const source = continuousSymbol(payloadBytes);

  const ready = [];
  for (const decoder of DECODERS) {
    try {
      ready.push({ name: decoder.name, read: await decoder.build() });
    } catch (caught) {
      const why = caught instanceof Error ? caught.message.split('\n')[0] : String(caught);
      console.log(`skipping ${decoder.name}: ${decoder.package} did not load. ${why}`);
    }
  }
  if (ready.length === 0) {
    console.error('no decoder loaded, so there is nothing to compare');
    process.exit(1);
  }

  console.log(
    `\npayload ${payloadBytes} bytes at level M: version ${source.version}, ` +
      `${source.totalModules} modules with the quiet zone`,
  );
  console.log('A cell counts a frame only when every payload byte comes back unchanged.');
  console.log(`Each cell is out of ${PHASES.length} sampling phases, and the time is one frame.\n`);

  const names = ready.map((one) => one.name);
  for (const sigmaModules of BLURS) {
    const blurred = blur(source.picture, source.side, sigmaModules * 12);
    console.log(`--- lens blur ${sigmaModules} of a module`);
    console.log('perModule  ' + names.map((name) => name.padStart(13)).join(''));
    for (const perModule of RATIOS) {
      const random = randomSource(41 + Math.round(perModule * 10) + Math.round(sigmaModules * 100));
      const frames = PHASES.map((phase) => frameAt(source, blurred, perModule, phase, random));
      const cells = [];
      for (const decoder of ready) {
        let read = 0;
        let totalMs = 0;
        for (const frame of frames) {
          const started = process.hrtime.bigint();
          let bytes = null;
          try {
            bytes = await decoder.read(frame.data, frame.side, frame.side);
          } catch {
            // A decoder that throws read nothing, which is what it would mean
            // inside a scanner's loop.
            bytes = null;
          }
          totalMs += Number(process.hrtime.bigint() - started) / 1e6;
          if (exact(bytes, source.bytes)) read += 1;
        }
        cells.push(
          `${read}/${PHASES.length} ${Math.round(totalMs / PHASES.length)}ms`.padStart(13),
        );
      }
      console.log(`${perModule.toFixed(1).padStart(9)}  ${cells.join('')}`);
    }
    console.log('');
  }
}

await main();
