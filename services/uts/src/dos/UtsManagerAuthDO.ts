import { DurableObject } from 'cloudflare:workers';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, SignJWT } from 'jose';
import { z } from 'zod';
import { readConfig, type Env, type UtsConfig } from '../env';
import { managerLoginClaims, type ManagerLoginClaims } from '../manager/config';
import { managerAuthObjectId } from './stubs';

const PublicJwkSchema = z.object({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: z.string().min(1),
  y: z.string().min(1),
});

const PrivateJwkSchema = PublicJwkSchema.extend({ d: z.string().min(1) });

/**
 * The stored key. It lives in the object's KV storage, not in SQL rows: a Workers trace records
 * each SQL statement's bound values, while a storage get or put records the key name only.
 */
const StoredLoginKeySchema = z.strictObject({
  kid: z.string().min(1),
  privateJwk: PrivateJwkSchema,
  publicJwk: PublicJwkSchema,
});
type StoredLoginKey = z.infer<typeof StoredLoginKeySchema>;

const LOGIN_KEY_NAME = 'manager-login-key';

/** ES256: Infisical JWT Auth documents RSA and ECDSA keys. */
const ALGORITHM = 'ES256';

/** Infisical checks the JWT once, at login; a short life limits a leaked login JWT. */
const LOGIN_JWT_LIFETIME = '2m';

export type ManagerJwk = {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  kid: string;
  alg: 'ES256';
  use: 'sig';
};

/** Empty until the first login JWT is signed, which creates the key. */
export type ManagerJwks = { keys: ManagerJwk[] };

export type ManagerJwksResult =
  | { status: 'ok'; jwks: ManagerJwks }
  | { status: 'misconfigured'; reason: string };

export type ManagerLoginJwtResult =
  | { status: 'signed'; jwt: string }
  | { status: 'misconfigured'; reason: string };

type Signing = { key: CryptoKey; jwk: ManagerJwk };

type Phase =
  | { status: 'loading' }
  | { status: 'no_key' }
  | { status: 'ready'; signing: Signing }
  | { status: 'refused'; reason: string };

type ReadyOrRefused = Extract<Phase, { status: 'ready' | 'refused' }>;

/**
 * The one object, `<environment>:manager-auth` in the `eu` jurisdiction, that holds the ECDSA P-256
 * key UTS logs in to the secrets manager with as `uts-rotation-<environment>` (design 4.2, 5.2).
 * It is a key of its own, never a token signer key. The private half never leaves this object;
 * only the public half is served, at `/manager-auth/.well-known/jwks.json`. A key-set read never
 * creates the key: the set stays empty until the first login JWT is signed. Workers RPC exposes
 * every public method, so the only public members are `jwks` and `signLoginJwt`.
 */
export class UtsManagerAuthDO extends DurableObject<Env> {
  readonly #config: UtsConfig;
  readonly #login: ManagerLoginClaims;
  #phase: Phase = { status: 'loading' };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#config = readConfig(env);
    this.#login = managerLoginClaims(this.#config);
    if (!ctx.id.equals(managerAuthObjectId(env, this.#config))) {
      const reason = 'manager auth object was not created by its name in this environment';
      console.error(JSON.stringify({ event: 'uts.manager_auth.refused', reason }));
      this.#phase = { status: 'refused', reason };
      return;
    }
    // A load that throws (a storage failure or a stored key that does not parse) resets the
    // object, and the next call loads again; it never replaces a stored key.
    void ctx.blockConcurrencyWhile(async () => {
      const stored: unknown = await ctx.storage.get(LOGIN_KEY_NAME);
      this.#phase =
        stored === undefined
          ? { status: 'no_key' }
          : { status: 'ready', signing: await adopt(StoredLoginKeySchema.parse(stored)) };
    });
  }

  async jwks(): Promise<ManagerJwksResult> {
    const phase = this.#phase;
    if (phase.status === 'refused') return { status: 'misconfigured', reason: phase.reason };
    return { status: 'ok', jwks: { keys: phase.status === 'ready' ? [phase.signing.jwk] : [] } };
  }

  /** A login JWT with the exact issuer, subject and audience this environment's identity trusts. */
  async signLoginJwt(): Promise<ManagerLoginJwtResult> {
    const signing = await this.#signing();
    if (signing.status === 'refused') return { status: 'misconfigured', reason: signing.reason };
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: ALGORITHM, kid: signing.signing.jwk.kid, typ: 'JWT' })
      .setIssuer(this.#login.issuer)
      .setSubject(this.#login.subject)
      .setAudience(this.#login.audience)
      .setJti(crypto.randomUUID())
      .setIssuedAt()
      .setExpirationTime(LOGIN_JWT_LIFETIME)
      .sign(signing.signing.key);
    return { status: 'signed', jwt };
  }

  async #signing(): Promise<ReadyOrRefused> {
    const phase = this.#phase;
    if (phase.status === 'ready' || phase.status === 'refused') return phase;
    // The one admission guard: no other call runs until the key is stored, so two first calls
    // never create two keys. A key already in storage is adopted, never replaced.
    return await this.ctx.blockConcurrencyWhile(async (): Promise<ReadyOrRefused> => {
      const current = this.#phase;
      if (current.status === 'ready' || current.status === 'refused') return current;
      const stored: unknown = await this.ctx.storage.get(LOGIN_KEY_NAME);
      let key: StoredLoginKey;
      if (stored === undefined) {
        key = await createKey();
        await this.ctx.storage.put(LOGIN_KEY_NAME, key);
        console.log(JSON.stringify({ event: 'uts.manager_auth.key_created', kid: key.kid }));
      } else {
        key = StoredLoginKeySchema.parse(stored);
      }
      const ready: ReadyOrRefused = { status: 'ready', signing: await adopt(key) };
      this.#phase = ready;
      return ready;
    });
  }
}

async function createKey(): Promise<StoredLoginKey> {
  // Generated extractable only so the private JWK can be stored in this object's own storage; the
  // key used for signing is imported again as non-extractable.
  const pair = await generateKeyPair(ALGORITHM, { extractable: true });
  const publicJwk = PublicJwkSchema.parse(await exportJWK(pair.publicKey));
  return {
    kid: await calculateJwkThumbprint(publicJwk),
    privateJwk: PrivateJwkSchema.parse(await exportJWK(pair.privateKey)),
    publicJwk,
  };
}

async function adopt(stored: StoredLoginKey): Promise<Signing> {
  const key = await importJWK(stored.privateJwk, ALGORITHM, { extractable: false });
  if (!(key instanceof CryptoKey)) throw new Error('login key did not import as a CryptoKey');
  const { kty, crv, x, y } = stored.publicJwk;
  return { key, jwk: { kty, crv, x, y, kid: stored.kid, alg: ALGORITHM, use: 'sig' } };
}
