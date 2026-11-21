import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const fallbackHash = 'scrypt$' + '0'.repeat(32) + '$' + '0'.repeat(64);

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, 32, options);
  return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}

export async function verifyPassword(password, stored) {
  const [, salt, expected] = (stored || fallbackHash).split('$');
  const actual = await derive(password, Buffer.from(salt, 'hex'), 32, options);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex')) && Boolean(stored);
}

export async function digest(value) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Buffer.from(hash).toString('hex');
}

export const randomToken = () => randomBytes(32).toString('base64url');
export const sessionLifetime = 60 * 60 * 12;
const cookieName = '__Host-tabetsuna';

export function sessionCookie(token = '', maxAge = 0) {
  return `${cookieName}=${token}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Strict`;
}

export function sessionToken(request) {
  const value = request.headers.get('Cookie')?.match(/(?:^|;\s*)__Host-tabetsuna=([A-Za-z0-9_-]{43})(?:;|$)/)?.[1];
  return value || null;
}
