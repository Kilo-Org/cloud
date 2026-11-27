import { withDORetry } from '@kilocode/worker-utils';
import {
  CLOUDFLARE_DEPLOY_MAX_TTL_SECONDS,
  CloudflareTokenIdSchema,
  StsEnvironmentSchema,
  WorkloadNameSchema,
  type AuditEvent,
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
  deployTokenScriptCheckFailedEvent,
  deployTokenUnexpectedRouteEvent,
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
  type ListedRoute,
  type ListedScript,
  type ListedToken,
  type ReturnedTokenPolicy,
} from '../cloudflare/client';
import {
  CLOUDFLARE_DEPLOY_PINS,
  CLOUDFLARE_MINTING_TOKEN_SECRET,
  DEPLOY_TOKEN_ACCOUNT_LIMIT_RETRY_AFTER_SECONDS,
  DEPLOY_TOKEN_ACCOUNT_MAX_OUTSTANDING,
  DEPLOY_TOKEN_CREDENTIAL_REFUSED_HOLD_CAP_MS,
  DEPLOY_TOKEN_CREDENTIAL_REFUSED_HOLD_MS,
  DEPLOY_TOKEN_DELETES_PER_ALARM,
  DEPLOY_TOKEN_DELETE_RETRY_CAP_MS,
  DEPLOY_TOKEN_DELETE_RETRY_MS,
  DEPLOY_TOKEN_EXPIRY_TOLERANCE_MS,
  DEPLOY_TOKEN_MINT_BUDGET_MS,
  DEPLOY_TOKEN_RETRY_AFTER_SECONDS,
  DEPLOY_TOKEN_ROUTE_ZONES_PER_CHECK,
  DEPLOY_TOKEN_ROW_RETENTION_MS,
  DEPLOY_TOKEN_SWEEP_INTERVAL_MS,
  DEPLOY_TOKEN_SWEEP_PAGES_PER_ALARM,
  DEPLOY_TOKEN_SWEEP_PAGE_SIZE,
  DEPLOY_TOKEN_UNEXPECTED_ROUTE_EVENTS_PER_CHECK,
  DEPLOY_TOKEN_UNEXPECTED_SCRIPT_EVENTS_PER_CHECK,
  DEPLOY_TOKEN_WINDOW_CHECK_ATTEMPTS,
  DEPLOY_TOKEN_WINDOW_CHECK_RETRY_MS,
  MINTING_CREDENTIAL_CACHE_MS,
  MINTING_FOLDER,
  RELAY_DELAY_MS,
  RELAY_RETRY_MS,
  type CloudflareDeployPins,
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
  /** Not retryable: this STS's setup is incomplete (setup step 3 did not pin the forbidden ids). */
  | { status: 'refused'; reason: 'not_configured' }
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

/** One GitHub run attempt, for `maxPerRun` counting; a token without an attempt is attempt 1. */
function runKey(runId: string, runAttempt: string | null | undefined): string {
  return `${runId}:${runAttempt ?? '1'}`;
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
 * handed-over token only after its window check ended.
 */
const prunable = and(
  isNull(schema.deployToken.deleteCause),
  ne(schema.deployToken.state, 'active'),
  ne(schema.deployToken.state, 'pending'),
  or(ne(schema.deployToken.state, 'deleted'), isNotNull(schema.deployToken.windowCheck))
);

/** A handed-over token's live window, widened by the clock tolerance on each side. */
type LiveWindow = {
  row: DeployTokenRow;
  from: number;
  to: number;
  intended: string[];
  /** The zone route patterns the token's grant intends (`intendedRoutes`). */
  routes: string[];
  zones: string[];
};

const StringListSchema = z.array(z.string());

/** Who a window-check row names: every token live at the change, with their owners and intents. */
function liveTokens(live: LiveWindow[]) {
  return {
    tokenIds: live.flatMap(window => (window.row.tokenId === null ? [] : [window.row.tokenId])),
    workloads: [...new Set(live.map(window => window.row.workload))],
    runIds: [...new Set(live.map(window => window.row.runId))],
    intendedScripts: [...new Set(live.flatMap(window => window.intended))],
  };
}

/** Why one window check failed; it counts against each checked window's attempts. */
class WindowCheckFailure extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'WindowCheckFailure';
  }
}

/**
 * One object per environment (design 6.1 job 3, 4.4): it mints Cloudflare account API tokens for
 * GitHub deploy jobs with the minting credential from `MINTING_FOLDER`, keeps one row per token
 * with its owner (never the token or the credential), enforces each workload's active and hourly
 * limits, deletes tokens on revoke and at expiry, and owns the `sts:<environment>:deploy-tokens`
 * audit stream. A token is returned only with its `deploy_token.minted` row committed; one STS
 * cannot hand over is deleted at once. A deletion Cloudflare cannot take is audited and retried by
 * the alarm until it succeeds, because an expired token still counts against the account's
 * 500-token cap. The minting credential lives in memory only. Deploys are a few hundred a day
 * (Kilo-Org/cloud's Worker deploys mint one token per job), so one
 * object serves the environment. A stub can call every prototype method, so everything but `mint`,
 * `revoke` and `alarm` is ECMAScript-private: no caller reaches the minting credential or creates a
 * token past `mint`'s limits.
 */
export class DeployTokenDO extends DurableObject<Env> {
  /** The Cloudflare pins every mint is checked against; a test sets its own. */
  static cloudflareDeployPins: CloudflareDeployPins = CLOUDFLARE_DEPLOY_PINS;

