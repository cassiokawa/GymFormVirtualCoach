/**
 * AlgorithmLab — the top-level orchestrator for the CV Algorithm Lab.
 *
 * The lab is an isolated mode layered on top of the live workout pipeline.
 * When {@link AlgorithmLab.activate} is called the caller (the demo frame loop)
 * routes frames to the lab instead of the RepCounter/FormEvaluator path,
 * preventing inference contention between lab benchmarking and live tracking
 * (Req 10.2). Deactivating restores the previously active model reference
 * exactly (Req 10.3).
 *
 * This class wires together the already-implemented lab components:
 * - {@link ModelRegistry} — adapter metadata + lookup.
 * - {@link PoseWorkerPool} — worker lifecycle for inference (used by the runner).
 * - {@link BenchmarkRunner} — timed inference passes + metrics.
 * - {@link Recommender} — plain-language model recommendation.
 * - {@link ResultStore} — IndexedDB persistence of benchmark results.
 *
 * Requirements covered: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 9.5
 * Design: "10. AlgorithmLab Orchestrator + LabModePanel".
 */

import type {
  AdapterMetadata,
  BenchmarkOptions,
  BenchmarkResult,
  Recommendation,
  RuntimeBackend,
} from './types.js';
import type { ModelRegistry } from './registry/ModelRegistry.js';
import type { PoseWorkerPool } from './workers/PoseWorkerPool.js';
import type { BenchmarkRunner } from './benchmark/BenchmarkRunner.js';
import type { Recommender } from './compare/Recommender.js';
import type { ResultStore } from './store/ResultStore.js';

/** Minimum number of distinct benchmark results required to recommend (Req 10.5). */
const MIN_RESULTS_FOR_RECOMMENDATION = 2;

/**
 * Thrown by {@link AlgorithmLab.activate} when no adapters are registered, so
 * the app can surface an error and stay in normal mode (Req 10.6).
 */
export class NoAdaptersRegisteredError extends Error {
  constructor() {
    super('Cannot activate Lab Mode: no pose adapters are registered.');
    this.name = 'NoAdaptersRegisteredError';
    // Restore prototype chain for instanceof after transpilation.
    Object.setPrototypeOf(this, NoAdaptersRegisteredError.prototype);
  }
}

/**
 * Thrown by {@link AlgorithmLab.startBenchmark} when no active model has been
 * selected for the run.
 */
export class NoActiveModelError extends Error {
  constructor() {
    super('Cannot start benchmark: no active model is selected.');
    this.name = 'NoActiveModelError';
    Object.setPrototypeOf(this, NoActiveModelError.prototype);
  }
}

/** Dependencies injected into {@link AlgorithmLab}. */
export interface AlgorithmLabDeps {
  /** Registry of pose adapters and their metadata. */
  registry: ModelRegistry;
  /** Worker pool used by the benchmark runner. */
  pool: PoseWorkerPool;
  /** Benchmark runner used by {@link AlgorithmLab.startBenchmark}. */
  runner: BenchmarkRunner;
  /** Recommender used by {@link AlgorithmLab.getRecommendation}. */
  recommender: Recommender;
  /** Persistence layer for benchmark results. */
  store: ResultStore;
}

/**
 * Orchestrates model switching, benchmarking, recommendation, and Lab Mode
 * activation for the CV Algorithm Lab.
 */
export class AlgorithmLab {
  private readonly registry: ModelRegistry;
  private readonly runner: BenchmarkRunner;
  private readonly recommender: Recommender;
  private readonly store: ResultStore;

  /** Whether Lab Mode is currently active (Req 10.2). */
  private active = false;
  /** Id of the model the lab is currently operating on, if any. */
  private activeModelId: string | null = null;
  /**
   * Id of the model that was active before Lab Mode was entered, captured on
   * {@link activate} and restored on {@link deactivate} (Req 10.3).
   */
  private previousModelId: string | null = null;
  /** Benchmark results collected during this lab session, in run order. */
  private readonly results: BenchmarkResult[] = [];

  /**
   * @param deps Already-constructed lab collaborators. `pool` is retained by
   *   the injected `runner`; it is accepted here to make the wiring explicit at
   *   the call site.
   */
  constructor(deps: AlgorithmLabDeps) {
    this.registry = deps.registry;
    this.runner = deps.runner;
    this.recommender = deps.recommender;
    this.store = deps.store;
    // `deps.pool` is owned by the runner; no direct reference needed here.
    void deps.pool;
  }

  /**
   * Enter Lab Mode. Records the currently active model so it can be restored on
   * {@link deactivate}, then flips the active flag. The caller (frame loop) must
   * observe {@link isActive} to stop routing frames to the workout pipeline.
   *
   * @throws {NoAdaptersRegisteredError} When the registry is empty (Req 10.6).
   */
  activate(): void {
    if (this.registry.list().length === 0) {
      throw new NoAdaptersRegisteredError();
    }
    // Capture the pre-lab model so deactivate() can restore it exactly.
    this.previousModelId = this.activeModelId;
    this.active = true;
  }

  /**
   * Exit Lab Mode and restore the previously active model reference (Req 10.3).
   * Idempotent: calling when inactive simply clears the flag.
   */
  deactivate(): void {
    this.active = false;
    this.activeModelId = this.previousModelId;
    this.previousModelId = null;
  }

  /** Whether Lab Mode is currently active. */
  isActive(): boolean {
    return this.active;
  }

  /** Id of the currently selected model, or null when none is selected. */
  getActiveModelId(): string | null {
    return this.activeModelId;
  }

  /**
   * Select the active model by id. Validates the id against the registry before
   * storing it.
   *
   * @param id Registered adapter id.
   * @throws {Error} When `id` is not registered.
   */
  async setActiveModel(id: string): Promise<void> {
    if (!this.registry.has(id)) {
      throw new Error(`Cannot select unknown model "${id}".`);
    }
    this.activeModelId = id;
    // Kept async to allow future eager warm-up (adapter.load) without changing
    // the public contract.
    return Promise.resolve();
  }

  /**
   * Run a benchmark for the active model over the supplied frames, persist the
   * result, and track it for recommendation.
   *
   * @param opts Frames, optional ground truth, and warm-up size.
   * @returns The completed {@link BenchmarkResult}.
   * @throws {NoActiveModelError} When no model has been selected.
   */
  async startBenchmark(opts: BenchmarkOptions): Promise<BenchmarkResult> {
    if (this.activeModelId === null) {
      throw new NoActiveModelError();
    }
    const backend = this.backendFor(this.activeModelId);
    const result = await this.runner.run(this.activeModelId, backend, opts);
    await this.store.saveBenchmark(result);
    this.results.push(result);
    return result;
  }

  /**
   * Produce a recommendation over the collected benchmark results when at least
   * two are available, otherwise `null` (Req 10.5).
   */
  getRecommendation(): Recommendation | null {
    if (this.results.length < MIN_RESULTS_FOR_RECOMMENDATION) {
      return null;
    }
    return this.recommender.analyze([...this.results]);
  }

  /** Snapshot of benchmark results collected during this lab session. */
  getResults(): BenchmarkResult[] {
    return [...this.results];
  }

  /**
   * Look up the runtime backend for a model id from its registered metadata.
   * Falls back to the mediapipe WASM backend if the metadata is somehow absent.
   */
  backendFor(modelId: string): RuntimeBackend {
    const meta: AdapterMetadata | undefined = this.registry
      .list()
      .find((m) => m.id === modelId);
    return meta?.backend ?? 'mediapipe-wasm';
  }
}
