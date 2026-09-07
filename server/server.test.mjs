/**
 * Server auth/crypto/db unit tests using Node's built-in test runner.
 * Run with: node --test server/
 *
 * These use node:sqlite and node:crypto directly, so they run under plain Node
 * rather than vitest (which cannot resolve node: builtins through its bundler).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from './db.mjs';
import {
  hashPassword, verifyPassword, generateToken, hashToken,
  signSession, verifySessionSignature, randomId,
} from './auth.mjs';

test('hashes and verifies a password (constant-time, never plaintext)', () => {
  const stored = hashPassword('supersecret1');
  assert.ok(stored.includes(':'));
  assert.ok(!stored.includes('supersecret1'));
  assert.equal(verifyPassword('supersecret1', stored), true);
  assert.equal(verifyPassword('wrongpass', stored), false);
});

test('same password yields different hashes (random salt)', () => {
  assert.notEqual(hashPassword('samepass1'), hashPassword('samepass1'));
});

test('token: stored hash matches hashToken(raw), raw is not the hash', () => {
  const { raw, hash } = generateToken();
  assert.equal(raw.length, 64);
  assert.equal(hashToken(raw), hash);
  assert.notEqual(hash, raw);
});

test('session signing verifies and rejects tampering', () => {
  const secret = 'test-secret';
  const id = randomId();
  const token = signSession(id, secret);
  assert.equal(verifySessionSignature(token, secret), id);
  assert.equal(verifySessionSignature(token, 'wrong-secret'), null);
  assert.equal(verifySessionSignature(token + 'x', secret), null);
  assert.equal(verifySessionSignature('garbage', secret), null);
});

test('DB: create and find user by username, email, id', () => {
  const db = new Db(':memory:');
  const u = { id: randomId(), username: 'kawa', email: 'k@ex.com', password_hash: hashPassword('pw12345678'), email_verified: 0, created_at: Date.now() };
  db.createUser(u);
  assert.equal(db.findUserByUsername('kawa').email, 'k@ex.com');
  assert.equal(db.findUserByEmail('k@ex.com').username, 'kawa');
  assert.equal(db.findUserByIdentifier('kawa').id, u.id);
  assert.equal(db.findUserByIdentifier('k@ex.com').id, u.id);
  assert.equal(db.findUserById(u.id).username, 'kawa');
  db.close();
});

test('DB: opaque blob round-trips and upsert replaces', () => {
  const db = new Db(':memory:');
  const uid = randomId();
  db.createUser({ id: uid, username: 'a', email: 'a@ex.com', password_hash: 'x:y', email_verified: 1, created_at: Date.now() });
  db.upsertBlob(uid, 'CIPHERTEXT_OPAQUE', 'WRAPPED_KEYS', 123);
  let row = db.getBlob(uid);
  assert.equal(row.blob, 'CIPHERTEXT_OPAQUE');
  assert.equal(row.key_store, 'WRAPPED_KEYS');
  db.upsertBlob(uid, 'NEW_CIPHER', 'NEW_KEYS', 456);
  assert.equal(db.getBlob(uid).blob, 'NEW_CIPHER');
  db.close();
});

test('DB: at most one redeemable token per kind; delete on redeem', () => {
  const db = new Db(':memory:');
  const uid = randomId();
  db.createUser({ id: uid, username: 'b', email: 'b@ex.com', password_hash: 'x:y', email_verified: 0, created_at: Date.now() });
  db.insertToken({ token_hash: 'h1', user_id: uid, kind: 'reset', expires_at: Date.now() + 1000 });
  db.insertToken({ token_hash: 'h2', user_id: uid, kind: 'reset', expires_at: Date.now() + 1000 });
  assert.equal(db.findToken('h1'), undefined);
  assert.equal(db.findToken('h2').user_id, uid);
  db.deleteToken('h2');
  assert.equal(db.findToken('h2'), undefined);
  db.close();
});

test('DB: erasure removes user, tokens, sessions, blob (GDPR)', () => {
  const db = new Db(':memory:');
  const uid = randomId();
  db.createUser({ id: uid, username: 'c', email: 'c@ex.com', password_hash: 'x:y', email_verified: 1, created_at: Date.now() });
  db.insertToken({ token_hash: 'ht', user_id: uid, kind: 'verify', expires_at: Date.now() + 1000 });
  db.insertSession('sess1', uid, Date.now() + 1000);
  db.upsertBlob(uid, 'C', 'K', 1);
  db.deleteUser(uid);
  assert.equal(db.findUserById(uid), undefined);
  assert.equal(db.findToken('ht'), undefined);
  assert.equal(db.findSession('sess1'), undefined);
  assert.equal(db.getBlob(uid), undefined);
  db.close();
});

test('DB: session lookup and revocation', () => {
  const db = new Db(':memory:');
  const uid = randomId();
  db.insertSession('s1', uid, Date.now() + 5000);
  assert.equal(db.findSession('s1').user_id, uid);
  db.deleteSession('s1');
  assert.equal(db.findSession('s1'), undefined);
  db.close();
});
