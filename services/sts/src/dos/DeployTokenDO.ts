import { withDORetry } from '@kilocode/worker-utils';
import {
  CLOUDFLARE_DEPLOY_MAX_TTL_SECONDS,
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
  deployTokenMintFailedEvent,
  deployTokenMintedEvent,
  deployTokenReapedEvent,
  deployTokenRevokedEvent,
  deployTokenUnexpectedScriptEvent,
  type DeployTokenAuditCaller,
  type DeployTokenDeleteCause,
  type DeployTokenDeletionResult,
} from '../audit/events';
import { AuditLog } from '../audit/log';
import {
  CloudflareTokens,
  cloudflareTime,
  type CloudflareTokenPolicy,
  type ListedToken,
  type ReturnedTokenPolicy,
} from '../cloudflare/client';
import {
  CLOUDFLARE_FORBIDDEN_PERMISSION_GROUP_IDS,
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
  DEPLOY_TOKEN_UNEXPECTED_SCRIPT_EVENTS_PER_CHECK,
  MINTING_CREDENTIAL_CACHE_MS,
  MINTING_FOLDER,
  RELAY_DELAY_MS,
  RELAY_RETRY_MS,
} from '../constants';
import * as schema from '../db/deploy-token-schema';
import { readConfig, type Env, type StsConfig } from '../env';
import { GithubRunSchema } from '../identity/verify';
import { InfisicalClient } from '../infisical/client';
import { CloudflareDeployGrantSchema, type CloudflareDeployGrant } from '../policy/schema';
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
 * Why the policies Cloudflare returns for a created token are not exactly the ones STS sent, or
 * null when they are: the same policies with the same effect, permission-group ids and resources,
 * and every returned group named exactly as the policy declares its id (a name Cloudflare leaves
 * out makes the list unreadable, `null`). The loader refuses a declared name that administers
 * tokens or members and `mint` refuses a pinned forbidden id before the call, so an exact match
 * holds neither. Never includes a token value.
 */
export function returnedGrantProblem(
  returned: ReturnedTokenPolicy[] | null,
  sent: CloudflareTokenPolicy[],
  grant: CloudflareDeployGrant
): string | null {
  if (returned === null) return 'the returned policies are unreadable or name no group';
  const key = (effect: string, ids: string[], resources: Record<string, string>) =>
    JSON.stringify([
      effect,
      [...ids].sort(),
      Object.entries(resources).sort(([left], [right]) => left.localeCompare(right)),
    ]);
  const asked = sent
    .map(policy =>
      key(
        policy.effect,
        policy.permission_groups.map(group => group.id),
        policy.resources
      )
    )
    .sort();
  const got = returned
    .map(policy =>
      key(
        policy.effect,
        policy.permissionGroups.map(group => group.id),
        policy.resources
      )
    )
    .sort();
  if (asked.length !== got.length || asked.some((entry, index) => entry !== got[index])) {
    return 'the returned effect, groups or resources differ from the ones sent';
  }
  const declared = new Map(grant.permissionGroups.map(group => [group.id, group.name]));
  for (const policy of returned) {
    for (const group of policy.permissionGroups) {
      if (declared.get(group.id) !== group.name) {
        return `group ${group.id} is not named as the policy declares it`;
      }
    }
  }
  return null;
}

/**
 * A row the alarm may delete once it ended a day ago: no deletion owed, not a live token, and a
 * handed-over token only after the sweep compared its live window with the Worker scripts.
 */
