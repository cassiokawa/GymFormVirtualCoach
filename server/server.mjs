/**
 * Zero-knowledge sync server (Node built-in http, no framework).
 *
 * Endpoints (all JSON):
 *   POST /auth/register        { username, email, password }
 *   POST /auth/verify-email    { token }
 *   POST /auth/login           { identifier, password }        -> { session, user }
 *   POST /auth/logout          (Bearer session)
 *   POST /auth/forgot-password { email }
 *   POST /auth/reset-password  { token, password }
 *   GET  /sync/blob            (Bearer session)                 -> { blob, keyStore, updatedAt }
 *   PUT  /sync/blob            (Bearer session) { blob, keyStore }
 *   DELETE /account            (Bearer session)                 (GDPR erasure)
 *
 * Zero-knowledge storage contract (spec 06, Req 2.4 / 2.5):
 *   - PUT /sync/blob accepts exactly two opaque strings: `blob` (the
 *     Encrypted_Envelope) and `keyStore` (the Wrapped_Key_Metadata). Both are
 *     validated only for type/size and stored verbatim; the server never parses
 *     or inspects their contents.
 *   - GET /sync/blob returns those same opaque strings back, unchanged.
 *   - The server never receives, derives, or stores the Master_Key, the
 *     Encryption_Passphrase, or the Recovery_Code — there is no request field
 *     and no DB column for any of them.
 *   - The only PII the server holds is the user's email (see db.mjs). The scrypt
 *     password hash authenticates the account only and is not vault key material.
 */

import http from 'node:http';
import { Db } from './db.mjs';
import {
  hashPassword, verifyPassword, generateToken, hashToken,
  signSession, verifySessionSignature, randomId,
} from './auth.mjs';
import { createEmailTransport } from './email.mjs';

const PORT = Number(process.env['SYNC_PORT'] ?? 8787);
const APP_ORIGIN = process.env['APP_ORIGIN'] ?? 'http://localhost:5173';
const SERVER_SECRET = process.env['SYNC_SECRET'] ?? 'dev-only-secret-change-me';
const DB_PATH = process.env['SYNC_DB'] ?? 'server/sync.db';

const SESSION_TTL_MS = 3600_000;      // 1h
const VERIFY_TTL_MS = 86_400_000;     // 24h
const RESET_TTL_MS = 3600_000;        // 1h
const MAX_BLOB_BYTES = 10 * 1024 * 1024;

const db = new Db(DB_PATH);
const email = createEmailTransport(process.env['EMAIL_MODE'] ?? 'dev');

// --- simple in-memory login rate limiting: 5 fails / 5 min -> 15 min lock ---
const loginAttempts = new Map(); // identifier -> { count, first, lockedUntil }
function isLocked(id) {
  const a = loginAttempts.get(id);
  return !!a && a.lockedUntil && a.lockedUntil > Date.now();
}
function recordFail(id) {
  const now = Date.now();
  const a = loginAttempts.get(id) ?? { count: 0, first: now, lockedUntil: 0 };
  if (now - a.first > 300_000) { a.count = 0; a.first = now; }
  a.count += 1;
  if (a.count >= 5) a.lockedUntil = now + 900_000;
  loginAttempts.set(id, a);
}
function clearFails(id) { loginAttempts.delete(id); }

