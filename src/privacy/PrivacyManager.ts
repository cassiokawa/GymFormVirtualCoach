/**
 * PrivacyManager — GDPR/LGPD data-rights layer for sensitive personal data.
 *
 * Responsibilities:
 *  - Consent: track explicit opt-in before storing sensitive body/weight data
 *    (GDPR Art. 6/7, LGPD Art. 7/8). No sensitive data is stored without it.
 *  - Encryption at rest: sensitive scans are encrypted via PrivacyVault before
 *    persistence (GDPR Art. 32, LGPD Art. 46).
 *  - Right to access + portability: exportAll() returns everything as JSON
 *    (GDPR Art. 15/20, LGPD Art. 18).
 *  - Right to erasure: eraseAll() wipes every trace, including the vault
 *    (GDPR Art. 17, LGPD Art. 18).
 *
 * Everything is client-side. Data never leaves the user's browser.
 */

import type { BodyScan } from '../bodyScan/BodyMeasurement.js';
import { PrivacyVault, type EncryptedEnvelope, type VaultKeyStore } from './PrivacyVault.js';
import { Storage } from '../storage/Storage.js';

// localStorage keys owned by the privacy layer.
const CONSENT_KEY = 'gym-coach-privacy-consent';
const KEYSTORE_KEY = 'gym-coach-privacy-keystore';
const ENC_SCANS_KEY = 'gym-coach-body-scans-enc';
// Legacy plaintext key (pre-privacy-layer). Migrated then removed on erasure.
const LEGACY_SCANS_KEY = 'gym-coach-body-scans';

// ---------------------------------------------------------------------------
// Scoped-erasure key partitions (design.md "Data Models", Req 5.1–5.3;
// coaching-safety.md: "Erasure of body data must be independently available
// from erasure of workout data").
//
// Body_Data and Workout_Data occupy DISTINCT storage keys so one can be erased
// without touching the other. Every key below is documented with what it holds
// and why it belongs to its partition. Keys that are neither Body_Data nor
// Workout_Data (account session/user, audio-mute prefs, consent, keystore) are
// intentionally absent from both partitions: scoped erasure must not remove
// them. `eraseAll()` still wipes everything as before.
// ---------------------------------------------------------------------------

/**
 * BODY_KEYS — the highest-risk data class (body scans, weight, and the prefs
 * that only exist to support the body-scan feature).
 *
 *  - `gym-coach-body-scans-enc`  encrypted body-scan store (weight, measurements)
 *  - `gym-coach-body-scans`      legacy plaintext scans (pre-encryption)
 *  - `gym-coach-body-ref`        body-scan reference-device preference
 *  - `gym-coach-height-cm`       user height, entered for the body scan
 */
const BODY_KEYS: readonly string[] = [
  ENC_SCANS_KEY,
  LEGACY_SCANS_KEY,
  'gym-coach-body-ref',
  'gym-coach-height-cm',
];

/**
 * WORKOUT_KEYS — workout/session history and the state that resumes a session.
 *
 *  - `gym-coach-session-snapshot`  the 120-second resume snapshot of a set
 *
 * NOTE: the bulk of Workout_Data lives in IndexedDB (`workout_sessions` and
 * `session_exercise_logs`, owned by `Storage`), not in localStorage. Scoped
 * workout erasure therefore also clears those IndexedDB stores via
 * `Storage.clearWorkoutData()` — see {@link PrivacyManager.eraseWorkoutData}.
 */
const WORKOUT_KEYS: readonly string[] = [
  'gym-coach-session-snapshot',
];

/** Consent record persisted locally. */
export interface ConsentRecord {
  /** True once the user has explicitly agreed to store sensitive data. */
  granted: boolean;
  /** When consent was granted (epoch ms). */
  grantedAt: number;
  /** Privacy notice version the user agreed to. */
  noticeVersion: string;
}

/** Current privacy-notice version. Bump to re-prompt for consent. */
export const PRIVACY_NOTICE_VERSION = '1.0';

