// A camera, modelled well enough to compare decoders against each other.
//
// The symbol and the decoders are real. Only the camera is a model. It has the
// four stages that a real camera has, in the order that a real camera has
// them:
//
//   1. The screen shows the symbol. This draws it at a high whole number of
//      pixels for each module, which stands for the continuous picture.
//   2. The lens blurs it. A lens blurs by a fixed angular amount, so at one
//      distance the blur is a fixed fraction of one module. The model states
//      the blur in modules, and never in pixels.
//   3. The sensor samples it. Each output pixel is the mean over the square
//      that the pixel covers, which is what a sensor well does. The grid also
//      carries a phase, because a hand never lines a module edge up with a
//      pixel edge.
//   4. The picture carries noise, and a lit screen in a photograph has neither
//      pure black nor pure white.
//
// What the model leaves out is worth naming, because it all makes the real
// world harder than this one: no perspective, no screen refresh banding, no
// moire against the sensor grid, no rolling shutter, no lens distortion and no
// compression. A decoder that fails here fails on a phone as well. A decoder
// that reads here has only cleared the easier bar.

import qrcode from 'qrcode-generator';

/** The quiet zone around a symbol, in modules. The standard asks for four. */
export const QUIET_MODULES = 4;

/** Pixels for each module in the continuous picture, before lens and sensor. */
export const SUPERSAMPLE = 12;

/** Grey levels of a lit screen in a photograph, rather than 0 and 255. */
const SCREEN_DARK = 30;
const SCREEN_LIGHT = 225;

/** The grey that surrounds the code in a frame. A phone body is dark. */
const SURROUND = 90;

/** Sensor noise, as a standard deviation in grey levels. */
const NOISE_LEVELS = 3;

/**
 * A repeatable random source.
 *
 * Two runs of a comparison have to agree. Otherwise nobody can tell a
 * difference between two decoders from a difference between two runs.
 */
export function randomSource(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * Draw a symbol of `payloadBytes` bytes at `SUPERSAMPLE` pixels a module.
 *
 * The bytes are arbitrary, which is what a voucher carries. They travel
 * through a latin1 string that maps one character to one byte. That is the
 * documented way to give this encoder data that is not text.
 */
export function continuousSymbol(payloadBytes, level = 'M', seed = 20260905) {
  const random = randomSource(seed);
  const bytes = new Uint8Array(payloadBytes);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(random() * 256);
  }

  qrcode.stringToBytes = (text) =>
    Array.from(text, (character) => character.charCodeAt(0) & 0xff);
  let latin1 = '';
  for (const byte of bytes) latin1 += String.fromCharCode(byte);
  const symbol = qrcode(0, level);
  symbol.addData(latin1, 'Byte');
  symbol.make();

  const modules = symbol.getModuleCount();
  const side = (modules + QUIET_MODULES * 2) * SUPERSAMPLE;
  const picture = new Float64Array(side * side).fill(SCREEN_LIGHT);
  for (let row = 0; row < modules; row += 1) {
    for (let column = 0; column < modules; column += 1) {
      if (!symbol.isDark(row, column)) continue;
      const top = (QUIET_MODULES + row) * SUPERSAMPLE;
      const left = (QUIET_MODULES + column) * SUPERSAMPLE;
      for (let y = top; y < top + SUPERSAMPLE; y += 1) {
        for (let x = left; x < left + SUPERSAMPLE; x += 1) picture[y * side + x] = SCREEN_DARK;
      }
    }
  }
  return {
    picture,
    side,
    bytes,
    modules,
    // A symbol of version v has 4v + 17 modules on a side.
    version: (modules - 17) / 4,
    totalModules: modules + QUIET_MODULES * 2,
  };
}

