import { base64urlToBytes, bytesToBase64url } from '@kilocode/worker-utils/base64url';
import {
  ACCESS_TOKEN_ALGORITHM,
  ACCESS_TOKEN_TYPE,
  MintRequestSchema,
  SERVICE_TOKEN_LIFETIME_SECONDS,
  StsEnvironmentSchema,
  WorkloadNameSchema,
  serviceSubject,
  type IssuedToken,
  type MintRequest,
} from '@kilocode/sts-contracts';
import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { calculateJwkThumbprint, SignJWT } from 'jose';
import { z } from 'zod';
import migrations from '../../drizzle.token-signer/migrations';
import { tokenIssuedEvent, tokenKeyRevokedEvent, tokenKeyRotatedEvent } from '../audit/events';
import { AuditLog } from '../audit/log';
import {
  MIN_TOKEN_LIFETIME_SECONDS,
  RELAY_DELAY_MS,
  RELAY_RETRY_MS,
  TOKEN_AUDIT_PRUNE_INTERVAL_MS,
  TOKEN_AUDIT_RETENTION_MS,
  TOKEN_SIGNER_SHARDS,
} from '../constants';
import * as schema from '../db/token-signer-schema';
import { readConfig, type Env, type StsConfig } from '../env';
import {
  KeyRingSchema,
  advanceKeyRing,
  keyRingDueAt,
  keepLatestSignedExp,
  publishedKeys,
  recordSignedExp,
  type GeneratedKey,
  type KeyRing,
  type TokenJwk,
  type TokenKey,
} from '../tokens/key-ring';
import { getTokenSignerStub } from './stubs';

/** KV storage key of the key ring (see `crypto/key-store.ts`). */
const KEY_RING_NAME = 'token-key-ring';

/** What STS asks the signer for, after its policy check allowed every listed token. */
export type TokenSignRequest = {
  environment: string;
  workload: string;
  /** How the caller proved its identity: `worker-binding` or the OIDC provider. */
  identity: string;
  /** The source attestation's `exp` in seconds, or null for a worker binding (no attestation). */
  attestationExp: number | null;
  request: MintRequest;
};

const TokenSignRequestSchema = z.strictObject({
  environment: StsEnvironmentSchema,
  workload: WorkloadNameSchema,
  identity: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  attestationExp: z.number().int().positive().nullable(),
  request: MintRequestSchema,
});

export type TokenSignResult =
  /** One token per requested entry, in request order, and their audit row committed. */
  | { status: 'signed'; tokens: IssuedToken[] }
  /** The attestation's `exp` leaves under `MIN_TOKEN_LIFETIME_SECONDS`; nothing was signed. */
  | { status: 'attestation_expiring' }
  /** Nothing was signed or nothing returned: the audit append failed, or the call was misaddressed. */
  | { status: 'unavailable' };

export type TokenJwks = { keys: TokenJwk[] };

const PublicJwkSchema = z.object({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  x: z.string(),
});

/**
 * A fresh Ed25519 key. Generated extractable only so its PKCS#8 can be stored in this object's own
 * storage; signing uses a non-extractable import of those bytes, the same key a restarted object
 * loads.
 */
async function generateTokenKey(): Promise<GeneratedKey> {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  if (!('privateKey' in pair)) throw new Error('Ed25519 key generation returned a single key');
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  if (!(pkcs8 instanceof ArrayBuffer)) throw new Error('PKCS#8 export returned a JWK');
  const { x } = PublicJwkSchema.parse(await crypto.subtle.exportKey('jwk', pair.publicKey));
  return {
    kid: await calculateJwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x }),
    pkcs8: bytesToBase64url(new Uint8Array(pkcs8)),
    x,
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/**
 * One shard of the environment's token signers (`TOKEN_SIGNER_SHARDS`): its own service-token key
 * ring and its `sts:<environment>:tokens:<shard>` audit stream (design 5.7, 6.1). STS picks a shard
 * per call, so any shard signs for any workload. A mint signs every token of the call and appends
 * one audit row listing them before it returns; a failed append returns no token. Relayed rows
 * are deleted after `TOKEN_AUDIT_RETENTION_MS`, so the table stays bounded at any call rate.
 * Rotation runs on this object's alarm and, should the alarm be late, at the start of the next
 * call, so no cron is involved. Callers do not retry a mint: a retry after a committed append
 * would audit tokens the caller never got.
 */
