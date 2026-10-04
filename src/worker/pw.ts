/**
 * Password and token helpers (WebCrypto).
 *
 * Passwords: PBKDF2-SHA256, 100000 iterations, 16-byte random salt, 32-byte derived key.
 * `hash` and `salt` are base64url strings (no padding); `iterations` is stored with each row so
 * the cost can change later without breaking existing hashes.
 */

export const PASSWORD_ITERATIONS = 100000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

export interface PasswordHash {
  hash: string;
  salt: string;
  iterations: number;
}

/** The `collaborators` columns that hold a password hash. */
export interface PasswordRow {
  password_hash: string;
  password_salt: string;
  password_iterations: number;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, HASH_BITS);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, PASSWORD_ITERATIONS);
  return { hash: toBase64Url(hash), salt: toBase64Url(salt), iterations: PASSWORD_ITERATIONS };
}

/** Constant-time check of `password` against a stored `collaborators` row. */
export async function verifyPassword(password: string, row: PasswordRow): Promise<boolean> {
  let salt: Uint8Array<ArrayBuffer>;
  let expected: Uint8Array<ArrayBuffer>;
  try {
    salt = fromBase64Url(row.password_salt);
    expected = fromBase64Url(row.password_hash);
  } catch {
    return false;
  }
  if (!Number.isInteger(row.password_iterations) || row.password_iterations < 1) return false;
  const actual = await derive(password, salt, row.password_iterations);
  let diff = actual.length ^ expected.length;
  const n = Math.max(actual.length, expected.length);
  for (let i = 0; i < n; i++) diff |= (actual[i] ?? 0) ^ (expected[i] ?? 0);
  return diff === 0;
}

// No 0/O or 1/l/I look-alikes.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Random password from an unambiguous alphabet (rejection sampling, no modulo bias). */
export function generatePassword(length = 20): string {
  const limit = 256 - (256 % ALPHABET.length);
  let out = '';
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(32))) {
      if (b < limit && out.length < length) out += ALPHABET.charAt(b % ALPHABET.length);
    }
  }
  return out;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  let hex = '';
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** 32 random bytes, base64url: the raw session cookie value. */
export function generateSessionToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}
