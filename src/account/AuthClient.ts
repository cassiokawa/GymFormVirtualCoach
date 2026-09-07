/**
 * AuthClient — talks to the zero-knowledge Sync_Server for account operations.
 *
 * ## Two-secrets invariant (Requirement 4.1)
 *
 * This client lives entirely on the *server-authentication* side of the
 * two-secrets model. It knows about exactly one secret — the **Account_Password**
 * — and treats it as an opaque login credential:
 *
 *   - The Account_Password is sent to the Sync_Server ONLY, over the `/auth/*`
 *     endpoints, to establish or restore a server session. It authenticates
 *     identity; it never decrypts anything.
 *   - The **session token** returned by a successful login is the SOLE
 *     client-held server credential. It (plus the non-secret {@link AccountUser}
 *     profile) is the only thing this client persists. No password is ever
 *     stored, in memory or on disk, after a request completes.
 *   - The Account_Password is NEVER used to derive or unwrap the vault
 *     Master_Key. That is the job of the device-only Encryption_Passphrase (and
 *     Recovery_Code), which live in `PrivacyVault`. AuthClient does not import
 *     `PrivacyVault`, does not reference the passphrase, recovery code, or master
 *     key, and has no path to key material.
 *
 * Consequence: resetting the Account_Password (see {@link AuthClient.forgotPassword}
 * / {@link AuthClient.resetPassword}) restores *server access* but grants no
 * ability to decrypt Body_Data or Workout_Data. The two secrets are independent
 * by construction, not by convention.
 *
 * The guard test `AuthClient.twoSecrets.test.ts` asserts this separation at the
 * module level (no `PrivacyVault` import, only a session token is persisted, no
 * key material is exposed).
 */

const SESSION_KEY = 'gym-coach-account-session';
const USER_KEY = 'gym-coach-account-user';

/**
 * Non-secret account profile returned by the server. Holds identity fields
 * only — no credential, no key material.
 */
export interface AccountUser {
  id: string;
  username: string;
  email: string;
  emailVerified: boolean;
}

/**
 * The opaque bearer token the Sync_Server issues on successful login. This is
 * the only server credential the client retains; it carries no key material and
 * cannot decrypt vault data. Modeled as its own type to make the "sole
 * client-held server credential" invariant (Req 4.1) explicit in the API.
 */
export type SessionToken = string;

export interface AuthResult {
  ok: boolean;
  error?: string;
  user?: AccountUser;
}

/**
 * Base URL of the sync server. The client talks to the server directly (the
 * server sends CORS headers for the app origin), rather than via a dev proxy —
 * Vite 8's proxy stalls on this endpoint. Override with VITE_SYNC_API for
 * production or a different host/port.
 */
const _env = (import.meta as unknown as { env?: Record<string, string> }).env;
export const SYNC_API_BASE = _env?.['VITE_SYNC_API'] ?? 'http://localhost:8787';

export class AuthClient {
  /** The sole client-held server credential (Req 4.1). Null when logged out. */
  private session: SessionToken | null = null;
  /** Non-secret profile of the logged-in user. Null when logged out. */
  private user: AccountUser | null = null;

  constructor() {
    this.session = localStorage.getItem(SESSION_KEY);
    const rawUser = localStorage.getItem(USER_KEY);
    if (rawUser) {
      try { this.user = JSON.parse(rawUser) as AccountUser; } catch { this.user = null; }
    }
  }

  isLoggedIn(): boolean {
    return this.session !== null;
  }

  currentUser(): AccountUser | null {
    return this.user;
  }

  /**
   * Session token for authenticated requests (used by SyncClient). This is the
   * only server credential exposed by the client; it is not key material and
   * cannot unwrap the vault Master_Key (Req 4.1).
   */
  getSession(): SessionToken | null {
    return this.session;
  }

  private async post(path: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
    let res: Response;
    try {
      res = await fetch(`${SYNC_API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      return { status: 0, data: { error: 'Cannot reach the sync server. Is it running?' } };
    }
    let data: Record<string, unknown> = {};
    try { data = (await res.json()) as Record<string, unknown>; } catch { /* empty */ }
    return { status: res.status, data };
  }

  /**
   * Register a new account. The Account_Password is sent to the Sync_Server for
   * credential creation only; it is not retained and never touches the vault.
   */
  async register(email: string, password: string): Promise<AuthResult> {
    const { status, data } = await this.post('/auth/register', { email, password });
    if (status === 201) return { ok: true };
    return { ok: false, error: (data['error'] as string) ?? 'Registration failed.' };
  }

  /**
   * Authenticate against the Sync_Server. On success the server returns a
   * session token and the non-secret user profile — those are the only values
   * persisted. The Account_Password is discarded once the request completes and
   * is never used to derive or unwrap the Master_Key (Req 4.1).
   */
  async login(identifier: string, password: string): Promise<AuthResult> {
    const { status, data } = await this.post('/auth/login', { identifier, password });
    if (status === 200 && typeof data['session'] === 'string') {
      this.session = data['session'] as SessionToken;
      this.user = data['user'] as AccountUser;
      localStorage.setItem(SESSION_KEY, this.session);
      localStorage.setItem(USER_KEY, JSON.stringify(this.user));
      return { ok: true, user: this.user };
    }
    return { ok: false, error: (data['error'] as string) ?? 'Login failed.' };
  }

  /**
   * End the server session and clear the sole client-held credential. Clears
   * only the session token and user profile; there is no key material to wipe
   * here (the vault manages its own lock/lifecycle independently).
   */
  async logout(): Promise<void> {
    if (this.session) {
      await this.post('/auth/logout', {}).catch(() => { /* best effort */ });
    }
    this.session = null;
    this.user = null;
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(USER_KEY);
  }

  /** Confirm an email-verification token with the server. No secret involved. */
  async verifyEmail(token: string): Promise<AuthResult> {
    const { status, data } = await this.post('/auth/verify-email', { token });
    return status === 200 ? { ok: true } : { ok: false, error: (data['error'] as string) ?? 'Verification failed.' };
  }

  /** Request a password-reset email from the server. No secret involved. */
  async forgotPassword(email: string): Promise<AuthResult> {
    const { status, data } = await this.post('/auth/forgot-password', { email });
    return status === 200 ? { ok: true } : { ok: false, error: (data['error'] as string) ?? 'Request failed.' };
  }

  /**
   * Set a new Account_Password via a reset token. This restores server access
   * only — it re-establishes the login credential and grants no ability to
   * decrypt vault data, which remains gated behind the device-only
   * Encryption_Passphrase / Recovery_Code (Req 4.1).
   */
  async resetPassword(token: string, password: string): Promise<AuthResult> {
    const { status, data } = await this.post('/auth/reset-password', { token, password });
    return status === 200 ? { ok: true } : { ok: false, error: (data['error'] as string) ?? 'Reset failed.' };
  }
}
