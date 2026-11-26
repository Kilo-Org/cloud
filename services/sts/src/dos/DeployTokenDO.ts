import { withDORetry } from '@kilocode/worker-utils';
import {
  CloudflareTokenIdSchema,
  StsEnvironmentSchema,
  WorkloadNameSchema,
  type DeployTokenLimitedReason,
} from '@kilocode/sts-contracts';
import { DurableObject } from 'cloudflare:workers';
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { z } from 'zod';
import migrations from '../../drizzle.deploy-token/migrations';
import {
  deployTokenMintedEvent,
  deployTokenReapedEvent,
  deployTokenRevokedEvent,
  type DeployTokenAuditCaller,
  type DeployTokenDeleteCause,
  type DeployTokenDeletionResult,
} from '../audit/events';
import { AuditLog } from '../audit/log';
import {
  CloudflareTokens,
  cloudflareTime,
  type CloudflareTokenPolicy,
  type CreatedToken,
  type ListedToken,
} from '../cloudflare/client';
import {
  CLOUDFLARE_MINTING_TOKEN_SECRET,
  DEPLOY_TOKEN_DELETES_PER_ALARM,
  DEPLOY_TOKEN_DELETE_RETRY_CAP_MS,
  DEPLOY_TOKEN_DELETE_RETRY_MS,
  DEPLOY_TOKEN_EXPIRY_TOLERANCE_MS,
  DEPLOY_TOKEN_MINT_BUDGET_MS,
  DEPLOY_TOKEN_RETRY_AFTER_SECONDS,
  DEPLOY_TOKEN_ROW_RETENTION_MS,
  DEPLOY_TOKEN_SWEEP_INTERVAL_MS,
  DEPLOY_TOKEN_SWEEP_PAGES_PER_ALARM,
  DEPLOY_TOKEN_SWEEP_PAGE_SIZE,
  MINTING_CREDENTIAL_CACHE_MS,
  MINTING_FOLDER,
  RELAY_DELAY_MS,
  RELAY_RETRY_MS,
} from '../constants';
import * as schema from '../db/deploy-token-schema';
import { readConfig, type Env, type StsConfig } from '../env';
import { GithubRunSchema } from '../identity/verify';
import { InfisicalClient } from '../infisical/client';
import {
  CloudflareDeployGrantSchema,
  FORBIDDEN_PERMISSION_GROUP_NAME,
  type CloudflareDeployGrant,
} from '../policy/schema';
import { getSignerStub } from './stubs';

type DeployTokenDatabase = DrizzleSqliteDODatabase<typeof schema>;
type DeployTokenRow = typeof schema.deployToken.$inferSelect;

const HOUR_MS = 60 * 60 * 1000;

const CallerSchema = z.strictObject({
  workload: WorkloadNameSchema,
  identity: z.literal('github'),
  channel: z.literal('http'),
  run: GithubRunSchema,
});

/** What STS asks the deploy-token object for, after its policy check allowed the grant. */
export type DeployTokenMintRequest = {
  environment: string;
  caller: DeployTokenAuditCaller;
  /** The policy's `cloudflare-deploy` entry, as loaded. */
  grant: CloudflareDeployGrant;
  /** When STS called this object (epoch milliseconds): the creation budget runs from here. */
  requestedAt: number;
};

const DeployTokenMintRequestSchema = z.strictObject({
  environment: StsEnvironmentSchema,
  caller: CallerSchema,
  grant: CloudflareDeployGrantSchema,
  requestedAt: z.number().int().positive(),
});

export type DeployTokenMintResult =
  /** Handed to the caller; its `deploy_token.minted` row is committed. */
  | { status: 'minted'; token: string; tokenId: string; expiresAt: number; ttlSeconds: number }
  | { status: 'limited'; reason: DeployTokenLimitedReason; retryAfterSeconds: number }
  | { status: 'unavailable'; retryAfterSeconds: number };

export type DeployTokenRevokeRequest = {
  environment: string;
  caller: DeployTokenAuditCaller;
  tokenId: string;
};

const DeployTokenRevokeRequestSchema = z.strictObject({
  environment: StsEnvironmentSchema,
  caller: CallerSchema,
  tokenId: CloudflareTokenIdSchema,
});

export type DeployTokenRevokeOutcome =
  | { status: 'revoked' }
  /** The caller hears `not_found` in every case; the reason is for its denial row. */
  | { status: 'not_found'; reason: 'not_owner' | 'other_run' | 'unknown_token' }
  | { status: 'unavailable'; retryAfterSeconds: number };

