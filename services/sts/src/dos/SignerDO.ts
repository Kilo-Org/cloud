import { DurableObject } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { exportJWK, generateKeyPair, importJWK, SignJWT } from 'jose';
import { z } from 'zod';
import migrations from '../../drizzle.signer/migrations';
import { sha256Base64Url } from '../crypto/hash';
import * as schema from '../db/signer-schema';
import { readConfig, type Env, type StsConfig } from '../env';

type SignerDatabase = DrizzleSqliteDODatabase<typeof schema>;

const PublicJwkSchema = z.object({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  x: z.string().min(1),
});

const PrivateJwkSchema = PublicJwkSchema.extend({ d: z.string().min(1) });

export type ManagerJwks = {
  keys: Array<{ kty: string; crv: string; x: string; kid: string; alg: string; use: string }>;
};

const MANAGER_AUDIENCE = 'infisical';
const MANAGER_TOKEN_LIFETIME = '5m';

/**
 * Holds the Ed25519 key STS authenticates to the manager with. The private key is
 * generated here, stored in this object's SQLite, and only its public half is served,
 * at a key set separate from any other STS signing material (design 4.4).
 */
export class SignerDO extends DurableObject<Env> {
  private readonly config: StsConfig;
  private readonly db: SignerDatabase;
  private signingKey: CryptoKey | null = null;
  private kid: string | null = null;
  private jwks: ManagerJwks | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = readConfig(env);
    this.db = drizzle(ctx.storage, { schema });
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
      await this.loadOrCreateKey();
    });
  }

  async signManagerToken(): Promise<string> {
    if (this.signingKey === null || this.kid === null) {
      throw new Error('signing key is not initialised');
    }
    return await new SignJWT({})
      .setProtectedHeader({ alg: 'EdDSA', kid: this.kid, typ: 'JWT' })
      .setIssuer(`${this.config.issuer}/manager-auth`)
      .setSubject(`sts:${this.config.environment}`)
      .setAudience(MANAGER_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(MANAGER_TOKEN_LIFETIME)
      .sign(this.signingKey);
  }

  async getJwks(): Promise<ManagerJwks> {
    if (this.jwks === null) throw new Error('signing key is not initialised');
    return this.jwks;
  }

  private async loadOrCreateKey(): Promise<void> {
    const row = this.db.select().from(schema.signingKey).where(eq(schema.signingKey.id, 1)).get();
    if (row !== undefined) {
      await this.adoptKey(row.kid, row.privateJwk, row.publicJwk);
      return;
    }

    const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const privateJwk = await exportJWK(pair.privateKey);
    const publicJwk = await exportJWK(pair.publicKey);
    const kid = (await sha256Base64Url(JSON.stringify(publicJwk))).slice(0, 16);
    const privateJwkJson = JSON.stringify(privateJwk);
    const publicJwkJson = JSON.stringify(publicJwk);
    this.db
      .insert(schema.signingKey)
      .values({
        id: 1,
        kid,
        privateJwk: privateJwkJson,
        publicJwk: publicJwkJson,
        createdAt: Date.now(),
      })
      .run();
    await this.adoptKey(kid, privateJwkJson, publicJwkJson);
  }

  private async adoptKey(
    kid: string,
    privateJwkJson: string,
    publicJwkJson: string
  ): Promise<void> {
    const privateJwk = PrivateJwkSchema.parse(JSON.parse(privateJwkJson));
    const publicJwk = PublicJwkSchema.parse(JSON.parse(publicJwkJson));
    this.signingKey = await importJWK(privateJwk, 'EdDSA');
    this.kid = kid;
    this.jwks = {
      keys: [
        {
          kty: publicJwk.kty,
          crv: publicJwk.crv,
          x: publicJwk.x,
          kid,
          alg: 'EdDSA',
          use: 'sig',
        },
      ],
    };
  }
}