/** Blur a square picture with a separable Gaussian of this many pixels. */
export function blur(picture, side, sigma) {
  if (sigma <= 0) return picture;
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float64Array(radius * 2 + 1);
  let sum = 0;
  for (let offset = -radius; offset <= radius; offset += 1) {
    const weight = Math.exp(-(offset * offset) / (2 * sigma * sigma));
    kernel[offset + radius] = weight;
    sum += weight;
  }
  for (let index = 0; index < kernel.length; index += 1) kernel[index] /= sum;

  const clamp = (value) => (value < 0 ? 0 : value > side - 1 ? side - 1 : value);
  const pass = (input) => {
    const output = new Float64Array(side * side);
    for (let row = 0; row < side; row += 1) {
      for (let column = 0; column < side; column += 1) {
        let total = 0;
        for (let offset = -radius; offset <= radius; offset += 1) {
          total += kernel[offset + radius] * input[row * side + clamp(column + offset)];
        }
        output[row * side + column] = total;
      }
    }
    return output;
  };
  const transpose = (input) => {
    const output = new Float64Array(side * side);
    for (let row = 0; row < side; row += 1) {
      for (let column = 0; column < side; column += 1) {
        output[column * side + row] = input[row * side + column];
      }
    }
    return output;
  };
  // One pass blurs along the rows. The transpose makes the second pass blur
  // along the other axis, which is what separable means.
  return transpose(pass(transpose(pass(picture))));
}

/**
 * Sample the continuous picture onto a grid of `outputSide` pixels.
 *
 * `phase` moves the grid that samples, inside one output pixel, from 0 to 1.
 * It is the uncontrolled variable of the real measurement. A sweep that holds
 * it at one value reports a coin toss rather than a rate.
 */
export function sample(picture, side, outputSide, phase) {
  const step = side / outputSide;
  const output = new Float64Array(outputSide * outputSide);
  for (let row = 0; row < outputSide; row += 1) {
    const top = (row + phase) * step;
    const bottom = top + step;
    for (let column = 0; column < outputSide; column += 1) {
      const left = (column + phase) * step;
      const right = left + step;
      let total = 0;
      let weight = 0;
      const firstRow = Math.max(0, Math.floor(top));
      const lastRow = Math.min(side - 1, Math.ceil(bottom) - 1);
      const firstColumn = Math.max(0, Math.floor(left));
      const lastColumn = Math.min(side - 1, Math.ceil(right) - 1);
      for (let y = firstRow; y <= lastRow; y += 1) {
        const height = Math.min(y + 1, bottom) - Math.max(y, top);
        if (height <= 0) continue;
        for (let x = firstColumn; x <= lastColumn; x += 1) {
          const width = Math.min(x + 1, right) - Math.max(x, left);
          if (width <= 0) continue;
          total += picture[y * side + x] * height * width;
          weight += height * width;
        }
      }
      output[row * outputSide + column] = weight === 0 ? SCREEN_LIGHT : total / weight;
    }
  }
  return output;
}

/** Put the sampled code in the middle of a camera frame, and add noise. */
export function frameOf(code, codeSide, frameWidth, frameHeight, random) {
  const data = new Uint8ClampedArray(frameWidth * frameHeight * 4);
  const left = Math.floor((frameWidth - codeSide) / 2);
  const top = Math.floor((frameHeight - codeSide) / 2);
  for (let row = 0; row < frameHeight; row += 1) {
    for (let column = 0; column < frameWidth; column += 1) {
      const inside =
        row >= top && row < top + codeSide && column >= left && column < left + codeSide;
      const level = inside ? code[(row - top) * codeSide + (column - left)] : SURROUND;
      // The mean of two uniform draws is near enough to a normal for a noise
      // term of three levels, and it costs one line.
      const noise = (random() + random() - 1) * NOISE_LEVELS * 2;
      const grey = level + noise;
      const offset = (row * frameWidth + column) * 4;
      data[offset] = grey;
      data[offset + 1] = grey;
      data[offset + 2] = grey;
      data[offset + 3] = 255;
    }
  }
  return data;
}

/**
 * Build one frame at a stated number of pixels for each module.
 *
 * This is the whole model in one call: blur the picture, sample it, surround
 * it and add noise. A caller that wants to compare two decoders gives both of
 * them the frame that this returns.
 */
export function frameAt(source, blurred, perModule, phase, random, framePadding = 40) {
  const codeSide = Math.round(source.totalModules * perModule);
  const frameSide = Math.max(codeSide + framePadding, 480);
  const code = sample(blurred, source.side, codeSide, phase);
  return { data: frameOf(code, codeSide, frameSide, frameSide, random), side: frameSide };
}
