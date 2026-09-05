import { REAR_CAMERA, middleSquare, openCamera } from './camera.js';
import { SCAN_FPS, SCAN_FRAME_HEIGHT, SCAN_FRAME_WIDTH } from './config.js';
import { element } from './dom.js';
import { decodeFrame, prepareDecoder } from './qr.js';

/**
 * What the camera gives this device, measured rather than assumed.
 *
 * A phone that fails to read a code fails somewhere between the lens and the
 * decoder, and no photograph of the failure says where. This screen asks the
 * device instead. It reports what the browser offers and which camera it
 * opened. It then reports what the stream delivers, how sharp the picture is,
 * and whether the decoder reads a code from it.
 *
 * The first measurement makes the request that the scanner makes, and it reads
 * the same middle square of the frame that the scanner reads. It therefore
 * describes the scanner rather than a gentler thing built for the screen. A
 * person then measures the other cameras that the phone carries.
 *
 * Two sweeps change one thing each. The frame sweep asks one camera for four
 * frame sizes. The zoom sweep asks one camera for four zoom factors. Each step
 * reports what the camera really gave. A browser may answer a request with
 * something else, and a measurement that trusts the request measures nothing.
 *
 * The screen needs a code to look at. A second phone showing a voucher is the
 * subject, because that is what a merchant points a camera at.
 */

/** How long one measurement watches a camera, in milliseconds. */
const MEASURE_MS = 6_000;

/**
 * How long one step of a sweep watches a camera, in milliseconds.
 *
 * A sweep measures four steps in a row, and a person holds two phones still
 * for the whole of it. Four seconds a step keeps the whole sweep under half a
 * minute, and it still counts about forty frames.
 */
const SWEEP_MS = 4_000;

/**
 * The frame widths that the frame sweep asks for.
 *
 * The page never asked for a size before, so every camera gave 640 by 480,
 * which the browser asks for when the page does not. These four steps say
 * whether this browser gives a larger frame when a page asks, and what the
 * decoder does with each one. The height keeps the three by four shape that
 * the cameras already report.
 */
const SWEEP_WIDTHS: readonly number[] = [480, 960, 1440, SCAN_FRAME_WIDTH];

/**
 * The zoom factors that the zoom sweep asks for.
 *
 * Zoom raises the size of a module against a lens blur that does not change.
 * That is the same lever as a larger frame, through different means. The
 * cameras report a range from 0.5 to 10. A phone reaches for a different
 * physical lens above some factor. That lens may not focus as close, so the
 * sweep reports what each step really did.
 */
const SWEEP_ZOOMS: readonly number[] = [1, 2, 3, 4];

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
  readonly square: number;
  readonly frames: number;
  readonly decoded: number;
  readonly firstDecodeMs: number | null;
  readonly decodeMs: number;
  readonly sharpLow: number;
  readonly sharpMid: number;
  readonly sharpHigh: number;
  /** How wide one module was, over the frames that read. */
  readonly moduleLow: number;
  readonly moduleMid: number;
  readonly moduleHigh: number;
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
 * Watch one camera that is already open, and report what it gave.
 *
 * The loop samples at the rate that the scanner samples, and it reads the
 * same middle square of the frame that the scanner reads. The numbers
 * therefore describe the scanner, and not a faster or gentler thing built for
 * the measurement.
 */
async function watch(
  video: HTMLVideoElement,
  track: MediaStreamTrack,
  label: string,
  asked: string,
  milliseconds: number,
): Promise<Measurement> {
  const settings = track.getSettings();

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) throw new Error('this browser draws no two dimensional canvas');

  const sharp: number[] = [];
  const modules: number[] = [];
  let frames = 0;
  let decoded = 0;
  let decodeTotal = 0;
  let firstDecodeMs: number | null = null;
  let square = 0;
  const startedAt = Date.now();
  while (Date.now() - startedAt < milliseconds) {
    await wait(Math.round(1000 / SCAN_FPS));
    const frame = middleSquare(video, canvas, context);
    if (frame === null) continue;
    frames += 1;
    square = frame.width;
    sharp.push(sharpness(frame));
    const before = Date.now();
    const found = await decodeFrame(frame);
    decodeTotal += Date.now() - before;
    if (found !== null) {
      decoded += 1;
      // The decoder names no version for some symbols, and the pitch follows
      // from the version. Those frames still count as reads.
      if (found.modulePixels !== null) modules.push(found.modulePixels);
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
    square,
    frames,
    decoded,
    firstDecodeMs,
    decodeMs: frames === 0 ? 0 : Math.round(decodeTotal / frames),
    sharpLow: sharp.length === 0 ? 0 : Math.min(...sharp),
    sharpMid: middle(sharp),
    sharpHigh: sharp.length === 0 ? 0 : Math.max(...sharp),
    moduleLow: modules.length === 0 ? 0 : Math.min(...modules),
    moduleMid: middle(modules),
    moduleHigh: modules.length === 0 ? 0 : Math.max(...modules),
  };
}

/** Open one camera, watch it, and release it. */
async function measure(
  video: HTMLVideoElement,
  wanted: MediaTrackConstraints,
  label: string,
  asked: string,
  milliseconds: number = MEASURE_MS,
): Promise<Measurement> {
  const stream = await openCamera(video, wanted);
  try {
    const track = stream.getVideoTracks()[0];
    if (track === undefined) throw new Error('the camera gave no video track');
    return await watch(video, track, label, asked, milliseconds);
  } finally {
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  }
}

