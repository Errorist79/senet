import { REAR_CAMERA, openCamera } from './camera.js';
import { SCAN_FPS } from './config.js';
import { element } from './dom.js';
import { decodeFrame } from './qr.js';

/**
 * What the camera gives this device, measured rather than assumed.
 *
 * A phone that fails to read a code fails somewhere between the lens and the
 * decoder, and no photograph of the failure says where. This screen asks the
 * device instead. It reports what the browser offers and which camera it
 * opened. It then reports what the stream delivers, how sharp the picture is,
 * and whether the decoder reads a code from it.
 *
 * It changes nothing. The scanner keeps the request that it always made, so
 * the first measurement describes the build that a person already ran. A person
 * then measures the other cameras that the phone carries, and the numbers say
 * which one to use.
 *
 * The screen needs a code to look at. A second phone showing a voucher is the
 * subject, because that is what a merchant points a camera at.
 */

/** How long one measurement watches a camera, in milliseconds. */
const MEASURE_MS = 6_000;

/**
 * The side of the centre square that the sharpness number uses, in pixels.
 *
 * A person aims the middle of the frame at the code, so the middle of the
 * frame is what the number must describe. A square of this size is small
 * enough to measure ten times a second on a phone.
 */
const SHARPNESS_CROP = 240;

/**
 * How much light each colour contributes to brightness.
 *
 * These are the Rec. 601 luma weights, which is what a grey picture of a
 * colour picture means.
 */
const LUMA_RED = 0.299;
const LUMA_GREEN = 0.587;
const LUMA_BLUE = 0.114;

/** What one camera did, over one measurement. */
interface Measurement {
  readonly label: string;
  readonly deviceId: string;
  readonly asked: string;
  readonly settings: string;
  readonly capabilities: string;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly frames: number;
  readonly decoded: number;
  readonly firstDecodeMs: number | null;
  readonly sharpLow: number;
  readonly sharpMid: number;
  readonly sharpHigh: number;
}

/**
 * How sharp the middle of a frame is.
 *
 * The number is the variance of the Laplacian, which is the usual measure of
 * focus. A sharp edge makes a large second difference, and a blurred one makes
 * a small difference. The number has no units and it moves with the light, so
 * it compares two cameras on one phone at one distance. It does not compare
 * two phones, and it does not compare two rooms.
 */
function sharpness(frame: ImageData): number {
  const side = Math.min(SHARPNESS_CROP, frame.width, frame.height);
  const left = Math.floor((frame.width - side) / 2);
  const top = Math.floor((frame.height - side) / 2);

  const grey = new Float64Array(side * side);
  for (let row = 0; row < side; row += 1) {
    for (let column = 0; column < side; column += 1) {
      const source = ((top + row) * frame.width + (left + column)) * 4;
      const red = frame.data[source] ?? 0;
      const green = frame.data[source + 1] ?? 0;
      const blue = frame.data[source + 2] ?? 0;
      grey[row * side + column] = red * LUMA_RED + green * LUMA_GREEN + blue * LUMA_BLUE;
    }
  }

  let total = 0;
  let squares = 0;
  let count = 0;
  for (let row = 1; row < side - 1; row += 1) {
    for (let column = 1; column < side - 1; column += 1) {
      const here = grey[row * side + column] ?? 0;
      const up = grey[(row - 1) * side + column] ?? 0;
      const down = grey[(row + 1) * side + column] ?? 0;
      const back = grey[row * side + column - 1] ?? 0;
      const forward = grey[row * side + column + 1] ?? 0;
      const edge = 4 * here - up - down - back - forward;
      total += edge;
      squares += edge * edge;
      count += 1;
    }
  }
  if (count === 0) return 0;
  const mean = total / count;
  return Math.round(squares / count - mean * mean);
}

/** Wait, so that the loop samples at the rate that the scanner samples. */
function wait(ms: number): Promise<void> {
  return new Promise((done) => window.setTimeout(done, ms));
}

/** A value that the browser hands back as a plain record, as text. */
function describe(value: object): string {
  const pairs = Object.entries({ ...value }).map(([key, held]) => `${key}=${JSON.stringify(held)}`);
  return pairs.length === 0 ? 'none' : pairs.join(' ');
}

/** What a page can ask this browser for. */
function supportedConstraints(): string {
  if (navigator.mediaDevices === undefined) return 'this browser offers no camera';
  const supported = navigator.mediaDevices.getSupportedConstraints();
  const named = Object.entries({ ...supported })
    .filter(([, held]) => held === true)
    .map(([key]) => key);
  return named.length === 0 ? 'none' : named.join(' ');
}

/**
 * What one camera can do, when the browser says.
 *
 * Safari added the zoom capability in version 17, and it offers no focus
 * control at all. The number therefore says what this phone really allows,
 * rather than what a document says a phone allows.
 */
function capabilitiesOf(track: MediaStreamTrack): string {
  if (typeof track.getCapabilities !== 'function') {
    return 'this browser reports no capabilities';
  }
  return describe(track.getCapabilities());
}

