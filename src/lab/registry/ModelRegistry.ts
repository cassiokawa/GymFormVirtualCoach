import type { PoseAdapter, AdapterMetadata } from '../types.js';

/**
 * Thrown by {@link ModelRegistry.get} when a requested model id has not been
 * registered. The message includes the offending id for diagnosability.
 *
 * Requirements: 1.4
 */
export class UnknownModelError extends Error {
  /** The unrecognized model id that was requested. */
  readonly modelId: string;

  constructor(modelId: string) {
    super(`Unknown model id: "${modelId}". No adapter is registered under this id.`);
    this.name = 'UnknownModelError';
    this.modelId = modelId;
    // Restore prototype chain for instanceof checks after transpilation.
    Object.setPrototypeOf(this, UnknownModelError.prototype);
  }
}

/**
 * Internal registration record pairing an adapter factory with its metadata
 * and (once created) its cached instance.
 */
interface Registration {
  /** Factory that lazily produces the adapter instance on first `get()`. */
  readonly factory: () => PoseAdapter;
  /** Static descriptor exposed via `list()` without instantiating the adapter. */
  readonly metadata: AdapterMetadata;
  /** Cached adapter instance, created lazily and reused thereafter. */
  instance?: PoseAdapter;
}

/**
 * Model_Registry — manages registration of pose adapters and exposes their
 * metadata. Adapters are lazily instantiated on first {@link get} and cached
 * for reuse, so lookups return synchronously in well under 50ms (excluding the
 * separate, caller-driven `load()` weight download).
 *
 * Requirements: 1.2, 1.4, 1.5
 */
export class ModelRegistry {
  private readonly registrations = new Map<string, Registration>();

  /**
   * Register an adapter factory under the id declared in its metadata.
   * The factory is not invoked until the adapter is first requested via
   * {@link get}. Re-registering an existing id replaces the prior entry and
   * clears any cached instance.
   *
   * @param factory - Producer of a fresh {@link PoseAdapter} instance.
   * @param metadata - Static descriptor whose `id` keys the registration.
   */
  register(factory: () => PoseAdapter, metadata: AdapterMetadata): void {
    this.registrations.set(metadata.id, { factory, metadata });
  }

  /**
   * Return the adapter registered under `id`, lazily instantiating it via its
   * factory on first access and caching the instance for subsequent calls.
   * Callers must `await adapter.load()` before invoking `detect()`.
   *
   * @param id - The model identifier to look up.
   * @returns The cached or freshly instantiated adapter.
   * @throws {UnknownModelError} When `id` has not been registered.
   */
  get(id: string): PoseAdapter {
    const registration = this.registrations.get(id);
    if (registration === undefined) {
      throw new UnknownModelError(id);
    }
    if (registration.instance === undefined) {
      registration.instance = registration.factory();
    }
    return registration.instance;
  }

  /**
   * List metadata for every registered adapter without instantiating any of
   * them.
   *
   * @returns A snapshot array of adapter metadata.
   */
  list(): AdapterMetadata[] {
    return Array.from(this.registrations.values(), (registration) => registration.metadata);
  }

  /**
   * Report whether an adapter is registered under `id`.
   *
   * @param id - The model identifier to check.
   * @returns `true` when a registration exists for `id`.
   */
  has(id: string): boolean {
    return this.registrations.has(id);
  }
}
