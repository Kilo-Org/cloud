import { base64url } from 'jose';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type SealedPayload = { iv: string; ciphertext: string };

/** Generates the key a Durable Object seals its own copy with. It never leaves that object. */
export function createEncryptionKey(): string {
  return base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sealJson(key: string, value: unknown): Promise<SealedPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await crypto.subtle.importKey('raw', base64url.decode(key), 'AES-GCM', false, [
    'encrypt',
  ]);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    encoder.encode(JSON.stringify(value))
  );
  return {
    iv: base64url.encode(iv),
    ciphertext: base64url.encode(new Uint8Array(ciphertext)),
  };
}

export async function openJson(key: string, sealed: SealedPayload): Promise<unknown> {
  const cryptoKey = await crypto.subtle.importKey('raw', base64url.decode(key), 'AES-GCM', false, [
    'decrypt',
  ]);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64url.decode(sealed.iv) },
    cryptoKey,
    base64url.decode(sealed.ciphertext)
  );
  return JSON.parse(decoder.decode(plaintext));
}
