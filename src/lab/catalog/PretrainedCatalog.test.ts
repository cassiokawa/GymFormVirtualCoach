/**
 * Unit tests for PretrainedCatalog.
 *
 * Covers catalog listing/metadata, schema validation, version comparison,
 * download (streamed + fallback, error paths) with registry registration, and
 * sideload of a user-provided model file.
 *
 * Requirements: 14.3, 14.4, 14.5, 14.6
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { PretrainedCatalog } from './PretrainedCatalog.js';
import { ModelRegistry } from '../registry/ModelRegistry.js';
import type { CatalogEntry } from '../types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** The built-in ids the catalog must expose (Req 14.1). */
const BUILT_IN_IDS = [
  'repnet-counter',
  'exercise-classifier',
  'form-assessor',
  'dtw-matcher',
] as const;

/**
 * Build a minimal fetch Response-like object for stubbing `global.fetch`.
 *
 * @param opts.ok/status/statusText - response status metadata.
 * @param opts.contentLength - value returned by headers.get('Content-Length');
 *   pass `null` to force the buffered fallback path.
 * @param opts.chunk - when provided, `body.getReader()` yields this one chunk
 *   then `{done:true}` (streamed path).
 * @param opts.arrayBufferBytes - bytes resolved by `arrayBuffer()` (fallback).
 */