/**
 * A device-only credential used to reconstruct the vault after a cross-device
 * pull (Req 2.6). Exactly one of the two secrets: the Encryption_Passphrase or
 * the one-time Recovery_Code. Neither is ever sent to the Sync_Server.
 */
export type ReconstructCredential =
  | { kind: 'passphrase'; passphrase: string }
  | { kind: 'recovery'; recoveryCode: string };

/**
 * The pulled sync material: the opaque Encrypted_Envelope (`blob`) and the
 * Wrapped_Key_Metadata (`keyStore`), both as JSON strings, as returned by
 * `SyncClient.pull()`. Both are ciphertext the server cannot read.
 */
export interface PulledSyncMaterial {
  blob: string;
  keyStore: string;
}

/**
 * The outcome of a cross-device reconstruction attempt (Req 2.6, 2.7).
 *
 *  - `{ ok: true, restored }` — the credential unwrapped the Master_Key from
 *    the pulled Wrapped_Key_Metadata AND the pulled Encrypted_Envelope decrypted
 *    cleanly; `restored` is the number of body scans written to the local store.
 *  - `{ ok: false, reason: 'bad-credential' }` — the supplied credential could
 *    not unwrap the Master_Key (wrong passphrase / recovery code). No data was
 *    reconstructed and the local store was not touched.
 *  - `{ ok: false, reason: 'decrypt-failed' }` — the credential unlocked the
 *    vault but the pulled blob failed to decrypt (AES-GCM auth failure /
 *    corrupt / malformed JSON). No partial data was applied; the local store is
 *    left unchanged.
 */
export type ReconstructResult =
  | { ok: true; restored: number }
  | { ok: false; reason: 'bad-credential' | 'decrypt-failed' };

/**
 * PrivacyManager singleton. Coordinates consent, the encrypted store, and
 * data-subject rights (export / erase).
 */
export class PrivacyManager {
  private static instance: PrivacyManager | null = null;
  private vault = PrivacyVault.getInstance();

  static getInstance(): PrivacyManager {
    if (!PrivacyManager.instance) PrivacyManager.instance = new PrivacyManager();
    return PrivacyManager.instance;
  }

  // --- Consent (GDPR Art. 6/7, LGPD Art. 7/8) ---

  getConsent(): ConsentRecord | null {
    try {
      const raw = localStorage.getItem(CONSENT_KEY);
      return raw ? (JSON.parse(raw) as ConsentRecord) : null;
    } catch {
      return null;
    }
  }

  hasConsent(): boolean {
    const c = this.getConsent();
    return !!c && c.granted && c.noticeVersion === PRIVACY_NOTICE_VERSION;
  }

  grantConsent(): void {
    const record: ConsentRecord = {
      granted: true,
      grantedAt: Date.now(),
      noticeVersion: PRIVACY_NOTICE_VERSION,
    };
    localStorage.setItem(CONSENT_KEY, JSON.stringify(record));
  }

  /** Withdraw consent (GDPR Art. 7(3)). Does NOT delete data — call eraseAll for that. */
  withdrawConsent(): void {
    localStorage.removeItem(CONSENT_KEY);
  }

  // --- Account lifecycle (local zero-knowledge) ---

  /** True if a vault (account) has already been created on this device. */
  isVaultInitialized(): boolean {
    return localStorage.getItem(KEYSTORE_KEY) !== null;
  }

  /** Alias used by UI: is there an account set up on this device? */
  hasAccount(): boolean {
    return this.isVaultInitialized();
  }

  isUnlocked(): boolean {
    return this.vault.isUnlocked();
  }

  /** Log out — wipe the in-memory key. Data stays encrypted at rest. */
  lock(): void {
    this.vault.lock();
  }

  private readKeyStore(): VaultKeyStore | null {
    try {
      const raw = localStorage.getItem(KEYSTORE_KEY);
      return raw ? (JSON.parse(raw) as VaultKeyStore) : null;
    } catch {
      return null;
    }
  }

  private writeKeyStore(ks: VaultKeyStore): void {
    localStorage.setItem(KEYSTORE_KEY, JSON.stringify(ks));
  }