/** The middle value of a list of numbers. */
function middle(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/**
 * Watch one camera, and report what it gave.
 *
 * The loop samples at the rate that the scanner samples, and it decodes the
 * whole frame as the scanner decodes it. The numbers therefore describe the
 * scanner, and not a faster or gentler thing built for the measurement.
 */
async function measure(
  video: HTMLVideoElement,
  wanted: MediaTrackConstraints,
  label: string,
  asked: string,
): Promise<Measurement> {
  const stream = await openCamera(video, wanted);
  try {
    const track = stream.getVideoTracks()[0];
    if (track === undefined) throw new Error('the camera gave no video track');
    const settings = track.getSettings();

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) throw new Error('this browser draws no two dimensional canvas');

    const sharp: number[] = [];
    let frames = 0;
    let decoded = 0;
    let firstDecodeMs: number | null = null;
    const startedAt = Date.now();
    while (Date.now() - startedAt < MEASURE_MS) {
      await wait(Math.round(1000 / SCAN_FPS));
      if (video.videoWidth === 0 || video.videoHeight === 0) continue;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frame = context.getImageData(0, 0, canvas.width, canvas.height);
      frames += 1;
      sharp.push(sharpness(frame));
      if (decodeFrame(frame) !== null) {
        decoded += 1;
        firstDecodeMs ??= Date.now() - startedAt;
      }
    }

    return {
      label,
      deviceId: settings.deviceId ?? 'unknown',
      asked,
      settings: describe(settings),
      capabilities: capabilitiesOf(track),
      frameWidth: video.videoWidth,
      frameHeight: video.videoHeight,
      frames,
      decoded,
      firstDecodeMs,
      sharpLow: sharp.length === 0 ? 0 : Math.min(...sharp),
      sharpMid: middle(sharp),
      sharpHigh: sharp.length === 0 ? 0 : Math.max(...sharp),
    };
  } finally {
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  }
}

/** One measurement, as a person reads it. */
function report(measured: Measurement): string {
  const rate = measured.frames === 0 ? 0 : Math.round((measured.decoded / measured.frames) * 100);
  return [
    `camera     ${measured.label}`,
    `id         ${measured.deviceId}`,
    `asked      ${measured.asked}`,
    `settings   ${measured.settings}`,
    `can do     ${measured.capabilities}`,
    `decoder    ${measured.frameWidth} by ${measured.frameHeight} pixels`,
    `read       ${measured.decoded} of ${measured.frames} frames, ${rate} percent`,
    `first read ${measured.firstDecodeMs === null ? 'never' : `${measured.firstDecodeMs} ms`}`,
    `sharpness  ${measured.sharpLow} low, ${measured.sharpMid} middle, ${measured.sharpHigh} high`,
  ].join('\n');
}

/**
 * The camera report screen.
 *
 * A person opens it, points the phone at a voucher on another phone, and
 * measures each camera in turn. Nothing here changes what the scanner does.
 */
export function startCameraReport(): void {
  const video = element('report-video', HTMLVideoElement);
  const status = element('report-status', HTMLParagraphElement);
  const cameras = element('report-cameras', HTMLDivElement);
  const output = element('report-output', HTMLPreElement);
  const findButton = element('report-find', HTMLButtonElement);
  const copyButton = element('report-copy', HTMLButtonElement);

  const lines: string[] = [];
  let busy = false;

  function write(text: string): void {
    lines.push(text);
    output.textContent = lines.join('\n\n');
    copyButton.hidden = false;
  }

  function say(text: string): void {
    status.textContent = text;
  }

  function failure(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
  }

  async function run(wanted: MediaTrackConstraints, label: string, asked: string): Promise<void> {
    if (busy) return;
    busy = true;
    video.hidden = false;
    say(`Measuring ${label}. Hold the code in the middle of the picture.`);
    try {
      write(report(await measure(video, wanted, label, asked)));
      say('Done. Measure another camera, or copy the report.');
    } catch (caught) {
      write(`camera     ${label}\nfailed     ${failure(caught)}`);
      say('That camera did not open. The report holds the reason.');
    } finally {
      video.hidden = true;
      busy = false;
    }
  }

  /**
   * List the cameras that this phone carries.
   *
   * A browser hides the names of the cameras until a person allows one. The
   * first measurement is therefore the scanner's own request, which both
   * describes the build that a person already ran and unlocks the names.
   */
  async function find(): Promise<void> {
    findButton.disabled = true;
    lines.length = 0;
    output.textContent = '';
    write(
      [
        `browser    ${navigator.userAgent}`,
        `screen     ${window.screen.width} by ${window.screen.height} at ${window.devicePixelRatio}x`,
        `can ask    ${supportedConstraints()}`,
      ].join('\n'),
    );
    await run(REAR_CAMERA, 'the camera that the scanner opens', describe(REAR_CAMERA));

    if (navigator.mediaDevices === undefined) {
      findButton.disabled = false;
      return;
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const found = devices.filter((device) => device.kind === 'videoinput');
    write(
      [
        `cameras    ${found.length} on this phone`,
        ...found.map((device) => `           ${device.label || 'unnamed'} ${device.deviceId}`),
      ].join('\n'),
    );

    const buttons = found.map((device) => {
      const name = device.label || 'an unnamed camera';
      const button = document.createElement('button');
      button.className = 'submit submit-quiet';
      button.type = 'button';
      button.textContent = `Measure ${name}`;
      button.addEventListener('click', () => {
        void run({ deviceId: { exact: device.deviceId } }, name, `deviceId ${device.deviceId}`);
      });
      return button;
    });
    cameras.replaceChildren(...buttons);
    say('Point the phone at a voucher, then measure each camera in turn.');
    findButton.disabled = false;
  }

  findButton.addEventListener('click', () => void find());

  copyButton.addEventListener('click', () => {
    const text = lines.join('\n\n');
    if (navigator.clipboard === undefined) {
      say('This browser copies nothing. Select the report and copy it by hand.');
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => say('The report is on the clipboard.'),
      () => say('The copy failed. Select the report and copy it by hand.'),
    );
  });
}