export class TokenSignerDO extends DurableObject<Env> {
  private readonly config: StsConfig;
  private readonly audit: AuditLog;
  private readonly stream: string;
  private ring: KeyRing = { keys: [] };
  /** Non-extractable signing keys by kid, imported once per instance. */
  private readonly signingKeys = new Map<string, CryptoKey>();
  /** The alarm time this instance last read or set (null: none); undefined until first read. */
  private alarmAt: number | null | undefined = undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = readConfig(env);
    const config = this.config;
    const shard = Array.from({ length: TOKEN_SIGNER_SHARDS }, (_, index) => index).find(index =>
      ctx.id.equals(getTokenSignerStub(env, config, index).id)
    );
    // Addressed by a name that is no shard of this environment: every call fails.
    if (shard === undefined) throw new Error('token signer addressed by an unknown name');
    this.audit = new AuditLog(ctx.storage, env.AUDIT_QUEUE, {
      retentionMs: TOKEN_AUDIT_RETENTION_MS,
      pruneIntervalMs: TOKEN_AUDIT_PRUNE_INTERVAL_MS,
    });
    this.stream = `sts:${config.environment}:tokens:${shard}`;
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(drizzle(ctx.storage, { schema }), migrations);
      const stored: unknown = await ctx.storage.get(KEY_RING_NAME);
      if (stored !== undefined) this.ring = KeyRingSchema.parse(stored);
      await this.advance(Date.now());
    });
  }

  async mint(raw: TokenSignRequest): Promise<TokenSignResult> {
    const input = TokenSignRequestSchema.parse(raw);
    if (input.environment !== this.config.environment) {
      // Meant for another environment: refuse rather than sign for it.
      return { status: 'unavailable' };
    }
    await this.advanceIfDue(Date.now());

    const issuedAt = Math.floor(Date.now() / 1000);
    const lifetimeCap = issuedAt + SERVICE_TOKEN_LIFETIME_SECONDS;
    const expiresAt =
      input.attestationExp === null ? lifetimeCap : Math.min(lifetimeCap, input.attestationExp);
    if (expiresAt - issuedAt < MIN_TOKEN_LIFETIME_SECONDS)
      return { status: 'attestation_expiring' };

    const key = this.currentKey();
    const signingKey = await this.signingKey(key);
    const tokens = await Promise.all(
      input.request.tokens.map(async ({ audience, scope }): Promise<IssuedToken> => {
        const jti = crypto.randomUUID();
        const token = await new SignJWT({
          client_id: input.workload,
          req: input.workload,
          env: this.config.environment,
          scope,
        })
          .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM, typ: ACCESS_TOKEN_TYPE, kid: key.kid })
          .setIssuer(this.config.issuer)
          .setSubject(serviceSubject(input.workload))
          .setAudience(audience)
          .setJti(jti)
          .setIssuedAt(issuedAt)
          .setExpirationTime(expiresAt)
          .sign(signingKey);
        return { status: 'issued', audience, scope, token, jti, expiresAt };
      })
    );

    try {
      await this.audit.append(
        this.stream,
        tokenIssuedEvent({
          environment: this.config.environment,
          workload: input.workload,
          identity: input.identity,
          kid: key.kid,
          issuedAt,
          expiresAt,
          attestationCapped: expiresAt < lifetimeCap,
          tokens,
        })
      );
    } catch (error) {
      console.error('sts: token audit append failed; no token is returned', {
        workload: input.workload,
        reason: errorName(error),
      });
      return { status: 'unavailable' };
    }
    // In the same output gate as the audit row: the retired key stays published past this exp.
    if (recordSignedExp(this.ring, key.kid, expiresAt)) {
      void this.ctx.storage.put(KEY_RING_NAME, this.ring);
    }
    await this.scheduleRelay();
    return { status: 'signed', tokens };
  }

  /** Next, current and retired-in-grace public keys; never private material. */
  async getJwks(): Promise<TokenJwks> {
    await this.advanceIfDue(Date.now());
    return { keys: publishedKeys(this.ring) };
  }

  async alarm(): Promise<void> {
    // A fired alarm is no longer stored.
    this.alarmAt = null;
    const now = Date.now();
    await this.advanceIfDue(now);
    let relayFailed = false;
    try {
      await this.audit.relay(this.stream);
    } catch (error) {
      relayFailed = true;
      console.warn('sts: token audit relay failed; rows stay for the next alarm', {
        reason: errorName(error),
      });
    }
    this.audit.pruneIfDue(now);
    await this.scheduleAlarm(Date.now(), relayFailed);
  }

  private currentKey(): TokenKey {
    const current = this.ring.keys.find(key => key.state === 'current');
    if (current === undefined) throw new Error('the token key ring has no current key');
    return current;
  }

  private async signingKey(key: TokenKey): Promise<CryptoKey> {
    const cached = this.signingKeys.get(key.kid);
    if (cached !== undefined) return cached;
    const imported = await crypto.subtle.importKey(
      'pkcs8',
      new Uint8Array(base64urlToBytes(key.pkcs8)),
      { name: 'Ed25519' },
      false,
      ['sign']
    );
    this.signingKeys.set(key.kid, imported);
    return imported;
  }

  /** Rotation and emergency removal run one at a time, and only when something is due. */
  private async advanceIfDue(now: number): Promise<void> {
    if (keyRingDueAt(this.ring, this.config.revokedTokenKids, now) > now) return;
    await this.ctx.blockConcurrencyWhile(() => this.advance(Date.now()));
  }

  /**
   * Applies the changes due at `now`, appends one audit event per change, then stores the ring;
   * the in-memory ring changes only after both, so a failure leaves the stored ring in force.
   */
  private async advance(now: number): Promise<void> {
    const result = await advanceKeyRing(this.ring, {
      now,
      revokedKids: this.config.revokedTokenKids,
      generate: generateTokenKey,
    });
    if (result.changes.length > 0 || result.revocations.length > 0) {
      const { environment } = this.config;
      for (const revocation of result.revocations) {
        await this.audit.append(this.stream, tokenKeyRevokedEvent({ environment, revocation }));
        console.warn('sts: token-signing key removed in an emergency', { ...revocation });
      }
      for (const change of result.changes) {
        await this.audit.append(this.stream, tokenKeyRotatedEvent({ environment, change }));
      }
      // A mint already past its key read may have raised a key's latest exp during the awaits
      // above; keep that value, or the retired key could leave the key set before its last token.
      keepLatestSignedExp(result.ring, this.ring);
      await this.ctx.storage.put(KEY_RING_NAME, result.ring);
      this.ring = result.ring;
      for (const kid of this.signingKeys.keys()) {
        if (!result.ring.keys.some(key => key.kid === kid)) this.signingKeys.delete(kid);
      }
    }
    await this.scheduleAlarm(now, false);
  }

  private async readAlarm(): Promise<number | null> {
    if (this.alarmAt === undefined) this.alarmAt = await this.ctx.storage.getAlarm();
    return this.alarmAt;
  }

  private async writeAlarm(at: number): Promise<void> {
    await this.ctx.storage.setAlarm(at);
    this.alarmAt = at;
  }

  /** Sets the relay alarm unless one is due soon; the kept alarm time spares a storage read. */
  private async scheduleRelay(): Promise<void> {
    try {
      const now = Date.now();
      const alarm = await this.readAlarm();
      if (alarm === null || alarm > now + RELAY_DELAY_MS || alarm < now) {
        await this.writeAlarm(now + RELAY_DELAY_MS);
      }
    } catch (error) {
      // The row is committed; the next mint or alarm relays it.
      this.alarmAt = undefined;
      console.warn('sts: relay alarm could not be set', { reason: errorName(error) });
    }
  }

  /** The earliest of: the next ring change, a relay of unsent rows, the next prune. */
  private async scheduleAlarm(now: number, relayFailed: boolean): Promise<void> {
    let target = keyRingDueAt(this.ring, this.config.revokedTokenKids, now);
    if (this.audit.hasUnrelayed()) {
      target = Math.min(target, now + (relayFailed ? RELAY_RETRY_MS : RELAY_DELAY_MS));
    } else if (this.audit.hasRows()) {
      target = Math.min(target, Math.max(now + 1_000, this.audit.nextPruneAt()));
    }
    target = Math.max(target, now + 1_000);
    const current = await this.readAlarm();
    if (current === null || current > target || current < now) {
      await this.writeAlarm(target);
    }
  }
}
