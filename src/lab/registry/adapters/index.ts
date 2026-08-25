/**
 * Built-in pose adapter registration.
 *
 * Provides {@link registerBuiltInAdapters}, which wires the five stock pose
 * adapters into a {@link ModelRegistry}. Each factory is lazy — the heavy
 * inference libraries are only imported when an adapter is first instantiated
 * and loaded — so registration itself is cheap.
 *
 * Requirements: 1.1, 1.3, 1.5
 */

import type { ModelRegistry } from '../ModelRegistry.js';
import { MediaPipeAdapter } from './MediaPipeAdapter.js';
import {
  MoveNetAdapter,
  MOVENET_LIGHTNING_METADATA,
  MOVENET_THUNDER_METADATA,
} from './MoveNetAdapter.js';
import { YoloPoseAdapter, YOLO_POSE_METADATA } from './YoloPoseAdapter.js';
import { RtmPoseAdapter, RTMPOSE_METADATA } from './RtmPoseAdapter.js';

export { MediaPipeAdapter } from './MediaPipeAdapter.js';
export {
  MoveNetAdapter,
  createMoveNetLightning,
  createMoveNetThunder,
  type MoveNetVariant,
} from './MoveNetAdapter.js';
export { YoloPoseAdapter } from './YoloPoseAdapter.js';
export { RtmPoseAdapter } from './RtmPoseAdapter.js';
export { BasePoseAdapter } from './PoseAdapter.js';

/**
 * Register the five built-in pose adapter factories with the given registry:
 * `mediapipe-blazepose`, `movenet-lightning`, `movenet-thunder`,
 * `yolov8-pose`, and `rtmpose`. Adapters are instantiated lazily by the
 * registry on first `get()`; the factories here do not load any weights.
 *
 * @param registry - The {@link ModelRegistry} to populate.
 */
export function registerBuiltInAdapters(registry: ModelRegistry): void {
  const mediapipeMetadata = new MediaPipeAdapter().metadata;
  registry.register(() => new MediaPipeAdapter(), mediapipeMetadata);

  registry.register(() => new MoveNetAdapter('lightning'), MOVENET_LIGHTNING_METADATA);
  registry.register(() => new MoveNetAdapter('thunder'), MOVENET_THUNDER_METADATA);

  registry.register(() => new YoloPoseAdapter(), YOLO_POSE_METADATA);
  registry.register(() => new RtmPoseAdapter(), RTMPOSE_METADATA);
}