// --- helpers ---
function send(res, status, body) {
  const json = JSON.stringify(body ?? {});
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': APP_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Max-Age': '600',
  });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BLOB_BYTES + 1024) { reject(new Error('payload too large')); req.destroy(); return; }
      data += c;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function bearer(req) {
  const h = req.headers['authorization'] ?? '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

/**
 * Resolve the authenticated user from a Bearer session token, or null.
 *
 * SESSION-PROTECTION CONTRACT (spec 06, Req 4.6)
 * ----------------------------------------------
 * This is the single gate every protected endpoint funnels through. It returns
 * a truthy `{ user, sessionId }` ONLY for a valid, unexpired session, and null
 * in every other case. The caller MUST reject a null result with a 401 before
 * reading or writing any protected data. The rejection cases, in order:
 *
 *   1. No Authorization header / not a "Bearer " token  -> bearer() === ''      -> null
 *   2. Malformed or garbage token                       -> signature check fails -> null
 *   3. Well-formed but forged/unknown session id        -> findSession() empty   -> null
 *   4. Known session that has expired                   -> expires_at < now      -> null
 *   5. Session whose user no longer exists (e.g. erased) -> findUserById() empty  -> null
 *
 * The HMAC signature check (verifySessionSignature) runs BEFORE any DB lookup,
 * so a forged token never reaches the session store. Because a null here always
 * short-circuits the handler, NO protected data is read or written for any
 * unauthenticated request.
 */
function authUser(req) {
  const token = bearer(req);
  if (!token) return null;                              // (1) no/empty bearer token
  const sessionId = verifySessionSignature(token, SERVER_SECRET);
  if (!sessionId) return null;                          // (2) malformed/garbage/tampered
  const session = db.findSession(sessionId);
  if (!session || session.expires_at < Date.now()) return null; // (3) forged id / (4) expired
  const user = db.findUserById(session.user_id);
  return user ? { user, sessionId } : null;             // (5) user gone
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// --- route handlers ---
const routes = {
  'POST /auth/register': async (req, res) => {
    const { email: em, password } = await readBody(req);
    // Identity is the email — no separate username.
    if (typeof em !== 'string' || !EMAIL_RE.test(em)) {
      return send(res, 400, { error: 'A valid email is required.' });
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
      return send(res, 400, { error: 'Password must be 8-128 characters.' });
    }
    if (db.findUserByEmail(em)) return send(res, 409, { error: 'Email is already registered.' });

    const id = randomId();
    // Store the email as the username too, so the schema and lookups are unchanged.
    db.createUser({ id, username: em, email: em, password_hash: hashPassword(password), email_verified: 0, created_at: Date.now() });
    const { raw, hash } = generateToken();
    db.insertToken({ token_hash: hash, user_id: id, kind: 'verify', expires_at: Date.now() + VERIFY_TTL_MS });
    await email.send(em, 'Verify your Form Coach account', `${APP_ORIGIN}/?verify=${raw}`);
    return send(res, 201, { ok: true, message: 'Account created. Check the server console for the verification link (dev mode).' });
  },

  'POST /auth/verify-email': async (req, res) => {
    const { token } = await readBody(req);
    if (typeof token !== 'string') return send(res, 400, { error: 'Token required.' });
    const row = db.findToken(hashToken(token));
    if (!row || row.kind !== 'verify') return send(res, 400, { error: 'Invalid verification token.' });
    if (row.expires_at < Date.now()) { db.deleteToken(row.token_hash); return send(res, 400, { error: 'Verification token has expired.' }); }
    db.setEmailVerified(row.user_id);
    db.deleteToken(row.token_hash);
    return send(res, 200, { ok: true });
  },

  'POST /auth/login': async (req, res) => {
    const { identifier, password } = await readBody(req);
    if (typeof identifier !== 'string' || typeof password !== 'string') {
      return send(res, 400, { error: 'Missing credentials.' });
    }
    if (isLocked(identifier)) return send(res, 429, { error: 'Too many attempts. Try again later.' });
    const user = db.findUserByIdentifier(identifier);
    // Always run a hash comparison to reduce timing signal, even for unknown users.
    const ok = user ? verifyPassword(password, user.password_hash) : verifyPassword(password, 'aa:bb');
    if (!user || !ok) { recordFail(identifier); return send(res, 401, { error: 'Invalid credentials.' }); }
    clearFails(identifier);
    const sessionId = randomId();
    db.insertSession(sessionId, user.id, Date.now() + SESSION_TTL_MS);
    return send(res, 200, {
      session: signSession(sessionId, SERVER_SECRET),
      user: { id: user.id, username: user.username, email: user.email, emailVerified: !!user.email_verified },
    });
  },

  'POST /auth/logout': async (req, res) => {
    const auth = authUser(req);
    if (auth) db.deleteSession(auth.sessionId);
    return send(res, 200, { ok: true });
  },

  'POST /auth/forgot-password': async (req, res) => {
    const { email: em } = await readBody(req);
    const user = typeof em === 'string' ? db.findUserByEmail(em) : undefined;
    if (user) {
      const { raw, hash } = generateToken();
      db.insertToken({ token_hash: hash, user_id: user.id, kind: 'reset', expires_at: Date.now() + RESET_TTL_MS });
      await email.send(em, 'Reset your Form Coach password', `${APP_ORIGIN}/?reset=${raw}`);
    }
    // Always the same response — never reveal whether the email exists.
    return send(res, 200, { ok: true, message: 'If that email is registered, a reset link has been sent.' });
  },

  'POST /auth/reset-password': async (req, res) => {
    const { token, password } = await readBody(req);
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
      return send(res, 400, { error: 'Password must be 8-128 characters.' });
    }
    const row = typeof token === 'string' ? db.findToken(hashToken(token)) : undefined;
    if (!row || row.kind !== 'reset' || row.expires_at < Date.now()) {
      if (row) db.deleteToken(row.token_hash);
      return send(res, 400, { error: 'Invalid or expired reset token.' });
    }
    db.setPasswordHash(row.user_id, hashPassword(password));
    db.deleteToken(row.token_hash);
    // NOTE: the encrypted vault blob is intentionally left unchanged — a password
    // reset restores server access only, NEVER the ability to decrypt data.
    return send(res, 200, { ok: true });
  },

  // PROTECTED (Req 4.6): requires a valid, unexpired session. Without one, the
  // request is rejected 401 and NO blob is read.
  'GET /sync/blob': async (req, res) => {
    const auth = authUser(req);
    if (!auth) return send(res, 401, { error: 'Not authenticated.' });
    const row = db.getBlob(auth.user.id);
    if (!row) return send(res, 200, { blob: null, keyStore: null, updatedAt: null });
    return send(res, 200, { blob: row.blob, keyStore: row.key_store, updatedAt: row.updated_at });
  },

  // PROTECTED (Req 4.6): requires a valid, unexpired session. Without one, the
  // request is rejected 401 BEFORE the body is read, so NO blob is written.
  //
  // Zero-knowledge write path (Req 2.4). Accepts ONLY the two opaque strings —
  // `blob` (Encrypted_Envelope) and `keyStore` (Wrapped_Key_Metadata) — and
  // stores them verbatim. Any other field in the body is ignored; there is no
  // field for a passphrase, recovery code, or master key.
  'PUT /sync/blob': async (req, res) => {
    const auth = authUser(req);
    if (!auth) return send(res, 401, { error: 'Not authenticated.' });
    const { blob, keyStore } = await readBody(req);
    if (typeof blob !== 'string' || blob.length === 0 || blob.length > MAX_BLOB_BYTES) {
      return send(res, 400, { error: 'Invalid blob payload.' });
    }
    if (typeof keyStore !== 'string' || keyStore.length === 0) {
      return send(res, 400, { error: 'Missing key store.' });
    }
    db.upsertBlob(auth.user.id, blob, keyStore, Date.now());
    return send(res, 200, { ok: true, updatedAt: Date.now() });
  },

  // PROTECTED (Req 4.6): requires a valid, unexpired session. Without one, the
  // request is rejected 401 and NO account/data is deleted.
  'DELETE /account': async (req, res) => {
    const auth = authUser(req);
    if (!auth) return send(res, 401, { error: 'Not authenticated.' });
    db.deleteUser(auth.user.id);
    return send(res, 200, { ok: true });
  },
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];
  if (!handler) return send(res, 404, { error: 'Not found.' });
  try {
    await handler(req, res);
  } catch (err) {
    const msg = err && err.message === 'payload too large' ? 'Payload too large.' : 'Server error.';
    const status = msg === 'Payload too large.' ? 413 : 500;
    send(res, status, { error: msg });
  }
});

// Only listen when run directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`🔐 Zero-knowledge sync server on http://localhost:${PORT} (origin ${APP_ORIGIN}, email=${email.mode})`);
  });
}

export { server, db, routes, authUser };
