/**
 * PrivacyVault — encryption-at-rest core for sensitive personal data (body
 * measurements, weight, and anything else the user marks private).
 *
 * Architecture (zero-knowledge, no server):
 *  - A single random 256-bit MASTER KEY encrypts all sensitive data (AES-GCM).
 *  - The master key is never stored in the clear. Instead it is "wrapped"
 *    (encrypted) independently by two credentials:
 *       1. the user PASSPHRASE  (their day-to-day login)
 *       2. a RECOVERY CODE      (shown once at sign-up, for forgotten passphrase)
 *    Each wrapping key is derived via PBKDF2 (SHA-256, 210k iterations) with its
 *    own salt. Either credential can recover the master key.
 *  - Because data is encrypted with the master key (not the passphrase), the
 *    user can CHANGE their passphrase by re-wrapping the master key — the data
 *    itself is never re-encrypted.
 *  - No credential is ever persisted. The master key lives only in memory while
 *    unlocked and is wiped on lock/logout. Forgetting BOTH the passphrase and
 *    the recovery code makes the data permanently unrecoverable — by design.
 *
 * All primitives use the platform Web Crypto API (crypto.subtle) — no external
 * libraries, no network, fully client-side.
 *
 * Formalized contracts (spec 06-local-first-privacy):
 *  - Req 1.2 — Body_Data is encrypted with the Master_Key using AES-GCM before
 *    it is written to device storage. `encryptJSON` (and the body-scan-typed
 *    `encryptBodyScans` entry below) are that write path.
 *  - Req 2.1 — a single 256-bit Master_Key encrypts all Classified data
 *    (`MASTER_KEY_BYTES = 32`, AES-GCM, imported once per unlock).
 *  - Req 2.2 — the Master_Key is wrapped INDEPENDENTLY by the
 *    Encryption_Passphrase and by the Recovery_Code, each wrapping key derived
 *    via PBKDF2-SHA-256 with its own per-credential salt (`wrapMasterKey`).
 *  - Req 1.4 — the locked-vault contract. WHILE the Vault is locked (no
 *    in-memory Master_Key), it rejects EVERY request to encrypt or decrypt
 *    Classified data. Every crypto entry point (`encryptJSON`, `decryptJSON`,
 *    `encryptBodyScans`, `decryptBodyScans`) and the master-key export used by
 *    `changePassphrase` route through a single private guard,
 *    `requireUnlocked()`, so the contract is enforced in ONE place and cannot
 *    drift: if the Master_Key is null, the guard throws a "locked" error and no
 *    sensitive data can be encrypted or decrypted.
 *  This module is the Master_Key holder of the Privacy & Sync context; it
 *  depends on nothing outward.
 */

import type { BodyScan } from '../bodyScan/BodyMeasurement.js';
import { declassifyForDevice, type Classified } from './Classification.js';

/** AES-GCM envelope. Contains no plaintext and no key material. */
export interface EncryptedEnvelope {
  /** Format version, for forward migration. */
  v: 1;
  /** Base64 AES-GCM initialization vector (per-write, unique). */
  iv: string;
  /** Base64 AES-GCM ciphertext (includes auth tag). */
  data: string;
}

/** A wrapped copy of the master key under one credential (passphrase or code). */
export interface WrappedKey {
  /** Base64 PBKDF2 salt for deriving the wrapping key from the credential. */
  salt: string;
  /** The master key, encrypted with the credential-derived wrapping key. */
  envelope: EncryptedEnvelope;
}

/** Persisted vault metadata: the master key wrapped under each credential. */
export interface VaultKeyStore {
  v: 1;
  /** Master key wrapped by the passphrase. */
  byPassphrase: WrappedKey;
  /** Master key wrapped by the recovery code. */
  byRecovery: WrappedKey;
}

const PBKDF2_ITERATIONS = 210_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const MASTER_KEY_BYTES = 32; // 256-bit AES key

function toB64(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]!);
  return btoa(bin);
}

function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Derive a non-extractable AES-GCM wrapping key from a credential + salt. */
async function deriveWrappingKey(credential: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(credential),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as unknown as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt raw bytes under a key, producing an envelope. */
async function encryptBytes(key: CryptoKey, bytes: Uint8Array): Promise<EncryptedEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    bytes as unknown as BufferSource,
  );
  return { v: 1, iv: toB64(iv), data: toB64(cipher) };
}

