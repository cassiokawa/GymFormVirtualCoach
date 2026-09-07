/**
 * Minimal Ollama client for browser use.
 *
 * Talks to a locally-running Ollama server (default http://localhost:11434).
 * Used to turn the deterministic {@link InsightsReport} into natural-language
 * coaching. Everything stays on the user's machine — no cloud calls.
 *
 * CORS note: Ollama only allows configured origins. If the app is served from
 * an origin Ollama rejects, start Ollama with `OLLAMA_ORIGINS=*` (or the app's
 * origin). {@link generate}/{@link listModels} surface a clear error in that case.
 */

/**
 * Default Ollama endpoint. In development, routed through Vite's proxy at
 * `/ollama` to avoid CORS issues (see vite.config.ts). In production, would
 * point directly to the Ollama host.
 */
export const DEFAULT_OLLAMA_URL = '/ollama';

/** A model entry from Ollama's /api/tags. */
export interface OllamaModel {
  name: string;
  /** Size in bytes, when reported. */
  size?: number;
}

/** Options for a single generation request. */
export interface GenerateOptions {
  model: string;
  prompt: string;
  /** System instruction prepended to the conversation. */
  system?: string;
  /** Sampling temperature (0..1). Lower = more focused. Default 0.4. */
  temperature?: number;
  /** Abort signal so callers can cancel a slow generation. */
  signal?: AbortSignal;
}

/** Error thrown for Ollama connectivity / CORS / server problems. */
export class OllamaError extends Error {
  /** Machine-readable cause category. */
  readonly kind: 'network' | 'cors' | 'http' | 'parse';
  constructor(kind: OllamaError['kind'], message: string) {
    super(message);
    this.name = 'OllamaError';
    this.kind = kind;
  }
}

export class OllamaClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string = DEFAULT_OLLAMA_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /**
   * List models installed on the local Ollama server. Rejects with an
   * {@link OllamaError} describing connectivity/CORS problems.
   */
  async listModels(): Promise<OllamaModel[]> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/tags`);
    } catch (cause) {
      throw new OllamaError(
        'network',
        `Cannot reach Ollama at ${this.baseUrl}. Is it running? ` +
          `If it is, this may be a CORS block — start Ollama with OLLAMA_ORIGINS=* . (${String(cause)})`,
      );
    }
    if (!res.ok) {
      throw new OllamaError('http', `Ollama returned HTTP ${res.status} listing models.`);
    }
    try {
      const data = (await res.json()) as { models?: Array<{ name: string; size?: number }> };
      return (data.models ?? []).map((m) => {
        const entry: OllamaModel = { name: m.name };
        if (typeof m.size === 'number') entry.size = m.size;
        return entry;
      });
    } catch (cause) {
      throw new OllamaError('parse', `Could not parse Ollama model list: ${String(cause)}`);
    }
  }

  /**
   * Generate a completion from a model. Uses the non-streaming
   * `/api/generate` endpoint and returns the full response text.
   */
  async generate(opts: GenerateOptions): Promise<string> {
    const body: Record<string, unknown> = {
      model: opts.model,
      prompt: opts.prompt,
      stream: false,
      options: { temperature: opts.temperature ?? 0.4 },
    };
    if (opts.system !== undefined) body['system'] = opts.system;

    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
    if (opts.signal !== undefined) init.signal = opts.signal;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/generate`, init);
    } catch (cause) {
      if (opts.signal?.aborted) throw new OllamaError('network', 'Generation cancelled.');
      throw new OllamaError(
        'network',
        `Cannot reach Ollama at ${this.baseUrl}. If it is running, set OLLAMA_ORIGINS=* to allow browser requests. (${String(cause)})`,
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new OllamaError('http', `Ollama HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
    try {
      const data = (await res.json()) as { response?: string };
      return (data.response ?? '').trim();
    } catch (cause) {
      throw new OllamaError('parse', `Could not parse Ollama response: ${String(cause)}`);
    }
  }
}