type CredentialRead = { status: 'ok'; value: string } | { status: 'unavailable'; detail: string };

/** Why one deletion attempt could not reach Cloudflare, or Cloudflare refused it. */
type FailedAttempt = { detail: string; credentialRefused: boolean; retryAfterMs: number | null };

const UNAVAILABLE = {
  status: 'unavailable',
  retryAfterSeconds: DEPLOY_TOKEN_RETRY_AFTER_SECONDS,
} as const;

function retryAfterSeconds(ms: number): number {
  return Math.min(3600, Math.max(1, Math.ceil(ms / 1000)));
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/** Every token STS mints in `environment` carries this name prefix; the sweep matches on it. */
export function deployTokenNamePrefix(environment: string): string {
  return `sts-${environment}-`;
}

/**
 * The policies a token of `grant` carries: the account-scoped groups on the account, the
 * zone-scoped groups on each listed zone (https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/).
 */
export function deployTokenPolicies(
  accountId: string,
  grant: CloudflareDeployGrant
): CloudflareTokenPolicy[] {
  const policies: CloudflareTokenPolicy[] = [];
  const account = grant.permissionGroups.filter(group => group.scope === 'account');
  if (account.length > 0) {
    policies.push({
      effect: 'allow',
      permission_groups: account.map(group => ({ id: group.id })),
      resources: { [`com.cloudflare.api.account.${accountId}`]: '*' },
    });
  }
  const zone = grant.permissionGroups.filter(group => group.scope === 'zone');
  if (zone.length > 0) {
    policies.push({
      effect: 'allow',
      permission_groups: zone.map(group => ({ id: group.id })),
      resources: Object.fromEntries(
        grant.zones.map(id => [`com.cloudflare.api.account.zone.${id}`, '*' as const])
      ),
    });
  }
  return policies;
}

/**
 * True when the token Cloudflare made carries exactly the permission groups asked for, and none
 * whose Cloudflare name administers tokens or members.
 */
function carriesGrant(token: CreatedToken, grant: CloudflareDeployGrant): boolean {
  const asked = new Set(grant.permissionGroups.map(group => group.id));
  const got = new Set(token.permissionGroups.map(group => group.id));
  if (asked.size !== got.size || [...asked].some(id => !got.has(id))) return false;
  return !token.permissionGroups.some(
    group => group.name !== null && FORBIDDEN_PERMISSION_GROUP_NAME.test(group.name)
  );
}

/**
 * One object per environment (design 6.1 job 3, 4.4): it mints Cloudflare account API tokens for
 * GitHub deploy jobs with the minting credential from `MINTING_FOLDER`, keeps one row per token
 * with its owner (never the token or the credential), enforces each workload's active and hourly
 * limits, deletes tokens on revoke and at expiry, and owns the `sts:<environment>:deploy-tokens`
 * audit stream. A token is returned only with its `deploy_token.minted` row committed; one STS
 * cannot hand over is deleted at once. A deletion Cloudflare cannot take is audited and retried by
 * the alarm until it succeeds, because an expired token still counts against the account's
 * 500-token cap. The minting credential lives in memory only. Deploys are few (tens a day), so one
 * object serves the environment.
 */
export class DeployTokenDO extends DurableObject<Env> {
  private readonly config: StsConfig;
  private readonly db: DeployTokenDatabase;
  private readonly audit: AuditLog;
  private readonly stream: string;
  private readonly manager: InfisicalClient;
  /** Deletions in flight, by token id: concurrent ones (callers and the alarm) share one call. */
  private readonly deleting = new Map<string, Promise<DeployTokenDeletionResult>>();
  /** The minting credential and when it was read; memory only, never storage. */
  private credential: { value: string; readAt: number } | null = null;
  private pendingCredential: Promise<CredentialRead> | null = null;
  /** No Cloudflare call before this time: Cloudflare answered 429 with `Retry-After`. */
  private cloudflareHoldUntil = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const config = readConfig(env);
    this.config = config;
    this.db = drizzle(ctx.storage, { schema });
    this.audit = new AuditLog(ctx.storage, env.AUDIT_QUEUE);
    this.stream = `sts:${config.environment}:deploy-tokens`;
    this.manager = new InfisicalClient(config.manager, () =>
      withDORetry(
        () => getSignerStub(env, config),
        stub => stub.signManagerToken(),
        'sts.signManagerToken'
      )
    );
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
    });
  }

  /**
   * Mints one token. The budget runs from when STS called this object. The pending row taken
   * before the Cloudflare call holds the workload's slot, so concurrent requests cannot pass the
   * limits together. Never retried by STS: a creation that timed out may have made a token, which
   * the sweep deletes once it expired.
   */
  async mint(raw: DeployTokenMintRequest): Promise<DeployTokenMintResult> {
    const input = DeployTokenMintRequestSchema.parse(raw);
    if (input.environment !== this.config.environment) return UNAVAILABLE;
    const accountId = this.config.cloudflareDeployAccountId;
    if (accountId === null) {
      console.warn('sts: deploy token refused: CF_DEPLOY_ACCOUNT_ID is empty in this environment');
      return UNAVAILABLE;
    }
    const { caller, grant } = input;
    const callStartedAt = Date.now();
    // A Worker clock ahead of this one must not lengthen the budget.
    const deadline = Math.min(input.requestedAt, callStartedAt) + DEPLOY_TOKEN_MINT_BUDGET_MS;
    if (callStartedAt >= deadline) {
      console.error('sts: deploy token request reached the object after its budget; none is made', {
        workload: caller.workload,
      });
      return UNAVAILABLE;
    }
    if (callStartedAt < this.cloudflareHoldUntil) {
      return {
        status: 'unavailable',
        retryAfterSeconds: retryAfterSeconds(this.cloudflareHoldUntil - callStartedAt),
      };
    }
    const limited = this.limitFor(caller.workload, grant, callStartedAt);
    if (limited !== null) return limited;

    const { slot } = this.db
      .insert(schema.deployToken)
      .values({
        workload: caller.workload,
        caller: JSON.stringify(caller),
        runId: caller.run.runId,
        permissionSet: grant.permissionSet,
        state: 'pending',
        createdAt: callStartedAt,
        expiresAt: deadline,
      })
      .returning({ slot: schema.deployToken.slot })
      .get();
    this.ensureSweepScheduled(callStartedAt);

    const credential = await this.mintingCredential();
    if (credential.status !== 'ok') {
      console.error('sts: deploy token refused: no minting credential', {
        workload: caller.workload,
        detail: credential.detail,
      });
      return await this.failCreation(slot);
    }
    const name = `${deployTokenNamePrefix(this.config.environment)}${caller.workload}-${caller.run.runId}-${slot}`;
    const notBefore = Date.now();
    const requestedExpiry = Date.parse(cloudflareTime(notBefore + grant.ttlSeconds * 1000));
    const created = await new CloudflareTokens(accountId).create(credential.value, {
      name,
      policies: deployTokenPolicies(accountId, grant),
      notBefore,
      expiresAt: requestedExpiry,
    });
    const finishedAt = Date.now();
    if (created.status === 'refused') {
      console.error('sts: Cloudflare refused the deploy token', {
        workload: caller.workload,
        status: created.httpStatus,
      });
      this.noteFailure(created);
      return await this.failCreation(slot, created.retryAfterMs);
    }
    if (created.status === 'unknown') {
      // A token may exist that nobody received: the sweep deletes it once it expired.
      console.error('sts: deploy token creation outcome unknown; the sweep checks for it', {
        workload: caller.workload,
        detail: created.detail,
      });
      this.requestSweep(requestedExpiry + DEPLOY_TOKEN_EXPIRY_TOLERANCE_MS);
      return await this.failCreation(slot);
    }

    const { token } = created;
    let cause: DeployTokenDeleteCause | null = null;
    if (finishedAt > deadline) {
      cause = 'late';
    } else if (Math.abs(token.expiresAt - requestedExpiry) > DEPLOY_TOKEN_EXPIRY_TOLERANCE_MS) {
      cause = 'expiry_mismatch';
    } else if (!carriesGrant(token, grant)) {
      cause = 'grant_mismatch';
    } else {
      try {
        await this.audit.append(
          this.stream,
          deployTokenMintedEvent({
            environment: this.config.environment,
            caller,
            permissionSet: grant.permissionSet,
            tokenId: token.id,
            tokenName: name,
            ttlSeconds: grant.ttlSeconds,
            expiresAt: token.expiresAt,
            permissionGroups: grant.permissionGroups.map(group => group.id),
            zones: grant.zones,
            intendedScripts: grant.intendedScripts,
          })
        );
        // The row is written; the token still goes back only while STS is waiting for it.
        if (Date.now() > deadline) cause = 'late';
      } catch (error) {
        console.error('sts: deploy token audit append failed; the token is deleted', {
          workload: caller.workload,
          reason: errorName(error),
        });
        cause = 'audit_failed';
      }
    }
    if (cause !== null) {
      console.error('sts: deploy token not handed over; it is deleted', {
        workload: caller.workload,
        cause,
      });
      // Owed until Cloudflare takes it: the alarm retries this row if the first attempt fails.
      this.db
        .update(schema.deployToken)
        .set({ tokenId: token.id, state: 'failed', expiresAt: token.expiresAt, deleteCause: cause })
        .where(eq(schema.deployToken.slot, slot))
        .run();
      await this.deleteOnce(token.id);
      await this.scheduleAlarm(Date.now(), false);
      return UNAVAILABLE;
    }
    // In the same output gate as the audit row.
    this.db
      .update(schema.deployToken)
      .set({ tokenId: token.id, state: 'active', expiresAt: token.expiresAt })
      .where(eq(schema.deployToken.slot, slot))
      .run();
    await this.scheduleAlarm(Date.now(), false);
    return {
      status: 'minted',
      token: token.value,
      tokenId: token.id,
      expiresAt: token.expiresAt,
      ttlSeconds: grant.ttlSeconds,
    };
  }

  /**
   * Deletes one of the caller's own tokens. A token id STS never handed to this workload is
   * `not_found`, whoever holds it, and so is a token asked for by another run of the same workload.
   * A token of the caller's that is already deleted answers `revoked` without a Cloudflare call.
   */
  async revoke(raw: DeployTokenRevokeRequest): Promise<DeployTokenRevokeOutcome> {
    const input = DeployTokenRevokeRequestSchema.parse(raw);
    if (input.environment !== this.config.environment) return UNAVAILABLE;
    const row = this.rowFor(input.tokenId);
    if (row === undefined || row.state === 'failed' || row.state === 'pending') {
      return { status: 'not_found', reason: 'unknown_token' };
    }
    if (row.workload !== input.caller.workload) return { status: 'not_found', reason: 'not_owner' };
    if (row.runId !== input.caller.run.runId) return { status: 'not_found', reason: 'other_run' };
    if (row.state === 'deleted') return { status: 'revoked' };

    if (row.deleteCause === null) {
      // Owed from now on: the alarm retries it if Cloudflare cannot take it.
      this.db
        .update(schema.deployToken)
        .set({ deleteCause: 'caller' })
        .where(eq(schema.deployToken.slot, row.slot))
        .run();
    }
    const result = await this.deleteOnce(input.tokenId);
    await this.scheduleAlarm(Date.now(), false);
    return result === 'delete_failed' ? UNAVAILABLE : { status: 'revoked' };
  }

  /**
   * Relays audit rows, marks expired tokens owed, retries owed deletions (at most
   * `DEPLOY_TOKEN_DELETES_PER_ALARM`, least recently tried first), runs the sweep when due with
   * what is left of that budget, and prunes ended rows.
   */
  async alarm(): Promise<void> {
    let failed = false;
    try {
      await this.audit.relay(this.stream);
    } catch (error) {
      failed = true;
      console.warn('sts: deploy-token audit relay failed; rows stay for the next alarm', {
        reason: errorName(error),
      });
    }
    let now = Date.now();
    this.db
      .update(schema.deployToken)
      .set({ deleteCause: 'expired' })
      .where(
        and(
          eq(schema.deployToken.state, 'active'),
          isNull(schema.deployToken.deleteCause),
          lte(schema.deployToken.expiresAt, now)
        )
      )
      .run();
    const owed = this.owedDeletions(now, DEPLOY_TOKEN_DELETES_PER_ALARM);
    for (const row of owed) {
      if (row.tokenId !== null) await this.deleteOnce(row.tokenId);
    }
    await this.sweepIfDue(Date.now(), DEPLOY_TOKEN_DELETES_PER_ALARM - owed.length);
    now = Date.now();
    this.audit.pruneIfDue(now);
    this.db
      .delete(schema.deployToken)
      .where(
        and(
          isNull(schema.deployToken.deleteCause),
          ne(schema.deployToken.state, 'active'),
          lt(
            sql`coalesce(${schema.deployToken.endedAt}, ${schema.deployToken.expiresAt})`,
            now - DEPLOY_TOKEN_ROW_RETENTION_MS
          )
        )
      )
      .run();
    await this.scheduleAlarm(Date.now(), failed, true);
  }

  /**
   * The refusal for a workload at its limits: its unexpired tokens (a creation in progress
   * counts), then its creations in the last hour, whatever their outcome.
   */
  private limitFor(
    workload: string,
    grant: CloudflareDeployGrant,
    now: number
  ): DeployTokenMintResult | null {
    const active = this.db
      .select({ expiresAt: schema.deployToken.expiresAt })
      .from(schema.deployToken)
      .where(
        and(
          eq(schema.deployToken.workload, workload),
          inArray(schema.deployToken.state, ['pending', 'active']),
          gt(schema.deployToken.expiresAt, now)
        )
      )
      .all();
    if (active.length >= grant.maxActive) {
      const soonest = Math.min(...active.map(row => row.expiresAt));
      return {
        status: 'limited',
        reason: 'too_many_active',
        retryAfterSeconds: retryAfterSeconds(soonest - now),
      };
    }
    const recent = this.db
      .select({ createdAt: schema.deployToken.createdAt })
      .from(schema.deployToken)
      .where(
        and(
          eq(schema.deployToken.workload, workload),
          gt(schema.deployToken.createdAt, now - HOUR_MS)
        )
      )
      .orderBy(asc(schema.deployToken.createdAt))
      .all();
    if (recent.length >= grant.maxPerHour) {
      return {
        status: 'limited',
        reason: 'rate_limited',
        retryAfterSeconds: retryAfterSeconds(recent[0].createdAt + HOUR_MS - now),
      };
    }
    return null;
  }

  /** Ends a creation that gave nothing to the caller and made no known token. */
  private async failCreation(
    slot: number,
    retryAfterMs: number | null = null
  ): Promise<DeployTokenMintResult> {
    const now = Date.now();
    this.db
      .update(schema.deployToken)
      .set({ state: 'failed', endedAt: now })
      .where(eq(schema.deployToken.slot, slot))
      .run();
    await this.scheduleAlarm(now, false);
    return {
      status: 'unavailable',
      retryAfterSeconds:
        retryAfterMs === null ? DEPLOY_TOKEN_RETRY_AFTER_SECONDS : retryAfterSeconds(retryAfterMs),
    };
  }

  private rowFor(tokenId: string): DeployTokenRow | undefined {
    return this.db
      .select()
      .from(schema.deployToken)
      .where(eq(schema.deployToken.tokenId, tokenId))
      .get();
  }

  /**
   * The minting credential, read from the manager when the copy in memory is older than
   * `MINTING_CREDENTIAL_CACHE_MS` or was dropped after Cloudflare refused it. Concurrent reads
   * merge into one.
   */
  private async mintingCredential(): Promise<CredentialRead> {
    const cached = this.credential;
    if (cached !== null && Date.now() - cached.readAt < MINTING_CREDENTIAL_CACHE_MS) {
      return { status: 'ok', value: cached.value };
    }
    this.pendingCredential ??= this.readMintingCredential().finally(() => {
      this.pendingCredential = null;
    });
    return await this.pendingCredential;
  }

  private async readMintingCredential(): Promise<CredentialRead> {
    const read = await this.manager.readMintingSecret(CLOUDFLARE_MINTING_TOKEN_SECRET);
    if (read.status === 'ok') {
      this.credential = { value: read.value, readAt: Date.now() };
      return { status: 'ok', value: read.value };
    }
    if (read.status === 'missing') {
      return {
        status: 'unavailable',
        detail: `${CLOUDFLARE_MINTING_TOKEN_SECRET} is missing in ${MINTING_FOLDER}`,
      };
    }
    return { status: 'unavailable', detail: read.detail };
  }

  /** Drops a refused credential and honours a `Retry-After`; logs nothing of the credential. */
  private noteFailure(failure: { credentialRefused: boolean; retryAfterMs: number | null }): void {
    if (failure.credentialRefused) this.credential = null;
    if (failure.retryAfterMs !== null) {
      this.cloudflareHoldUntil = Math.max(
        this.cloudflareHoldUntil,
        Date.now() + failure.retryAfterMs
      );
    }
  }

  /** One deletion attempt of an owed token, shared with any attempt already in flight. */
  private async deleteOnce(tokenId: string): Promise<DeployTokenDeletionResult> {
    const inFlight = this.deleting.get(tokenId);
    if (inFlight !== undefined) return await inFlight;
    const pending = this.attemptDeletion(tokenId).finally(() => {
      this.deleting.delete(tokenId);
    });
    this.deleting.set(tokenId, pending);
    return await pending;
  }

  /**
   * Asks Cloudflare to delete an owed token (its row carries `deleteCause`) and sets when the alarm
   * may try it next. On success it writes `deploy_token.revoked` (or `deploy_token.reaped` for an
   * expired one) and ends the row. On failure, the first failure whose row is written marks the
   * row, so later failures write none, and an append that failed is tried again on the next
   * failure. A failed append after a success also leaves it owed: the retry finds the token gone
   * and writes the row then.
   */
  private async attemptDeletion(tokenId: string): Promise<DeployTokenDeletionResult> {
    const row = this.rowFor(tokenId);
    if (row === undefined || row.deleteCause === null) return 'gone';
    const cause = row.deleteCause;
    const caller: DeployTokenAuditCaller = CallerSchema.parse(JSON.parse(row.caller));
    const now = Date.now();
    const backoff = Math.min(
      DEPLOY_TOKEN_DELETE_RETRY_CAP_MS,
      DEPLOY_TOKEN_DELETE_RETRY_MS * 2 ** row.deleteAttempts
    );
    this.db
      .update(schema.deployToken)
      .set({ deleteRetryAt: now + backoff, deleteAttempts: row.deleteAttempts + 1 })
      .where(eq(schema.deployToken.slot, row.slot))
      .run();

    const failure = await this.deleteAtCloudflare(tokenId);
    const deletion: DeployTokenDeletionResult =
      failure === null ? 'deleted' : failure === 'gone' ? 'gone' : 'delete_failed';
    if (failure !== null && failure !== 'gone') {
      console.error('sts: deploy token deletion failed; the object retries it', {
        workload: row.workload,
        cause,
        detail: failure.detail,
      });
      this.noteFailure(failure);
      if (failure.retryAfterMs !== null && failure.retryAfterMs > backoff) {
        this.db
          .update(schema.deployToken)
          .set({ deleteRetryAt: Date.now() + failure.retryAfterMs })
          .where(eq(schema.deployToken.slot, row.slot))
          .run();
      }
      if (row.deleteFailureAudited) return deletion;
    }
    try {
      await this.audit.append(
        this.stream,
        cause === 'expired'
          ? deployTokenReapedEvent({
              environment: this.config.environment,
              source: 'ledger',
              caller,
              permissionSet: row.permissionSet,
              tokenId,
              tokenName: null,
              expiresAt: row.expiresAt,
              result: deletion,
            })
          : deployTokenRevokedEvent({
              environment: this.config.environment,
              caller,
              permissionSet: row.permissionSet,
              tokenId,
              cause,
              result: deletion,
            })
      );
    } catch (error) {
      console.error('sts: deploy token deletion audit append failed', {
        workload: row.workload,
        reason: errorName(error),
      });
      return 'delete_failed';
    }
    this.db
      .update(schema.deployToken)
      .set(
        deletion === 'delete_failed'
          ? { deleteFailureAudited: true }
          : {
              state: row.state === 'active' ? 'deleted' : 'failed',
              endedAt: Date.now(),
              deleteCause: null,
              deleteRetryAt: null,
            }
      )
      .where(eq(schema.deployToken.slot, row.slot))
      .run();
    return deletion;
  }

  /** One Cloudflare delete: null when deleted, `gone` on 404, otherwise why it failed. */
  private async deleteAtCloudflare(tokenId: string): Promise<null | 'gone' | FailedAttempt> {
    const accountId = this.config.cloudflareDeployAccountId;
    if (accountId === null) {
      return {
        detail: 'CF_DEPLOY_ACCOUNT_ID is empty',
        credentialRefused: false,
        retryAfterMs: null,
      };
    }
    if (Date.now() < this.cloudflareHoldUntil) {
      return {
        detail: 'cloudflare asked to wait (429)',
        credentialRefused: false,
        retryAfterMs: this.cloudflareHoldUntil - Date.now(),
      };
    }
    const credential = await this.mintingCredential();
    if (credential.status !== 'ok') {
      return { detail: credential.detail, credentialRefused: false, retryAfterMs: null };
    }
    const deletion = await new CloudflareTokens(accountId).delete(credential.value, tokenId);
    if (deletion.status === 'deleted') return null;
    if (deletion.status === 'gone') return 'gone';
    return deletion;
  }

  /**
   * The owed deletions due by `dueBy`, least recently tried first. Expired ones stay owed: an
   * expired Cloudflare token still counts against the account's cap until it is deleted.
   */
  private owedDeletions(dueBy: number, limit: number): DeployTokenRow[] {
    if (limit <= 0) return [];
    return this.db
      .select()
      .from(schema.deployToken)
      .where(
        and(
          isNotNull(schema.deployToken.deleteCause),
          isNotNull(schema.deployToken.tokenId),
          inArray(schema.deployToken.state, ['active', 'failed']),
          or(isNull(schema.deployToken.deleteRetryAt), lte(schema.deployToken.deleteRetryAt, dueBy))
        )
      )
      .orderBy(sql`coalesce(${schema.deployToken.deleteRetryAt}, 0)`, asc(schema.deployToken.slot))
      .limit(limit)
      .all();
  }

  /** The first mint starts the daily sweep. */
  private ensureSweepScheduled(now: number): void {
    this.db
      .insert(schema.deployTokenSweep)
      .values({ id: 1, nextSweepAt: now + DEPLOY_TOKEN_SWEEP_INTERVAL_MS, page: null })
      .onConflictDoNothing()
      .run();
  }

  /** Brings the next sweep forward to `at` when it is later. */
  private requestSweep(at: number): void {
    this.db
      .insert(schema.deployTokenSweep)
      .values({ id: 1, nextSweepAt: at, page: null })
      .onConflictDoUpdate({
        target: schema.deployTokenSweep.id,
        set: { nextSweepAt: sql`min(${schema.deployTokenSweep.nextSweepAt}, ${at})` },
      })
      .run();
  }

  private setSweep(nextSweepAt: number, page: number | null): void {
    this.db
      .update(schema.deployTokenSweep)
      .set({ nextSweepAt, page })
      .where(eq(schema.deployTokenSweep.id, 1))
      .run();
  }

  /**
   * Reads up to `DEPLOY_TOKEN_SWEEP_PAGES_PER_ALARM` pages of the account's token list and deletes,
   * within `budget`, every expired token named for this environment that STS holds no row for.
   * A page where it deleted something is read again (the list shifted); a page shorter than the
   * page size ends the sweep, and the next one runs a day later.
   */
  private async sweepIfDue(now: number, budget: number): Promise<void> {
    const state = this.db
      .select()
      .from(schema.deployTokenSweep)
      .where(eq(schema.deployTokenSweep.id, 1))
      .get();
    const accountId = this.config.cloudflareDeployAccountId;
    if (state === undefined || state.nextSweepAt > now || accountId === null) return;
    const soon = now + DEPLOY_TOKEN_DELETE_RETRY_MS;
    if (now < this.cloudflareHoldUntil) {
      this.setSweep(this.cloudflareHoldUntil, state.page);
      return;
    }
    const credential = await this.mintingCredential();
    if (credential.status !== 'ok') {
      console.error('sts: deploy token sweep has no minting credential', {
        detail: credential.detail,
      });
      this.setSweep(now + RELAY_RETRY_MS, state.page);
      return;
    }
    const tokens = new CloudflareTokens(accountId);
    const prefix = deployTokenNamePrefix(this.config.environment);
    let page = state.page ?? 1;
    let left = budget;
    for (let read = 0; read < DEPLOY_TOKEN_SWEEP_PAGES_PER_ALARM; read += 1) {
      const listed = await tokens.list(credential.value, page, DEPLOY_TOKEN_SWEEP_PAGE_SIZE);
      if (listed.status !== 'ok') {
        console.error('sts: deploy token sweep could not list tokens', { detail: listed.detail });
        this.noteFailure(listed);
        this.setSweep(Math.max(now + RELAY_RETRY_MS, this.cloudflareHoldUntil), page);
        return;
      }
      const orphans = listed.tokens.filter(
        token =>
          token.name.startsWith(prefix) &&
          token.expiresAt !== null &&
          token.expiresAt <= now &&
          this.rowFor(token.id) === undefined
      );
      let deleted = 0;
      for (const orphan of orphans) {
        if (left <= 0) break;
        left -= 1;
        if ((await this.sweepDelete(tokens, credential.value, orphan)) !== 'delete_failed') {
          deleted += 1;
        }
      }
      if (deleted < orphans.length) {
        // Out of budget, or a deletion failed: this page again on the next alarm.
        this.setSweep(soon, page);
        return;
      }
      if (deleted === 0) {
        if (listed.tokens.length < DEPLOY_TOKEN_SWEEP_PAGE_SIZE) {
          this.setSweep(now + DEPLOY_TOKEN_SWEEP_INTERVAL_MS, null);
          return;
        }
        page += 1;
      }
    }
    this.setSweep(soon, page);
  }

  /** Deletes one expired token the sweep found and audits the attempt. */
  private async sweepDelete(
    tokens: CloudflareTokens,
    credential: string,
    orphan: ListedToken
  ): Promise<DeployTokenDeletionResult> {
    const deletion = await tokens.delete(credential, orphan.id);
    const result: DeployTokenDeletionResult =
      deletion.status === 'unreachable' ? 'delete_failed' : deletion.status;
    if (deletion.status === 'unreachable') {
      console.error('sts: deploy token sweep deletion failed; the next sweep retries it', {
        detail: deletion.detail,
      });
      this.noteFailure(deletion);
    }
    try {
      await this.audit.append(
        this.stream,
        deployTokenReapedEvent({
          environment: this.config.environment,
          source: 'sweep',
          caller: null,
          permissionSet: null,
          tokenId: orphan.id,
          tokenName: orphan.name,
          expiresAt: orphan.expiresAt,
          result,
        })
      );
    } catch (error) {
      console.error('sts: deploy token sweep audit append failed', { reason: errorName(error) });
    }
    return result;
  }

  /** The earliest time a row is due for deletion, or null for none. */
  private nextRowPruneAt(): number | null {
    const row = this.db
      .select({
        end: sql<
          number | null
        >`min(coalesce(${schema.deployToken.endedAt}, ${schema.deployToken.expiresAt}))`,
      })
      .from(schema.deployToken)
      .where(and(isNull(schema.deployToken.deleteCause), ne(schema.deployToken.state, 'active')))
      .get();
    return row === undefined || row.end === null ? null : row.end + DEPLOY_TOKEN_ROW_RETENTION_MS;
  }

  /** The earliest expiry of a handed-over token not yet owed for deletion, or null. */
  private nextExpiry(): number | null {
    const row = this.db
      .select({ at: sql<number | null>`min(${schema.deployToken.expiresAt})` })
      .from(schema.deployToken)
      .where(and(eq(schema.deployToken.state, 'active'), isNull(schema.deployToken.deleteCause)))
      .get();
    return row?.at ?? null;
  }

  /**
   * Sets the alarm to the earliest of the audit work, the next owed deletion, the next expiry, the
   * sweep and the row prune. After an alarm (`afterAlarm`), owed deletions wait at least
   * `DEPLOY_TOKEN_DELETE_RETRY_MS`, so retries make at most `DEPLOY_TOKEN_DELETES_PER_ALARM`
   * Cloudflare deletes per 30 seconds whatever the number of owed tokens.
   */
  private async scheduleAlarm(now: number, failed: boolean, afterAlarm = false): Promise<void> {
    let target = Number.POSITIVE_INFINITY;
    if (this.audit.hasUnrelayed()) {
      target = now + (failed ? RELAY_RETRY_MS : RELAY_DELAY_MS);
    } else if (this.audit.hasRows()) {
      target = Math.max(now + 1_000, this.audit.nextPruneAt());
    }
    const [nextDeletion] = this.owedDeletions(Number.MAX_SAFE_INTEGER, 1);
    if (nextDeletion !== undefined) {
      const due = nextDeletion.deleteRetryAt ?? now;
      target = Math.min(
        target,
        afterAlarm ? Math.max(due, now + DEPLOY_TOKEN_DELETE_RETRY_MS) : due
      );
    }
    const expiry = this.nextExpiry();
    if (expiry !== null) target = Math.min(target, expiry);
    const sweep = this.db
      .select({ at: schema.deployTokenSweep.nextSweepAt })
      .from(schema.deployTokenSweep)
      .where(eq(schema.deployTokenSweep.id, 1))
      .get();
    if (sweep !== undefined && this.config.cloudflareDeployAccountId !== null) {
      target = Math.min(target, sweep.at);
    }
    const rowPrune = this.nextRowPruneAt();
    if (rowPrune !== null) target = Math.min(target, rowPrune);
    if (target === Number.POSITIVE_INFINITY) return;
    target = Math.max(target, now + 1_000);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > target || current < now) {
      await this.ctx.storage.setAlarm(target);
    }
  }
}