function makeResponse(opts: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  contentLength?: string | null;
  chunk?: Uint8Array;
  arrayBufferBytes?: Uint8Array;
}): Response {
  const {
    ok = true,
    status = 200,
    statusText = 'OK',
    contentLength = null,
    chunk,
    arrayBufferBytes,
  } = opts;

  const headers = {
    get: (name: string): string | null =>
      name.toLowerCase() === 'content-length' ? contentLength : null,
  };

  let body: ReadableStream<Uint8Array> | null = null;
  if (chunk !== undefined) {
    let delivered = false;
    body = {
      getReader() {
        return {
          read(): Promise<{ done: boolean; value?: Uint8Array }> {
            if (!delivered) {
              delivered = true;
              return Promise.resolve({ done: false, value: chunk });
            }
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    } as unknown as ReadableStream<Uint8Array>;
  }

  const arrayBuffer = (): Promise<ArrayBuffer> => {
    const bytes = arrayBufferBytes ?? new Uint8Array([1, 2, 3, 4]);
    return Promise.resolve(bytes.buffer as ArrayBuffer);
  };

  return {
    ok,
    status,
    statusText,
    headers,
    body,
    arrayBuffer,
  } as unknown as Response;
}

/** Clone a built-in entry with overrides applied. */
function cloneEntry(base: CatalogEntry, overrides: Partial<CatalogEntry>): CatalogEntry {
  return { ...base, ...overrides };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// list / getEntry
// ---------------------------------------------------------------------------

describe('PretrainedCatalog.list / getEntry', () => {
  it('lists the built-in entries with expected ids and full metadata (Req 14.3)', () => {
    const catalog = new PretrainedCatalog();
    const entries = catalog.list();

    expect(entries.length).toBeGreaterThanOrEqual(4);

    const ids = entries.map((e) => e.id);
    for (const id of BUILT_IN_IDS) {
      expect(ids).toContain(id);
    }

    // Every entry carries the full set of metadata fields.
    for (const entry of entries) {
      expect(typeof entry.id).toBe('string');
      expect(typeof entry.displayName).toBe('string');
      expect(typeof entry.kind).toBe('string');
      expect(typeof entry.url).toBe('string');
      expect(['onnx', 'tfjs']).toContain(entry.format);
      expect(typeof entry.sizeMb).toBe('number');
      expect(Array.isArray(entry.supportedExercises)).toBe(true);
      expect(typeof entry.expectedAccuracy).toBe('number');
      expect(typeof entry.windowSize).toBe('number');
      expect([17, 33]).toContain(entry.keypointFormat);
      expect(typeof entry.license).toBe('string');
      expect(typeof entry.version).toBe('string');
    }
  });

  it('getEntry returns the entry for a known id and undefined for unknown', () => {
    const catalog = new PretrainedCatalog();

    const known = catalog.getEntry('exercise-classifier');
    expect(known).toBeDefined();
    expect(known?.id).toBe('exercise-classifier');

    expect(catalog.getEntry('does-not-exist')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validateSchema
// ---------------------------------------------------------------------------

describe('PretrainedCatalog.validateSchema (Req 14.4)', () => {
  const catalog = new PretrainedCatalog();
  const base = catalog.getEntry('exercise-classifier') as CatalogEntry;

  it('accepts keypointFormat 33 with a positive windowSize', () => {
    const entry = cloneEntry(base, { keypointFormat: 33, windowSize: 30 });
    expect(catalog.validateSchema(entry)).toBe(true);
  });

  it('rejects keypointFormat 17', () => {
    const entry = cloneEntry(base, { keypointFormat: 17, windowSize: 30 });
    expect(catalog.validateSchema(entry)).toBe(false);
  });

  it('rejects windowSize of 0 or negative', () => {
    expect(catalog.validateSchema(cloneEntry(base, { windowSize: 0 }))).toBe(false);
    expect(catalog.validateSchema(cloneEntry(base, { windowSize: -5 }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isNewerVersionAvailable
// ---------------------------------------------------------------------------

describe('PretrainedCatalog.isNewerVersionAvailable (Req 14.5)', () => {
  const catalog = new PretrainedCatalog();
  const installedVersion = (catalog.getEntry('exercise-classifier') as CatalogEntry).version;

  it('returns true when the catalog version is newer than installed', () => {
    expect(catalog.isNewerVersionAvailable('exercise-classifier', '1.0.0')).toBe(true);
  });

  it('returns false when versions are equal', () => {
    expect(catalog.isNewerVersionAvailable('exercise-classifier', installedVersion)).toBe(false);
  });

  it('returns false when the installed version is newer', () => {
    expect(catalog.isNewerVersionAvailable('exercise-classifier', '9.9.9')).toBe(false);
  });

  it('returns false for an unknown id', () => {
    expect(catalog.isNewerVersionAvailable('nope', '1.0.0')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// download
// ---------------------------------------------------------------------------

describe('PretrainedCatalog.download (Req 14.2)', () => {
  it('streams the body, reports 100 at the end, and registers into the registry', async () => {
    const chunk = new Uint8Array([10, 20, 30, 40, 50]);
    const fetchStub = vi.fn().mockResolvedValue(
      makeResponse({ chunk, contentLength: String(chunk.byteLength) }),
    );
    vi.stubGlobal('fetch', fetchStub);

    const registry = new ModelRegistry();
    const catalog = new PretrainedCatalog({ registry });

    const progress: number[] = [];
    await catalog.download('exercise-classifier', (pct) => progress.push(pct));

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(progress[progress.length - 1]).toBe(100);
    expect(registry.has('exercise-classifier')).toBe(true);
  });

  it('falls back to arrayBuffer when Content-Length is null and reports 100', async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      makeResponse({ contentLength: null, arrayBufferBytes: new Uint8Array([1, 2, 3]) }),
    );
    vi.stubGlobal('fetch', fetchStub);

    const catalog = new PretrainedCatalog();

    const progress: number[] = [];
    await catalog.download('repnet-counter', (pct) => progress.push(pct));

    expect(progress[progress.length - 1]).toBe(100);
  });

  it('throws on an unknown id', async () => {
    const catalog = new PretrainedCatalog();
    await expect(catalog.download('missing-id')).rejects.toThrow(/unknown catalog entry/i);
  });

  it('throws on a non-ok response', async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      makeResponse({ ok: false, status: 404, statusText: 'Not Found' }),
    );
    vi.stubGlobal('fetch', fetchStub);

    const catalog = new PretrainedCatalog();
    await expect(catalog.download('form-assessor')).rejects.toThrow(/404/);
  });
});

// ---------------------------------------------------------------------------
// sideload
// ---------------------------------------------------------------------------

/**
 * Build a File-like object. Uses the real `File` constructor when available in
 * the vitest environment, otherwise fakes name/size/arrayBuffer.
 */
function makeFile(bytes: Uint8Array, name: string): File {
  if (typeof File !== 'undefined') {
    return new File([bytes], name, { type: 'application/octet-stream' });
  }
  return {
    name,
    size: bytes.byteLength,
    arrayBuffer: () => Promise.resolve(bytes.buffer as ArrayBuffer),
  } as unknown as File;
}

describe('PretrainedCatalog.sideload (Req 14.6)', () => {
  it('registers a sideloaded .onnx file, lists it, and infers onnx format', async () => {
    const registry = new ModelRegistry();
    const catalog = new PretrainedCatalog({ registry });

    const file = makeFile(new Uint8Array([1, 2, 3, 4, 5, 6]), 'model.onnx');
    await catalog.sideload(file, { id: 'my-sideloaded-model', displayName: 'My Model' });

    const entry = catalog.getEntry('my-sideloaded-model');
    expect(entry).toBeDefined();
    expect(entry?.format).toBe('onnx');
    expect(entry?.displayName).toBe('My Model');

    const listedIds = catalog.list().map((e) => e.id);
    expect(listedIds).toContain('my-sideloaded-model');

    expect(registry.has('my-sideloaded-model')).toBe(true);
  });

  it('works without a registry injected and still lists the entry', async () => {
    const catalog = new PretrainedCatalog();
    const file = makeFile(new Uint8Array([9, 9, 9]), 'weights.json');
    await catalog.sideload(file, { id: 'tfjs-side' });

    const entry = catalog.getEntry('tfjs-side');
    expect(entry).toBeDefined();
    // Non-.onnx file name infers tfjs format.
    expect(entry?.format).toBe('tfjs');
  });
});
