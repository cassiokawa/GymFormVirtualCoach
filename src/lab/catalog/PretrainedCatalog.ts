/**
 * PretrainedCatalog — a catalog of downloadable, pre-trained exercise-specific
 * adapters that can be fetched, schema-validated, and registered into the
 * {@link ModelRegistry} so developers can use them immediately without training
 * from scratch.
 *
 * Responsibilities:
 * - Expose a built-in catalog of pre-trained adapters with rich metadata
 *   (Req 14.1, 14.3).
 * - Download model weights with progress reporting and register the resulting
 *   adapter into the registry within ~30s on broadband (Req 14.2).
 * - Validate that a catalog entry's input schema (keypoint format + window
 *   size) is compatible with the normalizer's 33-keypoint output before
 *   enabling inference (Req 14.4).
 * - Compare catalog and installed versions to notify when an update exists
 *   (Req 14.5).
 * - Sideload user-provided ONNX/TFJS files, registering them with user
 *   metadata (Req 14.6).
 *
 * Security: downloaded and sideloaded model bytes are treated as opaque data
 * only. They are never eval'd; they are handed to ONNX Runtime Web / TFJS
 * loaders elsewhere in the pipeline. This module only fetches and stores them.
 *
 * Requirements covered: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6
 */

import type { AdapterMetadata, CatalogEntry, PoseAdapter, RawPose } from '../types.js';
import type { ModelRegistry } from '../registry/ModelRegistry.js';

/** Keypoint schema the {@link KeypointNormalizer} always emits (MediaPipe-33). */
const NORMALIZER_OUTPUT_KEYPOINTS = 33 as const;

/**
 * Placeholder adapter created for a downloaded or sideloaded catalog entry.
 *
 * The catalog only owns fetching and registration; the actual inference wiring
 * (handing `bytes` to ONNX Runtime Web or TFJS) lives in the backend workers.
 * This adapter carries the fetched bytes and the derived metadata so the
 * registry can expose the model, and rejects `detect()` with a descriptive
 * error until inference wiring is attached.
 */
class CatalogAdapter implements PoseAdapter {
  readonly metadata: AdapterMetadata;

  /** Raw model weight bytes (ONNX or TFJS artifacts), treated as opaque data. */
  readonly bytes: ArrayBuffer;

  constructor(metadata: AdapterMetadata, bytes: ArrayBuffer) {
    this.metadata = metadata;
    this.bytes = bytes;
  }

  load(): Promise<void> {
    // Bytes are already resident; the concrete runtime loader is attached by
    // the worker host when inference is requested.
    return Promise.resolve();
  }

