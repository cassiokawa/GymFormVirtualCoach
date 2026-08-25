/**
 * Shim for the legacy `@mediapipe/pose` package.
 *
 * `@tensorflow-models/pose-detection` does `export * ... from '@mediapipe/pose'`
 * and expects a named `Pose` export. That package's real ESM build has a broken
 * export that fails the Rolldown/Vite worker bundler. The lab only uses MoveNet
 * (self-contained) from pose-detection, never BlazePose, so we provide a
 * minimal stub with the named exports the re-export chain requires. The stub is
 * never constructed at runtime for MoveNet paths.
 *
 * If BlazePose-via-pose-detection is ever needed, remove the alias in
 * vite.config.ts and resolve the upstream export instead.
 */

/** Stub matching the `Pose` symbol pose-detection re-exports. */
export class Pose {}

/** Landmark index constants some consumers read; empty stub is sufficient. */
export const POSE_LANDMARKS = {};
export const POSE_CONNECTIONS: unknown[] = [];

export default {};
