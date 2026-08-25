/**
 * Shared helper to fetch an ONNX model file and fail fast with a clear message
 * when the file is missing or not a real model.
 *
 * A dev server typically responds to an unknown `/models/foo.onnx` request with
 * a 200 + `index.html` fallback rather than a 404. ONNX Runtime then tries to
 * parse that HTML as protobuf and throws the opaque "protobuf parsing failed"
 * error. This helper detects that case up front (HTML content / tiny payload)
 * and explains that the weight file is missing, pointing at the setup docs.
 */

/**
 * Fetch an ONNX model as bytes, validating that the response is plausibly a
 * real ONNX model rather than an HTML fallback page.
 *
 * @param url Location of the `.onnx` file (served from `public/models/`).
 * @param modelName Human-readable model name for error messages.
 * @returns The model bytes, ready to hand to `InferenceSession.create`.
 * @throws With a descriptive message when the file is missing or invalid.
 */
export async function fetchOnnxModel(url: string, modelName: string): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${modelName}: could not fetch model from ${url} (${reason}).`);
  }

  if (!response.ok) {
    throw new Error(
      `${modelName}: model file not found at ${url} (HTTP ${response.status}). ` +
        'Place the .onnx weights in public/models/ — see public/models/README.md.',
    );
  }

  // A dev-server SPA fallback returns HTML with a 200 status. Reject it clearly.
  const contentType = response.headers.get('Content-Type') ?? '';
  if (contentType.includes('text/html')) {
    throw new Error(
      `${modelName}: ${url} returned an HTML page, not a model file. The .onnx ` +
        'weights are missing from public/models/ — see public/models/README.md.',
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());

  // A real ONNX model is a protobuf of non-trivial size; an HTML fallback is
  // small and starts with '<'. Guard both.
  if (bytes.byteLength < 1024 || bytes[0] === 0x3c /* '<' */) {
    throw new Error(
      `${modelName}: ${url} does not look like a valid ONNX model ` +
        `(${bytes.byteLength} bytes). The weights are missing or corrupt — ` +
        'see public/models/README.md.',
    );
  }

  return bytes;
}

/**
 * Preferred ONNX Runtime Web execution providers, fastest first.
 *
 * WebGPU is dramatically faster than the WASM (CPU) backend for pose models
 * (often 5-15x). ONNX Runtime tries providers in order and automatically falls
 * back to the next when one is unavailable — so on browsers/workers without
 * `navigator.gpu` this transparently degrades to `wasm`.
 */
export const PREFERRED_EXECUTION_PROVIDERS: readonly string[] = ['webgpu', 'wasm'];