/** Decrypt an envelope under a key, returning raw bytes. Throws on wrong key. */
async function decryptBytes(key: CryptoKey, env: EncryptedEnvelope): Promise<Uint8Array> {
  const iv = fromB64(env.iv);
  const data = fromB64(env.data);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    data as unknown as BufferSource,
  );
  return new Uint8Array(plain);
}

/**
 * Wrap the master key under a credential (passphrase or recovery code).
 *
 * Req 2.2: each call derives a fresh per-credential PBKDF2 salt and a distinct
 * wrapping key, so the Encryption_Passphrase wrapping and the Recovery_Code
 * wrapping are cryptographically independent — either alone recovers the
 * Master_Key, neither reveals the other.
 */
async function wrapMasterKey(credential: string, masterKeyRaw: Uint8Array): Promise<WrappedKey> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const wrappingKey = await deriveWrappingKey(credential, salt);
  const envelope = await encryptBytes(wrappingKey, masterKeyRaw);
  return { salt: toB64(salt), envelope };
}

/** Attempt to unwrap the master key with a credential. Returns null on failure. */
async function unwrapMasterKey(credential: string, wrapped: WrappedKey): Promise<Uint8Array | null> {
  try {
    const wrappingKey = await deriveWrappingKey(credential, fromB64(wrapped.salt));
    return await decryptBytes(wrappingKey, wrapped.envelope);
  } catch {
    return null;
  }
}

/**
 * Generate a human-friendly recovery code, e.g. "K7QM-3XPD-9RTB-2WHF".
 * 16 chars from an unambiguous alphabet (no 0/O/1/I) = ~82 bits of entropy.
 */
export function generateRecoveryCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
    if (i % 4 === 3 && i < 15) out += '-';
  }
  return out;
}

/** Normalize a recovery code for comparison (strip dashes/space, uppercase). */
export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

/**
 * PrivacyVault — singleton holding the in-memory master key for an unlocked
 * session and encrypting/decrypting JSON payloads with it.
 */
export class PrivacyVault {
  private static instance: PrivacyVault | null = null;

  /** In-memory master key (AES-GCM). Null when locked. Never persisted. */
  private masterKey: CryptoKey | null = null;

  static getInstance(): PrivacyVault {
    if (!PrivacyVault.instance) PrivacyVault.instance = new PrivacyVault();
    return PrivacyVault.instance;
  }

  /** True if the master key is loaded (vault unlocked / logged in). */
  isUnlocked(): boolean {
    return this.masterKey !== null;
  }

  /**
   * The single enforcement point of the locked-vault contract (Req 1.4).
   *
   * Returns the in-memory Master_Key when unlocked; throws a "locked" error
   * when the vault is locked (Master_Key is null). Every encrypt/decrypt entry
   * point and the master-key export route through here, so the contract holds
   * uniformly and cannot drift as new entry points are added.
   */
  private requireUnlocked(): CryptoKey {
    if (!this.masterKey) {
      throw new Error('PrivacyVault is locked. Unlock before encrypting or decrypting.');
    }
    return this.masterKey;
  }

  /** Wipe the in-memory master key. Call on lock / logout. */
  lock(): void {
    this.masterKey = null;
  }

  /**
   * Create a brand-new vault. Generates a random master key and wraps it under
   * BOTH the passphrase and a freshly generated recovery code. Returns the key
   * store (to persist) and the recovery code (to show the user ONCE).
   *
   * Req 2.1: `masterRaw` is a single random 256-bit key that encrypts all
   * Classified data. Req 2.2: it is wrapped independently by the
   * Encryption_Passphrase (`byPassphrase`) and the Recovery_Code
   * (`byRecovery`), each via PBKDF2 with its own salt (see `wrapMasterKey`).
   */
  async create(passphrase: string): Promise<{ keyStore: VaultKeyStore; recoveryCode: string }> {
    const masterRaw = crypto.getRandomValues(new Uint8Array(MASTER_KEY_BYTES));
    const recoveryCode = generateRecoveryCode();
    const byPassphrase = await wrapMasterKey(passphrase, masterRaw);
    const byRecovery = await wrapMasterKey(normalizeRecoveryCode(recoveryCode), masterRaw);
    this.masterKey = await this.importMaster(masterRaw);
    return { keyStore: { v: 1, byPassphrase, byRecovery }, recoveryCode };
  }

