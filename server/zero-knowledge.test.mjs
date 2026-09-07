/**
 * Zero-knowledge storage contract tests (spec 06, Req 2.4 / 2.5).
 * Run with: node --test server/
 *
 * These guard the promise that the Sync_Server can only ever hold opaque
 * ciphertext plus one piece of PII (email). They assert, against an in-memory
 * DB so the tests are deterministic and self-contained:
 *
 *   - after a blob PUT, the stored row contains EXACTLY the opaque `blob` +
 *     `key_store` that were sent, and nothing resembling a passphrase, recovery
 *     code, or master key;
 *   - the `users` table has no key-material column and email is the only PII;
 *   - the `vault_blobs` schema has no key-material column.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from './db.mjs';
import { hashPassword, randomId } from './auth.mjs';

// Words that would betray leaked vault key material if they appeared in a
// column name or a stored value. Master_Key, Encryption_Passphrase, Recovery_Code.
const SECRET_WORDS = ['passphrase', 'recovery', 'master', 'masterkey', 'master_key', 'secret', 'plaintext'];

/** Column names for a table via sqlite's PRAGMA table_info. */
function columnNames(db, table) {
  return db.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

test('stored blob row contains exactly the opaque blob + key_store that were sent', () => {
  const db = new Db(':memory:');
  const uid = randomId();
  db.createUser({ id: uid, username: 'z@ex.com', email: 'z@ex.com', password_hash: hashPassword('pw12345678'), email_verified: 1, created_at: Date.now() });

  // Simulate the client-side ciphertext. These are opaque strings to the server.
  const envelope = JSON.stringify({ v: 1, iv: 'BASE64_IV', data: 'BASE64_AESGCM_CIPHERTEXT' });
  const keyStore = JSON.stringify({
    v: 1,
    byPassphrase: { salt: 'SALT_A', envelope: { v: 1, iv: 'IV_A', data: 'WRAPPED_A' } },
    byRecovery: { salt: 'SALT_B', envelope: { v: 1, iv: 'IV_B', data: 'WRAPPED_B' } },
  });

  db.upsertBlob(uid, envelope, keyStore, 999);
  const row = db.getBlob(uid);

  // Stored verbatim: exactly what was sent, byte for byte.
  assert.equal(row.blob, envelope);
  assert.equal(row.key_store, keyStore);

  // The row exposes only user_id, blob, key_store, updated_at — no extra field.
  assert.deepEqual(Object.keys(row).sort(), ['blob', 'key_store', 'updated_at', 'user_id']);

  // Nothing stored looks like a raw secret. The wrapped-key metadata legitimately
  // has "byPassphrase"/"byRecovery" structural keys, but those wrap only ciphertext
  // — the actual secrets are never present. Assert no plaintext secret leaked in.
  const cipherText = row.blob + row.key_store;
  assert.ok(!cipherText.includes('MY_PASSPHRASE'), 'blob must not contain a raw passphrase');
  assert.ok(!cipherText.includes('MY_RECOVERY_CODE'), 'blob must not contain a raw recovery code');
  assert.ok(!cipherText.includes('MASTER_KEY_BYTES'), 'blob must not contain raw master key bytes');
  db.close();
});

test('vault_blobs schema has no key-material column', () => {
  const db = new Db(':memory:');
  const cols = columnNames(db, 'vault_blobs');
  // The complete, intended shape — opaque ciphertext only.
  assert.deepEqual(cols.sort(), ['blob', 'key_store', 'updated_at', 'user_id']);
  for (const col of cols) {
    for (const word of SECRET_WORDS) {
      assert.ok(!col.toLowerCase().includes(word), `vault_blobs must not have a ${word} column (found "${col}")`);
    }
  }
  db.close();
});

test('users table stores email as the only PII and no key material', () => {
  const db = new Db(':memory:');
  const cols = columnNames(db, 'users');
  // Fixed shape: identity + auth hash + flags. No vault secrets.
  assert.deepEqual(cols.sort(), ['created_at', 'email', 'email_verified', 'id', 'password_hash', 'username']);

  // No column names a vault secret.
  for (const col of cols) {
    for (const word of SECRET_WORDS) {
      assert.ok(!col.toLowerCase().includes(word), `users must not have a ${word} column (found "${col}")`);
    }
  }

  // password_hash is an auth hash, not vault key material: it is a scrypt
  // "salt:hash" and never the plaintext password.
  const pw = 'correcthorse42';
  const stored = hashPassword(pw);
  assert.ok(stored.includes(':'));
  assert.ok(!stored.includes(pw), 'password hash must never contain the plaintext password');
  db.close();
});

test('a fully populated user + blob row exposes email as the only human-readable PII', () => {
  const db = new Db(':memory:');
  const uid = randomId();
  const email = 'reader@ex.com';
  db.createUser({ id: uid, username: email, email, password_hash: hashPassword('pw12345678'), email_verified: 1, created_at: Date.now() });
  db.upsertBlob(uid, 'OPAQUE_ENVELOPE', 'OPAQUE_KEYSTORE', 1);

  const user = db.findUserById(uid);
  // username mirrors email (same PII, not a second class); id/hash/flags are not PII.
  assert.equal(user.email, email);
  assert.equal(user.username, email);
  assert.notEqual(user.password_hash, 'pw12345678');

  // The blob store holds only opaque strings.
  const row = db.getBlob(uid);
  assert.equal(row.blob, 'OPAQUE_ENVELOPE');
  assert.equal(row.key_store, 'OPAQUE_KEYSTORE');
  db.close();
});