/**
 * How wide one module was, as a person reads it.
 *
 * This number says whether the camera stood a chance. A frame that carries
 * about one pixel for each module defeats every decoder, however many frames
 * the loop takes. The line is empty when nothing read, because the decoder
 * measures a symbol only when it finds one.
 */
function pitch(measured: Measurement): string {
  if (measured.moduleHigh === 0) return 'no frame read, so no measurement';
  const say = (value: number): string => value.toFixed(2);
  return (
    `${say(measured.moduleLow)} low, ${say(measured.moduleMid)} middle, ` +
    `${say(measured.moduleHigh)} high, in pixels for each module`
  );
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
    `frame      ${measured.frameWidth} by ${measured.frameHeight} pixels`,
    `decoder    the middle ${measured.square} by ${measured.square} square`,
    `read       ${measured.decoded} of ${measured.frames} frames, ${rate} percent`,
    `first read ${measured.firstDecodeMs === null ? 'never' : `${measured.firstDecodeMs} ms`}`,
    `decode     ${measured.decodeMs} ms a frame`,
    `module     ${pitch(measured)}`,
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
  const frameButton = element('report-frames', HTMLButtonElement);
  const zoomButton = element('report-zoom', HTMLButtonElement);
  const copyButton = element('report-copy', HTMLButtonElement);

  const lines: string[] = [];
  let busy = false;

  /**
   * The camera that a sweep measures.
   *
   * A sweep changes one thing and holds everything else. The camera is one of
   * the things that it holds, and `facingMode` does not name one: a browser
   * may open a different rear camera than the one that reads best. A person
   * measures the cameras first, and a sweep then runs on the last one that
   * they measured. Null means the camera that the scanner itself opens.
   */
  let chosen: string | null = null;

  // Every measurement times a decode, so the decoder must already be ready.
  // Otherwise the first measurement would time the load as well.
  void prepareDecoder();

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
   * Ask the same camera for four frame sizes, and measure each one.
   *
   * One lens, one distance, one thing changed. The frame that a camera gives
   * is the only difference between the four steps. The four read rates
   * therefore say what the frame is worth. Each step also reports the size
   * that the camera really gave. A browser may answer a request for a large
   * frame with a smaller one.
   */
  async function sweepFrames(): Promise<void> {
    if (busy) return;
    busy = true;
    video.hidden = false;
    try {
      for (const width of SWEEP_WIDTHS) {
        const height = Math.round((width * SCAN_FRAME_HEIGHT) / SCAN_FRAME_WIDTH);
        const wanted: MediaTrackConstraints =
          chosen === null
            ? { facingMode: 'environment', width: { ideal: width }, height: { ideal: height } }
            : { deviceId: { exact: chosen }, width: { ideal: width }, height: { ideal: height } };
        const label = `a frame ${width} wide`;
        say(`Asking for ${width}. Hold the code still in the middle.`);
        try {
          write(report(await measure(video, wanted, label, describe(wanted), SWEEP_MS)));
        } catch (caught) {
          write(`camera     ${label}\nfailed     ${failure(caught)}`);
        }
      }
      say('The frame sweep finished. Copy the report.');
    } finally {
      video.hidden = true;
      busy = false;
    }
  }

  /**
   * Ask the same open camera for four zoom factors, and measure each one.
   *
   * The camera stays open across the four steps, so the only change is the
   * zoom. A camera that refuses the request keeps the factor that it had, and
   * the settings line of each step says which factor it really used.
   */
  async function sweepZoom(): Promise<void> {
    if (busy) return;
    busy = true;
    video.hidden = false;
    let stream: MediaStream | null = null;
    try {
      // The scanner's own frame request, on the chosen camera. This drops
      // `facingMode` when it names a device, because two rules for one camera
      // ask the browser to satisfy both.
      const wanted: MediaTrackConstraints =
        chosen === null
          ? REAR_CAMERA
          : {
              deviceId: { exact: chosen },
              width: { ideal: SCAN_FRAME_WIDTH },
              height: { ideal: SCAN_FRAME_HEIGHT },
            };
      stream = await openCamera(video, wanted);
      const track = stream.getVideoTracks()[0];
      if (track === undefined) throw new Error('the camera gave no video track');
      for (const zoom of SWEEP_ZOOMS) {
        say(`Asking for zoom ${zoom}. Hold the code still in the middle.`);
        let asked = `zoom ${zoom}`;
        try {
          await track.applyConstraints({ zoom });
        } catch (caught) {
          asked = `zoom ${zoom}, refused: ${failure(caught)}`;
        }
        write(report(await watch(video, track, `zoom ${zoom}`, asked, SWEEP_MS)));
      }
      say('The zoom sweep finished. Copy the report.');
    } catch (caught) {
      write(`camera     the zoom sweep\nfailed     ${failure(caught)}`);
      say('The zoom sweep did not run. The report holds the reason.');
    } finally {
      if (stream !== null) for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
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
        chosen = device.deviceId;
        void run({ deviceId: { exact: device.deviceId } }, name, `deviceId ${device.deviceId}`);
      });
      return button;
    });
    cameras.replaceChildren(...buttons);
    say('Point the phone at a voucher, then measure each camera in turn.');
    findButton.disabled = false;
  }

  findButton.addEventListener('click', () => void find());
  frameButton.addEventListener('click', () => void sweepFrames());
  zoomButton.addEventListener('click', () => void sweepZoom());

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