  /** Unlock with the passphrase. Returns true on success. */
  async unlockWithPassphrase(passphrase: string, keyStore: VaultKeyStore): Promise<boolean> {
    const raw = await unwrapMasterKey(passphrase, keyStore.byPassphrase);
    if (!raw) return false;
    this.masterKey = await this.importMaster(raw);
    return true;
  }

  /** Unlock with the recovery code. Returns true on success. */
  async unlockWithRecoveryCode(code: string, keyStore: VaultKeyStore): Promise<boolean> {
    const raw = await unwrapMasterKey(normalizeRecoveryCode(code), keyStore.byRecovery);
    if (!raw) return false;
    this.masterKey = await this.importMaster(raw);
    return true;
  }

  /**
   * Re-wrap the (currently unlocked) master key under a NEW passphrase, without
   * re-encrypting any data. Returns the updated key store. Requires unlock.
   */
  async changePassphrase(newPassphrase: string, keyStore: VaultKeyStore): Promise<VaultKeyStore> {
    const raw = await this.exportMaster();
    const byPassphrase = await wrapMasterKey(newPassphrase, raw);
    return { ...keyStore, byPassphrase };
  }

  /**
   * Encrypt a JSON-serializable value into an envelope. Requires unlock — the
   * locked-vault contract (Req 1.4) is enforced by `requireUnlocked()`.
   */
  async encryptJSON<T>(value: T): Promise<EncryptedEnvelope> {
    const masterKey = this.requireUnlocked();
    const enc = new TextEncoder();
    return encryptBytes(masterKey, enc.encode(JSON.stringify(value)));
  }

  /**
   * Decrypt an envelope back into a typed value. Requires unlock — the
   * locked-vault contract (Req 1.4) is enforced by `requireUnlocked()`.
   */
  async decryptJSON<T>(env: EncryptedEnvelope): Promise<T> {
    const masterKey = this.requireUnlocked();
    const bytes = await decryptBytes(masterKey, env);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }

  /**
   * Encrypt body scans at rest (Req 1.2). This is the body-scan-typed entry to
   * the vault: its input is `Classified<BodyScan[]>`, so a caller CANNOT hand
   * raw body scans to the vault without first branding them through
   * `classify()`. The Classification boundary (tech.md hard rule #3) thus
   * appears at the encryption door itself, not only at the network sink —
   * sensitive body data must be Classified before it can be encrypted.
   *
   * The generic `encryptJSON<T>` stays as the crypto core (used internally and
   * by existing callers); this method declassifies the branded payload right
   * before handing plaintext bytes to `encryptJSON`, and returns an unbranded
   * `EncryptedEnvelope` that carries no Classification and no key material.
   * Requires an unlocked vault.
   */
  async encryptBodyScans(data: Classified<BodyScan[]>): Promise<EncryptedEnvelope> {
    // declassifyForDevice unwraps the brand purely at the type level; the value
    // is unchanged. The plaintext lives only in memory here and is immediately
    // encrypted with the Master_Key (AES-GCM) before it can go anywhere.
    return this.encryptJSON(declassifyForDevice(data));
  }

  /**
   * Decrypt body scans previously written by `encryptBodyScans`. Returns a
   * `Classified<BodyScan[]>`: data read back out of the vault re-enters the
   * Classified world, so the type system keeps tracking it as sensitive on the
   * way to the review UI / local export (via `declassifyForDevice`) and blocks
   * it from a Network_Sink. Requires an unlocked vault.
   */
  async decryptBodyScans(env: EncryptedEnvelope): Promise<Classified<BodyScan[]>> {
    const scans = await this.decryptJSON<BodyScan[]>(env);
    // Re-brand as Classified on the way out. Zero-cost cast; matches `classify`.
    return scans as unknown as Classified<BodyScan[]>;
  }

  // --- master key import/export helpers ---

  private async importMaster(raw: Uint8Array): Promise<CryptoKey> {
    return crypto.subtle.importKey(
      'raw',
      raw as unknown as BufferSource,
      { name: 'AES-GCM', length: 256 },
      true, // extractable so we can re-wrap on passphrase change
      ['encrypt', 'decrypt'],
    );
  }

  private async exportMaster(): Promise<Uint8Array> {
    // Routed through the same locked-vault guard (Req 1.4): changePassphrase
    // cannot re-wrap a Master_Key that is not currently loaded.
    const masterKey = this.requireUnlocked();
    const raw = await crypto.subtle.exportKey('raw', masterKey);
    return new Uint8Array(raw);
  }
}