  detect(): Promise<RawPose> {
    return Promise.reject(
      new Error(
        `Catalog adapter "${this.metadata.id}" has no inference runtime wired. ` +
          `Downloaded weights are handed to the ONNX/TFJS worker host for detection.`,
      ),
    );
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Derive registry {@link AdapterMetadata} from a catalog entry. The catalog's
 * `format`/`keypointFormat`/`sizeMb` map onto the registry's backend/keypoint
 * fields so downloaded models list uniformly alongside built-in adapters.
 */
function toAdapterMetadata(entry: CatalogEntry): AdapterMetadata {
  return {
    id: entry.id,
    displayName: entry.displayName,
    keypointCount: entry.keypointFormat,
    backend: entry.format === 'onnx' ? 'onnx-web' : 'tfjs',
    modelSizeMb: entry.sizeMb,
    license: entry.license,
    version: entry.version,
  };
}

/**
 * Parse a semver-ish version string ("MAJOR.MINOR.PATCH", missing parts
 * treated as 0, non-numeric parts as 0) into a numeric triple for comparison.
 */
function parseVersion(version: string): [number, number, number] {
  const parts = version
    .trim()
    .replace(/^v/i, '')
    .split('.')
    .map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/**
 * Compare two semver-ish versions.
 *
 * @returns positive when `a > b`, negative when `a < b`, `0` when equal.
 */
function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (va[i] ?? 0) - (vb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/**
 * Built-in catalog of downloadable pre-trained adapters.
 *
 * NOTE: Real model weights are not bundled with the app. The `url` fields point
 * to documented placeholder assets under the app-relative `models/` directory.
 * Download wiring targets those assets; ship the real weights to those paths to
 * make the catalog live.
 *
 * Requirement 14.1 — includes RepNet-style counter, LSTM exercise classifier,
 * ST-GCN form assessor, and a DTW template matcher.
 */
const BUILT_IN_CATALOG: readonly CatalogEntry[] = [
  {
    id: 'repnet-counter',
    displayName: 'RepNet Repetition Counter',
    kind: 'repnet-counter',
    // Placeholder asset path; ship real weights here to enable download.
    url: 'models/repnet-counter/model.onnx',
    format: 'onnx',
    sizeMb: 18.4,
    // Class-agnostic: counts periodic motion for any exercise.
    supportedExercises: ['*'],
    expectedAccuracy: 0.9,
    windowSize: 64,
    keypointFormat: 33,
    license: 'Apache-2.0',
    version: '1.0.0',
  },
  {
    id: 'exercise-classifier',
    displayName: 'LSTM Exercise Classifier',
    kind: 'exercise-classifier',
    url: 'models/exercise-classifier/model.json',
    format: 'tfjs',
    sizeMb: 4.2,
    supportedExercises: ['squat', 'push_up', 'shoulder_press', 'bicep_curl'],
    expectedAccuracy: 0.93,
    windowSize: 30,
    keypointFormat: 33,
    license: 'MIT',
    version: '1.2.0',
  },
  {
    id: 'form-assessor',
    displayName: 'ST-GCN Form Assessor (Fitness-AQA)',
    kind: 'form-assessor',
    url: 'models/form-assessor/model.onnx',
    format: 'onnx',
    sizeMb: 27.9,
    supportedExercises: ['squat', 'push_up', 'shoulder_press', 'bicep_curl'],
    expectedAccuracy: 0.86,
    windowSize: 60,
    keypointFormat: 33,
    license: 'CC-BY-NC-4.0',
    version: '2.0.1',
  },
  {
    id: 'dtw-matcher',
    displayName: 'DTW Reference Template Matcher',
    kind: 'dtw-matcher',
    url: 'models/dtw-matcher/templates.json',
    format: 'tfjs',
    sizeMb: 1.1,
    supportedExercises: ['squat', 'push_up', 'shoulder_press', 'bicep_curl', 'lunge'],
    expectedAccuracy: 0.82,
    windowSize: 45,
    keypointFormat: 33,
    license: 'MIT',
    version: '1.0.3',
  },
];

/**
 * Manages the catalog of downloadable pre-trained adapters and their
 * download/validation/sideload/versioning lifecycle.
 */
export class PretrainedCatalog {
  /** Optional registry into which downloaded/sideloaded adapters register. */
  private readonly registry: ModelRegistry | undefined;

  /**
   * Live entries: built-ins plus any sideloaded entries. Keyed by id so
   * sideloaded models are discoverable via {@link list} and {@link getEntry}.
   */
  private readonly entries = new Map<string, CatalogEntry>();

  /**
   * @param deps - Optional dependencies. When `registry` is provided,
   *   downloaded and sideloaded adapters are registered into it (Req 14.2).
   */
  constructor(deps?: { registry?: ModelRegistry }) {
    this.registry = deps?.registry;
    for (const entry of BUILT_IN_CATALOG) {
      this.entries.set(entry.id, entry);
    }
  }

  /**
   * List all catalog entries (built-in and sideloaded) with full metadata.
   *
   * Requirements: 14.1, 14.3.
   *
   * @returns A snapshot array of catalog entries.
   */
  list(): CatalogEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Look up a single catalog entry by id.
   *
   * @param id - The catalog entry id.
   * @returns The entry, or `undefined` when no entry is registered under `id`.
   */
  getEntry(id: string): CatalogEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * Download the model weights for a catalog entry and, when a registry was
   * injected, register the resulting adapter (Req 14.2).
   *
   * Progress is reported via `onProgress` (0–100). A streamed reader is used
   * when the response exposes a body and a `Content-Length`, so progress is
   * granular; otherwise it falls back to a single buffered fetch reporting a
   * terminal 100%. Target: complete within ~30s on a standard broadband
   * connection.
   *
   * @param id - The catalog entry id to download.
   * @param onProgress - Optional callback receiving download percent [0, 100].
   * @throws When the id is unknown or the download fails (descriptive error).
   */
  async download(id: string, onProgress?: (pct: number) => void): Promise<void> {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      throw new Error(`Unknown catalog entry id: "${id}".`);
    }

    let response: Response;
    try {
      response = await fetch(entry.url);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Failed to download "${id}" from ${entry.url}: ${reason}`, { cause });
    }

    if (!response.ok) {
      throw new Error(
        `Failed to download "${id}" from ${entry.url}: HTTP ${response.status} ${response.statusText}.`,
      );
    }

    const bytes = await this.readWithProgress(response, id, onProgress);

    // Register the downloaded adapter so it lists alongside built-in models.
    // Bytes are opaque data handed to the runtime loader later; never eval'd.
    if (this.registry !== undefined) {
      const metadata = toAdapterMetadata(entry);
      const adapter = new CatalogAdapter(metadata, bytes);
      this.registry.register(() => adapter, metadata);
    }
  }

  /**
   * Read a fetch {@link Response} body to completion, reporting progress when
   * the payload size is known and the body is streamable.
   */
  private async readWithProgress(
    response: Response,
    id: string,
    onProgress?: (pct: number) => void,
  ): Promise<ArrayBuffer> {
    const lengthHeader = response.headers.get('Content-Length');
    const total = lengthHeader === null ? 0 : Number.parseInt(lengthHeader, 10);
    const body = response.body;

    // Fall back to a single buffered fetch when streaming or size is
    // unavailable; report a single terminal progress tick.
    if (body === null || !Number.isFinite(total) || total <= 0) {
      let buffer: ArrayBuffer;
      try {
        buffer = await response.arrayBuffer();
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`Failed reading "${id}" response body: ${reason}`, { cause });
      }
      onProgress?.(100);
      return buffer;
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value !== undefined) {
          chunks.push(value);
          received += value.byteLength;
          const pct = Math.min(100, Math.round((received / total) * 100));
          onProgress?.(pct);
        }
      }
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Failed streaming "${id}" response body: ${reason}`, { cause });
    }

    // Concatenate chunks into a single contiguous buffer.
    const out = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    onProgress?.(100);
    return out.buffer;
  }

  /**
   * Validate that a catalog entry's input schema is compatible with the
   * {@link KeypointNormalizer} output before inference is enabled (Req 14.4).
   *
   * The normalizer always emits the 33-keypoint MediaPipe schema. A 17-keypoint
   * entry is incompatible because it cannot consume the normalized output
   * directly. `windowSize` must be a positive integer.
   *
   * @param entry - The catalog entry to validate.
   * @returns `true` when compatible; `false` otherwise.
   */
  validateSchema(entry: CatalogEntry): boolean {
    const keypointOk = entry.keypointFormat === NORMALIZER_OUTPUT_KEYPOINTS;
    const windowOk = Number.isInteger(entry.windowSize) && entry.windowSize > 0;
    return keypointOk && windowOk;
  }

  /**
   * Report whether the catalog holds a newer version of an entry than the
   * installed one, so the UI can notify the user (Req 14.5).
   *
   * @param id - The catalog entry id.
   * @param installedVersion - The currently installed semver-ish version.
   * @returns `true` when the catalog version is strictly newer; `false` when
   *   equal, older, or the id is unknown.
   */
  isNewerVersionAvailable(id: string, installedVersion: string): boolean {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      return false;
    }
    return compareVersions(entry.version, installedVersion) > 0;
  }

  /**
   * Sideload a user-provided ONNX or TFJS model file, registering it as both a
   * catalog entry and a registry adapter using user-supplied metadata
   * (Req 14.6). Missing metadata fields fall back to sensible defaults derived
   * from the file.
   *
   * The file bytes are treated as opaque data — never eval'd — and are handed
   * to the runtime loader when inference is wired.
   *
   * @param file - The user's model file (`.onnx` or a TFJS `model.json`).
   * @param metadata - Partial catalog metadata overriding the defaults.
   * @throws When the file cannot be read.
   */
  async sideload(file: File, metadata: Partial<CatalogEntry>): Promise<void> {
    let bytes: ArrayBuffer;
    try {
      bytes = await file.arrayBuffer();
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Failed reading sideloaded file "${file.name}": ${reason}`, { cause });
    }

    // Infer a default format from the file name when not supplied.
    const inferredFormat: CatalogEntry['format'] = file.name.toLowerCase().endsWith('.onnx')
      ? 'onnx'
      : 'tfjs';

    const id = metadata.id ?? `sideloaded-${file.name}`;
    const entry: CatalogEntry = {
      id,
      displayName: metadata.displayName ?? file.name,
      kind: metadata.kind ?? 'exercise-classifier',
      url: metadata.url ?? `sideload://${file.name}`,
      format: metadata.format ?? inferredFormat,
      sizeMb: metadata.sizeMb ?? file.size / (1024 * 1024),
      supportedExercises: metadata.supportedExercises ?? [],
      expectedAccuracy: metadata.expectedAccuracy ?? 0,
      windowSize: metadata.windowSize ?? 30,
      keypointFormat: metadata.keypointFormat ?? NORMALIZER_OUTPUT_KEYPOINTS,
      license: metadata.license ?? 'user-provided',
      version: metadata.version ?? '0.0.0',
    };

    // Record as a catalog entry so it lists and is discoverable.
    this.entries.set(entry.id, entry);

    // Register into the model registry when one was injected.
    if (this.registry !== undefined) {
      const adapterMetadata = toAdapterMetadata(entry);
      const adapter = new CatalogAdapter(adapterMetadata, bytes);
      this.registry.register(() => adapter, adapterMetadata);
    }
  }
}
