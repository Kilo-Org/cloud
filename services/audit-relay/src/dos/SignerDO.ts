import { DurableObject } from 'cloudflare:workers';
import { bytesToBase64url, base64urlToBytes } from '@kilocode/worker-utils/base64url';
import { z } from 'zod';
import type { Env } from '../env';
import { CheckpointPublicKeySchema, ed25519Thumbprint } from '../relay/signing';
import type { CheckpointPublicKey } from '../relay/signing';

type StoredKey = { pkcs8: string; publicKey: CheckpointPublicKey };

const KEY_STORAGE = 'checkpoint_signing_key';

const PublicJwkSchema = z.object({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  x: z.string().min(1),
});

type LoadedKey = { privateKey: CryptoKey; publicKey: CheckpointPublicKey };

/**
 * Holds the checkpoint signing key. The PKCS#8 bytes live in this object's storage and no RPC
 * method returns them; only signatures and the public half leave the object.
 */
export class SignerDO extends DurableObject<Env> {
  private loaded: Promise<LoadedKey> | undefined;

  async sign(payload: string): Promise<{ keyId: string; signature: string }> {
    const { privateKey, publicKey } = await this.loadKey();
    const signature = await crypto.subtle.sign(
      { name: 'Ed25519' },
      privateKey,
      new TextEncoder().encode(payload)
    );
    return { keyId: publicKey.kid, signature: bytesToBase64url(new Uint8Array(signature)) };
  }

  async publicKeys(): Promise<CheckpointPublicKey[]> {
    const { publicKey } = await this.loadKey();
    return [publicKey];
  }

  private loadKey(): Promise<LoadedKey> {
    return (this.loaded ??= this.readOrCreateKey());
  }

  private async readOrCreateKey(): Promise<LoadedKey> {
    const stored = await this.ctx.storage.get<StoredKey>(KEY_STORAGE);
    if (stored) {
      const publicKey = CheckpointPublicKeySchema.parse(stored.publicKey);
      return { privateKey: await this.importPrivateKey(stored.pkcs8), publicKey };
    }

    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    if (!isKeyPair(pair)) throw new Error('Ed25519 key generation returned a single key');
    const exported = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
    if (!(exported instanceof ArrayBuffer)) throw new Error('PKCS#8 export returned a JWK');
    const jwk = PublicJwkSchema.parse(await crypto.subtle.exportKey('jwk', pair.publicKey));
    const publicKey: CheckpointPublicKey = {
      kty: 'OKP',
      crv: 'Ed25519',
      x: jwk.x,
      kid: await ed25519Thumbprint(jwk),
      use: 'sig',
      alg: 'EdDSA',
    };
    await this.ctx.storage.put(KEY_STORAGE, {
      pkcs8: bytesToBase64url(new Uint8Array(exported)),
      publicKey,
    });
    return { privateKey: pair.privateKey, publicKey };
  }

  private importPrivateKey(pkcs8: string): Promise<CryptoKey> {
    return crypto.subtle.importKey(
      'pkcs8',
      new Uint8Array(base64urlToBytes(pkcs8)),
      'Ed25519',
      false,
      ['sign']
    );
  }
}

function isKeyPair(key: CryptoKey | CryptoKeyPair): key is CryptoKeyPair {
  return 'privateKey' in key;
}

export function getSignerDOStub(env: Pick<Env, 'AUDIT_SIGNER'>): DurableObjectStub<SignerDO> {
  return env.AUDIT_SIGNER.get(env.AUDIT_SIGNER.idFromName('checkpoint-signer'));
}
