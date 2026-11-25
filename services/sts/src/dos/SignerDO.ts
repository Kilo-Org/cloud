import { DurableObject } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, SignJWT } from 'jose';
import { z } from 'zod';
import migrations from '../../drizzle.signer/migrations';
import { loadOrCreateKey } from '../crypto/key-store';
import * as schema from '../db/signer-schema';
import { readConfig, type Env, type ManagerLoginClaims } from '../env';

type SignerDatabase = DrizzleSqliteDODatabase<typeof schema>;

const PublicJwkSchema = z.object({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: z.string().min(1),
  y: z.string().min(1),
});

const PrivateJwkSchema = PublicJwkSchema.extend({ d: z.string().min(1) });

export type ManagerJwk = {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  kid: string;
  alg: 'ES256';
  use: 'sig';
};

export type ManagerJwks = { keys: ManagerJwk[] };

/**
 * ES256, because Infisical JWT Auth documents RSA and ECDSA keys
 * (https://infisical.com/docs/documentation/platform/identities/jwt-auth).
 */
const ALGORITHM = 'ES256';

/** Infisical checks the JWT once, at login; a short life limits a leaked login JWT. */
const LOGIN_JWT_LIFETIME = '2m';

type SigningState = { key: CryptoKey; kid: string; jwks: ManagerJwks };

/** KV storage key of the signing key (see `crypto/key-store.ts`). */
const SIGNING_KEY_NAME = 'manager-signing-key';

const StoredSigningKeySchema = z.strictObject({
  kid: z.string().min(1),
  privateJwk: z.string().min(1),
  publicJwk: z.string().min(1),
});

/**
 * Holds the ECDSA P-256 key STS logs in to the manager with (design 4.2, 4.4). The key is generated
 * here and its private half never leaves this object; only the public half is served, at a key-set
 * URL of its own.
 */
export class SignerDO extends DurableObject<Env> {
  private readonly login: ManagerLoginClaims;
  private readonly db: SignerDatabase;
  private signing: SigningState | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.login = readConfig(env).manager.login;
    this.db = drizzle(ctx.storage, { schema });
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
      this.signing = await this.loadOrCreateKey();
    });
  }

  /** A login JWT with the exact issuer, audience and subject this environment's identity trusts. */
  async signManagerToken(): Promise<string> {
    const signing = this.requireSigning();
    return await new SignJWT({})
      .setProtectedHeader({ alg: ALGORITHM, kid: signing.kid, typ: 'JWT' })
      .setIssuer(this.login.issuer)
      .setAudience(this.login.audience)
      .setSubject(this.login.subject)
      .setJti(crypto.randomUUID())
      .setIssuedAt()
      .setExpirationTime(LOGIN_JWT_LIFETIME)
      .sign(signing.key);
  }

  async getJwks(): Promise<ManagerJwks> {
    return this.requireSigning().jwks;
  }

  private requireSigning(): SigningState {
    if (this.signing === null) throw new Error('signing key is not initialised');
    return this.signing;
  }

  private async loadOrCreateKey(): Promise<SigningState> {
    const stored = await loadOrCreateKey({
      storage: this.ctx.storage,
      name: SIGNING_KEY_NAME,
      schema: StoredSigningKeySchema,
      legacy: () => {
        const row = this.db
          .select()
          .from(schema.signingKey)
          .where(eq(schema.signingKey.id, 1))
          .get();
        return row === undefined
          ? null
          : { kid: row.kid, privateJwk: row.privateJwk, publicJwk: row.publicJwk };
      },
      dropLegacy: () => {
        this.db.delete(schema.signingKey).where(eq(schema.signingKey.id, 1)).run();
      },
      create: async () => {
        // Generated extractable only so the private JWK can be stored in this object's own
        // storage; the key used for signing is re-imported non-extractable.
        const pair = await generateKeyPair(ALGORITHM, { extractable: true });
        const publicJwk = await exportJWK(pair.publicKey);
        return {
          kid: await calculateJwkThumbprint(publicJwk),
          privateJwk: JSON.stringify(await exportJWK(pair.privateKey)),
          publicJwk: JSON.stringify(publicJwk),
        };
      },
    });
    return await this.adoptKey(stored.kid, stored.privateJwk, stored.publicJwk);
  }

  private async adoptKey(
    kid: string,
    privateJwkJson: string,
    publicJwkJson: string
  ): Promise<SigningState> {
    const privateJwk = PrivateJwkSchema.parse(JSON.parse(privateJwkJson));
    const publicJwk = PublicJwkSchema.parse(JSON.parse(publicJwkJson));
    const key = await importJWK(privateJwk, ALGORITHM, { extractable: false });
    if (!(key instanceof CryptoKey)) throw new Error('signing key did not import as a CryptoKey');
    return {
      key,
      kid,
      jwks: {
        keys: [
          {
            kty: publicJwk.kty,
            crv: publicJwk.crv,
            x: publicJwk.x,
            y: publicJwk.y,
            kid,
            alg: ALGORITHM,
            use: 'sig',
          },
        ],
      },
    };
  }
}
