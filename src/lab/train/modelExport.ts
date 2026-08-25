/**
 * Model serialization helpers for the CV Algorithm Lab trainer.
 *
 * A model trained in the browser (see {@link file://./Trainer.ts} and
 * {@link file://./train.worker.ts}) must be persisted in two formats (Req 13.3):
 *
 *  - **TFJS LayersModel** — the native TensorFlow.js representation, produced by
 *    {@link exportToTfjs}. This is what the lab re-loads to run a custom model as
 *    an adapter/classifier (Req 13.4).
 *  - **ONNX** — a portable representation, produced by {@link exportToOnnx}, so
 *    the same model can run under ONNX Runtime Web alongside the pre-built ONNX
 *    adapters, or be exported for use outside the browser.
 *
 * Both helpers are deliberately dependency-light and defensive: TFJS is imported
 * dynamically so the heavy runtime is only pulled in when a real model is being
 * serialized, and every path is guarded so the module type-checks and runs even
 * in environments (e.g. tests) where the runtime or a converter is absent.
 *
 * Requirements: 13.3
 */

// The TFJS runtime is imported dynamically inside the helpers below, mirroring
// the adapter convention (see MoveNetAdapter). We reference its types here
// without eagerly importing the module so this file stays cheap to load.
type TfModule = typeof import('@tensorflow/tfjs');

/**
 * A TFJS model exposing the subset of the `LayersModel` surface these helpers
 * need. Using a structural type (rather than the concrete `tf.LayersModel`)
 * keeps this module decoupled from the exact TFJS export shape and lets the
 * trainer pass either a real model or a lightweight stand-in in tests.
 */
export interface SerializableLayersModel {
  /**
   * TFJS `save` accepts either a URL scheme string or an `io.IOHandler`. We use
   * an in-memory handler to capture artifacts without touching the network or
   * filesystem. The returned value is TFJS's `io.SaveResult`.
   */
  save(handlerOrUrl: unknown): Promise<unknown>;
}

/**
 * TFJS `ModelArtifacts` as captured by an in-memory IO handler. Only the fields
 * this module reads/forwards are described; TFJS attaches more (`format`,
 * `generatedBy`, `convertedBy`, `weightSpecs`, ...) which we preserve verbatim
 * by treating the object opaquely where possible.
 */
export interface TfjsArtifacts {
  /** JSON-serializable topology (layer graph) of the model. */
  modelTopology?: unknown;
  /** Weight tensor specifications. */
  weightSpecs?: unknown;
  /** Raw weight bytes. */
  weightData?: ArrayBuffer;
  /** Any additional artifact fields produced by TFJS. */
  [key: string]: unknown;
}

/**
 * Serialize a trained TFJS `LayersModel` to an in-memory artifacts object.
 *
 * Approach: TFJS's {@link https://js.tensorflow.org/api/latest/#tf.LayersModel.save `model.save`}
 * takes an `io.IOHandler`. We supply a custom handler whose `save(artifacts)`
 * callback simply captures the `ModelArtifacts` TFJS hands it and echoes back a
 * minimal `SaveResult`. This avoids any dependency on a URL scheme
 * (`localstorage://`, `indexeddb://`, `downloads://`) so the artifacts can be
 * embedded directly in a {@link import('../types.js').TrainedModelRecord} and
 * persisted through {@link import('../store/ResultStore.js').ResultStore}.
 *
 * The returned value is typed as `unknown` to match `TrainedModelRecord.tfjsArtifacts`;
 * it is a {@link TfjsArtifacts} object at runtime.
 *
 * @param model - A trained TFJS model (or structural stand-in) to serialize.
 * @returns The captured artifacts object, ready to store.
 */
export async function exportToTfjs(model: SerializableLayersModel): Promise<unknown> {
  let captured: TfjsArtifacts | null = null;

  // Custom in-memory IOHandler: TFJS calls `save(artifacts)` and expects a
  // SaveResult back. We capture the artifacts and return a minimal result. The
  // shape is intentionally loose (`unknown` in/out) so we do not couple to the
  // exact `io.SaveResult` / `io.ModelArtifacts` types across TFJS versions.
  const handler = {
    save: async (artifacts: TfjsArtifacts): Promise<unknown> => {
      captured = artifacts;
      return {
        modelArtifactsInfo: {
          dateSaved: new Date(),
          modelTopologyType: 'JSON',
        },
      };
    },
  };

  await model.save(handler);

  // `model.save` resolves only after our handler ran, so `captured` is set.
  if (captured === null) {
    throw new Error('exportToTfjs: model.save() did not invoke the in-memory IO handler');
  }
  return captured;
}

