/**
 * @vitest-environment jsdom
 *
 * Two-secrets separation guard for AuthClient (Requirement 4.1).
 *
 * These tests assert the structural invariant that keeps the Account_Password
 * (server auth) independent from the Encryption_Passphrase (device-only vault):
 *
 *   1. AuthClient's source does NOT import PrivacyVault and never references the
 *      passphrase, recovery code, or master key.
 *   2. A successful login persists ONLY a session token + the non-secret user
 *      profile — never the password or any key material.
 *   3. logout clears the session token and user, leaving nothing behind.
 *   4. login / logout / verifyEmail / resetPassword hit the server endpoints and
 *      surface the server's result, without touching vault key material.
 *
 * Validates: Requirements 4.1
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AuthClient } from './AuthClient.js';

const SESSION_KEY = 'gym-coach-account-session';
const USER_KEY = 'gym-coach-account-user';

// jsdom's localStorage can be incomplete; install a deterministic in-memory one.
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

/** Read the AuthClient source (vitest runs from the project root). */
function readAuthClientSource(): string {
  return readFileSync(resolve(process.cwd(), 'src/account/AuthClient.ts'), 'utf8');
}

/** Install a fetch stub that records calls and returns a scripted response. */
function stubFetch(response: { status: number; body: unknown }): Array<{ url: string; init: RequestInit }> {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fake = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      status: response.status,
      json: async () => response.body,
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fake);
  return calls;
}

beforeEach(() => {
  installMemoryLocalStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AuthClient two-secrets separation (Req 4.1)', () => {
  it('source does not import PrivacyVault or reference vault key material', () => {
    // Strip block and line comments first so the invariant prose in the header
    // (which necessarily *names* PrivacyVault to describe the rule) doesn't trip
    // the guard. All assertions run against the executable code only.
    const codeOnly = readAuthClientSource()
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    // No import of the vault module — even indirectly.
    expect(codeOnly).not.toMatch(/import[^;]*PrivacyVault/);
    expect(codeOnly).not.toMatch(/from\s+['"][^'"]*PrivacyVault[^'"]*['"]/);

    // No reference to vault crypto identifiers in the code body.
    for (const forbidden of [
      'masterKey', 'MasterKey', 'MASTER_KEY',
      'recoveryCode', 'RecoveryCode',
      'unlockWithPassphrase', 'unlockWithRecoveryCode',
      'encryptJSON', 'decryptJSON', 'VaultKeyStore', 'WrappedKey',
    ]) {
      expect(codeOnly).not.toContain(forbidden);
    }
  });

  it('login persists only the session token and the non-secret user profile', async () => {
    const user = { id: 'u1', username: 'sam', email: 's@x.dev', emailVerified: true };
    const calls = stubFetch({ status: 200, body: { session: 'tok-abc', user } });

    const client = new AuthClient();
    const result = await client.login('sam', 'hunter2-account-password');

    expect(result.ok).toBe(true);
    expect(client.isLoggedIn()).toBe(true);
    expect(client.getSession()).toBe('tok-abc');
    expect(client.currentUser()).toEqual(user);

    // Only the session token and user profile are persisted.
    expect(localStorage.getItem(SESSION_KEY)).toBe('tok-abc');
    expect(localStorage.getItem(USER_KEY)).toBe(JSON.stringify(user));

    // The Account_Password is never persisted anywhere.
    const persisted = [localStorage.getItem(SESSION_KEY), localStorage.getItem(USER_KEY)].join('\n');
    expect(persisted).not.toContain('hunter2-account-password');

    // The password went to the server login endpoint (server auth only)...
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/auth\/login$/);
    expect(String(calls[0]!.init.body)).toContain('hunter2-account-password');

    // ...and nothing key-material-shaped is exposed on the client surface.
    const surface = client as unknown as Record<string, unknown>;
    for (const key of Object.keys(surface)) {
      expect(key).not.toMatch(/master|passphrase|recovery|key/i);
    }
  });

  it('logout clears the session token and user, leaving nothing behind', async () => {
    const user = { id: 'u1', username: 'sam', email: 's@x.dev', emailVerified: true };
    stubFetch({ status: 200, body: { session: 'tok-abc', user } });

    const client = new AuthClient();
    await client.login('sam', 'pw');
    expect(client.isLoggedIn()).toBe(true);

    // logout also POSTs to the server; the stub answers 200 for the logout call.
    await client.logout();

    expect(client.isLoggedIn()).toBe(false);
    expect(client.getSession()).toBeNull();
    expect(client.currentUser()).toBeNull();
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(localStorage.getItem(USER_KEY)).toBeNull();
  });

  it('verifyEmail and resetPassword flow through the server without storing key material', async () => {
    // verifyEmail
    const verifyCalls = stubFetch({ status: 200, body: {} });
    const client = new AuthClient();
    const verify = await client.verifyEmail('verify-token');
    expect(verify.ok).toBe(true);
    expect(verifyCalls[0]!.url).toMatch(/\/auth\/verify-email$/);
    vi.unstubAllGlobals();

    // resetPassword restores server access only — no session/key is stored.
    const resetCalls = stubFetch({ status: 200, body: {} });
    const reset = await client.resetPassword('reset-token', 'brand-new-account-password');
    expect(reset.ok).toBe(true);
    expect(resetCalls[0]!.url).toMatch(/\/auth\/reset-password$/);

    // A password reset does NOT log the user in or persist any credential.
    expect(client.isLoggedIn()).toBe(false);
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
  });
});