  /**
   * Sign up: create the vault for the first time with a passphrase. Returns a
   * one-time recovery code that the caller MUST show the user to save. Also
   * migrates any legacy plaintext scans into the encrypted store.
   */
  async createVault(passphrase: string): Promise<string> {
    const { keyStore, recoveryCode } = await this.vault.create(passphrase);
    this.writeKeyStore(keyStore);
    await this.migrateLegacyScans();
    return recoveryCode;
  }

  /** Log in with the passphrase. Returns false if wrong or no account. */
  async unlockVault(passphrase: string): Promise<boolean> {
    const ks = this.readKeyStore();
    if (!ks) return false;
    return this.vault.unlockWithPassphrase(passphrase, ks);
  }

  /**
   * Recover with the one-time recovery code. On success the vault is unlocked;
   * the caller should then prompt for a new passphrase via changePassphrase().
   */
  async recoverWithCode(recoveryCode: string): Promise<boolean> {
    const ks = this.readKeyStore();
    if (!ks) return false;
    return this.vault.unlockWithRecoveryCode(recoveryCode, ks);
  }

  /**
   * Change the passphrase (vault must be unlocked). Re-wraps the master key
   * without re-encrypting data. The recovery code is unchanged.
   */
  async changePassphrase(newPassphrase: string): Promise<boolean> {
    const ks = this.readKeyStore();
    if (!ks || !this.vault.isUnlocked()) return false;
    const updated = await this.vault.changePassphrase(newPassphrase, ks);
    this.writeKeyStore(updated);
    return true;
  }

  // --- Cloud sync support (zero-knowledge) ---

  /**
   * The wrapped-key metadata (VaultKeyStore) as a JSON string. Safe to store on
   * the server: it contains only the master key wrapped by the passphrase and
   * by the recovery code — neither the server nor an attacker can unwrap it
   * without one of those secrets. Needed to reconstruct the vault on a new
   * device. Returns null if no vault exists.
   */
  exportKeyStore(): string | null {
    const ks = this.readKeyStore();
    return ks ? JSON.stringify(ks) : null;
  }

  /**
   * Install a VaultKeyStore pulled from the server onto a new device. The vault
   * remains LOCKED until the user provides the passphrase or recovery code.
   */
  importKeyStore(keyStoreJson: string): void {
    const ks = JSON.parse(keyStoreJson) as VaultKeyStore;
    this.writeKeyStore(ks);
  }

  /**
   * Build the encrypted sync blob: the full set of sensitive body scans,
   * encrypted with the master key. Requires an unlocked vault. Returns the
   * envelope as a JSON string (opaque ciphertext) for upload.
   */
  async buildSyncBlob(): Promise<string> {
    if (!this.vault.isUnlocked()) throw new Error('Vault locked. Unlock before syncing.');
    const scans = await this.loadScans();
    const env = await this.vault.encryptJSON({ v: 1, bodyScans: scans });
    return JSON.stringify(env);
  }

  /**
   * Apply an encrypted sync blob pulled from the server: decrypt it with the
   * master key and persist the scans into the local encrypted store. Requires
   * an unlocked vault. Throws if decryption fails (wrong key / corrupt data).
   */
  async applySyncBlob(blobJson: string): Promise<number> {
    if (!this.vault.isUnlocked()) throw new Error('Vault locked. Unlock before applying sync.');
    const env = JSON.parse(blobJson) as EncryptedEnvelope;
    const payload = await this.vault.decryptJSON<{ v: number; bodyScans: BodyScan[] }>(env);
    const scans = Array.isArray(payload.bodyScans) ? payload.bodyScans : [];
    await this.saveScans(scans);
    return scans.length;
  }

