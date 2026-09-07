/**
 * Analysis bounded context — public surface.
 *
 * The Exercise Spec Engine lives here. It consumes {@link LandmarkFrame} and
 * publishes {@link DomainEvent}s. No exercise `id`, name, or alias appears in
 * any file under this context — exercises are data only.
 */

export * from './types';
export * from './spec';
export * from './loader';
export * from './smoothing';
export * from './validator';
export * from './phaseMachine';
export * from './faultEvaluator';
export * from './engine';
export * from './fixture';
