/**
 * Database layer for the zero-knowledge sync server.
 *
 * Uses Node's built-in node:sqlite (no external dependency). Stores accounts,
 * email tokens, sessions, and the opaque encrypted vault blob. The server can
 * authenticate users and store their data but can NEVER read the plaintext:
 * the blob is AES-GCM ciphertext produced client-side.
 *
 * -------------------------------------------------------------------------
 * ZERO-KNOWLEDGE STORAGE CONTRACT (spec 06, Req 2.4 / 2.5)
 * -------------------------------------------------------------------------
 * What the server stores, and how each column is classified:
 *
 *   vault_blobs.blob       opaque-ciphertext  Encrypted_Envelope: AES-GCM
 *                                             ciphertext + IV, serialized
 *                                             client-side. Opaque to the server.
 *   vault_blobs.key_store  opaque-ciphertext  Wrapped_Key_Metadata: the
 *                                             Master_Key wrapped independently by
 *                                             the Encryption_Passphrase and by the
 *                                             Recovery_Code. Unwrappable ONLY with a
 *                                             device-only secret the server never sees.
 *   users.email            PII                the ONLY personally identifiable
 *                                             information the server holds.
 *   users.username         PII                mirrors email (identity is the email;
 *                                             see server.mjs register). Same PII, not
 *                                             a second data class.
 *   users.password_hash    auth-hash          scrypt "salt:hash" for account auth
 *                                             ONLY. This authenticates to the server;
 *                                             it is NOT vault key material and can
 *                                             never unwrap the Master_Key.
 *   users.id               non-sensitive      opaque random UUID.
 *   users.email_verified   non-sensitive      boolean flag.
 *   users.created_at       non-sensitive      epoch ms.
 *   tokens.token_hash      non-sensitive      SHA-256 of an email verify/reset
 *                                             token; not vault material.
 *   tokens.{user_id,kind,expires_at}  non-sensitive.
 *   sessions.{id,user_id,expires_at}  non-sensitive  server session records.
 *
 * The server has NO column and NO field for the Master_Key, the
 * Encryption_Passphrase, or the Recovery_Code. Those three secrets live only on
 * the client and are never transmitted here. A fully compromised server can read
 * an email address and hold ciphertext it cannot decrypt — nothing more.
 * A guarding test (server/zero-knowledge.test.mjs) asserts this contract.
 *
 * Row shapes:
 *   users        { id, username, email, password_hash, email_verified, created_at }
 *   tokens       { token_hash, user_id, kind ('verify'|'reset'), expires_at }
 *   sessions     { id, user_id, expires_at }
 *   vault_blobs  { user_id, blob, key_store, updated_at }
 */

import { DatabaseSync } from 'node:sqlite';

export class Db {
  /** @param {string} path SQLite file path (':memory:' for tests). */
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        email_verified INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tokens (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      -- Zero-knowledge blob store. 'blob' is the opaque Encrypted_Envelope and
      -- 'key_store' is the opaque Wrapped_Key_Metadata (see the header contract).
      -- Deliberately NO column for master key / passphrase / recovery code.
      CREATE TABLE IF NOT EXISTS vault_blobs (
        user_id TEXT PRIMARY KEY,
        blob TEXT NOT NULL,
        key_store TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  // --- users ---

  createUser(u) {
    this.db.prepare(
      'INSERT INTO users (id, username, email, password_hash, email_verified, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(u.id, u.username, u.email, u.password_hash, u.email_verified, u.created_at);
  }

  findUserByUsername(username) {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  }

  findUserByEmail(email) {
    return this.db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  }

  findUserByIdentifier(identifier) {
    return this.db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(identifier, identifier);
  }

  findUserById(id) {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }

  setEmailVerified(userId) {
    this.db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(userId);
  }

  setPasswordHash(userId, hash) {
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
  }

  deleteUser(userId) {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    this.db.prepare('DELETE FROM tokens WHERE user_id = ?').run(userId);
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    this.db.prepare('DELETE FROM vault_blobs WHERE user_id = ?').run(userId);
  }

  // --- tokens ---

  insertToken(t) {
    // At most one redeemable token per account per kind.
    this.db.prepare('DELETE FROM tokens WHERE user_id = ? AND kind = ?').run(t.user_id, t.kind);
    this.db.prepare(
      'INSERT INTO tokens (token_hash, user_id, kind, expires_at) VALUES (?, ?, ?, ?)',
    ).run(t.token_hash, t.user_id, t.kind, t.expires_at);
  }

  findToken(tokenHash) {
    return this.db.prepare('SELECT * FROM tokens WHERE token_hash = ?').get(tokenHash);
  }

  deleteToken(tokenHash) {
    this.db.prepare('DELETE FROM tokens WHERE token_hash = ?').run(tokenHash);
  }

  // --- sessions ---

  insertSession(id, userId, expiresAt) {
    this.db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(id, userId, expiresAt);
  }

  findSession(id) {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  }

  deleteSession(id) {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  // --- vault blobs (zero-knowledge) ---

  /**
   * Store the opaque ciphertext for a user. `blob` and `keyStore` are treated
   * as opaque strings and written verbatim: the server neither parses nor
   * inspects them. It never receives (and cannot derive) the Master_Key,
   * Encryption_Passphrase, or Recovery_Code. (Req 2.4)
   */
  upsertBlob(userId, blob, keyStore, updatedAt) {
    this.db.prepare(`
      INSERT INTO vault_blobs (user_id, blob, key_store, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET blob = excluded.blob, key_store = excluded.key_store, updated_at = excluded.updated_at
    `).run(userId, blob, keyStore, updatedAt);
  }

  getBlob(userId) {
    return this.db.prepare('SELECT * FROM vault_blobs WHERE user_id = ?').get(userId);
  }

  close() {
    this.db.close();
  }
}
