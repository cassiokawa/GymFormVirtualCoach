/**
 * Classification — the compile-time device-only boundary (tech.md hard rule #3).
 *
 * Sensitive personal data (body measurements, weight, workout logs) carries a
 * Classification in the *type system*, not at runtime. A value derived from
 * sensitive data is a `Classified<T>`: the type system tracks it distinctly
 * from its underlying `T`, so it can never be silently handed to a Network_Sink
 * (fetch / XHR / WebSocket / sendBeacon) where a plain payload is expected.
 *
 * Why compile-time and not a runtime guard: a runtime check gets bypassed under
 * deadline pressure; a type error does not. The device-only guarantee is an
 * invariant the compiler enforces.
 *
 * There are exactly three doors in and out of the Classified world:
 *   - `classify(value)`            — the ONLY way to brand a value as Classified.
 *   - `declassifyForDevice(value)` — the greppable on-device escape hatch, for
 *                                    rendering review screens / user-initiated
 *                                    local export. Never for a Network_Sink.
 *   - `encryptForSync(...)`        — the ONLY sanctioned path from Classified to
 *                                    network-transmissible; declassifies the
 *                                    branded input internally and returns an
 *                                    opaque, unbranded EncryptedEnvelope.
 *
 * This module defines the brand and all three doors: `classify` and
 * `declassifyForDevice` (task 1.1), the unbranded `EncryptedEnvelope` boundary
 * type and the `NetworkTransmissible` payload union (task 2.1), and the single
 * `encryptForSync` transform (task 2.2, below).
 */

/**
 * A unique symbol brand key. It is `declare`d (compile-time only, no runtime
 * value) and never exported, so user code cannot name it, forge it, or
 * construct a `Classified<T>` by hand. The only constructor is `classify`.
 */
declare const CLASSIFIED: unique symbol;

/**
 * `Classified<T>`: a value of type `T` derived from sensitive personal data.
 *
 * The brand is an *opaque wrapper*, not an intersection. The underlying `T` is
 * carried in a phantom property keyed by the private `CLASSIFIED` symbol.
 * Consequences enforced by the type system:
 *   - assignable-FROM `T` only via `classify(value: T)` — a bare `T` lacks the
 *     symbol-keyed brand property, so it is not assignable to `Classified<T>`;
 *   - NOT assignable-TO a plain `T` — `Classified<T>` is a distinct wrapper
 *     shape, not a subtype of `T`, so it cannot be silently used where a `T`
 *     (or a Network_Sink payload) is expected. Getting `T` back out requires
 *     `declassifyForDevice` (on-device) or `encryptForSync` (task 2, network).
 *
 * An intersection brand (`T & { ...brand }`) would fail the second rule: an
 * intersection is a *subtype* of `T`, so it would remain assignable to a plain
 * `T`. The opaque wrapper keeps the two types mutually distinct.
 */
export type Classified<T> = { readonly [CLASSIFIED]: T };

/**
 * `Sensitive<T>` — alias of `Classified<T>` for call sites that read better as
 * "Sensitive". Same brand, same guarantees; not a distinct classification.
 */
export type Sensitive<T> = Classified<T>;

/**
 * Brand a value as Classified. The ONLY way to enter the Classified world.
 *
 * Every value derived from Body_Data or Workout_Data must pass through here so
 * the type system can track it distinctly from its underlying type thereafter.
 * This is a zero-cost cast: the brand exists only in the type system.
 */
export function classify<T>(value: T): Classified<T> {
  // The brand exists ONLY in the type system: `CLASSIFIED` is a `declare const`
  // with no runtime representation, so it must never be referenced at runtime.
  // At runtime this is a zero-cost identity — the value passes through unchanged
  // and carries its Classified<T> type purely for the compiler. Nothing about
  // the value is mutated or wrapped.
  return value as unknown as Classified<T>;
}