const prunable = and(
  isNull(schema.deployToken.deleteCause),
  ne(schema.deployToken.state, 'active'),
  ne(schema.deployToken.state, 'pending'),
  or(ne(schema.deployToken.state, 'deleted'), eq(schema.deployToken.scriptsChecked, true))
);

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
  /** The permission groups no token may hold; a test's subclass sets its own. */
  static readonly forbiddenPermissionGroupIds: readonly string[] =
    CLOUDFLARE_FORBIDDEN_PERMISSION_GROUP_IDS;

  private readonly config: StsConfig;
  private readonly db: DeployTokenDatabase;
  private readonly audit: AuditLog;
  private readonly stream: string;
  private readonly manager: InfisicalClient;
  /** Deletions in flight, by token id: concurrent ones (callers and the alarm) share one call. */
  private readonly deleting = new Map<string, Promise<DeployTokenDeletionResult>>();
  /** The slots of the creations this instance is running; a `pending` row outside it was cut off. */
  private readonly creating = new Set<number>();
  /** The minting credential and when it was read; memory only, never storage. */
  private credential: { value: string; readAt: number } | null = null;
  private pendingCredential: Promise<CredentialRead> | null = null;
  /** No Cloudflare call before this time: Cloudflare answered 429 with `Retry-After`. */
  private cloudflareHoldUntil = 0;
  /** The alarm running now; Cloudflare refused the minting credential during it. */
  private alarmRun: { credentialRefused: boolean } | null = null;

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
    const pinned = (this.constructor as typeof DeployTokenDO).forbiddenPermissionGroupIds;
    const forbidden = grant.permissionGroups
      .map(group => group.id)
      .filter(id => pinned.includes(id));
    if (forbidden.length > 0) {
      // The loader refuses such a grant; this holds even for a grant that did not pass it.
      console.error('sts: deploy token refused: the grant lists a forbidden permission group', {
        workload: caller.workload,
        groups: forbidden,
      });
      return UNAVAILABLE;
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
        intendedScripts: JSON.stringify(grant.intendedScripts),
      })
      .returning({ slot: schema.deployToken.slot })
      .get();
    this.creating.add(slot);
    try {
      this.ensureSweepScheduled(callStartedAt);
      // Should this instance stop during the creation, the alarm finds the row past its budget.
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > deadline) await this.ctx.storage.setAlarm(deadline);
      return await this.create(slot, caller, grant, accountId, deadline);
    } finally {
      this.creating.delete(slot);
    }
  }

  /** The creation behind `mint`, for the slot it took. */
  private async create(
    slot: number,
    caller: DeployTokenAuditCaller,
    grant: CloudflareDeployGrant,
    accountId: string,
    deadline: number
  ): Promise<DeployTokenMintResult> {
    const credential = await this.mintingCredential();
    if (credential.status !== 'ok') {
      console.error('sts: deploy token refused: no minting credential', {
        workload: caller.workload,
        detail: credential.detail,
      });
      return await this.failCreation(slot);
    }
    const name = this.tokenName(caller.workload, caller.run.runId, slot);
    const policies = deployTokenPolicies(accountId, grant);
    const notBefore = Date.now();
    const requestedExpiry = Date.parse(cloudflareTime(notBefore + grant.ttlSeconds * 1000));
    const created = await new CloudflareTokens(accountId).create(credential.value, {
      name,
      policies,
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
      await this.auditMintFailed(caller, grant.permissionSet, slot, 'refused', created.httpStatus);
      return await this.failCreation(slot, created.retryAfterMs);
    }
    if (created.status === 'unknown') {
      // A token may exist that nobody received: the sweep deletes it once it expired.
      console.error('sts: deploy token creation outcome unknown; the sweep checks for it', {
        workload: caller.workload,
        detail: created.detail,
      });
      this.requestSweep(requestedExpiry + DEPLOY_TOKEN_EXPIRY_TOLERANCE_MS);
      await this.auditMintFailed(caller, grant.permissionSet, slot, 'unknown', null);
      return await this.failCreation(slot);
    }

    const { token } = created;
    let cause: DeployTokenDeleteCause | null = null;
    if (finishedAt > deadline) {
      cause = 'late';
    } else if (Math.abs(token.expiresAt - requestedExpiry) > DEPLOY_TOKEN_EXPIRY_TOLERANCE_MS) {
      cause = 'expiry_mismatch';
    } else {
      const problem = returnedGrantProblem(token.policies, policies, grant);
      if (problem !== null) {
        console.error('sts: Cloudflare returned another grant than the one asked for', {
          workload: caller.workload,
          problem,
        });
        cause = 'grant_mismatch';
      }
    }
    if (cause === null) {
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

  /** The name of the token a creation asks Cloudflare for. */
  private tokenName(workload: string, runId: string, slot: number): string {
    return `${deployTokenNamePrefix(this.config.environment)}${workload}-${runId}-${slot}`;
  }

  /** Writes `deploy_token.mint_failed`; a failed append is logged only, the creation has ended. */
  private async auditMintFailed(
    caller: DeployTokenAuditCaller,
    permissionSet: string,
    slot: number,
    outcome: 'unknown' | 'refused',
    httpStatus: number | null
  ): Promise<void> {
    try {
      await this.audit.append(
        this.stream,
        deployTokenMintFailedEvent({
          environment: this.config.environment,
          caller,
          permissionSet,
          slot,
          tokenName: this.tokenName(caller.workload, caller.run.runId, slot),
          outcome,
          httpStatus,
        })
      );
    } catch (error) {
      console.error('sts: deploy token mint_failed audit append failed', {
        workload: caller.workload,
        reason: errorName(error),
      });
    }
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
   * Relays audit rows, marks expired tokens owed, ends creations an earlier instance of this object
   * left `pending`, retries owed deletions (at most `DEPLOY_TOKEN_DELETES_PER_ALARM`, least
   * recently tried first), runs the sweep when due with what is left of that budget, and prunes
   * ended rows. Once Cloudflare answers 401 or 403 to the minting credential, the alarm makes no
   * further Cloudflare call and reads no credential until its next run.
   */
  async alarm(): Promise<void> {
    const run = { credentialRefused: false };
    this.alarmRun = run;
    try {
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
      await this.endInterruptedCreations(now);
      const owed = this.owedDeletions(now, DEPLOY_TOKEN_DELETES_PER_ALARM);
      for (const row of owed) {
        if (run.credentialRefused) break;
        if (row.tokenId !== null) await this.deleteOnce(row.tokenId);
      }
      if (!run.credentialRefused) {
        await this.sweepIfDue(Date.now(), DEPLOY_TOKEN_DELETES_PER_ALARM - owed.length);
      }
      now = Date.now();
      this.audit.pruneIfDue(now);
      this.db
        .delete(schema.deployToken)
        .where(
          and(
            prunable,
            lt(
              sql`coalesce(${schema.deployToken.endedAt}, ${schema.deployToken.expiresAt})`,
              now - DEPLOY_TOKEN_ROW_RETENTION_MS
            )
          )
        )
        .run();
      await this.scheduleAlarm(Date.now(), failed, true);
    } finally {
      this.alarmRun = null;
    }
  }

  /**
   * A `pending` row past its creation budget that no creation of this instance holds was left by
   * an instance that stopped while Cloudflare was creating its token: the creation's outcome is
   * unknown. Ends it, writes `deploy_token.mint_failed` (`unknown`), and brings the sweep forward
   * to when such a token has expired: its expiry is at most `CLOUDFLARE_DEPLOY_MAX_TTL_SECONDS`
   * after the budget ended, plus Cloudflare's tolerance.
   */
  private async endInterruptedCreations(now: number): Promise<void> {
    const interrupted = this.db
      .select()
      .from(schema.deployToken)
      .where(and(eq(schema.deployToken.state, 'pending'), lt(schema.deployToken.expiresAt, now)))
      .all()
      .filter(row => !this.creating.has(row.slot));
    for (const row of interrupted) {
      console.error('sts: a deploy token creation was interrupted; the sweep checks for it', {
        workload: row.workload,
      });
      this.requestSweep(
        row.expiresAt + CLOUDFLARE_DEPLOY_MAX_TTL_SECONDS * 1000 + DEPLOY_TOKEN_EXPIRY_TOLERANCE_MS
      );
      this.db
        .update(schema.deployToken)
        .set({ state: 'failed', endedAt: now })
        .where(eq(schema.deployToken.slot, row.slot))
        .run();
      await this.auditMintFailed(
        CallerSchema.parse(JSON.parse(row.caller)),
        row.permissionSet,
        row.slot,
        'unknown',
        null
      );
    }
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
      // A slot opens when enough creations leave the hour to bring the count below the cap; a
      // lowered cap can leave more than `maxPerHour` in it.
      const freeing = recent[recent.length - grant.maxPerHour];
      return {
        status: 'limited',
        reason: 'rate_limited',
        retryAfterSeconds: retryAfterSeconds(freeing.createdAt + HOUR_MS - now),
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

  /**
   * Drops a refused credential (and ends the running alarm's Cloudflare work, so it reads no new
   * credential before its next run) and honours a `Retry-After`; logs nothing of the credential.
   */
  private noteFailure(failure: { credentialRefused: boolean; retryAfterMs: number | null }): void {
    if (failure.credentialRefused) {
      this.credential = null;
      if (this.alarmRun !== null) this.alarmRun.credentialRefused = true;
    }
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
   * Starts a sweep with the Worker script check (`checkScripts`), then reads up to
   * `DEPLOY_TOKEN_SWEEP_PAGES_PER_ALARM` pages of the account's token list and deletes, within
   * `budget`, every expired token named for this environment that STS holds no row for. A page
   * where it deleted something is read again (the list shifted); a page shorter than the page size
   * ends the sweep, and the next one runs a day later.
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
    if (state.page === null && !(await this.checkScripts(tokens, credential.value, now))) {
      this.setSweep(Math.max(now + RELAY_RETRY_MS, this.cloudflareHoldUntil), null);
      return;
    }
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
        if (left <= 0 || this.alarmRun?.credentialRefused === true) break;
        left -= 1;
        if ((await this.sweepDelete(tokens, credential.value, orphan)) !== 'delete_failed') {
          deleted += 1;
        }
      }
      if (deleted < orphans.length) {
        // Out of budget, or a deletion failed: this page again on the next alarm.
        this.setSweep(Math.max(soon, this.cloudflareHoldUntil), page);
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

  /**
   * The detective check behind design Q65: a deploy token can change any Worker of the account, so
   * once a handed-over token's live window closed (it was deleted or it expired), one call lists
   * the account's Worker scripts and every script whose `modified_on` falls inside a window not yet
   * checked is compared with the `intendedScripts` of every token live at that time. Each script
   * none of them names gets one `deploy_token.unexpected_script` row (at most
   * `DEPLOY_TOKEN_UNEXPECTED_SCRIPT_EVENTS_PER_CHECK`), and the windows are marked checked. Only a
   * script's last change is visible, so a later change of the same script hides an earlier one.
   * False when the sweep must stop: Cloudflare refused the credential or answered 429. Any other
   * failure leaves the windows for the next sweep, and the token sweep goes on.
   */
  private async checkScripts(
    tokens: CloudflareTokens,
    credential: string,
    now: number
  ): Promise<boolean> {
    const windows = this.db
      .select()
      .from(schema.deployToken)
      .where(inArray(schema.deployToken.state, ['active', 'deleted']))
      .all()
      .map(row => {
        const end = Math.min(row.endedAt ?? row.expiresAt, row.expiresAt);
        return {
          row,
          closed: end <= now,
          // The slack covers the clock difference between this object and Cloudflare.
          from: row.createdAt - DEPLOY_TOKEN_EXPIRY_TOLERANCE_MS,
          to: end + DEPLOY_TOKEN_EXPIRY_TOLERANCE_MS,
          intended: z.array(z.string()).parse(JSON.parse(row.intendedScripts)),
        };
      });
    const due = windows.filter(window => window.closed && !window.row.scriptsChecked);
    if (due.length === 0) return true;
    const listed = await tokens.listScripts(credential);
    if (listed.status !== 'ok') {
      console.error('sts: deploy token script check could not list Worker scripts', {
        detail: listed.detail,
      });
      this.noteFailure(listed);
      return !listed.credentialRefused && listed.retryAfterMs === null;
    }
    const unexpected = listed.scripts
      .filter(script =>
        due.some(window => script.modifiedAt >= window.from && script.modifiedAt <= window.to)
      )
      .map(script => ({
        script,
        live: windows.filter(
          window => script.modifiedAt >= window.from && script.modifiedAt <= window.to
        ),
      }))
      .filter(({ script, live }) => !live.some(window => window.intended.includes(script.name)))
      .sort((left, right) => left.script.modifiedAt - right.script.modifiedAt);
    if (unexpected.length > 0) {
      console.error(
        'sts: Worker scripts changed while a deploy token was live, outside its scripts',
        {
          count: unexpected.length,
        }
      );
    }
    for (const { script, live } of unexpected.slice(
      0,
      DEPLOY_TOKEN_UNEXPECTED_SCRIPT_EVENTS_PER_CHECK
    )) {
      try {
        await this.audit.append(
          this.stream,
          deployTokenUnexpectedScriptEvent({
            environment: this.config.environment,
            script: script.name,
            modifiedAt: script.modifiedAt,
            tokenIds: live.flatMap(window =>
              window.row.tokenId === null ? [] : [window.row.tokenId]
            ),
            workloads: [...new Set(live.map(window => window.row.workload))],
            runIds: [...new Set(live.map(window => window.row.runId))],
            intendedScripts: [...new Set(live.flatMap(window => window.intended))],
            unexpectedInCheck: unexpected.length,
          })
        );
      } catch (error) {
        // The windows stay unchecked, so the next sweep writes the rows.
        console.error('sts: deploy token script check audit append failed', {
          reason: errorName(error),
        });
        return true;
      }
    }
    this.db
      .update(schema.deployToken)
      .set({ scriptsChecked: true })
      .where(
        inArray(
          schema.deployToken.slot,
          due.map(window => window.row.slot)
        )
      )
      .run();
    return true;
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
      .where(prunable)
      .get();
    return row === undefined || row.end === null ? null : row.end + DEPLOY_TOKEN_ROW_RETENTION_MS;
  }

  /** The earliest budget end of a `pending` row no creation of this instance holds, or null. */
  private nextInterruptedCreation(): number | null {
    const deadlines = this.db
      .select({ slot: schema.deployToken.slot, deadline: schema.deployToken.expiresAt })
      .from(schema.deployToken)
      .where(eq(schema.deployToken.state, 'pending'))
      .all()
      .filter(row => !this.creating.has(row.slot))
      .map(row => row.deadline);
    return deadlines.length === 0 ? null : Math.min(...deadlines);
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
   * Sets the alarm to the earliest of the audit work, the next owed deletion, the next expiry, an
   * interrupted creation, the sweep and the row prune. After an alarm (`afterAlarm`), owed
   * deletions wait at least `DEPLOY_TOKEN_DELETE_RETRY_MS`, so retries make at most
   * `DEPLOY_TOKEN_DELETES_PER_ALARM` Cloudflare deletes per 30 seconds whatever the number of owed
   * tokens.
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
    const interrupted = this.nextInterruptedCreation();
    if (interrupted !== null) target = Math.min(target, interrupted);
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
