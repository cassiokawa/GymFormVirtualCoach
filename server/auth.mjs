/**
 * Auth primitives for the sync server — all via Node's built-in crypto.
 *
 * - Password hashing: scrypt with a random per-user salt (stored as salt:hash).
 * - Password verification: constant-time comparison.
 * - Raw tokens (verify/reset): 32 random bytes, hex. Only the SHA-256 hash is
 *   stored server-side, so a DB leak does not expose usable tokens.
 * - Session tokens: "<sessionId>.<HMAC>" signed with the server secret, so the
 *   server can verify integrity and revoke by sessionId.
 */

import crypto from 'node:crypto';

const SCRYPT_KEYLEN = 64;

/** Hash a password with scrypt. Returns "salt:hash" (both hex). */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

/** Verify a password against a stored "salt:hash". Constant-time. */
export function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** Generate a raw token (returned to user) and its SHA-256 hash (stored). */
export function generateToken() {
  const raw = crypto.randomBytes(32).toString('hex'); // 256-bit
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

/** SHA-256 of a raw token, for lookup. */
export function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

/** Create a signed session token "<id>.<hmac>". */
export function signSession(sessionId, secret) {
  const mac = crypto.createHmac('sha256', secret).update(sessionId).digest('hex');
  return `${sessionId}.${mac}`;
}

/** Verify a signed session token; returns the sessionId or null. */
export function verifySessionSignature(token, secret) {
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const [sessionId, mac] = parts;
  const expected = crypto.createHmac('sha256', secret).update(sessionId).digest('hex');
  // Strict hex + exact-length check: Buffer.from('..','hex') silently drops
  // invalid trailing nibbles, which would let a tampered mac slip through.
  if (mac.length !== expected.length || !/^[0-9a-f]+$/i.test(mac)) return null;
  const a = Buffer.from(mac, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return sessionId;
}

export function randomId() {
  return crypto.randomUUID();
}