/**
 * Read Classified data for legitimate ON-DEVICE use — rendering a review
 * screen, exporting to a local file the user initiated. This is the on-device
 * escape hatch out of the Classified world.
 *
 * Deliberately named to be greppable and reviewable: a reviewer (and the
 * build-time Classification_Guard) can locate every place Classified data is
 * unwrapped and assert none of them also touches a Network_Sink.
 *
 * MUST NOT be used to feed a Network_Sink. The only sanctioned path from
 * Classified to the network is `encryptForSync` (task 2), which returns an
 * opaque EncryptedEnvelope. Using `declassifyForDevice` to hand plaintext to
 * `fetch`/`XHR`/`WebSocket`/`sendBeacon` defeats hard rule #3.
 */
export function declassifyForDevice<T>(value: Classified<T>): T {
  // The inverse of `classify`: a zero-cost identity at runtime. The brand is a
  // compile-time-only wrapper, so the underlying value IS the runtime value;
  // we strip the phantom brand type and hand back `T`. No symbol is read.
  return value as unknown as T;
}

// ---------------------------------------------------------------------------
// Task 2.1 — the Encrypted_Envelope boundary type and the Network_Sink allowlist
// ---------------------------------------------------------------------------
//
// This section defines *what is allowed onto the wire*. It is the type-level
// counterpart of hard rule #3: a `Classified<T>` (branded, sensitive) is a
// distinct shape from anything in `NetworkTransmissible`, so the type system
// rejects a Classified value wherever a wire payload is expected. There is no
// runtime cost and no runtime check — the guarantee lives entirely in the types.
//
// `encryptForSync` (task 2.2, at the end of this module) is the single
// sanctioned transform from `Classified<T>` to an unbranded `EncryptedEnvelope`.
// It is the ONLY producer of an `EncryptedEnvelope` from Classified input,
// closing the loop: Classified data can reach a Network_Sink only after being
// converted to an envelope by that transform.

// Type-only imports keep this module free of a runtime dependency on
// `PrivacyVault` — `Classification` sits at the inward edge of the Privacy &
// Sync context and must not create an import cycle. `PrivacyVault` is imported
// as a TYPE for the `encryptForSync` parameter (task 2.2); no runtime value is
// pulled in, so there is no circular-import hazard even though `PrivacyVault`
// imports `classify`/`declassifyForDevice` from here at runtime.
import type { EncryptedEnvelope, VaultKeyStore, PrivacyVault } from './PrivacyVault';

/**
 * Re-export the UNBRANDED `EncryptedEnvelope` from `PrivacyVault`.
 *
 * Callers get the boundary type from the classification module (the module that
 * owns the device-only boundary), so "what may leave the device" is defined in
 * one place. The shape is unchanged and deliberately carries NO brand: an
 * envelope is opaque AES-GCM ciphertext + IV — it holds no plaintext and no key
 * material, so it is *safe to transmit* and therefore freely assignable to a
 * Network_Sink payload. That assignability is the entire point of leaving it
 * unbranded; branding it would defeat the sanctioned sync path.
 */
export type { EncryptedEnvelope } from './PrivacyVault';

/**
 * The wrapped-key metadata that travels alongside an envelope during sync.
 *
 * `VaultKeyStore` is the Master_Key wrapped independently under the
 * Encryption_Passphrase and the Recovery_Code (`WrappedKey` each). Both are
 * opaque ciphertext + PBKDF2 salts — no plaintext, no unwrapped key material —
 * so the Sync_Server can store them without ever being able to unwrap them.
 * Re-exported unbranded for the same reason as `EncryptedEnvelope`: safe to
 * transmit, so wire-assignable.
 */
export type { VaultKeyStore, WrappedKey } from './PrivacyVault';

/**
 * `AccountCredential` — the account-authentication payloads exchanged with the
 * Sync_Server (email, password, session/verification/reset tokens).
 *
 * These are Account_Password / session data used by `AuthClient`. They
 * authenticate the user to the server and can NEVER unwrap the Master_Key, so
 * they are deliberately NOT `Classified` vault data — the two secrets are kept
 * distinct (see requirements: Account_Password vs Encryption_Passphrase). They
 * are wire-safe by nature: sending a login credential to the server is what
 * authentication *is*. Shapes mirror the request bodies in `AuthClient`.
 */
