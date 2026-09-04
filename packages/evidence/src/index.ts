/**
 * The archive format of the evidence trees, and the step that writes it.
 *
 * Several commands write into those trees, and more arrive as the application
 * grows. This package holds one definition of a row and of a manifest. A change
 * of the shape therefore breaks a build, and it produces no wrong row. A caller
 * in JavaScript compiles nothing, so the archive step also checks a row at the
 * moment it writes it.
 */
export * from './types.js';
export * from './archive.js';
