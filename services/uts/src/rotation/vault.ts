import { z } from 'zod';

/** One login password, encrypted with AES-256-GCM; the login name is the additional data. */
export const SealedSchema = z.strictObject({
  iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  data: z.string().regex(/^[A-Za-z0-9_-]+$/),
});
export type Sealed = z.infer<typeof SealedSchema>;

/**
 * The stored key, generated inside the rotation object (design E6). It sits in the same object
 * storage as the sealed passwords, so sealing keeps passwords out of storage dumps and traces only;
 * anyone who can read that storage can read both. The object never sends the key anywhere and
 * imports it as non-extractable. workerd exports empty JWK members of other key types too, so the
 * parse keeps only the AES ones.
 */
export const StoredVaultKeySchema = z.object({
  kty: z.literal('oct'),
  alg: z.literal('A256GCM'),
  k: z.string().min(43),
});
export type StoredVaultKey = z.infer<typeof StoredVaultKeySchema>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)), c =>
    c.charCodeAt(0)
  );
}

export async function createVaultKey(): Promise<StoredVaultKey> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  if (!(key instanceof CryptoKey)) throw new Error('AES-GCM generates one secret key');
  return StoredVaultKeySchema.parse(await crypto.subtle.exportKey('jwk', key));
}

/** Seals and opens login passwords with one stored key. */
export class Vault {
  private constructor(private readonly key: CryptoKey) {}

  static async adopt(stored: StoredVaultKey): Promise<Vault> {
    const key = await crypto.subtle.importKey('jwk', stored, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
    return new Vault(key);
  }

  async seal(login: string, password: string): Promise<Sealed> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(login) },
      this.key,
      encoder.encode(password)
    );
    return { iv: toBase64Url(iv), data: toBase64Url(data) };
  }

  /** Throws when the ciphertext was not sealed by this key for this login. */
  async open(login: string, sealed: Sealed): Promise<string> {
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64Url(sealed.iv),
        additionalData: encoder.encode(login),
      },
      this.key,
      fromBase64Url(sealed.data)
    );
    return decoder.decode(plain);
  }
}
