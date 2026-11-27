/**
 * A PostgreSQL SCRAM-SHA-256 password verifier (RFC 5802, RFC 7677), in the form PostgreSQL
 * stores in `pg_authid.rolpassword`:
 * `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>`. `ALTER ROLE ... PASSWORD` takes it
 * as is, so the statement, which Supabase logs as DDL, never carries the password itself.
 */

/** PostgreSQL's default `scram_iterations`. */
const ITERATIONS = 4096;
const SALT_BYTES = 16;

/** Base64 and the verifier's separators only: safe to place inside a SQL string literal. */
export const SCRAM_VERIFIER_PATTERN =
  /^SCRAM-SHA-256\$[0-9]+:[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/;

const encoder = new TextEncoder();

function base64(bytes: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

async function hmac(key: ArrayBuffer, message: string): Promise<ArrayBuffer> {
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(message));
}

/**
 * The verifier of `password` with `salt` (random when left out). The rotation's passwords are
 * base64url text, which SASLprep leaves unchanged, so the UTF-8 bytes are the normalized form.
 */
export async function scramVerifier(
  password: string,
  salt: Uint8Array = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
): Promise<string> {
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const salted = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS },
    passwordKey,
    256
  );
  const clientKey = await hmac(salted, 'Client Key');
  const storedKey = await crypto.subtle.digest('SHA-256', clientKey);
  const serverKey = await hmac(salted, 'Server Key');
  return `SCRAM-SHA-256$${ITERATIONS}:${base64(salt)}$${base64(storedKey)}:${base64(serverKey)}`;
}

/** A new login password: 32 random bytes as base64url, 43 characters. */
export function newLoginPassword(): string {
  return base64(crypto.getRandomValues(new Uint8Array(32)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}
