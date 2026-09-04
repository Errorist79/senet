import { SCAN_FPS } from './config.js';
import { decodeFrame } from './qr.js';
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
export const REAR_CAMERA: MediaTrackConstraints = { facingMode: 'environment' };

/**
 * Open one camera and show it.
 *
 * The scanner asks for a rear camera. The camera report asks for one named
 * device, so that a person can compare the lenses that a phone carries. Both
 * need the same failures in the same words, so both come through here.
 */
export async function openCamera(
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

  const readOneFrame = (): void => {
    if (!running || context === null) return;
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const found = decodeFrame(context.getImageData(0, 0, canvas.width, canvas.height));
      if (found !== null) {
        stop();
        onFound(found);
        return;
      }
    }
    timer = window.setTimeout(readOneFrame, Math.round(1000 / SCAN_FPS));
  };

  readOneFrame();
  return { stop };
}
