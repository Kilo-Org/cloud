/**
 * AES-256-GCM encryption for environment variable values.
 *
 * Used to encrypt sensitive env var values in the CF Worker before placing
 * them in Fly Machine config.env. Decrypted at boot by start-openclaw.sh
 * using the KILOCLAW_ENV_KEY (stored as a Fly app secret).
 *
 * Ciphertext format: "enc:v1:{base64(12-byte-iv + ciphertext + 16-byte-tag)}"
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';

/** Prefix added to env var names in config.env for encrypted values. */
export const ENCRYPTED_ENV_PREFIX = 'KILOCLAW_ENC_';

/** Prefix on encrypted values (format version marker). */
const ENCRYPTED_VALUE_PREFIX = 'enc:v1:';

/** Prefixes reserved for the encryption system. User env vars must not use these. */
export const RESERVED_PREFIXES = ['KILOCLAW_ENC_', 'KILOCLAW_ENV_'] as const;

/** Valid shell identifier: letters, digits, underscores. Must start with letter or underscore. */
const SHELL_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Generate a random 256-bit AES key, returned as base64. */
export function generateEnvKey(): string {
  return randomBytes(32).toString('base64');
}

/** Encrypt a plaintext value. Returns "enc:v1:{base64(iv + ciphertext + authTag)}". */
export function encryptEnvValue(keyBase64: string, plaintext: string): string {
  const key = Buffer.from(keyBase64, 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, encrypted, tag]);
  return ENCRYPTED_VALUE_PREFIX + combined.toString('base64');
}

/** Decrypt an encrypted value. Input must start with "enc:v1:". */
export function decryptEnvValue(keyBase64: string, encoded: string): string {
  if (!encoded.startsWith(ENCRYPTED_VALUE_PREFIX)) {
    throw new Error('Invalid encrypted value: missing enc:v1: prefix');
  }

  const key = Buffer.from(keyBase64, 'base64');
  const data = Buffer.from(encoded.slice(ENCRYPTED_VALUE_PREFIX.length), 'base64');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(data.length - 16);
  const ciphertext = data.subarray(12, data.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(ciphertext, undefined, 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/** Check if a string looks like an encrypted env value. */
export function isEncryptedEnvValue(value: string): boolean {
  return value.startsWith(ENCRYPTED_VALUE_PREFIX);
}

/**
 * Validate that an env var name is a valid shell identifier.
 * Returns true if the name matches /^[A-Za-z_][A-Za-z0-9_]*$/.
 */
export function isValidShellIdentifier(name: string): boolean {
  return SHELL_IDENTIFIER_RE.test(name);
}

/**
 * Validate that a user-provided env var name doesn't use reserved prefixes
 * and is a valid shell identifier.
 * Throws if validation fails.
 */
export function validateUserEnvVarName(name: string): void {
  for (const prefix of RESERVED_PREFIXES) {
    if (name.startsWith(prefix)) {
      throw new Error(`Env var name '${name}' uses reserved prefix '${prefix}'`);
    }
  }
  if (!isValidShellIdentifier(name)) {
    throw new Error(
      `Env var name '${name}' is not a valid shell identifier (must match /^[A-Za-z_][A-Za-z0-9_]*$/)`
    );
  }
}
