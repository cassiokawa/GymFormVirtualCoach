/**
 * Session UX bounded context — public surface.
 *
 * The four-state coach session machine (SETUP → ARMED → WORKING → REVIEW) and
 * the thin Coaching seam (audio bus + cue rationing) live here. This context
 * depends inward on the Analysis contracts it consumes and never the reverse.
 * No exercise `id`, name, or alias appears as a literal in any file under this
 * context — exercise metadata is read as data.
 */

export * from './types';
export { transition } from './machine';
export {
  SessionMachine,
  type SessionListener,
  type SurfaceRegistry,
  type SessionMachineConfig,
} from './SessionMachine';
export * from './FramingValidator';
export { CueRationer, CUE_COOLDOWN_REPS } from './CueRationer';
export {
  CoachController,
  mountCoach,
  NO_MOTION_STALL_MS,
  type AnalysisEventSource,
  type CoachControllerOptions,
  type CoachAudio,
  type ControllerTimer,
} from './CoachController';
export { ManualEventSource, DemoReplaySource } from './demoEventSource';
export * from './AudioBus';
export * from './PhaseArc';
export * from './RepCountDisplay';
export * from './ExerciseGrid';
export { filterExercises, recentFive } from './exerciseSelection';
export * from './SpeechChannel';
export * from './surfaces/SetupSurface';
export * from './surfaces/ArmedSurface';
export * from './surfaces/ReviewSurface';
export * from './surfaces/SetSummary';
export * from './surfaces/VelocityChart';
export * from './surfaces/WorkingSurface';