  readonly #config: StsConfig;
  readonly #db: DeployTokenDatabase;
  readonly #audit: AuditLog;
  readonly #stream: string;
  readonly #manager: InfisicalClient;
  /** Deletions in flight, by token id: concurrent ones (callers and the alarm) share one call. */
  readonly #deleting = new Map<string, Promise<DeployTokenDeletionResult>>();
  /** The slots of the creations this instance is running; a `pending` row outside it was cut off. */
  readonly #creating = new Set<number>();
  /** The minting credential and when it was read; memory only, never storage. */
  #credential: { value: string; readAt: number } | null = null;
  #pendingCredential: Promise<CredentialRead> | null = null;
  /** No Cloudflare call before this time: Cloudflare answered 429 with `Retry-After`. */
  #cloudflareHoldUntil = 0;
  /**
   * The stored credential hold (`deploy_token_credential_hold`): after Cloudflare refused the
   * minting credential, the alarm makes no Cloudflare call and reads no credential before `until`.
   */
  #credentialHold = { until: 0, holdMs: 0 };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const config = readConfig(env);
    this.#config = config;
    this.#db = drizzle(ctx.storage, { schema });
    this.#audit = new AuditLog(ctx.storage, env.AUDIT_QUEUE);
    this.#stream = `sts:${config.environment}:deploy-tokens`;
    this.#manager = new InfisicalClient(config.manager, () =>
      withDORetry(
        () => getSignerStub(env, config),
        stub => stub.signManagerToken(),
        'sts.signManagerToken'
      )
    );
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(this.#db, migrations);
      const hold = this.#db
        .select()
        .from(schema.deployTokenCredentialHold)
        .where(eq(schema.deployTokenCredentialHold.id, 1))
        .get();
      if (hold !== undefined) this.#credentialHold = { until: hold.until, holdMs: hold.holdMs };
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
    if (input.environment !== this.#config.environment) return UNAVAILABLE;
    const accountId = this.#config.cloudflareDeployAccountId;
    if (accountId === null) {
      console.warn('sts: deploy token refused: CF_DEPLOY_ACCOUNT_ID is empty in this environment');
      return UNAVAILABLE;
    }
    const pins = (this.constructor as typeof DeployTokenDO).cloudflareDeployPins;
    if (pins.forbiddenGroupIds.length === 0 || pins.allowedGroups.length === 0) {
      // Setup step 5 set the account before step 3 pinned the groups.
      console.error(
        'sts: deploy token refused: CF_DEPLOY_ACCOUNT_ID is set but CLOUDFLARE_DEPLOY_PINS has no forbidden or allowed groups'
      );
      return { status: 'refused', reason: 'not_configured' };
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
    if (callStartedAt < this.#cloudflareHoldUntil) {
      return {
        status: 'unavailable',
        retryAfterSeconds: retryAfterSeconds(this.#cloudflareHoldUntil - callStartedAt),
      };
    }
    const forbidden = grant.permissionGroups
      .map(group => group.id)
      .filter(id => pins.forbiddenGroupIds.includes(id));
    const outside = [
      ...grant.permissionGroups
        .filter(
          group =>
            !pins.allowedGroups.some(
              allowed => allowed.id === group.id && allowed.scope === group.scope
            )
        )
        .map(group => group.id),
      ...grant.zones.filter(zone => !pins.allowedZones[this.#config.environment].includes(zone)),
    ];
    if (forbidden.length > 0 || outside.length > 0) {
      // The loader refuses such a grant; this holds even for a grant that did not pass it.
      console.error('sts: deploy token refused: a group or zone outside the pins', {
        workload: caller.workload,
        forbidden,
        outside,
      });
      return UNAVAILABLE;
    }
    const limited =
      this.#accountLimit(callStartedAt) ??
      (grant.maxPerRun === undefined
        ? this.#limitFor(caller.workload, grant, callStartedAt)
        : this.#runLimitFor(caller, grant.maxPerRun, grant, callStartedAt));
    if (limited !== null) return limited;

    const { slot } = this.#db
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
        intendedRoutes: JSON.stringify(grant.intendedRoutes),
        zones: JSON.stringify(grant.zones),
      })
      .returning({ slot: schema.deployToken.slot })
      .get();
    this.#creating.add(slot);
    try {
      this.#ensureSweepScheduled(callStartedAt);
      // Should this instance stop during the creation, the alarm finds the row past its budget.
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > deadline) await this.ctx.storage.setAlarm(deadline);
      return await this.#create(slot, caller, grant, accountId, deadline);
    } finally {
      this.#creating.delete(slot);
    }
  }

  /** The creation behind `mint`, for the slot it took. */
  async #create(
    slot: number,
    caller: DeployTokenAuditCaller,
    grant: CloudflareDeployGrant,
    accountId: string,
    deadline: number
  ): Promise<DeployTokenMintResult> {
    const credential = await this.#mintingCredential();
    if (credential.status !== 'ok') {
      console.error('sts: deploy token refused: no minting credential', {
        workload: caller.workload,
        detail: credential.detail,
      });
      return await this.#failCreation(slot);
    }
    const name = this.#tokenName(caller.workload, caller.run.runId, slot);
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
      this.#noteFailure(created);
      await this.#auditMintFailed(caller, grant.permissionSet, slot, 'refused', created.httpStatus);
      return await this.#failCreation(slot, created.retryAfterMs);
    }
    if (created.status === 'unknown') {
      // A token may exist that nobody received: the sweep deletes it once it expired.
      console.error('sts: deploy token creation outcome unknown; the sweep checks for it', {
        workload: caller.workload,
        detail: created.detail,
      });
      this.#requestSweep(requestedExpiry + DEPLOY_TOKEN_EXPIRY_TOLERANCE_MS);
      this.#db
        .update(schema.deployToken)
        .set({ outcomeUnknown: true })
        .where(eq(schema.deployToken.slot, slot))
        .run();
      await this.#auditMintFailed(caller, grant.permissionSet, slot, 'unknown', null);
      return await this.#failCreation(slot);
    }
    if (created.status === 'unverified') {
      // Cloudflare made a token STS cannot check: delete it at once, as a grant it cannot verify.
      console.error('sts: deploy token answer names a token but cannot be read; it is deleted', {
        workload: caller.workload,
      });
      this.#endCredentialHold();
      return await this.#deleteUnhanded(slot, created.tokenId, requestedExpiry, 'grant_mismatch');
    }
    this.#endCredentialHold();

    const { token } = created;
    let cause: DeployTokenDeleteCause | null = null;
    if (finishedAt > deadline) {
      cause = 'late';
    } else if (
      // Never later than asked: the job is told the requested lifetime.
      token.expiresAt > requestedExpiry ||
      requestedExpiry - token.expiresAt > DEPLOY_TOKEN_EXPIRY_TOLERANCE_MS
    ) {
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
        await this.#audit.append(
          this.#stream,
          deployTokenMintedEvent({
            environment: this.#config.environment,
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
      return await this.#deleteUnhanded(slot, token.id, token.expiresAt, cause);
    }
    // In the same output gate as the audit row.
    this.#db
      .update(schema.deployToken)
      .set({ tokenId: token.id, state: 'active', expiresAt: token.expiresAt })
      .where(eq(schema.deployToken.slot, slot))
      .run();
    await this.#scheduleAlarm(Date.now(), false);
    return {
      status: 'minted',
      token: token.value,
      tokenId: token.id,
      expiresAt: token.expiresAt,
      ttlSeconds: grant.ttlSeconds,
    };
  }

  /**
   * Deletes a token Cloudflare made that STS does not hand over, and answers `unavailable`; the
   * deletion stays owed on the row until Cloudflare takes it, and the alarm retries it.
   */
  async #deleteUnhanded(
    slot: number,
    tokenId: string,
    expiresAt: number,
    cause: DeployTokenDeleteCause
  ): Promise<DeployTokenMintResult> {
    this.#db
      .update(schema.deployToken)
      .set({ tokenId, state: 'failed', expiresAt, deleteCause: cause })
      .where(eq(schema.deployToken.slot, slot))
      .run();
    await this.#deleteOnce(tokenId);
    await this.#scheduleAlarm(Date.now(), false);
    return UNAVAILABLE;
  }

  /** The name of the token a creation asks Cloudflare for. */
  #tokenName(workload: string, runId: string, slot: number): string {
    return `${deployTokenNamePrefix(this.#config.environment)}${workload}-${runId}-${slot}`;
  }

  /** Writes `deploy_token.mint_failed`; a failed append is logged only, the creation has ended. */
  async #auditMintFailed(
    caller: DeployTokenAuditCaller,
    permissionSet: string,
    slot: number,
    outcome: 'unknown' | 'refused',
    httpStatus: number | null
  ): Promise<void> {
    try {
      await this.#audit.append(
        this.#stream,
        deployTokenMintFailedEvent({
          environment: this.#config.environment,
          caller,
          permissionSet,
          slot,
          tokenName: this.#tokenName(caller.workload, caller.run.runId, slot),
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
   * A token of the caller's that is already deleted answers `revoked` without a Cloudflare call. A
   * revoke during a deletion of the token already in flight (the alarm's) joins it and answers
   * from its outcome. A deletion that failed is tried again no sooner than its row's retry time,
   * by the caller as by the alarm: until then the caller hears `unavailable` with the time left,
   * and no call is made.
   */
  async revoke(raw: DeployTokenRevokeRequest): Promise<DeployTokenRevokeOutcome> {
    const input = DeployTokenRevokeRequestSchema.parse(raw);
    if (input.environment !== this.#config.environment) return UNAVAILABLE;
    let row = this.#rowFor(input.tokenId);
    if (row === undefined || row.state === 'failed' || row.state === 'pending') {
      return { status: 'not_found', reason: 'unknown_token' };
    }
    if (row.workload !== input.caller.workload) return { status: 'not_found', reason: 'not_owner' };
    if (row.runId !== input.caller.run.runId) return { status: 'not_found', reason: 'other_run' };
    const inFlight = this.#deleting.get(input.tokenId);
    if (inFlight !== undefined) {
      // That attempt set the retry time before its call; its outcome is this revoke's.
      await inFlight;
      row = this.#rowFor(input.tokenId) ?? row;
    }
    if (row.state === 'deleted') return { status: 'revoked' };
    const now = Date.now();
    if (row.deleteRetryAt !== null && row.deleteRetryAt > now) {
      return {
        status: 'unavailable',
        retryAfterSeconds: retryAfterSeconds(row.deleteRetryAt - now),
      };
    }

    if (row.deleteCause === null) {
      // Owed from now on: the alarm retries it if Cloudflare cannot take it.
      this.#db
        .update(schema.deployToken)
        .set({ deleteCause: 'caller' })
        .where(eq(schema.deployToken.slot, row.slot))
        .run();
    }
    const result = await this.#deleteOnce(input.tokenId);
    await this.#scheduleAlarm(Date.now(), false);
    return result === 'delete_failed' ? UNAVAILABLE : { status: 'revoked' };
  }

  /**
   * Relays audit rows, marks expired tokens owed, ends creations an earlier instance of this object
   * left `pending`, runs the window check of tokens whose live window closed, retries owed
   * deletions (at most `DEPLOY_TOKEN_DELETES_PER_ALARM`, least recently tried first), then the
   * sweep's failed deletions that are due, runs the sweep when due with what is left of that
   * budget, and prunes ended rows. The window check runs before the deletions, so a hold the
   * deletions keep renewing cannot starve it. While the credential hold runs (Cloudflare answered
   * 401 to the minting credential, or 401 or 403 to a list), the alarm makes no Cloudflare call
   * and reads no credential.
   */
  async alarm(): Promise<void> {
    let failed = false;
    try {
      await this.#audit.relay(this.#stream);
    } catch (error) {
      failed = true;
      console.warn('sts: deploy-token audit relay failed; rows stay for the next alarm', {
        reason: errorName(error),
      });
    }
    let now = Date.now();
    this.#db
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
    await this.#endInterruptedCreations(now);
    await this.#checkWindowsIfDue(now);
    const owed = this.#owedDeletions(Date.now(), DEPLOY_TOKEN_DELETES_PER_ALARM);
    for (const row of owed) {
      if (this.#credentialHeld(Date.now())) break;
      if (row.tokenId !== null) await this.#deleteOnce(row.tokenId);
    }
    const retried = await this.#retrySweepDeletions(DEPLOY_TOKEN_DELETES_PER_ALARM - owed.length);
    await this.#sweepIfDue(Date.now(), DEPLOY_TOKEN_DELETES_PER_ALARM - owed.length - retried);
    now = Date.now();
    this.#audit.pruneIfDue(now);
    this.#db
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
    await this.#scheduleAlarm(Date.now(), failed, true);
  }

  /**
   * A `pending` row past its creation budget that no creation of this instance holds was left by
   * an instance that stopped while Cloudflare was creating its token: the creation's outcome is
   * unknown. Ends it, writes `deploy_token.mint_failed` (`unknown`), and brings the sweep forward
   * to when such a token has expired: its expiry is at most `CLOUDFLARE_DEPLOY_MAX_TTL_SECONDS`
   * after the budget ended, plus Cloudflare's tolerance.
   */
  async #endInterruptedCreations(now: number): Promise<void> {
    const interrupted = this.#db
      .select()
      .from(schema.deployToken)
      .where(and(eq(schema.deployToken.state, 'pending'), lt(schema.deployToken.expiresAt, now)))
      .all()
      .filter(row => !this.#creating.has(row.slot));
    for (const row of interrupted) {
      console.error('sts: a deploy token creation was interrupted; the sweep checks for it', {
        workload: row.workload,
      });
      this.#requestSweep(
        row.expiresAt + CLOUDFLARE_DEPLOY_MAX_TTL_SECONDS * 1000 + DEPLOY_TOKEN_EXPIRY_TOLERANCE_MS
      );
      this.#db
        .update(schema.deployToken)
        .set({ state: 'failed', endedAt: now, outcomeUnknown: true })
        .where(eq(schema.deployToken.slot, row.slot))
        .run();
      await this.#auditMintFailed(
        CallerSchema.parse(JSON.parse(row.caller)),
        row.permissionSet,
        row.slot,
        'unknown',
        null
      );
    }
  }

  /**
   * The refusal while this environment holds `DEPLOY_TOKEN_ACCOUNT_MAX_OUTSTANDING` tokens that
   * may exist at Cloudflare and count against the account's 500-token cap: creations in progress,
   * handed-over tokens until deleted, tokens whose deletion is owed, creations whose outcome is
   * unknown recently enough that a lost token may still exist (its expiry plus the sweep's delay),
   * and tokens the sweep found but could not delete yet.
   */
  #accountLimit(now: number): DeployTokenMintResult | null {
    const lostSince =
      now -
      DEPLOY_TOKEN_MINT_BUDGET_MS -
      CLOUDFLARE_DEPLOY_MAX_TTL_SECONDS * 1000 -
      2 * DEPLOY_TOKEN_EXPIRY_TOLERANCE_MS;
    const row = this.#db
      .select({ outstanding: sql<number>`count(*)` })
      .from(schema.deployToken)
      .where(
        or(
          inArray(schema.deployToken.state, ['pending', 'active']),
          isNotNull(schema.deployToken.deleteCause),
          and(
            eq(schema.deployToken.state, 'failed'),
            isNull(schema.deployToken.tokenId),
            eq(schema.deployToken.outcomeUnknown, true),
            gt(schema.deployToken.createdAt, lostSince)
          )
        )
      )
      .get();
    const stuck = this.#db
      .select({ count: sql<number>`count(*)` })
      .from(schema.deployTokenSweepRetry)
      .get();
    const outstanding = (row?.outstanding ?? 0) + (stuck?.count ?? 0);
    if (outstanding < DEPLOY_TOKEN_ACCOUNT_MAX_OUTSTANDING) return null;
    console.error('sts: deploy token refused: this environment holds its share of account tokens', {
      outstanding,
    });
    return {
      status: 'limited',
      reason: 'account_limit',
      retryAfterSeconds: DEPLOY_TOKEN_ACCOUNT_LIMIT_RETRY_AFTER_SECONDS,
    };
  }

  /**
   * The refusal for a workload at its limits: its unexpired tokens (a creation in progress
   * counts), then its creations in the last hour, whatever their outcome.
   */
  #limitFor(
    workload: string,
    grant: CloudflareDeployGrant,
    now: number
  ): DeployTokenMintResult | null {
    const active = this.#db
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
    const recent = this.#db
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

  /**
   * The refusal for a workload at its limits under `maxPerRun`: `maxActive` and `maxPerHour`
   * count GitHub run attempts (run id and attempt), not tokens, so the parallel jobs of one run
   * each get their own token. The caller's own run attempt never counts against those two; it may
   * make `maxPerRun` creations in the last hour, whatever their outcome (`run_limit` beyond).
   */
  #runLimitFor(
    caller: DeployTokenAuditCaller,
    maxPerRun: number,
    grant: CloudflareDeployGrant,
    now: number
  ): DeployTokenMintResult | null {
    const ownKey = runKey(caller.run.runId, caller.run.runAttempt);
    const rows = this.#db
      .select({
        runId: schema.deployToken.runId,
        runAttempt: sql<
          string | null
        >`json_extract(${schema.deployToken.caller}, '$.run.runAttempt')`,
        state: schema.deployToken.state,
        createdAt: schema.deployToken.createdAt,
        expiresAt: schema.deployToken.expiresAt,
      })
      .from(schema.deployToken)
      .where(
        and(
          eq(schema.deployToken.workload, caller.workload),
          or(
            gt(schema.deployToken.createdAt, now - HOUR_MS),
            and(
              inArray(schema.deployToken.state, ['pending', 'active']),
              gt(schema.deployToken.expiresAt, now)
            )
          )
        )
      )
      .orderBy(asc(schema.deployToken.createdAt))
      .all();
    const own = rows.filter(
      row => runKey(row.runId, row.runAttempt) === ownKey && row.createdAt > now - HOUR_MS
    );
    if (own.length >= maxPerRun) {
      const freeing = own[own.length - maxPerRun];
      return {
        status: 'limited',
        reason: 'run_limit',
        retryAfterSeconds: retryAfterSeconds(freeing.createdAt + HOUR_MS - now),
      };
    }
    // Each other run attempt: when its last unexpired token expires, and its last creation.
    const activeUntil = new Map<string, number>();
    const lastCreated = new Map<string, number>();
    for (const row of rows) {
      const key = runKey(row.runId, row.runAttempt);
      if (key === ownKey) continue;
      if ((row.state === 'pending' || row.state === 'active') && row.expiresAt > now) {
        activeUntil.set(key, Math.max(activeUntil.get(key) ?? 0, row.expiresAt));
      }
      if (row.createdAt > now - HOUR_MS) lastCreated.set(key, row.createdAt);
    }
    // A run attempt that made a token in the last hour is already counted, as for the hourly cap,
    // so an ordered later job of the same run (one that starts after the earlier jobs revoked
    // theirs) is never refused while another run holds tokens. Every token lives at most an hour.
    if (own.length === 0 && activeUntil.size >= grant.maxActive) {
      const soonest = Math.min(...activeUntil.values());
      return {
        status: 'limited',
        reason: 'too_many_active',
        retryAfterSeconds: retryAfterSeconds(soonest - now),
      };
    }
    if (own.length === 0 && lastCreated.size >= grant.maxPerHour) {
      // A run attempt leaves the hour with its last creation; a slot opens when enough have left.
      const leaving = [...lastCreated.values()].sort((left, right) => left - right);
      const freeing = leaving[leaving.length - grant.maxPerHour];
      return {
        status: 'limited',
        reason: 'rate_limited',
        retryAfterSeconds: retryAfterSeconds(freeing + HOUR_MS - now),
      };
    }
    return null;
  }

  /** Ends a creation that gave nothing to the caller and made no known token. */
  async #failCreation(
    slot: number,
    retryAfterMs: number | null = null
  ): Promise<DeployTokenMintResult> {
    const now = Date.now();
    this.#db
      .update(schema.deployToken)
      .set({ state: 'failed', endedAt: now })
      .where(eq(schema.deployToken.slot, slot))
      .run();
    await this.#scheduleAlarm(now, false);
    return {
      status: 'unavailable',
      retryAfterSeconds:
        retryAfterMs === null ? DEPLOY_TOKEN_RETRY_AFTER_SECONDS : retryAfterSeconds(retryAfterMs),
    };
  }

  #rowFor(tokenId: string): DeployTokenRow | undefined {
    return this.#db
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
  async #mintingCredential(): Promise<CredentialRead> {
    const cached = this.#credential;
    if (cached !== null && Date.now() - cached.readAt < MINTING_CREDENTIAL_CACHE_MS) {
      return { status: 'ok', value: cached.value };
    }
    this.#pendingCredential ??= this.#readMintingCredential().finally(() => {
      this.#pendingCredential = null;
    });
    return await this.#pendingCredential;
  }

  async #readMintingCredential(): Promise<CredentialRead> {
    const read = await this.#manager.readMintingSecret(CLOUDFLARE_MINTING_TOKEN_SECRET);
    if (read.status === 'ok') {
      this.#credential = { value: read.value, readAt: Date.now() };
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
   * Drops a refused credential and starts or doubles the stored credential hold, so the alarm
   * reads no new credential and calls Cloudflare no more before it ends; honours a `Retry-After`.
   * Logs nothing of the credential.
   */
  #noteFailure(failure: { credentialRefused: boolean; retryAfterMs: number | null }): void {
    if (failure.credentialRefused) {
      this.#credential = null;
      const holdMs =
        this.#credentialHold.holdMs === 0
          ? DEPLOY_TOKEN_CREDENTIAL_REFUSED_HOLD_MS
          : Math.min(DEPLOY_TOKEN_CREDENTIAL_REFUSED_HOLD_CAP_MS, this.#credentialHold.holdMs * 2);
      this.#credentialHold = { until: Date.now() + holdMs, holdMs };
      this.#db
        .insert(schema.deployTokenCredentialHold)
        .values({ id: 1, ...this.#credentialHold })
        .onConflictDoUpdate({
          target: schema.deployTokenCredentialHold.id,
          set: this.#credentialHold,
        })
        .run();
    }
    if (failure.retryAfterMs !== null) {
      this.#cloudflareHoldUntil = Math.max(
        this.#cloudflareHoldUntil,
        Date.now() + failure.retryAfterMs
      );
    }
  }

  /** Cloudflare accepted the minting credential: the next refusal starts a fresh hold. */
  #endCredentialHold(): void {
    if (this.#credentialHold.holdMs === 0) return;
    this.#credentialHold = { until: 0, holdMs: 0 };
    this.#db.delete(schema.deployTokenCredentialHold).run();
  }

  /** The alarm makes no Cloudflare call now: the credential hold runs. */
  #credentialHeld(now: number): boolean {
    return now < this.#credentialHold.until;
  }

  /** The earliest time the alarm may call Cloudflare again: after a 429's wait and the hold. */
  #cloudflareResumeAt(): number {
    return Math.max(this.#cloudflareHoldUntil, this.#credentialHold.until);
  }

  /** One deletion attempt of an owed token, shared with any attempt already in flight. */
  async #deleteOnce(tokenId: string): Promise<DeployTokenDeletionResult> {
    const inFlight = this.#deleting.get(tokenId);
    if (inFlight !== undefined) return await inFlight;
    const pending = this.#attemptDeletion(tokenId).finally(() => {
      this.#deleting.delete(tokenId);
    });
    this.#deleting.set(tokenId, pending);
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
  async #attemptDeletion(tokenId: string): Promise<DeployTokenDeletionResult> {
    const row = this.#rowFor(tokenId);
    if (row === undefined || row.deleteCause === null) return 'gone';
    const cause = row.deleteCause;
    const caller: DeployTokenAuditCaller = CallerSchema.parse(JSON.parse(row.caller));
    const now = Date.now();
    const backoff = Math.min(
      DEPLOY_TOKEN_DELETE_RETRY_CAP_MS,
      DEPLOY_TOKEN_DELETE_RETRY_MS * 2 ** row.deleteAttempts
    );
    this.#db
      .update(schema.deployToken)
      .set({ deleteRetryAt: now + backoff, deleteAttempts: row.deleteAttempts + 1 })
      .where(eq(schema.deployToken.slot, row.slot))
      .run();

    const failure = await this.#deleteAtCloudflare(tokenId);
    const deletion: DeployTokenDeletionResult =
      failure === null ? 'deleted' : failure === 'gone' ? 'gone' : 'delete_failed';
    if (failure !== null && failure !== 'gone') {
      console.error('sts: deploy token deletion failed; the object retries it', {
        workload: row.workload,
        cause,
        detail: failure.detail,
      });
      this.#noteFailure(failure);
      if (failure.retryAfterMs !== null && failure.retryAfterMs > backoff) {
        this.#db
          .update(schema.deployToken)
          .set({ deleteRetryAt: Date.now() + failure.retryAfterMs })
          .where(eq(schema.deployToken.slot, row.slot))
          .run();
      }
      if (row.deleteFailureAudited) return deletion;
    }
    try {
      await this.#audit.append(
        this.#stream,
        cause === 'expired'
          ? deployTokenReapedEvent({
              environment: this.#config.environment,
              source: 'ledger',
              caller,
              permissionSet: row.permissionSet,
              tokenId,
              tokenName: null,
              expiresAt: row.expiresAt,
              result: deletion,
            })
          : deployTokenRevokedEvent({
              environment: this.#config.environment,
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
    this.#db
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
  async #deleteAtCloudflare(tokenId: string): Promise<null | 'gone' | FailedAttempt> {
    const accountId = this.#config.cloudflareDeployAccountId;
    if (accountId === null) {
      return {
        detail: 'CF_DEPLOY_ACCOUNT_ID is empty',
        credentialRefused: false,
        retryAfterMs: null,
      };
    }
    if (Date.now() < this.#cloudflareHoldUntil) {
      return {
        detail: 'cloudflare asked to wait (429)',
        credentialRefused: false,
        retryAfterMs: this.#cloudflareHoldUntil - Date.now(),
      };
    }
    const credential = await this.#mintingCredential();
    if (credential.status !== 'ok') {
      return { detail: credential.detail, credentialRefused: false, retryAfterMs: null };
    }
    const deletion = await new CloudflareTokens(accountId).delete(credential.value, tokenId);
    if (deletion.status === 'unreachable') return deletion;
    this.#endCredentialHold();
    return deletion.status === 'deleted' ? null : 'gone';
  }

  /**
   * The owed deletions due by `dueBy`, least recently tried first. Expired ones stay owed: an
   * expired Cloudflare token still counts against the account's cap until it is deleted.
   */
  #owedDeletions(dueBy: number, limit: number): DeployTokenRow[] {
    if (limit <= 0) return [];
    return this.#db
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
  #ensureSweepScheduled(now: number): void {
    this.#db
      .insert(schema.deployTokenSweep)
      .values({ id: 1, nextSweepAt: now + DEPLOY_TOKEN_SWEEP_INTERVAL_MS, page: null })
      .onConflictDoNothing()
      .run();
  }

  /** Brings the next sweep forward to `at` when it is later. */
  #requestSweep(at: number): void {
    this.#db
      .insert(schema.deployTokenSweep)
      .values({ id: 1, nextSweepAt: at, page: null })
      .onConflictDoUpdate({
        target: schema.deployTokenSweep.id,
        set: { nextSweepAt: sql`min(${schema.deployTokenSweep.nextSweepAt}, ${at})` },
      })
      .run();
  }

  #setSweep(nextSweepAt: number, page: number | null): void {
    this.#db
      .update(schema.deployTokenSweep)
      .set({ nextSweepAt, page })
      .where(eq(schema.deployTokenSweep.id, 1))
      .run();
  }

  /**
   * Reads up to `DEPLOY_TOKEN_SWEEP_PAGES_PER_ALARM` pages of the account's token list and deletes,
   * within `budget`, every expired token named for this environment that STS holds no row for. A
   * page where it deleted something is read again (the list shifted); a page shorter than the page
   * size ends the sweep, and the next one runs a day later. A token whose deletion failed is
   * passed over, so it holds up neither its page nor the later ones: `retrySweepDeletions` tries
   * it again by id. While a 429's wait or the credential hold runs, the sweep waits until both
   * ended.
   */
  async #sweepIfDue(now: number, budget: number): Promise<void> {
    const state = this.#db
      .select()
      .from(schema.deployTokenSweep)
      .where(eq(schema.deployTokenSweep.id, 1))
      .get();
    const accountId = this.#config.cloudflareDeployAccountId;
    if (state === undefined || state.nextSweepAt > now || accountId === null) return;
    const soon = now + DEPLOY_TOKEN_DELETE_RETRY_MS;
    if (now < this.#cloudflareResumeAt()) {
      this.#setSweep(this.#cloudflareResumeAt(), state.page);
      return;
    }
    const credential = await this.#mintingCredential();
    if (credential.status !== 'ok') {
      console.error('sts: deploy token sweep has no minting credential', {
        detail: credential.detail,
      });
      this.#setSweep(now + RELAY_RETRY_MS, state.page);
      return;
    }
    const tokens = new CloudflareTokens(accountId);
    const prefix = deployTokenNamePrefix(this.#config.environment);
    let page = state.page ?? 1;
    let left = budget;
    for (let read = 0; read < DEPLOY_TOKEN_SWEEP_PAGES_PER_ALARM; read += 1) {
      if (Date.now() < this.#cloudflareResumeAt()) {
        this.#setSweep(Math.max(soon, this.#cloudflareResumeAt()), page);
        return;
      }
      const listed = await tokens.list(credential.value, page, DEPLOY_TOKEN_SWEEP_PAGE_SIZE);
      if (listed.status !== 'ok') {
        console.error('sts: deploy token sweep could not list tokens', { detail: listed.detail });
        this.#noteFailure(listed);
        this.#setSweep(Math.max(now + RELAY_RETRY_MS, this.#cloudflareResumeAt()), page);
        return;
      }
      this.#endCredentialHold();
      // STS always sets an expiry, so a token of its prefix without one is not one it handed over.
      const orphans = listed.tokens.filter(
        token =>
          token.name.startsWith(prefix) &&
          (token.expiresAt === null || token.expiresAt <= now) &&
          this.#rowFor(token.id) === undefined &&
          !this.#sweepRetryPending(token.id)
      );
      let deleted = 0;
      for (const orphan of orphans) {
        if (left <= 0 || Date.now() < this.#cloudflareResumeAt()) {
          // Out of budget, or the credential hold or a 429's wait began: this page again later.
          this.#setSweep(Math.max(soon, this.#cloudflareResumeAt()), page);
          return;
        }
        left -= 1;
        if ((await this.#sweepDelete(orphan)) !== 'delete_failed') deleted += 1;
      }
      if (deleted === 0) {
        if (listed.tokens.length < DEPLOY_TOKEN_SWEEP_PAGE_SIZE) {
          this.#setSweep(now + DEPLOY_TOKEN_SWEEP_INTERVAL_MS, null);
          return;
        }
        page += 1;
      }
    }
    this.#setSweep(soon, page);
  }

  /** Every handed-over token's live window, oldest first. */
  #liveWindows(): LiveWindow[] {
    return this.#db
      .select()
      .from(schema.deployToken)
      .where(inArray(schema.deployToken.state, ['active', 'deleted']))
      .orderBy(asc(schema.deployToken.slot))
      .all()
      .map(row => ({
        row,
        // The slack covers the clock difference between this object and Cloudflare.
        from: row.createdAt - DEPLOY_TOKEN_EXPIRY_TOLERANCE_MS,
        to:
          Math.min(row.endedAt ?? row.expiresAt, row.expiresAt) + DEPLOY_TOKEN_EXPIRY_TOLERANCE_MS,
        intended: StringListSchema.parse(JSON.parse(row.intendedScripts)),
        routes: StringListSchema.parse(JSON.parse(row.intendedRoutes)),
        zones: StringListSchema.parse(JSON.parse(row.zones)),
      }));
  }

  /**
   * The detective check behind design Q65, run by the alarm once a handed-over token's live window
   * closed: its deletion or expiry plus the 2-minute tolerance. A deploy token can change any
   * Worker of the account and any route of its zones, so one call lists the account's Worker
   * scripts and one call per zone lists its Workers routes (at most
   * `DEPLOY_TOKEN_ROUTE_ZONES_PER_CHECK` zones; windows with further zones wait for the next
   * alarm). It writes `deploy_token.unexpected_script` for each script whose `modified_on` falls
   * in a checked window, not in a window checked before, and that no token live at that moment
   * intends; and `deploy_token.unexpected_route` for each route added or changed since the zone's
   * previous list that points at a script no token with that zone live since then intends. Then,
   * in one write, it marks the windows checked and stores each zone's list for the next check. A
   * failure counts against each window's attempts (`windowCheckFailed`).
   */
  async #checkWindowsIfDue(now: number): Promise<void> {
    const accountId = this.#config.cloudflareDeployAccountId;
    if (accountId === null || now < this.#cloudflareResumeAt()) return;
    const windows = this.#liveWindows();
    const due = windows.filter(
      window =>
        window.row.windowCheck === null &&
        window.to <= now &&
        (window.row.windowCheckRetryAt ?? 0) <= now
    );
    const batch: LiveWindow[] = [];
    const zones = new Set<string>();
    for (const window of due) {
      const added = window.zones.filter(zone => !zones.has(zone));
      if (batch.length > 0 && zones.size + added.length > DEPLOY_TOKEN_ROUTE_ZONES_PER_CHECK) break;
      for (const zone of added) zones.add(zone);
      batch.push(window);
    }
    if (batch.length === 0) return;
    try {
      const credential = await this.#mintingCredential();
      if (credential.status !== 'ok') throw new WindowCheckFailure(credential.detail);
      const client = new CloudflareTokens(accountId);
      const scripts = await client.listScripts(credential.value);
      if (scripts.status !== 'ok') {
        this.#noteFailure(scripts);
        throw new WindowCheckFailure(scripts.detail);
      }
      this.#endCredentialHold();
      if (scripts.dropped > 0) {
        console.warn('sts: deploy token window check dropped unreadable scripts', {
          dropped: scripts.dropped,
        });
      }
      const routes = new Map<string, ListedRoute[]>();
      for (const zone of zones) {
        const listed = await client.listRoutes(credential.value, zone);
        if (listed.status !== 'ok') {
          this.#noteFailure(listed);
          throw new WindowCheckFailure(listed.detail);
        }
        routes.set(zone, listed.routes);
      }
      await this.#auditUnexpectedScripts(scripts.scripts, batch, windows);
      await this.#auditUnexpectedRoutes(routes, windows);
      // No await from here on: the storage writes below commit together.
      for (const window of batch) {
        this.#db
          .update(schema.deployToken)
          .set({ windowCheck: 'checked', windowCheckRetryAt: null })
          .where(eq(schema.deployToken.slot, window.row.slot))
          .run();
      }
      for (const [zone, listed] of routes) {
        this.#db
          .delete(schema.deployTokenRoute)
          .where(eq(schema.deployTokenRoute.zone, zone))
          .run();
        for (const route of listed) {
          this.#db
            .insert(schema.deployTokenRoute)
            .values({ zone, routeId: route.id, pattern: route.pattern, script: route.script })
            .onConflictDoNothing()
            .run();
        }
        this.#db
          .insert(schema.deployTokenRouteZone)
          .values({ zone, listedAt: now })
          .onConflictDoUpdate({ target: schema.deployTokenRouteZone.zone, set: { listedAt: now } })
          .run();
      }
    } catch (error) {
      if (!(error instanceof WindowCheckFailure)) throw error;
      await this.#windowCheckFailed(batch, now, error.detail);
    }
  }

  /** The `deploy_token.unexpected_script` rows of one check; throws `WindowCheckFailure`. */
  async #auditUnexpectedScripts(
    scripts: ListedScript[],
    batch: LiveWindow[],
    windows: LiveWindow[]
  ): Promise<void> {
    const inside = (window: LiveWindow, at: number) => at >= window.from && at <= window.to;
    // A change inside a window checked before was compared then, against every token live then.
    const checked = windows.filter(window => window.row.windowCheck === 'checked');
    const unexpected = scripts
      .filter(
        script =>
          batch.some(window => inside(window, script.modifiedAt)) &&
          !checked.some(window => inside(window, script.modifiedAt))
      )
      .map(script => ({
        script,
        live: windows.filter(window => inside(window, script.modifiedAt)),
      }))
      .filter(({ script, live }) => !live.some(window => window.intended.includes(script.name)))
      .sort((left, right) => left.script.modifiedAt - right.script.modifiedAt);
    if (unexpected.length === 0) return;
    console.error('sts: deploy token window check: unexpected Worker scripts', {
      count: unexpected.length,
    });
    for (const { script, live } of unexpected.slice(
      0,
      DEPLOY_TOKEN_UNEXPECTED_SCRIPT_EVENTS_PER_CHECK
    )) {
      await this.#appendCheckRow(
        deployTokenUnexpectedScriptEvent({
          environment: this.#config.environment,
          script: script.name,
          modifiedAt: script.modifiedAt,
          ...liveTokens(live),
          unexpectedInCheck: unexpected.length,
        })
      );
    }
  }

  /**
   * The `deploy_token.unexpected_route` rows of one check; throws `WindowCheckFailure`. A route
   * list has no time, so a route counts when it differs from the zone's previous list (every route
   * of a zone never listed before), and the tokens it names are every token with that zone live
   * since that list. Such a route is expected only when one live token intends both its Worker
   * (`intendedScripts`) and its pattern (`intendedRoutes`), so a new or changed pattern that sends
   * traffic to an intended Worker counts too, and so does one token's pattern pointed at another
   * token's Worker. A removed route, or one that runs no Worker, is not reported.
   */
  async #auditUnexpectedRoutes(
    routes: Map<string, ListedRoute[]>,
    windows: LiveWindow[]
  ): Promise<void> {
    const unexpected: {
      zone: string;
      route: ListedRoute & { script: string };
      previousScript: string | null;
      firstListOfZone: boolean;
      live: LiveWindow[];
    }[] = [];
    for (const [zone, listed] of routes) {
      const since = this.#db
        .select({ listedAt: schema.deployTokenRouteZone.listedAt })
        .from(schema.deployTokenRouteZone)
        .where(eq(schema.deployTokenRouteZone.zone, zone))
        .get()?.listedAt;
      const previous = new Map(
        this.#db
          .select()
          .from(schema.deployTokenRoute)
          .where(eq(schema.deployTokenRoute.zone, zone))
          .all()
          .map(route => [route.routeId, route])
      );
      const live = windows.filter(
        window => window.zones.includes(zone) && (since === undefined || window.to >= since)
      );
      for (const route of listed) {
        const before = previous.get(route.id);
        const changed =
          before === undefined ||
          before.pattern !== route.pattern ||
          before.script !== route.script;
        const { script } = route;
        if (!changed || script === null) continue;
        if (
          live.some(
            window => window.intended.includes(script) && window.routes.includes(route.pattern)
          )
        ) {
          continue;
        }
        unexpected.push({
          zone,
          route: { ...route, script },
          previousScript: before?.script ?? null,
          firstListOfZone: since === undefined,
          live,
        });
      }
    }
    if (unexpected.length === 0) return;
    console.error('sts: deploy token window check: unexpected Workers routes', {
      count: unexpected.length,
    });
    for (const entry of unexpected.slice(0, DEPLOY_TOKEN_UNEXPECTED_ROUTE_EVENTS_PER_CHECK)) {
      await this.#appendCheckRow(
        deployTokenUnexpectedRouteEvent({
          environment: this.#config.environment,
          zone: entry.zone,
          routeId: entry.route.id,
          pattern: entry.route.pattern,
          script: entry.route.script,
          previousScript: entry.previousScript,
          firstListOfZone: entry.firstListOfZone,
          ...liveTokens(entry.live),
          unexpectedInCheck: unexpected.length,
        })
      );
    }
  }

  /** Appends one row of a window check; a failed append fails the check, which is retried. */
  async #appendCheckRow(event: AuditEvent): Promise<void> {
    try {
      await this.#audit.append(this.#stream, event);
    } catch (error) {
      throw new WindowCheckFailure(`audit append failed: ${errorName(error)}`);
    }
  }

  /**
   * One failed check of `batch`: each window is tried again later, after
   * `DEPLOY_TOKEN_WINDOW_CHECK_RETRY_MS` doubling per failure, and after
   * `DEPLOY_TOKEN_WINDOW_CHECK_ATTEMPTS` failures it gets a `deploy_token.script_check_failed` row
   * and is no longer held (a window whose row cannot be written is tried again).
   */
  async #windowCheckFailed(batch: LiveWindow[], now: number, detail: string): Promise<void> {
    console.error('sts: deploy token window check failed', { detail, windows: batch.length });
    for (const { row } of batch) {
      const attempts = row.windowCheckAttempts + 1;
      const retry = {
        windowCheckAttempts: attempts,
        windowCheckRetryAt: now + DEPLOY_TOKEN_WINDOW_CHECK_RETRY_MS * 2 ** (attempts - 1),
      };
      let done = false;
      if (attempts >= DEPLOY_TOKEN_WINDOW_CHECK_ATTEMPTS && row.tokenId !== null) {
        try {
          await this.#audit.append(
            this.#stream,
            deployTokenScriptCheckFailedEvent({
              environment: this.#config.environment,
              caller: CallerSchema.parse(JSON.parse(row.caller)),
              permissionSet: row.permissionSet,
              tokenId: row.tokenId,
              attempts,
              reason: detail,
            })
          );
          done = true;
        } catch (error) {
          console.error('sts: deploy token script_check_failed audit append failed', {
            reason: errorName(error),
          });
        }
      }
      this.#db
        .update(schema.deployToken)
        .set(done ? { ...retry, windowCheck: 'failed', windowCheckRetryAt: null } : retry)
        .where(eq(schema.deployToken.slot, row.slot))
        .run();
    }
  }

  /**
   * Deletes one expired token the sweep found, or one whose deletion failed before, and audits the
   * attempt. A failure keeps the token in `deploy_token_sweep_retry`, which the sweep passes over
   * from then on. A failure of the token's own (a 403, a 5xx, no answer, no credential) doubles its
   * wait up to the sweep's interval; a 401 or a 429 adds none, as the credential hold or
   * Cloudflare's wait already delays every call. Its `delete_failed` row is written once, until
   * Cloudflare deleted the token or no longer has it.
   */
  async #sweepDelete(orphan: ListedToken): Promise<DeployTokenDeletionResult> {
    const failure = await this.#deleteAtCloudflare(orphan.id);
    const retry = this.#db
      .select()
      .from(schema.deployTokenSweepRetry)
      .where(eq(schema.deployTokenSweepRetry.tokenId, orphan.id))
      .get();
    const result: DeployTokenDeletionResult =
      failure === null ? 'deleted' : failure === 'gone' ? 'gone' : 'delete_failed';
    if (failure === null || failure === 'gone') {
      this.#db
        .delete(schema.deployTokenSweepRetry)
        .where(eq(schema.deployTokenSweepRetry.tokenId, orphan.id))
        .run();
    } else {
      console.error('sts: deploy token sweep deletion failed; it is tried again later', {
        detail: failure.detail,
      });
      this.#noteFailure(failure);
      const own = !failure.credentialRefused && failure.retryAfterMs === null;
      const attempts = (retry?.attempts ?? 0) + (own ? 1 : 0);
      const now = Date.now();
      const retryAt = own
        ? now +
          Math.min(
            DEPLOY_TOKEN_SWEEP_INTERVAL_MS,
            DEPLOY_TOKEN_DELETE_RETRY_MS * 2 ** (attempts - 1)
          )
        : now;
      this.#db
        .insert(schema.deployTokenSweepRetry)
        .values({
          tokenId: orphan.id,
          tokenName: orphan.name,
          expiresAt: orphan.expiresAt,
          retryAt,
          attempts,
        })
        .onConflictDoUpdate({
          target: schema.deployTokenSweepRetry.tokenId,
          set: { retryAt, attempts },
        })
        .run();
      if (retry?.failureAudited === true) return result;
    }
    try {
      await this.#audit.append(
        this.#stream,
        deployTokenReapedEvent({
          environment: this.#config.environment,
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
      return result;
    }
    if (result === 'delete_failed') {
      this.#db
        .update(schema.deployTokenSweepRetry)
        .set({ failureAudited: true })
        .where(eq(schema.deployTokenSweepRetry.tokenId, orphan.id))
        .run();
    }
    return result;
  }

  /** The sweep passes over a token whose failed deletion `retrySweepDeletions` owns. */
  #sweepRetryPending(tokenId: string): boolean {
    return (
      this.#db
        .select({ tokenId: schema.deployTokenSweepRetry.tokenId })
        .from(schema.deployTokenSweepRetry)
        .where(eq(schema.deployTokenSweepRetry.tokenId, tokenId))
        .get() !== undefined
    );
  }

  /**
   * Tries again, by id, the sweep's failed deletions that are due, at most `budget`, the longest
   * due first, and returns how many it tried. Stops while the credential hold or a 429's wait runs.
   */
  async #retrySweepDeletions(budget: number): Promise<number> {
    if (budget <= 0 || this.#config.cloudflareDeployAccountId === null) return 0;
    const due = this.#db
      .select()
      .from(schema.deployTokenSweepRetry)
      .where(lte(schema.deployTokenSweepRetry.retryAt, Date.now()))
      .orderBy(asc(schema.deployTokenSweepRetry.retryAt))
      .limit(budget)
      .all();
    let tried = 0;
    for (const retry of due) {
      if (Date.now() < this.#cloudflareResumeAt()) break;
      tried += 1;
      await this.#sweepDelete({
        id: retry.tokenId,
        name: retry.tokenName,
        expiresAt: retry.expiresAt,
      });
    }
    return tried;
  }

  /** The earliest time a row is due for deletion, or null for none. */
  #nextRowPruneAt(): number | null {
    const row = this.#db
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
  #nextInterruptedCreation(): number | null {
    const deadlines = this.#db
      .select({ slot: schema.deployToken.slot, deadline: schema.deployToken.expiresAt })
      .from(schema.deployToken)
      .where(eq(schema.deployToken.state, 'pending'))
      .all()
      .filter(row => !this.#creating.has(row.slot))
      .map(row => row.deadline);
    return deadlines.length === 0 ? null : Math.min(...deadlines);
  }

  /** The earliest expiry of a handed-over token not yet owed for deletion, or null. */
  #nextExpiry(): number | null {
    const row = this.#db
      .select({ at: sql<number | null>`min(${schema.deployToken.expiresAt})` })
      .from(schema.deployToken)
      .where(and(eq(schema.deployToken.state, 'active'), isNull(schema.deployToken.deleteCause)))
      .get();
    return row?.at ?? null;
  }

  /**
   * When the next window check is owed: the earliest window end plus tolerance, or its retry time,
   * of a handed-over token whose check has not ended; null for none.
   */
  #nextWindowCheck(): number | null {
    const { endedAt, expiresAt, windowCheckRetryAt } = schema.deployToken;
    const row = this.#db
      .select({
        at: sql<
          number | null
        >`min(max(min(coalesce(${endedAt}, ${expiresAt}), ${expiresAt}) + ${DEPLOY_TOKEN_EXPIRY_TOLERANCE_MS}, coalesce(${windowCheckRetryAt}, 0)))`,
      })
      .from(schema.deployToken)
      .where(
        and(
          inArray(schema.deployToken.state, ['active', 'deleted']),
          isNull(schema.deployToken.windowCheck)
        )
      )
      .get();
    return row?.at ?? null;
  }

  /**
   * Sets the alarm to the earliest of the audit work, the next owed deletion, the next expiry, the
   * next window check, an interrupted creation, the next retry of a failed sweep deletion, the
   * sweep and the row prune. After an alarm (`afterAlarm`), owed deletions and sweep retries wait
   * at least `DEPLOY_TOKEN_DELETE_RETRY_MS`, so retries make at most
   * `DEPLOY_TOKEN_DELETES_PER_ALARM` Cloudflare deletes per 30 seconds whatever the number of
   * owed tokens. Deletions and the window check wait out the credential hold.
   */
  async #scheduleAlarm(now: number, failed: boolean, afterAlarm = false): Promise<void> {
    let target = Number.POSITIVE_INFINITY;
    if (this.#audit.hasUnrelayed()) {
      target = now + (failed ? RELAY_RETRY_MS : RELAY_DELAY_MS);
    } else if (this.#audit.hasRows()) {
      target = Math.max(now + 1_000, this.#audit.nextPruneAt());
    }
    const [nextDeletion] = this.#owedDeletions(Number.MAX_SAFE_INTEGER, 1);
    if (nextDeletion !== undefined) {
      const due = Math.max(nextDeletion.deleteRetryAt ?? now, this.#credentialHold.until);
      target = Math.min(
        target,
        afterAlarm ? Math.max(due, now + DEPLOY_TOKEN_DELETE_RETRY_MS) : due
      );
    }
    const windowCheck = this.#nextWindowCheck();
    if (windowCheck !== null && this.#config.cloudflareDeployAccountId !== null) {
      target = Math.min(target, Math.max(windowCheck, this.#cloudflareResumeAt()));
    }
    const expiry = this.#nextExpiry();
    if (expiry !== null) target = Math.min(target, expiry);
    const interrupted = this.#nextInterruptedCreation();
    if (interrupted !== null) target = Math.min(target, interrupted);
    const sweepRetry =
      this.#db
        .select({ at: sql<number | null>`min(${schema.deployTokenSweepRetry.retryAt})` })
        .from(schema.deployTokenSweepRetry)
        .get()?.at ?? null;
    if (sweepRetry !== null && this.#config.cloudflareDeployAccountId !== null) {
      const due = Math.max(sweepRetry, this.#cloudflareResumeAt());
      target = Math.min(
        target,
        afterAlarm ? Math.max(due, now + DEPLOY_TOKEN_DELETE_RETRY_MS) : due
      );
    }
    const sweep = this.#db
      .select({ at: schema.deployTokenSweep.nextSweepAt })
      .from(schema.deployTokenSweep)
      .where(eq(schema.deployTokenSweep.id, 1))
      .get();
    if (sweep !== undefined && this.#config.cloudflareDeployAccountId !== null) {
      target = Math.min(target, sweep.at);
    }
    const rowPrune = this.#nextRowPruneAt();
    if (rowPrune !== null) target = Math.min(target, rowPrune);
    if (target === Number.POSITIVE_INFINITY) return;
    target = Math.max(target, now + 1_000);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > target || current < now) {
      await this.ctx.storage.setAlarm(target);
    }
  }
}