/**
 * Convert TFJS artifacts to ONNX bytes.
 *
 * Browser-side TFJS→ONNX conversion is non-trivial: there is no first-party
 * converter that runs in the browser, and the mature path
 * (`tf2onnx` / `tensorflowjs_converter`) is a Python toolchain. Rather than
 * pull in a heavyweight or unavailable dependency, this helper:
 *
 *  1. Attempts a conversion via an optional, dynamically-imported converter
 *     module if one is present in the environment (wrapped in try/catch), and
 *  2. Falls back to a documented placeholder ONNX payload when no converter is
 *     available, so the trainer can still produce a complete
 *     {@link import('../types.js').TrainedModelRecord}.
 *
 * The placeholder is a small, self-describing byte buffer (an ASCII marker plus
 * a JSON summary of the source artifacts) — never a partial/invalid ONNX graph
 * that could be mistaken for a real model. Callers that require a genuine ONNX
 * model should check {@link isPlaceholderOnnx} on the result.
 *
 * TODO(task 13.3 follow-up): wire a real TFJS→ONNX conversion path — either a
 * WASM build of tf2onnx, a server round-trip, or an onnxruntime-web export —
 * and replace the placeholder branch below.
 *
 * @param tfjsArtifacts - Artifacts produced by {@link exportToTfjs}.
 * @returns ONNX model bytes (real when a converter is available, otherwise a
 *          clearly-marked placeholder).
 */
export async function exportToOnnx(tfjsArtifacts: unknown): Promise<ArrayBuffer> {
  // Real conversion path (best-effort). No such converter ships with the app
  // today; the dynamic import is expected to fail and is caught below. This
  // keeps the structure in place for when a converter becomes available.
  try {
    const converter = await tryLoadOnnxConverter();
    if (converter !== null) {
      return await converter.convert(tfjsArtifacts);
    }
  } catch {
    // Swallow and fall through to the placeholder — a missing/failed converter
    // must never block producing a TrainedModelRecord.
  }

  return buildPlaceholderOnnx(tfjsArtifacts);
}

/** Magic ASCII prefix marking a placeholder (non-runnable) ONNX payload. */
const PLACEHOLDER_ONNX_MAGIC = 'ONNX-PLACEHOLDER\u0000';

/**
 * Report whether an ONNX buffer produced by {@link exportToOnnx} is the
 * documented placeholder rather than a genuine ONNX model.
 *
 * @param bytes - Bytes previously returned by {@link exportToOnnx}.
 * @returns `true` when the buffer begins with the placeholder magic marker.
 */
export function isPlaceholderOnnx(bytes: ArrayBuffer): boolean {
  const magic = new TextEncoder().encode(PLACEHOLDER_ONNX_MAGIC);
  if (bytes.byteLength < magic.length) return false;
  const head = new Uint8Array(bytes, 0, magic.length);
  for (let i = 0; i < magic.length; i += 1) {
    if (head[i] !== magic[i]) return false;
  }
  return true;
}

/**
 * Minimal converter contract an external TFJS→ONNX module would satisfy. Kept
 * local so the rest of the module has no hard dependency on any converter.
 */
interface OnnxConverter {
  convert(tfjsArtifacts: unknown): Promise<ArrayBuffer>;
}

/**
 * Attempt to load an optional TFJS→ONNX converter. Returns `null` when no
 * converter is installed, which is the normal case today.
 *
 * The specifier is intentionally not a statically-known package so bundlers do
 * not attempt to resolve it at build time; the call is expected to reject and
 * is caught by the caller.
 */
async function tryLoadOnnxConverter(): Promise<OnnxConverter | null> {
  // TODO(task 13.3 follow-up): replace with a real converter import once one is
  // vendored, e.g. `await import('tfjs-to-onnx')`. Until then there is nothing
  // to load, so we return null and let callers use the placeholder.
  return null;
}

/**
 * Build the documented placeholder ONNX payload: the magic marker followed by a
 * UTF-8 JSON summary describing the source artifacts. This yields a stable,
 * non-empty {@link ArrayBuffer} so downstream storage/round-trip logic has real
 * bytes to persist, while remaining trivially distinguishable from a real model
 * via {@link isPlaceholderOnnx}.
 */
function buildPlaceholderOnnx(tfjsArtifacts: unknown): ArrayBuffer {
  const summary = summarizeArtifacts(tfjsArtifacts);
  const payload = PLACEHOLDER_ONNX_MAGIC + JSON.stringify(summary);
  const encoded = new TextEncoder().encode(payload);
  // Return a standalone ArrayBuffer (not a view over a possibly larger buffer).
  const buffer = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(buffer).set(encoded);
  return buffer;
}

/** Produce a small, JSON-safe description of TFJS artifacts for the placeholder. */
function summarizeArtifacts(tfjsArtifacts: unknown): Record<string, unknown> {
  if (tfjsArtifacts === null || typeof tfjsArtifacts !== 'object') {
    return { note: 'placeholder ONNX — no TFJS artifacts provided', kind: typeof tfjsArtifacts };
  }
  const artifacts = tfjsArtifacts as TfjsArtifacts;
  return {
    note: 'placeholder ONNX — real TFJS->ONNX conversion not yet wired (see modelExport.ts TODO)',
    hasTopology: artifacts.modelTopology !== undefined,
    hasWeightSpecs: artifacts.weightSpecs !== undefined,
    weightBytes:
      artifacts.weightData instanceof ArrayBuffer ? artifacts.weightData.byteLength : 0,
  };
}

/**
 * Dynamically import the TFJS runtime, mirroring the adapter convention. Kept
 * here so the trainer/worker can obtain a typed handle without a static import.
 * Returns `null` when the runtime is unavailable (e.g. in a minimal test env).
 *
 * @internal
 */
export async function tryLoadTf(): Promise<TfModule | null> {
  try {
    return await import('@tensorflow/tfjs');
  } catch {
    return null;
  }
}
