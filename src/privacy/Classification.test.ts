/**
 * Type-level + runtime tests for the classification brand (spec 06, task 1.2).
 *
 * The core assertions here are TYPE-LEVEL: they are `@ts-expect-error`
 * annotations that must COMPILE CLEAN under `tsc --noEmit`. If the brand ever
 * regresses (e.g. `Classified<T>` becomes assignable to a plain `T`), the
 * `@ts-expect-error` on that line would have nothing to suppress and `tsc`
 * itself would fail with "Unused '@ts-expect-error' directive" — so the type
 * boundary is verified by the build, not just by the runtime assertions.
 *
 * Verified by: `npx tsc --noEmit` (type layer) and `vitest run` (runtime layer).
 *
 * Validates: Requirements 3.1
 */

import { describe, it, expect } from 'vitest';
import { classify, declassifyForDevice } from './Classification';
import type {
  Classified,
  Sensitive,
  EncryptedEnvelope,
  NetworkTransmissible,
} from './Classification';

interface Reading {
  weight: number;
}

// A helper that only accepts a plain (unbranded) payload — a stand-in for a
// Network_Sink payload parameter. Classified data must NOT be assignable here.
function acceptsPlain(_value: Reading): void {}

describe('classify / declassifyForDevice brand', () => {
  it('classify produces a Classified<T> that round-trips through declassifyForDevice', () => {
    const raw: Reading = { weight: 70 };
    const branded: Classified<Reading> = classify(raw);
    const back: Reading = declassifyForDevice(branded);
    expect(back).toEqual(raw);
  });

  it('Sensitive<T> is an alias of Classified<T> (interchangeable)', () => {
    const branded: Sensitive<Reading> = classify({ weight: 82 });
    const asClassified: Classified<Reading> = branded; // must compile
    expect(declassifyForDevice(asClassified)).toEqual({ weight: 82 });
  });

  // ---- TYPE-LEVEL ASSERTIONS (must compile clean) ----

  it('type rules hold at compile time', () => {
    const raw: Reading = { weight: 70 };
    const branded = classify(raw);

    // classify(x) yields Classified<T>, assignable to a Classified<T> binding.
    const ok: Classified<Reading> = branded;
    expect(ok).toBeDefined();

    // A Classified<T> must NOT be assignable to a plain T.
    // @ts-expect-error Classified<Reading> is not assignable to plain Reading
    const leak: Reading = branded;
    void leak;

    // A Classified<T> must NOT be passable where a plain (network) payload is expected.
    // @ts-expect-error Classified<Reading> is not a valid plain payload
    acceptsPlain(branded);

    // A bare T must NOT be assignable to Classified<T> — classify is the only door.
    // @ts-expect-error a bare Reading cannot be used as Classified<Reading>
    const forged: Classified<Reading> = raw;
    void forged;

    // declassifyForDevice returns T (assignable to a plain Reading binding).
    const unwrapped: Reading = declassifyForDevice(branded);
    expect(unwrapped).toEqual(raw);

    // declassifyForDevice requires a Classified<T> input — a bare T is rejected.
    // @ts-expect-error declassifyForDevice does not accept an unbranded value
    declassifyForDevice(raw);
  });
});

/**
 * Type-level assertions for the Network_Sink boundary (spec 06, task 2.1).
 *
 * These prove the core invariant of hard rule #3 at the type layer:
 *   - a branded `Classified<T>` is NOT assignable to `NetworkTransmissible`
 *     (it cannot be used where a wire payload is expected), and
 *   - an unbranded `EncryptedEnvelope` IS assignable to `NetworkTransmissible`
 *     (an envelope is safe to send).
 *
 * As with the assertions above, the `@ts-expect-error` lines must have an error
 * to suppress: if `Classified<T>` ever became wire-assignable, `tsc` would fail
 * with "Unused '@ts-expect-error' directive", so the boundary is verified by the
 * build itself.
 *
 * Validates: Requirements 3.4, 3.6
 */

// A stand-in for a Network_Sink parameter: it accepts ONLY the wire allowlist.
function acceptsTransmissible(_payload: NetworkTransmissible): void {}

