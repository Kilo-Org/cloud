/**
 * AES-256-GCM encryption utilities for storing DoltHub tokens at rest.
 *
 * Uses the Web Crypto API (available in Cloudflare Workers).
 * Encrypted format: base64(iv || ciphertext || tag)
 * - IV: 12 bytes, randomly generated per encryption
 * - AES-256-GCM provides authenticated encryption (tag is appended by SubtleCrypto)
 */

const IV_BYTES = 12;
const ALGORITHM = 'AES-GCM';

// Fixed salt for PBKDF2 key derivation. Safe against rainbow-table attacks
// because the input key material (WASTELAND_ENCRYPTION_KEY) is already a
// high-entropy secret. However this means every credential in the database
// is encrypted with the same derived AES key — compromise of
// WASTELAND_ENCRYPTION_KEY plus a dump of `wasteland_credentials` decrypts
// all tokens at once. TODO (followup): add a per-credential `salt BLOB`
// column and pass it through `deriveEncryptionKey(secret, salt)` so the
// blast radius is limited to a single row.
const PBKDF2_SALT = new TextEncoder().encode('wasteland-credential-encryption-salt-v1');
const PBKDF2_ITERATIONS = 100_000;

/** Encrypt a plaintext string. Returns base64(iv || ciphertext || tag). */
export async function encryptToken(plaintext: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertextWithTag = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, key, encoded);

  // Concatenate iv || ciphertext || tag (GCM appends the 16-byte tag automatically)
  const result = new Uint8Array(iv.byteLength + ciphertextWithTag.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertextWithTag), iv.byteLength);

  return uint8ToBase64(result);
}

/** Decrypt a base64(iv || ciphertext || tag) string back to plaintext. */
export async function decryptToken(encrypted: string, key: CryptoKey): Promise<string> {
  const data = base64ToUint8(encrypted);

  if (data.byteLength < IV_BYTES + 1) {
    throw new Error('Invalid encrypted token: too short');
  }

  const iv = data.slice(0, IV_BYTES);
  const ciphertextWithTag = data.slice(IV_BYTES);

  const decrypted = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, ciphertextWithTag);

  return new TextDecoder().decode(decrypted);
}

/** Derive an AES-256-GCM CryptoKey from a secret string using PBKDF2. */
export async function deriveEncryptionKey(secret: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: PBKDF2_SALT,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: ALGORITHM, length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// --- base64 helpers using platform-agnostic approach ---

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
