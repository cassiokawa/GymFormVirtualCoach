/**
 * SyncClient — pushes/pulls the opaque encrypted vault blob to the server.
 *
 * The server never sees plaintext: PrivacyManager encrypts the payload with the
 * vault master key before it reaches here. The wrapped-key metadata (keyStore)
 * is uploaded alongside so a new device can reconstruct the vault after the user
 * supplies their passphrase or recovery code.
 */

import type { AuthClient } from './AuthClient.js';
import { SYNC_API_BASE } from './AuthClient.js';

export interface PulledBlob {
  blob: string | null;
  keyStore: string | null;
  updatedAt: number | null;
}

export class SyncClient {
  constructor(private auth: AuthClient) {}

  private authHeaders(): Record<string, string> {
    const session = this.auth.getSession();
    return session ? { Authorization: `Bearer ${session}` } : {};
  }

  /** Upload the encrypted blob + wrapped-key metadata. Requires login. */
  async push(blob: string, keyStore: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.auth.isLoggedIn()) return { ok: false, error: 'Not logged in.' };
    try {
      const res = await fetch(`${SYNC_API_BASE}/sync/blob`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify({ blob, keyStore }),
      });
      if (res.ok) return { ok: true };
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { ok: false, error: (data['error'] as string) ?? 'Sync upload failed.' };
    } catch {
      return { ok: false, error: 'Cannot reach the sync server.' };
    }
  }

  /** Download the encrypted blob + wrapped-key metadata. Requires login. */
  async pull(): Promise<{ ok: boolean; data?: PulledBlob; error?: string }> {
    if (!this.auth.isLoggedIn()) return { ok: false, error: 'Not logged in.' };
    try {
      const res = await fetch(`${SYNC_API_BASE}/sync/blob`, { headers: this.authHeaders() });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        return { ok: false, error: (data['error'] as string) ?? 'Sync download failed.' };
      }
      const data = (await res.json()) as PulledBlob;
      return { ok: true, data };
    } catch {
      return { ok: false, error: 'Cannot reach the sync server.' };
    }
  }

  /** Delete the server account and all its data (GDPR erasure). */
  async deleteAccount(): Promise<{ ok: boolean; error?: string }> {
    if (!this.auth.isLoggedIn()) return { ok: false, error: 'Not logged in.' };
    try {
      const res = await fetch(`${SYNC_API_BASE}/account`, { method: 'DELETE', headers: this.authHeaders() });
      return res.ok ? { ok: true } : { ok: false, error: 'Delete failed.' };
    } catch {
      return { ok: false, error: 'Cannot reach the sync server.' };
    }
  }
}
