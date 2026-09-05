/**
 * Camera controls that the browser has and that the bundled type library
 * lacks.
 *
 * `MediaTrackSettings` in the bundled library already carries `torch` and
 * `zoom`, so a page can read what a camera does. `MediaTrackConstraintSet`
 * carries neither, so the same page cannot ask for them without this
 * declaration.
 *
 * Both controls are real. The Image Capture standard defines them, and both
 * appear in `navigator.mediaDevices.getSupportedConstraints()` on the phones
 * that this project measures. A page must still read `getCapabilities()`
 * before it asks, because a camera that lacks the control refuses the request.
 *
 * Remove this file when the bundled library declares them.
 */
interface MediaTrackConstraintSet {
  torch?: ConstrainBoolean;
  zoom?: ConstrainDouble;
}
