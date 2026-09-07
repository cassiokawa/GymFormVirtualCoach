/**
 * @vitest-environment jsdom
 *
 * Tests for the privacy layer: encryption round-trip, wrong-passphrase
 * rejection, tamper detection, consent tracking, legacy migration, and erasure.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PrivacyVault, generateRecoveryCode, normalizeRecoveryCode, type VaultKeyStore, type EncryptedEnvelope } from './PrivacyVault.js';
import { PrivacyManager, PRIVACY_NOTICE_VERSION } from './PrivacyManager.js';
import type { BodyScan } from '../bodyScan/BodyMeasurement.js';
import { classify, declassifyForDevice } from './Classification.js';

// Some jsdom builds ship an incomplete localStorage (missing clear()). Install a
// simple, spec-complete in-memory implementation so tests are deterministic.
function installMemoryLocalStorage(): void {
  const store = new Map<string, string>();
  const mock: Storage = {
    get length() { return store.size; },
    clear() { store.clear(); },
    getItem(k: string) { return store.has(k) ? store.get(k)! : null; },
    key(i: number) { return Array.from(store.keys())[i] ?? null; },
    removeItem(k: string) { store.delete(k); },
    setItem(k: string, v: string) { store.set(k, String(v)); },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: mock, configurable: true, writable: true });
}

// Reset singletons + storage between tests.
beforeEach(() => {
  installMemoryLocalStorage();
  PrivacyVault.getInstance().lock();
  PrivacyManager.getInstance().lock();
});

function fakeScan(id: string, weightKg?: number): BodyScan {
  const scan: BodyScan = {
    id,
    timestamp: 1000,
    poseQuality: 0.9,
    measurements: {
      shoulderWidth: 0.2, hipWidth: 0.15, shoulderToHipRatio: 1.33,
      leftUpperArm: 0.15, rightUpperArm: 0.15, leftForearm: 0.13, rightForearm: 0.13,
      leftThigh: 0.24, rightThigh: 0.24, leftCalf: 0.2, rightCalf: 0.2,
      torsoLength: 0.3, heightPx: 800,
    },
  };
  if (weightKg != null) scan.weightKg = weightKg;
  return scan;
}

describe('PrivacyVault', () => {
  it('encrypts and decrypts JSON round-trip after create', async () => {
    const vault = PrivacyVault.getInstance();
    await vault.create('correct horse battery staple');
    const payload = { hello: 'world', n: 42 };
    const env = await vault.encryptJSON(payload);
    expect(env.data).not.toContain('world');
    const back = await vault.decryptJSON<typeof payload>(env);
    expect(back).toEqual(payload);
  });

  it('unlocks with the passphrase and decrypts the same data', async () => {
    const vault = PrivacyVault.getInstance();
    const { keyStore } = await vault.create('right-pass-123');
    const env = await vault.encryptJSON({ v: 1 });
    vault.lock();
    expect(await vault.unlockWithPassphrase('right-pass-123', keyStore)).toBe(true);
    expect(await vault.decryptJSON<{ v: number }>(env)).toEqual({ v: 1 });
  });

  it('rejects a wrong passphrase on unlock', async () => {
    const vault = PrivacyVault.getInstance();
    const { keyStore } = await vault.create('right-pass-123');
    vault.lock();
    expect(await vault.unlockWithPassphrase('wrong-pass-999', keyStore)).toBe(false);
    expect(vault.isUnlocked()).toBe(false);
  });

  it('unlocks with the recovery code', async () => {
    const vault = PrivacyVault.getInstance();
    const { keyStore, recoveryCode } = await vault.create('pass-abc-123');
    const env = await vault.encryptJSON({ secret: 7 });
    vault.lock();
    expect(await vault.unlockWithRecoveryCode(recoveryCode, keyStore)).toBe(true);
    expect(await vault.decryptJSON<{ secret: number }>(env)).toEqual({ secret: 7 });
  });

  it('recovery code is tolerant of formatting (dashes / case)', async () => {
    const vault = PrivacyVault.getInstance();
    const { keyStore, recoveryCode } = await vault.create('pass-abc-123');
    vault.lock();
    const messy = recoveryCode.replace(/-/g, '').toLowerCase();
    expect(await vault.unlockWithRecoveryCode(messy, keyStore)).toBe(true);
  });

  it('changes the passphrase without re-encrypting data; old fails, new works', async () => {
    const vault = PrivacyVault.getInstance();
    const { keyStore } = await vault.create('old-pass-1234');
    const env = await vault.encryptJSON({ keep: 'me' });
    const updated = await vault.changePassphrase('new-pass-5678', keyStore);
    vault.lock();
    // Old passphrase no longer works.
    expect(await vault.unlockWithPassphrase('old-pass-1234', updated)).toBe(false);
    // New passphrase works and decrypts pre-existing data.
    expect(await vault.unlockWithPassphrase('new-pass-5678', updated)).toBe(true);
    expect(await vault.decryptJSON<{ keep: string }>(env)).toEqual({ keep: 'me' });
  });

  it('recovery code still works after a passphrase change', async () => {
    const vault = PrivacyVault.getInstance();
    const { keyStore, recoveryCode } = await vault.create('old-pass-1234');
    const updated = await vault.changePassphrase('new-pass-5678', keyStore);
    vault.lock();
    expect(await vault.unlockWithRecoveryCode(recoveryCode, updated)).toBe(true);
  });

  it('fails to decrypt tampered ciphertext (AES-GCM auth)', async () => {
    const vault = PrivacyVault.getInstance();
    await vault.create('a-passphrase-here');
    const env = await vault.encryptJSON({ secret: true });
    const tampered = { ...env, data: env.data.slice(0, -2) + (env.data.endsWith('A') ? 'B' : 'A') + '=' };
    await expect(vault.decryptJSON(tampered)).rejects.toBeDefined();
  });

  it('throws when encrypting while locked', async () => {
    const vault = PrivacyVault.getInstance();
    vault.lock();
    await expect(vault.encryptJSON({ x: 1 })).rejects.toThrow(/locked/i);
  });

  it('encrypts and decrypts Classified body scans round-trip (Req 1.2)', async () => {
    const vault = PrivacyVault.getInstance();
    await vault.create('body-scan-passphrase');
    const scans = [fakeScan('s1', 82.5), fakeScan('s2')];
    // Body scans must be classify()'d before they can reach the vault.
    const env = await vault.encryptBodyScans(classify(scans));
    // Envelope carries no plaintext (no weight, no scan id in the ciphertext).
    expect(env.data).not.toContain('82.5');
    expect(env.data).not.toContain('s1');
    const back = await vault.decryptBodyScans(env);
    expect(declassifyForDevice(back)).toEqual(scans);
  });

  it('encryptBodyScans throws while the vault is locked (Req 1.4)', async () => {
    const vault = PrivacyVault.getInstance();
    vault.lock();
    await expect(vault.encryptBodyScans(classify([fakeScan('x')]))).rejects.toThrow(/locked/i);
  });

  // Locked-vault contract (Req 1.4): while locked, EVERY encrypt/decrypt entry
  // point rejects; after unlock, each succeeds. The guard is enforced in one
  // place (requireUnlocked) so no path can drift.
  describe('locked-vault contract (Req 1.4)', () => {
    it('decryptJSON throws while the vault is locked', async () => {
      const vault = PrivacyVault.getInstance();
      // Produce a valid envelope while unlocked, then lock and attempt decrypt.
      await vault.create('decrypt-locked-pass');
      const env = await vault.encryptJSON({ a: 1 });
      vault.lock();
      await expect(vault.decryptJSON(env)).rejects.toThrow(/locked/i);
    });

    it('decryptBodyScans throws while the vault is locked', async () => {
      const vault = PrivacyVault.getInstance();
      const scans = [fakeScan('bs', 70)];
      await vault.create('decrypt-body-locked-pass');
      const env = await vault.encryptBodyScans(classify(scans));
      vault.lock();
      await expect(vault.decryptBodyScans(env)).rejects.toThrow(/locked/i);
    });

    it('every entry point rejects while locked, then succeeds after unlock', async () => {
      const vault = PrivacyVault.getInstance();
      const { keyStore } = await vault.create('roundtrip-locked-pass');
      // Capture envelopes while unlocked for the decrypt paths.
      const jsonEnv = await vault.encryptJSON({ n: 5 });
      const scans = [fakeScan('r1', 61)];
      const scanEnv = await vault.encryptBodyScans(classify(scans));

      // Locked: all four entry points reject.
      vault.lock();
      await expect(vault.encryptJSON({ n: 5 })).rejects.toThrow(/locked/i);
      await expect(vault.decryptJSON(jsonEnv)).rejects.toThrow(/locked/i);
      await expect(vault.encryptBodyScans(classify(scans))).rejects.toThrow(/locked/i);
      await expect(vault.decryptBodyScans(scanEnv)).rejects.toThrow(/locked/i);

      // Unlocked: all four succeed.
      expect(await vault.unlockWithPassphrase('roundtrip-locked-pass', keyStore)).toBe(true);
      const reJson = await vault.encryptJSON({ n: 5 });
      expect(await vault.decryptJSON<{ n: number }>(reJson)).toEqual({ n: 5 });
      const reScanEnv = await vault.encryptBodyScans(classify(scans));
      expect(declassifyForDevice(await vault.decryptBodyScans(reScanEnv))).toEqual(scans);
    });
  });

  it('generates formatted recovery codes with expected shape', () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(normalizeRecoveryCode(code)).toHaveLength(16);
    // No ambiguous characters.
    expect(normalizeRecoveryCode(code)).not.toMatch(/[O0I1L]/);
  });
});

describe('PrivacyManager — consent', () => {
  it('starts with no consent', () => {
    const m = PrivacyManager.getInstance();
    expect(m.hasConsent()).toBe(false);
  });

  it('grants and reports consent for the current notice version', () => {
    const m = PrivacyManager.getInstance();
    m.grantConsent();
    expect(m.hasConsent()).toBe(true);
    expect(m.getConsent()?.noticeVersion).toBe(PRIVACY_NOTICE_VERSION);
  });

  it('withdraws consent', () => {
    const m = PrivacyManager.getInstance();
    m.grantConsent();
    m.withdrawConsent();
    expect(m.hasConsent()).toBe(false);
  });
});

describe('PrivacyManager — encrypted scan store', () => {
  it('saves and loads encrypted scans (including weight)', async () => {
    const m = PrivacyManager.getInstance();
    await m.createVault('vault-pass-1234');
    const scans = [fakeScan('a', 80.5), fakeScan('b')];
    await m.saveScans(scans);

    // Raw storage must be encrypted (no plaintext id / weight visible).
    const raw = localStorage.getItem('gym-coach-body-scans-enc') ?? '';
    expect(raw).not.toContain('80.5');
    expect(raw).not.toContain('"id":"a"');

    const loaded = await m.loadScans();
    expect(loaded).toHaveLength(2);
    expect(loaded[0]?.weightKg).toBe(80.5);
    expect(loaded[1]?.weightKg).toBeUndefined();
  });

  it('migrates legacy plaintext scans into the vault and removes the plaintext', async () => {
    // Seed legacy plaintext.
    localStorage.setItem('gym-coach-body-scans', JSON.stringify([fakeScan('legacy', 75)]));
    const m = PrivacyManager.getInstance();
    await m.createVault('migrate-pass-1');
    // Legacy plaintext must be gone.
    expect(localStorage.getItem('gym-coach-body-scans')).toBeNull();
    // Data must be readable from the encrypted store.
    const loaded = await m.loadScans();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe('legacy');
    expect(loaded[0]?.weightKg).toBe(75);
  });

  it('cannot read scans after re-lock, but can after unlock with the passphrase', async () => {
    const m = PrivacyManager.getInstance();
    await m.createVault('relock-pass-1');
    await m.saveScans([fakeScan('x', 90)]);
    m.lock();
    await expect(m.loadScans()).rejects.toThrow(/locked/i);
    const ok = await m.unlockVault('relock-pass-1');
    expect(ok).toBe(true);
    const loaded = await m.loadScans();
    expect(loaded[0]?.weightKg).toBe(90);
  });

  it('rejects unlock with the wrong passphrase', async () => {
    const m = PrivacyManager.getInstance();
    await m.createVault('the-real-pass');
    m.lock();
    expect(await m.unlockVault('not-the-pass')).toBe(false);
  });
});

describe('PrivacyManager — account recovery & passphrase change', () => {
  it('createVault returns a recovery code and logs in with it', async () => {
    const m = PrivacyManager.getInstance();
    const code = await m.createVault('signup-pass-1');
    expect(typeof code).toBe('string');
    expect(code.length).toBeGreaterThan(10);
    await m.saveScans([fakeScan('r', 88)]);
    m.lock();
    // Recover using the code.
    expect(await m.recoverWithCode(code)).toBe(true);
    const loaded = await m.loadScans();
    expect(loaded[0]?.weightKg).toBe(88);
  });

  it('changes the passphrase; old fails, new works, data intact', async () => {
    const m = PrivacyManager.getInstance();
    await m.createVault('first-pass-1');
    await m.saveScans([fakeScan('c', 55)]);
    expect(await m.changePassphrase('second-pass-2')).toBe(true);
    m.lock();
    expect(await m.unlockVault('first-pass-1')).toBe(false);
    expect(await m.unlockVault('second-pass-2')).toBe(true);
    const loaded = await m.loadScans();
    expect(loaded[0]?.weightKg).toBe(55);
  });

  it('recovery code survives a passphrase change', async () => {
    const m = PrivacyManager.getInstance();
    const code = await m.createVault('orig-pass-1');
    await m.saveScans([fakeScan('s', 77)]);
    await m.changePassphrase('changed-pass-2');
    m.lock();
    expect(await m.recoverWithCode(code)).toBe(true);
    const loaded = await m.loadScans();
    expect(loaded[0]?.weightKg).toBe(77);
  });

  it('rejects an invalid recovery code', async () => {
    const m = PrivacyManager.getInstance();
    await m.createVault('some-pass-1');
    m.lock();
    expect(await m.recoverWithCode('AAAA-BBBB-CCCC-DDDD')).toBe(false);
  });
});

describe('PrivacyManager — data rights', () => {
  it('exports all data as a portable JSON object', async () => {
    const m = PrivacyManager.getInstance();
    m.grantConsent();
    await m.createVault('export-pass-1');
    await m.saveScans([fakeScan('e', 70)]);
    localStorage.setItem('gym-coach-body-ref', 'iphone15promax');

    const dump = await m.exportAll();
    expect(dump['format']).toBe('gym-coach-data-export');
    expect(Array.isArray(dump['bodyScans'])).toBe(true);
    expect((dump['bodyScans'] as BodyScan[])[0]?.weightKg).toBe(70);
    // Benign preference included; secrets/blobs excluded.
    const prefs = dump['preferences'] as Record<string, string>;
    expect(prefs['gym-coach-body-ref']).toBe('iphone15promax');
    expect(prefs['gym-coach-body-scans-enc']).toBeUndefined();
    expect(prefs['gym-coach-privacy-keystore']).toBeUndefined();
  });

  it('erases everything (right to be forgotten)', async () => {
    const m = PrivacyManager.getInstance();
    m.grantConsent();
    await m.createVault('erase-pass-1');
    await m.saveScans([fakeScan('z', 60)]);
    localStorage.setItem('gym-coach-body-ref', 'pen');

    await m.eraseAll();

    expect(localStorage.getItem('gym-coach-body-scans-enc')).toBeNull();
    expect(localStorage.getItem('gym-coach-privacy-keystore')).toBeNull();
    expect(localStorage.getItem('gym-coach-privacy-consent')).toBeNull();
    expect(localStorage.getItem('gym-coach-body-ref')).toBeNull();
    expect(m.hasConsent()).toBe(false);
    expect(m.isUnlocked()).toBe(false);
    expect(m.isVaultInitialized()).toBe(false);
  });
});

describe('PrivacyManager — scoped erasure (Req 5.1, 5.2, 5.3)', () => {
  // Body_Data lives in these localStorage keys.
  const BODY_ENC = 'gym-coach-body-scans-enc';
  const BODY_REF = 'gym-coach-body-ref';
  const BODY_HEIGHT = 'gym-coach-height-cm';
  // Workout_Data lives in this localStorage key (bulk is in IndexedDB).
  const WORKOUT_SNAPSHOT = 'gym-coach-session-snapshot';

  it('erasing Body_Data removes body keys and retains Workout_Data (Req 5.1, 5.2)', async () => {
    const m = PrivacyManager.getInstance();
    await m.createVault('scoped-body-pass');
    await m.saveScans([fakeScan('body-1', 81)]); // writes BODY_ENC
    localStorage.setItem(BODY_REF, 'iphone15promax');
    localStorage.setItem(BODY_HEIGHT, '178');
    // Seed Workout_Data that must survive.
    localStorage.setItem(WORKOUT_SNAPSHOT, JSON.stringify({ setNumber: 2 }));

    m.eraseBodyData();

    // Body_Data gone.
    expect(localStorage.getItem(BODY_ENC)).toBeNull();
    expect(localStorage.getItem(BODY_REF)).toBeNull();
    expect(localStorage.getItem(BODY_HEIGHT)).toBeNull();
    // Workout_Data retained.
    expect(localStorage.getItem(WORKOUT_SNAPSHOT)).toBe(JSON.stringify({ setNumber: 2 }));
  });

  it('erasing Workout_Data removes workout keys and retains Body_Data (Req 5.3)', async () => {
    const m = PrivacyManager.getInstance();
    await m.createVault('scoped-workout-pass');
    await m.saveScans([fakeScan('body-2', 74)]); // writes BODY_ENC
    localStorage.setItem(BODY_REF, 'pixel8');
    localStorage.setItem(WORKOUT_SNAPSHOT, JSON.stringify({ setNumber: 3 }));

    await m.eraseWorkoutData();

    // Workout_Data gone.
    expect(localStorage.getItem(WORKOUT_SNAPSHOT)).toBeNull();
    // Body_Data retained and still decryptable.
    expect(localStorage.getItem(BODY_ENC)).not.toBeNull();
    expect(localStorage.getItem(BODY_REF)).toBe('pixel8');
    const loaded = await m.loadScans();
    expect(loaded[0]?.weightKg).toBe(74);
  });

  it('full erase clears both Body_Data and Workout_Data', async () => {
    const m = PrivacyManager.getInstance();
    await m.createVault('scoped-all-pass');
    await m.saveScans([fakeScan('body-3', 66)]);
    localStorage.setItem(BODY_REF, 'device');
    localStorage.setItem(BODY_HEIGHT, '180');
    localStorage.setItem(WORKOUT_SNAPSHOT, JSON.stringify({ setNumber: 1 }));

    await m.eraseAll();

    expect(localStorage.getItem(BODY_ENC)).toBeNull();
    expect(localStorage.getItem(BODY_REF)).toBeNull();
    expect(localStorage.getItem(BODY_HEIGHT)).toBeNull();
    expect(localStorage.getItem(WORKOUT_SNAPSHOT)).toBeNull();
    expect(m.isUnlocked()).toBe(false);
    expect(m.isVaultInitialized()).toBe(false);
  });
});

describe('PrivacyManager — cross-device reconstruction (Req 2.6, 2.7)', () => {
  /**
   * Simulate two devices sharing ONE persistence layer the way the real product
   * does: device A creates a vault + scans and produces the sync material
   * (blob + keyStore); device B is a fresh vault/lock that reconstructs from
   * that pulled material. Because PrivacyManager is a singleton keyed to the
   * in-memory localStorage mock, "device B" is modeled by wiping local state
   * (fresh device: no keystore, no scans, vault locked) and then reconstructing.
   */
  async function deviceAProducesSyncMaterial(
    passphrase: string,
  ): Promise<{ blob: string; keyStore: string; recoveryCode: string }> {
    const m = PrivacyManager.getInstance();
    const recoveryCode = await m.createVault(passphrase);
    await m.saveScans([fakeScan('sync-1', 81.5), fakeScan('sync-2')]);
    const blob = await m.buildSyncBlob();
    const keyStore = m.exportKeyStore();
    expect(keyStore).not.toBeNull();
    return { blob, keyStore: keyStore!, recoveryCode };
  }

  /** Wipe all local state → a pristine "new device" with a locked vault. */
  function freshDevice(): PrivacyManager {
    installMemoryLocalStorage();
    PrivacyVault.getInstance().lock();
    const m = PrivacyManager.getInstance();
    m.lock();
    expect(m.isVaultInitialized()).toBe(false);
    return m;
  }

  it('reconstructs on a new device with the correct passphrase (Req 2.6)', async () => {
    const { blob, keyStore } = await deviceAProducesSyncMaterial('device-a-pass-1');

    const m = freshDevice();
    const result = await m.reconstructFromSync({ blob, keyStore }, { kind: 'passphrase', passphrase: 'device-a-pass-1' });

    expect(result).toEqual({ ok: true, restored: 2 });
    expect(m.isUnlocked()).toBe(true);
    const loaded = await m.loadScans();
    expect(loaded).toHaveLength(2);
    expect(loaded[0]?.id).toBe('sync-1');
    expect(loaded[0]?.weightKg).toBe(81.5);
  });

  it('reconstructs on a new device with the recovery code (Req 2.6)', async () => {
    const { blob, keyStore, recoveryCode } = await deviceAProducesSyncMaterial('device-a-pass-2');

    const m = freshDevice();
    const result = await m.reconstructFromSync({ blob, keyStore }, { kind: 'recovery', recoveryCode });

    expect(result).toEqual({ ok: true, restored: 2 });
    const loaded = await m.loadScans();
    expect(loaded).toHaveLength(2);
    expect(loaded[1]?.id).toBe('sync-2');
  });

  it('reports bad-credential for a wrong passphrase and does not populate local scans (Req 2.7)', async () => {
    const { blob, keyStore } = await deviceAProducesSyncMaterial('device-a-pass-3');

    const m = freshDevice();
    const result = await m.reconstructFromSync({ blob, keyStore }, { kind: 'passphrase', passphrase: 'wrong-pass-000' });

    expect(result).toEqual({ ok: false, reason: 'bad-credential' });
    // Vault stayed locked; no scans were written to the local store.
    expect(m.isUnlocked()).toBe(false);
    expect(localStorage.getItem('gym-coach-body-scans-enc')).toBeNull();
  });

  it('reports bad-credential for a wrong recovery code and leaves local data untouched (Req 2.7)', async () => {
    const { blob, keyStore } = await deviceAProducesSyncMaterial('device-a-pass-4');

    const m = freshDevice();
    const result = await m.reconstructFromSync({ blob, keyStore }, { kind: 'recovery', recoveryCode: 'AAAA-BBBB-CCCC-DDDD' });

    expect(result).toEqual({ ok: false, reason: 'bad-credential' });
    expect(m.isUnlocked()).toBe(false);
    expect(localStorage.getItem('gym-coach-body-scans-enc')).toBeNull();
  });

  it('reports decrypt-failed for a corrupted blob and leaves local data unchanged (Req 2.7)', async () => {
    const { blob, keyStore } = await deviceAProducesSyncMaterial('device-a-pass-5');

    // Corrupt the ciphertext so the AES-GCM auth tag fails, while keeping valid
    // envelope JSON so the failure is at decrypt time (not JSON parse).
    const env = JSON.parse(blob) as EncryptedEnvelope;
    const corruptedData = env.data.slice(0, -2) + (env.data.endsWith('A') ? 'B' : 'A') + '=';
    const corruptedBlob = JSON.stringify({ ...env, data: corruptedData });

    const m = freshDevice();
    const result = await m.reconstructFromSync({ blob: corruptedBlob, keyStore }, { kind: 'passphrase', passphrase: 'device-a-pass-5' });

    expect(result).toEqual({ ok: false, reason: 'decrypt-failed' });
    // The credential unlocked the vault, but no scans were persisted from the
    // failed blob: the local store stays empty (decrypt fails before saveScans).
    const loaded = await m.loadScans();
    expect(loaded).toHaveLength(0);
    expect(localStorage.getItem('gym-coach-body-scans-enc')).toBeNull();
  });
});