export type AccountCredential =
  | { email: string; password: string }              // register
  | { identifier: string; password: string }          // login
  | { token: string }                                  // verify-email / logout-ish
  | { token: string; password: string }               // reset-password
  | { email: string }                                 // forgot-password
  | { session: string };                               // bearer session token

/**
 * `NetworkTransmissible` — the ALLOWLIST of payloads permitted to reach a
 * Network_Sink.
 *
 * This union is deliberately an allowlist, not a blocklist: only the shapes
 * enumerated here may cross the boundary. Anything else — most importantly a
 * `Classified<T>` — is simply not a member of the union, so the type system
 * rejects it at the call site with no runtime check required.
 *
 * Members, all unbranded and opaque:
 *   - `EncryptedEnvelope`  — AES-GCM ciphertext + IV (no plaintext, no key).
 *   - `VaultKeyStore`      — Master_Key wrapped under two credentials
 *                            (ciphertext + salts only); safe to store server-side.
 *   - `AccountCredential`  — server-auth data (email/password/token/session),
 *                            which is account data, not Classified vault data.
 *
 * A `Classified<T>` is a distinct branded wrapper shape (see above) and is NOT a
 * member of this union — passing one where a `NetworkTransmissible` is expected
 * is a compile-time error. That is the boundary. The only way a Classified value
 * becomes transmissible is `encryptForSync` (task 2.2), which returns an
 * `EncryptedEnvelope` — a member of this allowlist.
 */
export type NetworkTransmissible = EncryptedEnvelope | VaultKeyStore | AccountCredential;

// ---------------------------------------------------------------------------
// Task 2.2 — encryptForSync: the single door from Classified<T> to the network
// ---------------------------------------------------------------------------

/**
 * `encryptForSync` — the ONE sanctioned transform from a `Classified<T>` to a
 * wire-transmissible `EncryptedEnvelope`. This is the single door out of the
 * Classified world toward a Network_Sink (Req 3.3): there is no other function
 * that turns branded, sensitive data into something on the `NetworkTransmissible`
 * allowlist.
 *
 * How it upholds hard rule #3:
 *   - It CONSUMES a `Classified<T>` — a caller cannot invoke it with an
 *     unbranded value, so only data that has passed through `classify` can be
 *     prepared for sync.
 *   - It declassifies the branded input INTERNALLY (via `declassifyForDevice`)
 *     and immediately hands the plaintext to `vault.encryptJSON`. The cleartext
 *     exists only for the moment between unwrap and encrypt, inside this
 *     function; it is never returned, logged, or exposed to a caller.
 *   - It RETURNS an unbranded `EncryptedEnvelope` — AES-GCM ciphertext + IV that
 *     carries no Classification, no plaintext, and no key material (Req 3.4).
 *     Being unbranded, the envelope is a member of `NetworkTransmissible` and is
 *     therefore assignable to a Network_Sink payload; being ciphertext, it is
 *     safe to send.
 *
 * Requires an UNLOCKED vault: it delegates to `PrivacyVault.encryptJSON`, which
 * throws if the Master_Key is not loaded. `vault` is typed (not the singleton)
 * so the dependency is explicit and testable, and `PrivacyVault` is imported as
 * a TYPE only, avoiding any runtime import cycle with this module.
 *
 * This is the ONLY place `declassifyForDevice` is paired with an encryption
 * step for network purposes; the Classification_Guard treats the presence of
 * `encryptForSync` as the sanctioned route, and no other transform is permitted
 * to produce an envelope from Classified input.
 */
export function encryptForSync<T>(
  vault: PrivacyVault,
  data: Classified<T>,
): Promise<EncryptedEnvelope> {
  // Unwrap the brand at the type level (zero-cost identity), then encrypt the
  // plaintext with the Master_Key. The returned promise resolves to an opaque
  // envelope — no brand, no plaintext, no key material leaves this function.
  return vault.encryptJSON(declassifyForDevice(data));
}
