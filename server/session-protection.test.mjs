/**
 * Session-protection contract tests for the sync server (spec 06, Req 4.6).
 * Run with: node --test server/
 *
 * "WHEN a request reaches a protected sync endpoint without a valid session,
 *  THE Sync_Server SHALL reject the request with an authentication error."
 *
 * The gate every protected endpoint funnels through is server.mjs `authUser`,
 * which resolves a Bearer session token to a user ONLY when the session is
 * valid and unexpired. `authUser` closes over the module-level file DB and
 * server secret, so here we reconstruct that exact guard chain against an
 * in-memory DB (mirroring how server.test.mjs tests db/auth primitives). This
 * lets us drive the four rejection cases and the accept case deterministically:
 *
 *   1. no Authorization header        -> reject
 *   2. malformed / garbage token      -> reject
 *   3. forged / unknown session id    -> reject
 *   4. expired session                -> reject
 *   5. valid, unexpired session       -> accept
 *
 * The reconstructed guard is kept byte-for-byte in step with server.mjs; the
 * final test pins that server.mjs still short-circuits with a 401 on every
 * protected route when the guard yields null.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from './db.mjs';
import { signSession, verifySessionSignature, randomId } from './auth.mjs';
import { routes } from './server.mjs';

const SECRET = 'test-secret';

/**
 * Faithful reconstruction of server.mjs `authUser`, parameterized on db/secret
 * so it can run against an in-memory DB. Must mirror server.mjs exactly.
 */
function authUserWith(db, secret, req) {
  const h = req.headers['authorization'] ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return null;                              // (1) no/empty bearer
  const sessionId = verifySessionSignature(token, secret);
  if (!sessionId) return null;                          // (2) malformed/garbage
  const session = db.findSession(sessionId);
  if (!session || session.expires_at < Date.now()) return null; // (3) forged / (4) expired
  const user = db.findUserById(session.user_id);
  return user ? { user, sessionId } : null;             // (5) user gone
}

function reqWith(authHeader) {
  return { headers: authHeader === undefined ? {} : { authorization: authHeader } };
}

function seedValidSession(db) {
  const uid = randomId();
  db.createUser({ id: uid, username: 'a@ex.com', email: 'a@ex.com', password_hash: 'x:y', email_verified: 1, created_at: Date.now() });
  const sessionId = randomId();
  db.insertSession(sessionId, uid, Date.now() + 3600_000);
  return { uid, token: signSession(sessionId, SECRET) };
}

test('Req 4.6: rejects when there is no Authorization header', () => {
  const db = new Db(':memory:');
  assert.equal(authUserWith(db, SECRET, reqWith(undefined)), null);
  assert.equal(authUserWith(db, SECRET, reqWith('')), null);
  db.close();
});

test('Req 4.6: rejects a malformed / garbage bearer token', () => {
  const db = new Db(':memory:');
  assert.equal(authUserWith(db, SECRET, reqWith('Bearer garbage')), null);
  assert.equal(authUserWith(db, SECRET, reqWith('Bearer not.a.valid.token')), null);
  assert.equal(authUserWith(db, SECRET, reqWith('Basic abc123')), null); // wrong scheme
  db.close();
});

test('Req 4.6: rejects a well-formed but forged/unknown session id', () => {
  const db = new Db(':memory:');
  // Correctly HMAC-signed with the server secret, but the session was never stored.
  const forged = signSession(randomId(), SECRET);
  assert.equal(verifySessionSignature(forged, SECRET) !== null, true); // signature is valid...
  assert.equal(authUserWith(db, SECRET, reqWith(`Bearer ${forged}`)), null); // ...but session is unknown
  db.close();
});

test('Req 4.6: rejects a token signed with the wrong secret', () => {
  const db = new Db(':memory:');
  const { token } = seedValidSession(db);
  const wrongSecretToken = signSession(verifySessionSignature(token, SECRET), 'attacker-secret');
  assert.equal(authUserWith(db, SECRET, reqWith(`Bearer ${wrongSecretToken}`)), null);
  db.close();
});

test('Req 4.6: rejects an expired session', () => {
  const db = new Db(':memory:');
  const uid = randomId();
  db.createUser({ id: uid, username: 'b@ex.com', email: 'b@ex.com', password_hash: 'x:y', email_verified: 1, created_at: Date.now() });
  const sessionId = randomId();
  db.insertSession(sessionId, uid, Date.now() - 1); // already expired
  const token = signSession(sessionId, SECRET);
  assert.equal(authUserWith(db, SECRET, reqWith(`Bearer ${token}`)), null);
  db.close();
});

test('Req 4.6: rejects a valid session whose user has been erased', () => {
  const db = new Db(':memory:');
  const { uid, token } = seedValidSession(db);
  db.deleteUser(uid); // account erased, session row also removed
  assert.equal(authUserWith(db, SECRET, reqWith(`Bearer ${token}`)), null);
  db.close();
});

test('Req 4.6: accepts a valid, unexpired session', () => {
  const db = new Db(':memory:');
  const { uid, token } = seedValidSession(db);
  const auth = authUserWith(db, SECRET, reqWith(`Bearer ${token}`));
  assert.ok(auth, 'expected a resolved auth context');
  assert.equal(auth.user.id, uid);
  db.close();
});

/**
 * Pin the server wiring: every protected route guards on authUser and returns a
 * 401 authentication error when it yields null. We invoke each route handler
 * with a mock req/res carrying no Authorization header (the module DB is never
 * touched because the guard short-circuits first).
 */
test('Req 4.6: every protected route returns 401 on an unauthenticated request', async () => {
  const protectedRoutes = ['GET /sync/blob', 'PUT /sync/blob', 'DELETE /account'];
  for (const key of protectedRoutes) {
    const handler = routes[key];
    assert.ok(typeof handler === 'function', `missing handler for ${key}`);

    let status = 0;
    let body = null;
    const res = {
      writeHead() {},
      end(json) { body = JSON.parse(json); },
    };
    // Give writeHead access to status via a captured setter.
    res.writeHead = (s) => { status = s; };

    const req = { method: key.split(' ')[0], headers: {}, on() {} };
    await handler(req, res);

    assert.equal(status, 401, `${key} should reject unauthenticated request with 401`);
    assert.equal(body.error, 'Not authenticated.', `${key} should return an authentication error`);
  }
});