  /**
   * Cross-device reconstruction (Req 2.6, 2.7). On a NEW device that has pulled
   * the sync material from the server, this installs the Wrapped_Key_Metadata,
   * reconstructs the Master_Key from the supplied device-only credential
   * (Encryption_Passphrase or Recovery_Code), and decrypts the pulled
   * Encrypted_Envelope into the local encrypted store.
   *
   * It is the cohesive form of the three-step flow that the account layer would
   * otherwise stitch together by hand:
   *   1. `importKeyStore(pulled.keyStore)` — install the wrapped-key metadata.
   *   2. unlock with the credential — reconstruct the Master_Key.
   *   3. `applySyncBlob(pulled.blob)` — decrypt + persist the scans.
   *
   * Failure is reported cleanly, never thrown, and never leaves partial state:
   *   - Req 2.7 (bad credential): if the credential cannot unwrap the
   *     Master_Key, the vault stays LOCKED, the blob is NOT applied, and the
   *     result is `{ ok: false, reason: 'bad-credential' }`.
   *   - Req 2.7 (undecryptable blob): if the credential unlocks the vault but
   *     the pulled blob fails to decrypt (AES-GCM auth failure / corrupt /
   *     malformed), the failure is caught and surfaced as
   *     `{ ok: false, reason: 'decrypt-failed' }`. `applySyncBlob` decrypts
   *     BEFORE it writes, so a failed decrypt never reaches `saveScans` and the
   *     local store is left unchanged.
   *   - Req 2.6 (success): `{ ok: true, restored }` with the count of scans.
   *
   * The keyStore is installed first so the pulled wrapped-key metadata is what
   * the credential is checked against — this is exactly the new-device case
   * where no local vault existed before.
   */
  async reconstructFromSync(
    pulled: PulledSyncMaterial,
    credential: ReconstructCredential,
  ): Promise<ReconstructResult> {
    // 1. Install the pulled Wrapped_Key_Metadata. Guard against malformed JSON:
    //    a keyStore we cannot even parse is treated as a bad-credential outcome
    //    (there is nothing to unwrap against), never a thrown error.
    try {
      this.importKeyStore(pulled.keyStore);
    } catch {
      return { ok: false, reason: 'bad-credential' };
    }

    // 2. Reconstruct the Master_Key from the device-only credential. A wrong
    //    passphrase / recovery code returns false; we leave the vault locked and
    //    do NOT touch the local store.
    const unlocked =
      credential.kind === 'passphrase'
        ? await this.unlockVault(credential.passphrase)
        : await this.recoverWithCode(credential.recoveryCode);
    if (!unlocked) return { ok: false, reason: 'bad-credential' };

    // 3. Decrypt the pulled Encrypted_Envelope and persist. applySyncBlob
    //    decrypts before writing, so any failure here (AES-GCM auth error,
    //    corrupt ciphertext, malformed JSON) is thrown before saveScans runs —
    //    the local store is never partially populated.
    try {
      const restored = await this.applySyncBlob(pulled.blob);
      return { ok: true, restored };
    } catch {
      return { ok: false, reason: 'decrypt-failed' };
    }
  }

  // --- Encrypted body-scan store ---

  /** Load and decrypt all body scans. Requires an unlocked vault. */
  async loadScans(): Promise<BodyScan[]> {
    if (!this.vault.isUnlocked()) throw new Error('Vault locked. Unlock to read body scans.');
    const raw = localStorage.getItem(ENC_SCANS_KEY);
    if (!raw) return [];
    try {
      const env = JSON.parse(raw) as EncryptedEnvelope;
      return await this.vault.decryptJSON<BodyScan[]>(env);
    } catch {
      return [];
    }
  }

  /** Encrypt and persist the full set of body scans. Requires an unlocked vault. */
  async saveScans(scans: BodyScan[]): Promise<void> {
    if (!this.vault.isUnlocked()) throw new Error('Vault locked. Unlock to save body scans.');
    const env = await this.vault.encryptJSON(scans);
    localStorage.setItem(ENC_SCANS_KEY, JSON.stringify(env));
  }

