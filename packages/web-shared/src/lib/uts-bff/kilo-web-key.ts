import 'server-only';
import { KILO_WEB_CLIENT_ID, type UtsEnvironment } from '@kilocode/uts-contracts';
import { SignJWT, calculateJwkThumbprint } from 'jose';
import { z } from 'zod';
import {
  lazyStsSecretReader,
  STS_TRANSPORT_LOAD_TIMEOUT_MS,
} from '@kilocode/web-shared/lib/sts-secret-reader';
import { stsSecretReadFailureReason } from '@kilocode/web-shared/lib/sts-secret-read-failure';

/**
 * The `kilo-web` client key (design 5.1; `@kilocode/uts-contracts` `browser-sessions.ts`). Every
 * call the BFF makes to UTS carries a private-key JWT (RFC 7523) signed with this Ed25519 key,
 * whose public half UTS lists in `KILO_WEB_CLIENT_JWKS`.
 *
 * The key is the `UTS_KILO_WEB_CLIENT_KEY` field of the web workload's STS bundle: one private JWK,
 * `kid` = `kilo-web-` plus its RFC 7638 thumbprint. During a rotation `UTS_KILO_WEB_CLIENT_KEY_NEXT`
 * stages the next key until its public half reaches UTS; this module never reads it. Production and
 * staging read the bundle only. Local development reads the same name from its environment, unless
 * `SECRETS_SOURCE=sts`.
 */
export const KILO_WEB_CLIENT_KEY_SECRET = 'UTS_KILO_WEB_CLIENT_KEY';

/** UTS refuses an assertion living over 300 s; one request needs far less. */
const CLIENT_ASSERTION_LIFETIME_SECONDS = 60;

export type KiloWebSigningKey = { kid: string; privateKey: CryptoKey };

/**
 * `unavailable`: temporary (the bundle cannot be read now). `invalid`: the key is missing or
 * unusable; only a configuration change helps.
 */
export type KiloWebSigningKeyAnswer =
  | { status: 'ready'; key: KiloWebSigningKey }
  | { status: 'unavailable' }
  | { status: 'invalid' };

export type KiloWebSigningKeyProvider = () => Promise<KiloWebSigningKeyAnswer>;

const KeyBytesSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .refine(value => Buffer.from(value, 'base64url').toString('base64url') === value);

const PrivateJwkSchema = z.strictObject({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  alg: z.literal('EdDSA'),
  use: z.literal('sig'),
  kid: z.string(),
  x: KeyBytesSchema,
  d: KeyBytesSchema,
});

const PROBE = new TextEncoder().encode('kilo-web signing key check');

/**
 * Imports the key from its stored value. It is `ready` only when the JWK has exactly the agreed
 * members, `kid` is `kilo-web-` plus the thumbprint of `x`, and a probe signed with `d` verifies
 * under `x`. The private key is imported non-extractable, for signing only. Any failure is
 * `invalid`, and neither its reason nor the value is kept, so neither can reach a log.
 */
export async function importKiloWebSigningKey(value: string): Promise<KiloWebSigningKeyAnswer> {
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    return { status: 'invalid' };
  }
  const parsed = PrivateJwkSchema.safeParse(json);
  if (!parsed.success) return { status: 'invalid' };
  const { kty, crv, kid, x, d } = parsed.data;
  if (kid !== `kilo-web-${await calculateJwkThumbprint({ kty, crv, x }, 'sha256')}`) {
    return { status: 'invalid' };
  }
  try {
    const algorithm = { name: 'Ed25519' };
    const privateKey = await crypto.subtle.importKey('jwk', { kty, crv, x, d }, algorithm, false, [
      'sign',
    ]);
    const publicKey = await crypto.subtle.importKey('jwk', { kty, crv, x }, algorithm, false, [
      'verify',
    ]);
    const signature = await crypto.subtle.sign(algorithm, privateKey, PROBE);
    if (!(await crypto.subtle.verify(algorithm, publicKey, signature, PROBE))) {
      return { status: 'invalid' };
    }
    return { status: 'ready', key: { kid, privateKey } };
  } catch {
    return { status: 'invalid' };
  }
}

/**
 * A client assertion for one UTS endpoint: EdDSA, `iss` = `sub` = `kilo-web`, `aud` the exact URL
 * called, a random single-use `jti`, 60 seconds. UTS records the `jti` and refuses it again.
 */
export async function signClientAssertion(
  key: KiloWebSigningKey,
  endpointUrl: string
): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  return await new SignJWT({})
    .setProtectedHeader({ alg: 'EdDSA', kid: key.kid })
    .setIssuer(KILO_WEB_CLIENT_ID)
    .setSubject(KILO_WEB_CLIENT_ID)
    .setAudience(endpointUrl)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + CLIENT_ASSERTION_LIFETIME_SECONDS)
    .setJti(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'))
    .sign(key.privateKey);
}

/** Reads one secret by name; a missing or refused secret rejects with the client's reason. */
type SecretRead = (name: string) => Promise<string>;

const readBundleSecret: SecretRead = lazyStsSecretReader(async () => {
  // Loaded on the first bundle read only, as `sts-secret-reader.ts` does, so local development
  // on its environment never loads the STS transport, the Vercel OIDC exchange or the cache.
  const { createVercelStsSecretReader } =
    await import('@kilocode/web-shared/lib/sts-secret-transport');
  return createVercelStsSecretReader();
}, STS_TRANSPORT_LOAD_TIMEOUT_MS);

/** A read that no configuration change can fix right now counts as `invalid`, else `unavailable`. */
function failureAnswer(error: unknown): KiloWebSigningKeyAnswer {
  const reason = stsSecretReadFailureReason(error);
  return reason === 'missing' ||
    reason === 'not_granted' ||
    reason === 'denied' ||
    reason === 'config'
    ? { status: 'invalid' }
    : { status: 'unavailable' };
}

/**
 * The key provider of a deployment. It keeps no key itself: each call reads the current value and
 * imports it, so a rotation applies as soon as the bundle serves it. A rejected read's error, which
 * may name the secret, is dropped.
 */
export function kiloWebSigningKeyProvider(
  environment: UtsEnvironment,
  runtime: Readonly<Record<string, string | undefined>> = process.env,
  readSecret: SecretRead = readBundleSecret
): KiloWebSigningKeyProvider {
  return async () => {
    // Only a process outside Vercel reads its own environment; a Vercel runtime never does.
    if (
      environment === 'development' &&
      runtime.VERCEL === undefined &&
      runtime.SECRETS_SOURCE !== 'sts'
    ) {
      const value = runtime[KILO_WEB_CLIENT_KEY_SECRET];
      return value ? await importKiloWebSigningKey(value) : { status: 'invalid' };
    }
    let value: string;
    try {
      value = await readSecret(KILO_WEB_CLIENT_KEY_SECRET);
    } catch (error) {
      return failureAnswer(error);
    }
    return await importKiloWebSigningKey(value);
  };
}
