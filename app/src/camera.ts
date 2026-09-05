import { SCAN_FPS, SCAN_FRAME_HEIGHT, SCAN_FRAME_WIDTH } from './config.js';
import { decodeFrame, prepareDecoder } from './qr.js';
import type { Scanned } from './qr.js';

/**
 * The camera, and the loop that reads frames from it.
 *
 * The camera is the merchant's input device, and it is the one part of the
 * application that a person can refuse. Every failure here is something a
 * merchant must be able to act on, so each one carries its own message.
 */

/** Why the camera did not open. */
export type CameraProblem = 'refused' | 'missing' | 'unsupported' | 'failed';

/** A camera that did not open, with the reason a merchant can act on. */
export class CameraError extends Error {
  constructor(readonly problem: CameraProblem, message: string) {
    super(message);
    this.name = 'CameraError';
  }
}

/** A scan in progress. Stop it to release the camera. */
export interface Scan {
  stop: () => void;
}

/** Turn a caught value into the reason that a merchant reads. */
function cameraProblem(caught: unknown): CameraError {
  const name = caught instanceof Error ? caught.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new CameraError(
      'refused',
      'This page cannot use the camera. Allow the camera for this site, then scan again.',
    );
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new CameraError('missing', 'This device has no camera that the page can use.');
  }
  return new CameraError('failed', 'The camera did not start. Close other apps that use it.');
}

/** What the scanner asks for. A merchant points a rear camera at a screen. */
const REAR_CAMERA: MediaTrackConstraints = {
  facingMode: 'environment',
  width: { ideal: SCAN_FRAME_WIDTH },
  height: { ideal: SCAN_FRAME_HEIGHT },
};

/**
 * Copy the middle square of what the camera shows, and give back its pixels.
 *
 * The scanner reads a square rather than the whole frame, for two reasons.
 *
 * A person aims the middle of the picture at the code. The top and the bottom
 * of a tall frame hold nothing that the decoder wants. A read of them costs
 * time and finds nothing.
 *
 * The canvas also stays as small as the square. A large frame makes a large
 * canvas, and a read of a large canvas is the slowest step of the loop. The
 * source rectangle of `drawImage` cuts the frame before it reaches the
 * canvas, so the cost follows the square and not the frame.
 *
 * The preview that a person watches is square as well, so the picture that
 * they aim is the picture that the decoder reads.
 */
function middleSquare(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
): ImageData | null {
  const side = Math.min(video.videoWidth, video.videoHeight);
  if (side === 0) return null;
  if (canvas.width !== side || canvas.height !== side) {
    canvas.width = side;
    canvas.height = side;
  }
  context.drawImage(
    video,
    (video.videoWidth - side) / 2,
    (video.videoHeight - side) / 2,
    side,
    side,
    0,
    0,
    side,
    side,
  );
  return context.getImageData(0, 0, side, side);
}

/**
 * Open one camera and show it.
 *
 * Every failure here reaches a merchant as words that they can act on, so
 * every caller comes through this one place.
 */
async function openCamera(
  video: HTMLVideoElement,
  wanted: MediaTrackConstraints,
): Promise<MediaStream> {
  if (navigator.mediaDevices === undefined) {
    throw new CameraError(
      'unsupported',
      'This browser offers no camera. A camera needs a secure connection.',
    );
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: wanted, audio: false });
  } catch (caught) {
    throw cameraProblem(caught);
  }
  video.srcObject = stream;
  video.setAttribute('playsinline', 'true');
  await video.play();
  return stream;
}

/**
 * Open the camera and read frames until a symbol appears.
 *
 * A merchant points the rear camera at a payer's screen, so the request asks
 * for that one. A device with no rear camera gives whatever it has.
 */
export async function scanForSymbol(
  video: HTMLVideoElement,
  onFound: (scanned: Scanned) => void,
): Promise<Scan> {
  // The decoder loads before the camera opens. A camera that runs while the
  // decoder still starts throws its first frames away, and those are the
  // frames that a person aimed.
  await prepareDecoder();
  const stream = await openCamera(video, REAR_CAMERA);

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  let timer = 0;
  let running = true;

  const stop = (): void => {
    running = false;
    window.clearTimeout(timer);
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  };

  const readOneFrame = async (): Promise<void> => {
    if (!running || context === null) return;
    const frame = middleSquare(video, canvas, context);
    if (frame !== null) {
      const found = await decodeFrame(frame);
      // A merchant can stop the scan while a frame is still in the decoder.
      // Without this the loop would report a voucher after the camera closed.
      if (!running) return;
      if (found !== null) {
        stop();
        onFound(found);
        return;
      }
    }
    timer = window.setTimeout(() => void readOneFrame(), Math.round(1000 / SCAN_FPS));
  };

  void readOneFrame();
  return { stop };
}