  /** One-time migration of pre-encryption plaintext scans into the vault. */
  private async migrateLegacyScans(): Promise<void> {
    const legacy = localStorage.getItem(LEGACY_SCANS_KEY);
    if (!legacy) return;
    try {
      const scans = JSON.parse(legacy) as BodyScan[];
      if (Array.isArray(scans) && scans.length > 0) {
        await this.saveScans(scans);
      }
    } catch {
      /* corrupt legacy data — skip */
    }
    // Remove the plaintext copy so sensitive data is no longer unencrypted.
    localStorage.removeItem(LEGACY_SCANS_KEY);
  }

  // --- Right to access + portability (GDPR Art. 15/20, LGPD Art. 18) ---

  /**
   * Export everything the app holds about the user as a single JSON object.
   * Body scans are decrypted for the export (the user is exercising their own
   * right of access, with an unlocked vault). Non-sensitive data (workout
   * history, preferences) is included in plaintext.
   */
  async exportAll(): Promise<Record<string, unknown>> {
    const bodyScans = this.vault.isUnlocked() ? await this.loadScans() : '[[ locked — unlock the vault to include body scans ]]';
    const preferences: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      // Skip secrets and encrypted blobs; include benign preferences.
      if (k === KEYSTORE_KEY || k === ENC_SCANS_KEY || k === LEGACY_SCANS_KEY) continue;
      if (k.startsWith('gym-coach-')) preferences[k] = localStorage.getItem(k) ?? '';
    }
    return {
      exportedAt: new Date().toISOString(),
      format: 'gym-coach-data-export',
      formatVersion: 1,
      consent: this.getConsent(),
      preferences,
      bodyScans,
    };
  }

  /** Trigger a browser download of the full export as a JSON file. */
  async downloadExport(): Promise<void> {
    const data = await this.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gym-coach-data-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // --- Right to erasure (GDPR Art. 17, LGPD Art. 18) ---
  //
  // Erasure is partitioned so the user controls each kind of data
  // independently (Req 5.1–5.3, coaching-safety.md). Body_Data erasure never
  // touches Workout_Data and vice versa; `eraseAll` still wipes everything.

  /**
   * Erase Body_Data only (Req 5.1, 5.2). Removes every key in `BODY_KEYS` —
   * the encrypted body-scan store, the legacy plaintext scans, and the
   * body-scan preferences — and RETAINS all Workout_Data. Available
   * independently from workout erasure.
   *
   * Body_Data lives only in localStorage, so this needs no IndexedDB
   * coordination. The vault is not locked here: body scans are re-encrypted
   * with the same Master_Key on the next save, and locking would be a broader
   * effect than "erase my body data" implies.
   */
  eraseBodyData(): void {
    for (const k of BODY_KEYS) localStorage.removeItem(k);
  }

  /**
   * Erase Workout_Data only (Req 5.3). Removes every key in `WORKOUT_KEYS`
   * from localStorage AND clears the workout stores in IndexedDB
   * (`workout_sessions`, `session_exercise_logs`) where the bulk of workout
   * history lives. RETAINS all Body_Data. Available independently from body
   * erasure.
   *
   * The IndexedDB clear is delegated to `Storage.clearWorkoutData()`; if the
   * database was never opened it resolves as a no-op.
   */
  async eraseWorkoutData(): Promise<void> {
    for (const k of WORKOUT_KEYS) localStorage.removeItem(k);
    await Storage.getInstance().clearWorkoutData();
  }

  /**
   * Permanently delete ALL locally stored data: encrypted scans, vault salt +
   * verifier, consent, legacy plaintext, every gym-coach preference key, and
   * the IndexedDB workout stores. Also wipes the in-memory key. This is
   * irreversible. (Full-erase behavior is unchanged from prior releases; it is
   * a superset of both scoped erasures.)
   */
  async eraseAll(): Promise<void> {
    // Do the synchronous localStorage wipe and vault lock FIRST so callers that
    // do not await (and existing synchronous tests) still observe an emptied
    // store and a locked vault the moment control returns. The IndexedDB clear
    // is the only genuinely async step and is awaited last.
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('gym-coach-')) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
    this.vault.lock();
    await Storage.getInstance().clearWorkoutData();
  }
}