describe('NetworkTransmissible boundary', () => {
  it('type rules hold at compile time', () => {
    const branded = classify<Reading>({ weight: 70 });
    const envelope: EncryptedEnvelope = { v: 1, iv: 'aXY=', data: 'Y2lwaGVy' };

    // An EncryptedEnvelope IS assignable to NetworkTransmissible (safe to send).
    const wire: NetworkTransmissible = envelope;
    expect(wire).toBeDefined();
    acceptsTransmissible(envelope); // compiles: envelope is on the allowlist

    // A Classified<T> is NOT assignable to NetworkTransmissible.
    // @ts-expect-error Classified<Reading> is not a wire-transmissible payload
    const leak: NetworkTransmissible = branded;
    void leak;

    // A Classified<T> must NOT be passable where a Network_Sink payload is expected.
    // @ts-expect-error Classified<Reading> cannot be passed to a NetworkTransmissible sink
    acceptsTransmissible(branded);
  });
});

/**
 * Tests for `encryptForSync` — the single sanctioned Classified -> wire door
 * (spec 06, task 2.2; Requirements 3.3, 3.4).
 *
 * Runtime layer: with an UNLOCKED vault, `encryptForSync(vault, classify(x))`
 * resolves to an `EncryptedEnvelope` whose ciphertext does not contain the
 * plaintext (Req 3.4 — no plaintext leaves in the envelope).
 *
 * Type layer: the returned value IS assignable to `NetworkTransmissible` (an
 * envelope is on the wire allowlist, Req 3.6-adjacent), and passing a
 * NON-classified value to `encryptForSync` is a compile error suppressed by
 * `@ts-expect-error` — if the signature ever accepted a bare value, `tsc` would
 * fail with "Unused '@ts-expect-error' directive".
 *
 * @vitest-environment jsdom
 *
 * Validates: Requirements 3.3, 3.4
 */

import { encryptForSync } from './Classification';
import { PrivacyVault } from './PrivacyVault';

describe('encryptForSync (single Classified -> wire transform)', () => {
  it('encrypts Classified data into an envelope containing no plaintext (requires an unlocked vault)', async () => {
    // A fresh, UNLOCKED vault: creating it loads the Master_Key in memory.
    const vault = new PrivacyVault();
    await vault.create('correct horse battery staple');
    expect(vault.isUnlocked()).toBe(true);

    const secret = 'weight-73-kilograms-unique-marker';
    const branded = classify<Reading & { note: string }>({ weight: 73, note: secret });

    const envelope: EncryptedEnvelope = await encryptForSync(vault, branded);

    // Envelope shape: opaque ciphertext + IV, versioned, no key material.
    expect(envelope.v).toBe(1);
    expect(typeof envelope.iv).toBe('string');
    expect(typeof envelope.data).toBe('string');

    // Req 3.4: the ciphertext must NOT contain the plaintext marker.
    expect(envelope.data).not.toContain(secret);
    expect(envelope.iv).not.toContain(secret);
    // Full serialized envelope carries no plaintext either.
    expect(JSON.stringify(envelope)).not.toContain(secret);

    // Round-trips back through the vault to the original plaintext.
    const back = await vault.decryptJSON<Reading & { note: string }>(envelope);
    expect(back).toEqual({ weight: 73, note: secret });
  });

  // ---- TYPE-LEVEL ASSERTIONS (must compile clean) ----

  it('type rules hold at compile time', async () => {
    const vault = new PrivacyVault();
    await vault.create('another passphrase');

    const branded = classify<Reading>({ weight: 70 });

    // Positive: the transform's output IS assignable to NetworkTransmissible.
    const wire: NetworkTransmissible = await encryptForSync(vault, branded);
    expect(wire).toBeDefined();

    // Negative: a NON-classified (bare) value is NOT accepted by encryptForSync.
    // @ts-expect-error encryptForSync only accepts a Classified<T>, not a bare value
    await encryptForSync(vault, { weight: 70 });
  });
});
