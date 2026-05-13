/**
 * Platform API routes -- backend-to-backend only (x-internal-api-key).
 *
 * All routes are thin RPC wrappers around KiloClawInstance DO methods.
 * The route handler's only job: validate input, get DO stub, call method.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import * as fly from '../fly/client';
import type { InstanceStatus } from '../durable-objects/kiloclaw-instance/types';
import type { AppEnv } from '../types';
import {
  ProvisionRequestSchema,
  UserIdRequestSchema,
  DestroyRequestSchema,
  ChannelsPatchSchema,
  GoogleCredentialsSchema,
  GoogleOAuthConnectionSchema,
  MachineSizeSchema,
  SecretsPatchSchema,
  InstanceIdParam,
} from '../schemas/instance-config';
import {
  compareTierRank,
  DEFAULT_INSTANCE_TIER,
  InstanceTierKeySchema,
  isOfferedTier,
  type InstanceTierKey,
} from '@kilocode/kiloclaw-instance-tiers';
import { ImageVersionEntrySchema, imageVersionKey } from '../schemas/image-version';
import { listAllVersions, resolveLatestVersion, updateTagIndex } from '../lib/image-version';
import {
  selectImageVersionForInstance,
  setRolloutPercent,
  markImageAsLatest,
  disableImageAndClearRollout,
} from '../lib/version-rollout';
import { setKiloclawEarlyAccess, lookupKiloclawEarlyAccessByInstanceId } from '../lib/user-flags';
import { upsertCatalogVersion } from '../lib/catalog-registration';
import { runScheduledActionNoticesSweep } from '../scheduled/scheduled-action-notices';
import { flattenError, z } from 'zod';
import {
  KiloclawStartReasonSchema,
  KiloclawStopReasonSchema,
  withDORetry,
} from '@kilocode/worker-utils';
import { readBillingCorrelationHeaders } from '@kilocode/worker-utils/kiloclaw-billing-observability';
import {
  getKiloClawPricingCatalogEntry,
  isKiloClawPriceVersion,
  markInstanceDestroyedWithPersonalSubscriptionCollapse,
  type KiloClawPriceVersion,
  type KiloClawSubscriptionChangeActor,
} from '@kilocode/db';
import {
  kiloclaw_inbound_email_aliases,
  kiloclaw_inbound_email_reserved_aliases,
  kiloclaw_instances,
} from '@kilocode/db/schema';
import { deriveGatewayToken } from '../auth/gateway-token';
import { sandboxIdFromUserId } from '../auth/sandbox-id';
import { writeEvent } from '../utils/analytics';
import { deriveHttpEventName } from '../middleware/analytics';
import { assertAvailableProvider } from '../providers';
import type { ProviderCapability } from '../providers/types';
import {
  providerRolloutAvailability,
  ProviderRolloutConfigSchema,
  readProviderRolloutConfig,
  selectProviderForProvision,
  writeProviderRolloutConfig,
} from '../providers/rollout';
import type { ProviderId } from '../schemas/instance-config';
import { doKeyFromActiveInstance, resolveDoKeyForUser } from '../lib/instance-routing';
import { getInstanceById, getInstanceByIdIncludingDestroyed, getWorkerDb } from '../db';
import { and, eq, isNull } from 'drizzle-orm';
import {
  BootstrapProvisionFallbackError,
  bootstrapProvisionedSubscriptionWithFallback,
  resolveProvisionEntitlementWithFallback,
} from './provision-bootstrap';

const GmailHistoryIdSchema = z.object({
  userId: z.string().min(1),
  historyId: z.string().min(1),
});

const KiloCodeConfigPatchSchema = z.object({
  userId: z.string().min(1),
  kilocodeApiKey: z.string().nullable().optional(),
  kilocodeApiKeyExpiresAt: z.string().nullable().optional(),
  kilocodeDefaultModel: z
    .string()
    .regex(
      /^kilocode\/[^/]+\/.+$/,
      'kilocodeDefaultModel must start with kilocode/ and include a provider'
    )
    .nullable()
    .optional(),
  vectorMemoryEnabled: z.boolean().optional(),
  vectorMemoryModel: z.string().nullable().optional(),
  dreamingEnabled: z.boolean().optional(),
});

const WebSearchConfigPatchSchema = z.object({
  userId: z.string().min(1),
  exaMode: z.enum(['kilo-proxy', 'disabled']).nullable().optional(),
});

const KILOCLAW_WORKER_DESTROY_ACTOR = {
  actorType: 'system',
  actorId: 'kiloclaw-worker',
} satisfies KiloClawSubscriptionChangeActor;

const KiloCliRunConflictSchema = z.object({
  conflict: z.object({
    code: z.enum([
      'kilo_cli_run_instance_not_running',
      'kilo_cli_run_already_active',
      'kilo_cli_run_no_active_run',
    ]),
    error: z.string().min(1),
  }),
});

const DoctorRunConflictSchema = z.object({
  conflict: z.object({
    code: z.enum([
      'openclaw_doctor_instance_not_running',
      'openclaw_doctor_already_active',
      'openclaw_doctor_no_active_run',
    ]),
    error: z.string().min(1),
  }),
});

const platform = new Hono<AppEnv>();
type KiloClawInstanceStub = ReturnType<AppEnv['Bindings']['KILOCLAW_INSTANCE']['get']>;

type BillingPlatformLogFields = {
  billingFlow?: string;
  billingRunId?: string;
  billingSweep?: string;
  billingCallId?: string;
  billingAttempt?: number;
  billingComponent: 'kiloclaw_platform';
  event: 'downstream_action';
  outcome: 'started' | 'completed' | 'failed';
  method: string;
  path: string;
  durationMs?: number;
  statusCode?: number;
  userId?: string;
  instanceId?: string;
  error?: string;
};

function logBillingPlatform(
  level: 'info' | 'error',
  message: string,
  fields: BillingPlatformLogFields
) {
  const record = JSON.stringify({
    level,
    message,
    ...fields,
  });

  if (level === 'error') {
    console.error(record);
    return;
  }
  console.log(record);
}

type ProvisionWriteLogFields = {
  event:
    | 'instance_record_insert'
    | 'instance_record_destroy'
    | 'subscription_bootstrap'
    | 'subscription_bootstrap_quarantine';
  outcome: 'started' | 'completed' | 'failed';
  userId?: string;
  instanceId?: string;
  orgId?: string | null;
  sandboxId?: string;
  durationMs?: number;
  statusCode?: number;
  inserted?: boolean;
  error?: string;
};

function logProvisionWrite(
  level: 'info' | 'error',
  message: string,
  fields: ProvisionWriteLogFields
) {
  const record = JSON.stringify({
    level,
    message,
    billingComponent: 'kiloclaw_platform',
    ...fields,
  });

  if (level === 'error') {
    console.error(record);
    return;
  }
  console.log(record);
}

// Analytics middleware — runs for every platform route. Captures timing and
// error state. Skips emitting for routes with no user context (e.g. /versions)
// unless an error occurred.
platform.use('*', async (c, next) => {
  const start = c.get('requestStartTime') ?? performance.now();
  const billingContext = readBillingCorrelationHeaders(c.req.raw.headers);
  const method = c.req.method;
  const path = c.req.path;
  const instanceId = c.req.query('instanceId') ?? undefined;

  if (billingContext) {
    logBillingPlatform('info', 'Starting billing-correlated kiloclaw platform request', {
      ...billingContext,
      billingComponent: 'kiloclaw_platform',
      event: 'downstream_action',
      outcome: 'started',
      method,
      path,
      instanceId,
    });
  }

  let error: string | undefined;
  try {
    await next();
    if (c.res.status >= 400) {
      error = `HTTP ${c.res.status}`;
    }
  } catch (err) {
    error = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    throw err;
  } finally {
    const durationMs = performance.now() - start;

    // userId is always read from Hono context — set by parseBody() for
    // POST/PATCH routes, or by setValidatedQueryUserId() for GET/DELETE routes.
    const userId = c.get('userId') || '';

    if (billingContext) {
      const statusCode = c.res.status;
      logBillingPlatform(
        error ? 'error' : 'info',
        'Finished billing-correlated kiloclaw platform request',
        {
          ...billingContext,
          billingComponent: 'kiloclaw_platform',
          event: 'downstream_action',
          outcome: error ? 'failed' : 'completed',
          method,
          path,
          durationMs,
          statusCode,
          userId: userId || undefined,
          instanceId,
          ...(error ? { error } : {}),
        }
      );
    }

    // Skip analytics for routes with no user context (e.g. /versions) unless
    // they errored — no userId means nothing useful to attribute.
    if (userId || error) {
      let sandboxId = '';
      if (userId) {
        try {
          sandboxId = sandboxIdFromUserId(userId);
        } catch {
          // ignore
        }
      }

      writeEvent(c.env, {
        event: deriveHttpEventName(method, path),
        delivery: 'http',
        route: `${method} ${path}`,
        error,
        userId,
        sandboxId,
        durationMs,
      });
    }
  }
});

/**
 * Validate and set userId from the query string onto the Hono context.
 * GET/DELETE routes use this so the analytics middleware can read userId
 * from context without falling back to raw unvalidated query params.
 */
function setValidatedQueryUserId(c: Context<AppEnv>): string | null {
  const parsed = UserIdRequestSchema.safeParse({ userId: c.req.query('userId') });
  if (!parsed.success) {
    return null;
  }

  c.set('userId', parsed.data.userId);
  return parsed.data.userId;
}

/**
 * Resolve the DO key for a platform request.
 *
 * When instanceId is provided, it is authoritative. Postgres is only a
 * best-effort bridge so legacy rows still route to their original userId-keyed
 * DO and destroyed rows keep resolving after soft-delete. Missing rows fall
 * back to the explicit instanceId so fresh provisioning can reach its DO
 * before the instance record is inserted.
 *
 * Otherwise the active Postgres row is the source of truth so legacy sandboxes
 * continue to route to the original userId-keyed DO after kilocode_users.id
 * migrations.
 */
export async function resolveInstanceDoKey(
  env: AppEnv['Bindings'],
  userId: string,
  instanceId?: string
): Promise<string> {
  if (instanceId) {
    const connectionString = env.HYPERDRIVE?.connectionString;
    if (!connectionString) {
      console.warn(
        '[platform] Missing database connection for explicit instance DO-key resolution, using instanceId',
        { userId, instanceId }
      );
      return instanceId;
    }

    try {
      const instance = await getInstanceByIdIncludingDestroyed(
        getWorkerDb(connectionString),
        instanceId,
        {
          includeDestroyed: true,
        }
      );
      if (!instance) {
        console.warn(
          '[platform] Instance not found during explicit DO-key resolution, using instanceId',
          { userId, instanceId }
        );
        return instanceId;
      }
      return doKeyFromActiveInstance(instance);
    } catch (err) {
      console.warn('[platform] Failed to resolve DO key for explicit instance, using instanceId', {
        userId,
        instanceId,
        error: err instanceof Error ? err.message : String(err),
      });
      return instanceId;
    }
  }

  try {
    return (await resolveDoKeyForUser(env.HYPERDRIVE?.connectionString, userId)) ?? userId;
  } catch (err) {
    console.warn('[platform] Failed to resolve DO key from Postgres, falling back to userId', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return userId;
  }
}

/**
 * Create a fresh KiloClawInstance DO stub.
 * Returns a factory (not the stub itself) so withDORetry can get a fresh stub per attempt.
 */
async function instanceStubFactory(
  env: AppEnv['Bindings'],
  userId: string,
  instanceId?: string
): Promise<() => KiloClawInstanceStub> {
  const doKey = await resolveInstanceDoKey(env, userId, instanceId);
  return () => env.KILOCLAW_INSTANCE.get(env.KILOCLAW_INSTANCE.idFromName(doKey));
}

async function withResolvedDORetry<TResult>(
  env: AppEnv['Bindings'],
  userId: string,
  instanceId: string | undefined,
  operation: (stub: KiloClawInstanceStub) => Promise<TResult>,
  operationName: string
): Promise<TResult> {
  return withDORetry(await instanceStubFactory(env, userId, instanceId), operation, operationName);
}

type ProvisionedInstanceRecord = {
  id: string;
  sandboxId: string;
};

function buildDefaultInboundEmailAlias(instanceId: string): string {
  return `claw-${instanceId.replaceAll('-', '')}`;
}

function isWithinSelfServiceEntitlement(
  requestedTier: InstanceTierKey,
  entitlementTier: InstanceTierKey
): boolean {
  if (requestedTier === entitlementTier) return true;
  if (!isOfferedTier(entitlementTier)) return false;
  return compareTierRank(requestedTier, entitlementTier) <= 0;
}

async function insertProvisionedInstanceRecord(params: {
  env: AppEnv['Bindings'];
  userId: string;
  instanceId: string;
  sandboxId: string;
  orgId: string | null;
  provider: ProviderId;
  instanceType: string;
}): Promise<ProvisionedInstanceRecord> {
  const connectionString = params.env.HYPERDRIVE?.connectionString;
  if (!connectionString) {
    logProvisionWrite('error', 'Instance record insert aborted: HYPERDRIVE not configured', {
      event: 'instance_record_insert',
      outcome: 'failed',
      userId: params.userId,
      instanceId: params.instanceId,
      orgId: params.orgId,
      error: 'HYPERDRIVE is not configured',
    });
    throw new Error('HYPERDRIVE is not configured');
  }

  const start = performance.now();
  logProvisionWrite('info', 'Inserting provisioned instance record', {
    event: 'instance_record_insert',
    outcome: 'started',
    userId: params.userId,
    instanceId: params.instanceId,
    orgId: params.orgId,
    sandboxId: params.sandboxId,
  });

  const db = getWorkerDb(connectionString);
  const alias = buildDefaultInboundEmailAlias(params.instanceId);
  try {
    const created = await db.transaction(async tx => {
      const [createdInstance] = await tx
        .insert(kiloclaw_instances)
        .values({
          id: params.instanceId,
          user_id: params.userId,
          sandbox_id: params.sandboxId,
          provider: params.provider,
          organization_id: params.orgId,
          instance_type: params.instanceType,
        })
        .onConflictDoNothing({ target: kiloclaw_instances.id })
        .returning({
          id: kiloclaw_instances.id,
          sandboxId: kiloclaw_instances.sandbox_id,
        });

      const [existingAlias] = await tx
        .select({ alias: kiloclaw_inbound_email_aliases.alias })
        .from(kiloclaw_inbound_email_aliases)
        .where(
          and(
            eq(kiloclaw_inbound_email_aliases.instance_id, params.instanceId),
            isNull(kiloclaw_inbound_email_aliases.retired_at)
          )
        )
        .limit(1);

      if (!existingAlias) {
        await tx
          .insert(kiloclaw_inbound_email_reserved_aliases)
          .values({ alias })
          .onConflictDoNothing();

        await tx
          .insert(kiloclaw_inbound_email_aliases)
          .values({
            alias,
            instance_id: params.instanceId,
          })
          .onConflictDoNothing({
            target: kiloclaw_inbound_email_aliases.alias,
          });
      }

      return createdInstance ?? null;
    });

    if (created) {
      logProvisionWrite('info', 'Instance record inserted', {
        event: 'instance_record_insert',
        outcome: 'completed',
        userId: params.userId,
        instanceId: params.instanceId,
        orgId: params.orgId,
        sandboxId: params.sandboxId,
        durationMs: performance.now() - start,
        inserted: true,
      });
      return created;
    }

    const [existing] = await db
      .select({
        id: kiloclaw_instances.id,
        sandboxId: kiloclaw_instances.sandbox_id,
      })
      .from(kiloclaw_instances)
      .where(eq(kiloclaw_instances.id, params.instanceId))
      .limit(1);

    if (!existing) {
      logProvisionWrite('error', 'Instance record insert reported conflict but row not found', {
        event: 'instance_record_insert',
        outcome: 'failed',
        userId: params.userId,
        instanceId: params.instanceId,
        orgId: params.orgId,
        durationMs: performance.now() - start,
        error: 'row_missing_after_conflict',
      });
      throw new Error('Failed to insert provisioned instance record');
    }

    logProvisionWrite('info', 'Instance record already existed (onConflictDoNothing hit)', {
      event: 'instance_record_insert',
      outcome: 'completed',
      userId: params.userId,
      instanceId: params.instanceId,
      orgId: params.orgId,
      sandboxId: existing.sandboxId,
      durationMs: performance.now() - start,
      inserted: false,
    });
    return existing;
  } catch (err) {
    logProvisionWrite('error', 'Instance record insert failed', {
      event: 'instance_record_insert',
      outcome: 'failed',
      userId: params.userId,
      instanceId: params.instanceId,
      orgId: params.orgId,
      durationMs: performance.now() - start,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function markProvisionedInstanceDestroyed(params: {
  env: AppEnv['Bindings'];
  instanceId: string;
}): Promise<void> {
  const connectionString = params.env.HYPERDRIVE?.connectionString;
  if (!connectionString) {
    logProvisionWrite('error', 'Instance destroy compensation aborted: HYPERDRIVE not configured', {
      event: 'instance_record_destroy',
      outcome: 'failed',
      instanceId: params.instanceId,
      error: 'HYPERDRIVE is not configured',
    });
    throw new Error('HYPERDRIVE is not configured during instance destroy compensation');
  }

  const start = performance.now();
  logProvisionWrite('info', 'Marking provisioned instance destroyed', {
    event: 'instance_record_destroy',
    outcome: 'started',
    instanceId: params.instanceId,
  });

  const db = getWorkerDb(connectionString);
  try {
    await db.transaction(async tx => {
      const [instance] = await tx
        .select({
          id: kiloclaw_instances.id,
          userId: kiloclaw_instances.user_id,
        })
        .from(kiloclaw_instances)
        .where(
          and(eq(kiloclaw_instances.id, params.instanceId), isNull(kiloclaw_instances.destroyed_at))
        )
        .limit(1);

      if (!instance) {
        return;
      }

      await markInstanceDestroyedWithPersonalSubscriptionCollapse({
        actor: KILOCLAW_WORKER_DESTROY_ACTOR,
        executor: tx,
        instanceId: instance.id,
        reason: 'destroy_path_inline_collapse',
        userId: instance.userId,
      });
    });

    logProvisionWrite('info', 'Instance record marked destroyed', {
      event: 'instance_record_destroy',
      outcome: 'completed',
      instanceId: params.instanceId,
      durationMs: performance.now() - start,
    });
  } catch (err) {
    logProvisionWrite('error', 'Instance destroy compensation failed', {
      event: 'instance_record_destroy',
      outcome: 'failed',
      instanceId: params.instanceId,
      durationMs: performance.now() - start,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/** Parse and validate optional ?instanceId= query param. Returns 400 on invalid format. */
function parseInstanceIdQuery(
  c: Context<AppEnv>
): { instanceId: string | undefined } | { error: Response } {
  const raw = c.req.query('instanceId');
  if (!raw) return { instanceId: undefined };
  const result = InstanceIdParam.safeParse(raw);
  if (!result.success) {
    return {
      error: new Response(JSON.stringify({ error: 'Invalid instance ID' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    };
  }
  return { instanceId: result.data };
}

async function requireProviderCapability(
  c: Context<AppEnv>,
  userId: string,
  instanceId: string | undefined,
  capability: ProviderCapability,
  operation: string,
  options?: { failOpen?: boolean }
): Promise<Response | null> {
  let metadata: {
    provider: string;
    capabilities: Record<ProviderCapability, boolean>;
  };
  try {
    metadata = await withResolvedDORetry(
      c.env,
      userId,
      instanceId,
      stub => stub.getProviderMetadata(),
      'getProviderMetadata'
    );
  } catch (error) {
    if (options?.failOpen) {
      console.warn(`[platform] ${operation}: provider capability lookup failed, proceeding`, error);
      return null;
    }
    throw error;
  }

  if (metadata.capabilities[capability]) {
    return null;
  }

  return jsonError(`${operation} is not supported for provider ${metadata.provider}`, 400);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isHttpStatus(value: unknown): value is { status: number } {
  return isRecord(value) && typeof value.status === 'number';
}

function hasStringCode(value: unknown): value is { code: string } {
  return isRecord(value) && typeof value.code === 'string';
}

/** Extract a string `code` from an error or its `.cause`, if present. */
function getErrorCode(err: unknown): string | undefined {
  if (hasStringCode(err)) return err.code;
  if (err instanceof Error && hasStringCode(err.cause)) return err.cause.code;
  return undefined;
}

function statusCodeFromError(err: unknown): number {
  // Extract a valid HTTP status from the error or its cause, defaulting to 500.
  for (const candidate of [err, err instanceof Error ? err.cause : undefined]) {
    if (isHttpStatus(candidate) && candidate.status >= 400 && candidate.status < 600) {
      return candidate.status;
    }
  }
  return 500;
}

function describeUnknownError(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return null;
  }
}

function jsonError(message: string, status: number, code?: string): Response {
  return new Response(JSON.stringify({ error: message, ...(code ? { code } : {}) }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Result of the running-state check used by the polling guards.
 *
 * `running: true` means the proxied call is safe to make. `running: false`
 * carries the best-known instance status label (from DO or, when verified,
 * the mapped Fly state) so the caller can include it in the sentinel
 * payload — useful for the frontend's "Instance is {status}…" hint.
 */
type InstanceRunningCheck = { running: true } | { running: false; status: InstanceStatus | null };

/**
 * Decide whether the instance is actually running, for the polling guards.
 *
 * Polling endpoints (gateway/status, gateway/ready, controller-version,
 * morning-briefing/status) proxy to port 18789 on the Fly machine via Fly's
 * HTTPS edge. Even with `services[0].autostart: false`, Fly's proxy will wake
 * a stopped machine to serve the request. The check below decides whether to
 * skip the proxied call so no traffic reaches the machine while it is stopped.
 *
 * Two layers, in order:
 *
 * 1. **Durable Object cached state.** Cheap (storage read). Handles the
 *    common case where DO and Fly agree, plus admin-UI-initiated stops where
 *    the DO has already updated its cached state.
 *
 * 2. **Fly Machines REST API state.** Only when DO says `running` and the
 *    instance is on Fly. The Machines REST API is a separate path from the
 *    HTTPS edge proxy, so this call does not wake the machine. Catches drift
 *    where DO cached state lags real Fly state (out-of-band stops: Fly CLI,
 *    dashboard, health-check kill, platform incidents). Also closes the
 *    in-flight stop race: while `DO.stop()` is waiting on `Fly.stopMachine`,
 *    DO state still reads `running` for the duration of that call, so a
 *    concurrent poll would otherwise fall through. Adds ~50-200ms to each
 *    poll where DO says running; acceptable given the 5-10s polling cadence
 *    and the alternative (the wake bug).
 *
 * Fail-open on Fly API errors: if we can't reach Fly to verify, trust the DO
 * state and forward. Logs a warning so the failure mode is visible.
 */
async function checkInstanceRunningState(
  env: AppEnv['Bindings'],
  userId: string,
  instanceId: string | undefined
): Promise<InstanceRunningCheck> {
  const status = await withResolvedDORetry(
    env,
    userId,
    instanceId,
    stub => stub.getStatus(),
    'getStatus'
  );

  // Layer 1: DO cached state says not running. Trust it (cheapest path).
  if (status.status !== 'running') {
    return { running: false, status: status.status };
  }

  // Layer 2: DO says running. Verify against live Fly state when we can,
  // because DO state can lag (out-of-band stops, in-flight stops where DO
  // hasn't yet updated its cached status after the Fly stop call).
  //
  // Skip the Fly check when:
  //   - the instance has no flyMachineId yet (pre-provisioning or non-Fly
  //     provider — nothing to verify, and forwarding is safe because there
  //     is nothing for Fly's proxy to wake);
  //   - FLY_API_TOKEN isn't configured (dev environments without Fly creds).
  const flyMachineId = status.flyMachineId;
  const flyAppName = status.flyAppName;
  if (status.provider !== 'fly' || !flyMachineId || !flyAppName || !env.FLY_API_TOKEN) {
    return { running: true };
  }

  try {
    const machine = await fly.getMachine(
      { apiToken: env.FLY_API_TOKEN, appName: flyAppName },
      flyMachineId
    );
    if (machine.state !== 'started') {
      // Drift detected. DO will reconcile its cached state on the next
      // `maybeDispatchLiveCheck` tick (already dispatched by getStatus()
      // above), so we don't force a synchronous reconcile here. Return
      // the sentinel using Fly's reported state so the frontend can show
      // an accurate label.
      console.warn('[platform] poll short-circuit: Fly reports machine not started', {
        userId,
        instanceId,
        flyMachineId,
        doStatus: status.status,
        flyState: machine.state,
      });
      return { running: false, status: mapFlyStateToDoStatus(machine.state) };
    }
  } catch (err) {
    // Fail open: trust DO state when Fly is unreachable. The alternative
    // (failing closed) would break polling during any Fly API hiccup.
    console.warn('[platform] poll short-circuit: Fly state check failed, trusting DO', {
      userId,
      instanceId,
      flyMachineId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { running: true };
}

/**
 * Wrapper around `checkInstanceRunningState` that builds the unified 200
 * sentinel response (`{ ok: false, reason, status }`) when not running.
 * Returns `null` when the proxied call is safe to make.
 *
 * Routes whose existing response shape is `{ ready, ... }` should call
 * `checkInstanceRunningState` directly and build a route-shaped sentinel
 * — see `/gateway/ready` for an example.
 */
async function shortCircuitIfNotRunning(
  env: AppEnv['Bindings'],
  userId: string,
  instanceId: string | undefined
): Promise<Response | null> {
  const check = await checkInstanceRunningState(env, userId, instanceId);
  if (check.running) return null;
  return new Response(
    JSON.stringify({
      ok: false,
      reason: 'instance_not_running',
      status: check.status,
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }
  );
}

/**
 * Map a Fly machine state into the closest equivalent DO status label so
 * the frontend's "Instance is {status}…" hint reads naturally. We can't
 * always represent Fly states 1:1 (e.g. Fly has no `restoring`), so
 * unknown states fall through to `stopped` which is the safer default for
 * a polling guard.
 *
 * Return type is `InstanceStatus` (the worker's canonical DO status enum)
 * rather than `string`, so adding a new Fly state mapping to a value
 * outside the DO vocabulary fails to typecheck instead of silently
 * shipping a label the frontend doesn't understand.
 */
function mapFlyStateToDoStatus(state: string): InstanceStatus {
  switch (state) {
    case 'started':
      return 'running';
    case 'starting':
    case 'created':
    case 'replacing':
    case 'updating':
      return 'starting';
    case 'stopping':
      return 'stopped';
    case 'stopped':
    case 'suspended':
    case 'destroying':
    case 'destroyed':
    case 'failed':
      return 'stopped';
    default:
      return 'stopped';
  }
}

function kiloCliRunConflictResponse(response: unknown): Response | undefined {
  const result = KiloCliRunConflictSchema.safeParse(response);
  if (result.success) {
    const { code, error } = result.data.conflict;
    return jsonError(error, 409, code);
  }

  if (isRecord(response) && 'conflict' in response) {
    return jsonError('Invalid Kilo CLI conflict response', 502, 'upstream_invalid_response');
  }

  return undefined;
}

function doctorRunConflictResponse(response: unknown): Response | undefined {
  const result = DoctorRunConflictSchema.safeParse(response);
  if (result.success) {
    const { code, error } = result.data.conflict;
    return jsonError(error, 409, code);
  }

  if (isRecord(response) && 'conflict' in response) {
    return jsonError('Invalid doctor conflict response', 502, 'upstream_invalid_response');
  }

  return undefined;
}

/**
 * Safe error messages that can be returned to callers without leaking internals.
 * All other error messages are replaced with a generic "Internal error" response.
 * The raw error is always logged via console.error for Sentry/debugging.
 */
const SAFE_ERROR_PREFIXES = [
  'Instance is not ', // e.g. "Instance is not running"
  'Instance not ', // e.g. "Instance not provisioned" (DO uses both forms)
  'Instance must be stopped ', // volume reassociation requires stopped state
  'User already has an ', // duplicate provision
  'Gateway controller ', // already sanitized at DO level
  'Config was modified ', // etag mismatch on config replace
  'Invalid secret patch: ', // catalog validation (allFieldsRequired, etc.)
  'Cannot enable Gmail ', // no Google account connected
  'New volume ID is ', // reassociate: same volume
  'Volume ', // reassociate: volume not found / bad state
  'Cannot restore: ', // snapshot restore: bad state
  'Cannot destroy: ', // destroy while restoring
  'Cannot resize: ', // resize during destroying/restoring/recovering
  'Cannot retry recovery', // force-retry-recovery guard messages
  'Stream Chat sendMessage failed', // sendMessage HTTP errors
  'Stream Chat is not set up', // no Stream Chat on this instance
  'Provider ', // explicit not-implemented provider errors
];

function sanitizeError(err: unknown, operation: string): { message: string; status: number } {
  const raw = err instanceof Error ? err.message : 'Unknown error';
  const status = statusCodeFromError(err);
  const normalized = raw.replace(/^(?:[A-Za-z]+Error:\s*)+/, '');

  // Log the full error for Sentry/debugging — this never reaches the caller
  console.error(`[platform] ${operation} failed:`, err);

  // Allow known-safe messages through
  if (SAFE_ERROR_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
    return { message: normalized, status: correctLostStatus(normalized, status) };
  }

  return { message: `${operation} failed`, status };
}

function classifyProvisionFailure(err: unknown, status: number): string {
  const raw = err instanceof Error ? err.message : String(err);
  const flyApiMatch = raw.match(/Fly API ([A-Za-z0-9_-]+) failed \((\d{3})\)/);
  const flyOperation = flyApiMatch?.[1];
  const flyStatus = flyApiMatch?.[2];
  if (flyOperation && flyStatus) return `fly_api_${flyOperation}_${flyStatus}`;
  return `provision_${status}`;
}

/**
 * DO lifecycle methods throw `Object.assign(new Error('Instance not provisioned'), { status: 404 })`
 * but `.status` is lost crossing the DO RPC boundary, so `statusCodeFromError`
 * defaults to 500. Correct it here for this specific message only.
 *
 * Note: `requireGatewayControllerContext()` in gateway.ts throws the same message
 * with status 409 (conflict). We only correct when status === 500 (i.e. lost),
 * so a preserved 409 passes through unchanged.
 */
function correctLostStatus(message: string, status: number): number {
  if (status === 500 && message === 'Instance not provisioned') return 404;
  if (
    status === 500 &&
    message.startsWith('Provider ') &&
    message.endsWith(' is not implemented yet')
  )
    return 501;
  return status;
}

const OPENCLAW_CONFIG_ERROR_CODES = new Set([
  'controller_route_unavailable',
  'config_etag_conflict',
  'file_etag_conflict',
  'file_not_found',
  'invalid_json_body',
  'invalid_request_body',
]);

function isSafeOpenclawConfigCode(code: string): boolean {
  return OPENCLAW_CONFIG_ERROR_CODES.has(code) || code.startsWith('openclaw_import_');
}

function sanitizeOpenclawConfigError(
  err: unknown,
  operation: string
): { message: string; status: number; code?: string } {
  const raw = err instanceof Error ? err.message : 'Unknown error';
  const status = statusCodeFromError(err);
  const normalized = raw.replace(/^(?:[A-Za-z]+Error:\s*)+/, '');
  const code = getErrorCode(err);

  console.error(`[platform] ${operation} failed:`, raw);

  if (code && isSafeOpenclawConfigCode(code)) {
    return { message: normalized, status, code };
  }

  if (SAFE_ERROR_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
    return {
      message: normalized,
      status: correctLostStatus(normalized, status),
      ...(code ? { code } : {}),
    };
  }

  return { message: `${operation} failed`, status, ...(code ? { code } : {}) };
}

/**
 * Safely parse JSON body through a zod schema.
 * Returns 400 with a consistent error shape on malformed JSON or validation failure.
 */
async function parseBody<T extends z.ZodTypeAny>(
  c: Context<AppEnv>,
  schema: T
): Promise<{ data: z.infer<T> } | { error: Response }> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { error: c.json({ error: 'Malformed JSON body' }, 400) };
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return {
      error: c.json({ error: 'Invalid request', details: parsed.error.flatten().fieldErrors }, 400),
    };
  }

  // Expose userId on the Hono context so the analytics middleware can
  // read it after the handler completes. Platform routes use
  // x-internal-api-key auth (no JWT), so userId comes from the body.
  if (
    parsed.data &&
    typeof parsed.data === 'object' &&
    'userId' in parsed.data &&
    typeof parsed.data.userId === 'string' &&
    parsed.data.userId
  ) {
    c.set('userId', parsed.data.userId);
  }

  return { data: parsed.data };
}

// POST /api/platform/provision
platform.post('/provision', async c => {
  const result = await parseBody(c, ProvisionRequestSchema);
  if ('error' in result) return result.error;

  const {
    userId,
    instanceId,
    orgId,
    bootstrapSubscription,
    provider,
    envVars,
    encryptedSecrets,
    channels,
    kilocodeApiKey,
    kilocodeApiKeyExpiresAt,
    kilocodeDefaultModel,
    userTimezone,
    userLocation,
    instanceType: requestedInstanceType,
    region,
    pinnedImageTag,
  } = result.data;
  if (requestedInstanceType && !isOfferedTier(requestedInstanceType)) {
    return c.json({ error: 'instanceType must be an offered tier' }, 400);
  }
  const provisionedInstanceId = instanceId ?? crypto.randomUUID();
  const shouldInsertInstanceRecord = !instanceId;
  const shouldBootstrapSubscription = !instanceId || bootstrapSubscription === true;
  const provisionRoute = '/api/platform/provision';
  const provisionDoKey = await resolveInstanceDoKey(c.env, userId, provisionedInstanceId);
  const provisionStartedAt = performance.now();

  let selectedProvider = provider;
  if (!selectedProvider && shouldInsertInstanceRecord) {
    selectedProvider = await selectProviderForProvision({
      kv: c.env.KV_CLAW_CACHE,
      userId,
      orgId,
      workerEnv: c.env.WORKER_ENV,
      defaultProvider: c.env.KILOCLAW_DEFAULT_PROVIDER,
    });
  }

  let provisionEntitlement: {
    priceVersion: KiloClawPriceVersion;
    selfServiceInstanceType: InstanceTierKey;
  } | null = null;
  let instanceType: InstanceTierKey | undefined;
  let provision: Awaited<ReturnType<KiloClawInstanceStub['provision']>>;
  try {
    if (selectedProvider) {
      assertAvailableProvider(c.env, selectedProvider);
    }
    if (shouldInsertInstanceRecord) {
      const resolvedEntitlement = await resolveProvisionEntitlementWithFallback({
        env: c.env,
        input: { userId, orgId: orgId ?? null },
      });
      if (!isKiloClawPriceVersion(resolvedEntitlement.priceVersion)) {
        throw new Error(`Unknown KiloClaw price version: ${resolvedEntitlement.priceVersion}`);
      }
      const pricing = getKiloClawPricingCatalogEntry(resolvedEntitlement.priceVersion);
      const resolvedSelfServiceInstanceType = InstanceTierKeySchema.parse(
        resolvedEntitlement.selfServiceInstanceType
      );
      if (resolvedSelfServiceInstanceType !== pricing.selfServiceInstanceType) {
        throw new Error(
          `KiloClaw entitlement tier drift during provision: price version ${pricing.priceVersion} resolved ${resolvedSelfServiceInstanceType}, catalog expects ${pricing.selfServiceInstanceType}`
        );
      }
      provisionEntitlement = {
        priceVersion: pricing.priceVersion,
        selfServiceInstanceType: pricing.selfServiceInstanceType,
      };
      if (
        requestedInstanceType &&
        !isWithinSelfServiceEntitlement(
          requestedInstanceType,
          provisionEntitlement.selfServiceInstanceType
        )
      ) {
        return c.json({ error: 'instanceType exceeds self-service entitlement' }, 400);
      }
    }
    // Only default to the billing entitlement tier on FRESH inserts. On
    // re-provision (config updates with an existing instanceId), pass
    // `undefined` so the DO's `inferredInstanceType` path preserves existing
    // tier / machineSize / volumeSizeGb. `provision()` is overloaded as the
    // entrypoint for both fresh-create and config-update flows; defaulting
    // unconditionally would silently overwrite custom (e.g. extend-volume) and
    // legacy tiers on the next config change.
    instanceType =
      requestedInstanceType ??
      (shouldInsertInstanceRecord ? provisionEntitlement?.selfServiceInstanceType : undefined);
    provision = await withResolvedDORetry(
      c.env,
      userId,
      provisionedInstanceId,
      stub =>
        stub.provision(
          userId,
          {
            envVars,
            encryptedSecrets,
            channels,
            kilocodeApiKey,
            kilocodeApiKeyExpiresAt,
            kilocodeDefaultModel,
            userTimezone,
            userLocation,
            instanceType,
            region,
            pinnedImageTag,
          },
          { instanceId: provisionedInstanceId, orgId, provider: selectedProvider }
        ),
      'provision'
    );
  } catch (err) {
    const raw = err instanceof Error ? err.message : 'Unknown error';
    if (raw.includes('duplicate key') || raw.includes('unique constraint')) {
      console.error('[platform] provision failed: duplicate instance');
      return c.json({ error: 'User already has an active instance' }, 409);
    }
    const { message, status } = sanitizeError(err, 'provision');
    writeEvent(c.env, {
      event: 'instance.provisioning_failed',
      delivery: 'http',
      route: provisionRoute,
      userId,
      instanceId: provisionedInstanceId,
      orgId: orgId ?? undefined,
      error: message,
      label: classifyProvisionFailure(err, status),
      durationMs: performance.now() - provisionStartedAt,
      value: status,
    });
    return jsonError(message, status);
  }

  if (shouldInsertInstanceRecord) {
    const insertStartedAt = performance.now();
    try {
      await insertProvisionedInstanceRecord({
        env: c.env,
        userId,
        instanceId: provisionedInstanceId,
        sandboxId: provision.sandboxId,
        orgId: orgId ?? null,
        provider: selectedProvider ?? 'fly',
        // Inside this branch `shouldInsertInstanceRecord` is true, so the
        // worker-side tier default has already been applied to `instanceType`
        // — but TS can't narrow `string | undefined` from the broader scope.
        // Re-derive locally so the helper signature stays `string`.
        instanceType:
          requestedInstanceType ??
          provisionEntitlement?.selfServiceInstanceType ??
          DEFAULT_INSTANCE_TIER,
      });
      writeEvent(c.env, {
        event: 'instance.record_inserted',
        delivery: 'http',
        route: provisionRoute,
        userId,
        instanceId: provisionedInstanceId,
        sandboxId: provision.sandboxId,
        orgId: orgId ?? undefined,
        durationMs: performance.now() - insertStartedAt,
      });
    } catch (persistErr) {
      console.error('[platform] Provision post-processing failed:', persistErr);
      const { message, status } = sanitizeError(persistErr, 'post-provision bootstrap');
      writeEvent(c.env, {
        event: 'instance.record_insert_failed',
        delivery: 'http',
        route: provisionRoute,
        userId,
        instanceId: provisionedInstanceId,
        sandboxId: provision.sandboxId,
        orgId: orgId ?? undefined,
        error: message,
        durationMs: performance.now() - insertStartedAt,
      });
      await withResolvedDORetry(
        c.env,
        userId,
        provisionedInstanceId,
        stub => stub.destroy({ reason: 'bootstrap_cleanup_failure' }),
        'destroy'
      ).catch(destroyErr => {
        console.error(
          '[platform] Failed to destroy provisioned instance after bootstrap error:',
          destroyErr
        );
      });
      await markProvisionedInstanceDestroyed({
        env: c.env,
        instanceId: provisionedInstanceId,
      }).catch(markErr => {
        console.error(
          '[platform] Failed to mark instance destroyed after bootstrap error:',
          markErr
        );
      });
      return jsonError(message, status);
    }
  }

  if (shouldBootstrapSubscription) {
    const bootstrapStartedAt = performance.now();
    logProvisionWrite('info', 'Bootstrapping provisioned subscription', {
      event: 'subscription_bootstrap',
      outcome: 'started',
      userId,
      instanceId: provisionedInstanceId,
      orgId: orgId ?? null,
    });
    try {
      const bootstrap = await bootstrapProvisionedSubscriptionWithFallback({
        env: c.env,
        input: {
          userId,
          instanceId: provisionedInstanceId,
          orgId: orgId ?? null,
          expectedPriceVersion: provisionEntitlement?.priceVersion,
        },
      });
      logProvisionWrite('info', 'Provisioned subscription bootstrapped', {
        event: 'subscription_bootstrap',
        outcome: 'completed',
        userId,
        instanceId: provisionedInstanceId,
        orgId: orgId ?? null,
        durationMs: performance.now() - bootstrapStartedAt,
      });
      writeEvent(c.env, {
        event: 'instance.subscription_bootstrapped',
        delivery: 'http',
        route: provisionRoute,
        userId,
        instanceId: provisionedInstanceId,
        sandboxId: provision.sandboxId,
        orgId: orgId ?? undefined,
        label: bootstrap.mode,
        durationMs: performance.now() - bootstrapStartedAt,
      });
    } catch (persistErr) {
      console.error('[platform] Provision post-processing failed:', persistErr);
      const { message, status } = sanitizeError(persistErr, 'post-provision bootstrap');
      writeEvent(c.env, {
        event: 'instance.subscription_bootstrap_failed',
        delivery: 'http',
        route: provisionRoute,
        userId,
        instanceId: provisionedInstanceId,
        sandboxId: provision.sandboxId,
        orgId: orgId ?? undefined,
        error: message,
        durationMs: performance.now() - bootstrapStartedAt,
      });
      const rpcError =
        persistErr instanceof BootstrapProvisionFallbackError ? persistErr.rpcError : persistErr;
      const fallbackError =
        persistErr instanceof BootstrapProvisionFallbackError
          ? persistErr.fallbackError
          : undefined;
      logProvisionWrite('error', 'Subscription bootstrap quarantined for remediation', {
        event: 'subscription_bootstrap_quarantine',
        outcome: 'failed',
        userId,
        instanceId: provisionedInstanceId,
        orgId: orgId ?? null,
        durationMs: performance.now() - bootstrapStartedAt,
        error:
          fallbackError instanceof Error
            ? fallbackError.message.slice(0, 500)
            : message.slice(0, 500),
      });
      writeEvent(c.env, {
        event: 'instance.subscription_bootstrap_quarantined',
        delivery: 'http',
        route: provisionRoute,
        userId,
        instanceId: provisionedInstanceId,
        sandboxId: provision.sandboxId,
        orgId: orgId ?? undefined,
        error: [message, describeUnknownError(rpcError), describeUnknownError(fallbackError)]
          .filter(part => !!part)
          .join(' | '),
        label: 'rpc_and_local_fallback_failed',
        durationMs: performance.now() - bootstrapStartedAt,
      });
      if (shouldInsertInstanceRecord) {
        await withResolvedDORetry(
          c.env,
          userId,
          provisionedInstanceId,
          stub => stub.destroy({ reason: 'bootstrap_cleanup_failure' }),
          'destroy'
        ).catch(destroyErr => {
          console.error(
            '[platform] Failed to destroy provisioned instance after subscription bootstrap error:',
            destroyErr
          );
        });
        await markProvisionedInstanceDestroyed({
          env: c.env,
          instanceId: provisionedInstanceId,
        }).catch(markErr => {
          console.error(
            '[platform] Failed to mark bootstrap-quarantined instance destroyed for retry:',
            markErr
          );
        });
      }
      console.error(
        '[platform] Subscription bootstrap failed after local fallback; instance quarantined for remediation',
        {
          userId,
          instanceId: provisionedInstanceId,
          doKey: provisionDoKey,
          shouldInsertInstanceRecord,
          rpcError: describeUnknownError(rpcError) ?? undefined,
          fallbackError: describeUnknownError(fallbackError) ?? undefined,
        }
      );
      return jsonError(message, status);
    }
  }

  try {
    const registryKey = orgId ? `org:${orgId}` : `user:${userId}`;
    const registryStub = c.env.KILOCLAW_REGISTRY.get(
      c.env.KILOCLAW_REGISTRY.idFromName(registryKey)
    );
    await registryStub.createInstance(registryKey, userId, provisionedInstanceId, provisionDoKey);
    console.log('[platform] Registry entry created:', {
      registryKey,
      instanceId: provisionedInstanceId,
      doKey: provisionDoKey,
    });
  } catch (registryErr) {
    console.error('[platform] Registry create failed (non-fatal):', registryErr);
  }

  return c.json(
    {
      ...provision,
      instanceId: provisionedInstanceId,
    },
    201
  );
});

// PATCH /api/platform/kilocode-config
platform.patch('/kilocode-config', async c => {
  const result = await parseBody(c, KiloCodeConfigPatchSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const {
    userId,
    kilocodeApiKey,
    kilocodeApiKeyExpiresAt,
    kilocodeDefaultModel,
    vectorMemoryEnabled,
    vectorMemoryModel,
    dreamingEnabled,
  } = result.data;

  try {
    const updated = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub =>
        stub.updateKiloCodeConfig({
          kilocodeApiKey,
          kilocodeApiKeyExpiresAt,
          kilocodeDefaultModel,
          vectorMemoryEnabled,
          vectorMemoryModel,
          dreamingEnabled,
        }),
      'updateKiloCodeConfig'
    );
    return c.json(updated, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'kilocode-config patch');
    return jsonError(message, status);
  }
});

// PATCH /api/platform/web-search-config
platform.patch('/web-search-config', async c => {
  const result = await parseBody(c, WebSearchConfigPatchSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId, exaMode } = result.data;

  try {
    const updated = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.updateWebSearchConfig({ exaMode }),
      'updateWebSearchConfig'
    );
    return c.json(updated, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'web-search-config patch');
    return jsonError(message, status);
  }
});

// PATCH /api/platform/channels
platform.patch('/channels', async c => {
  const result = await parseBody(c, ChannelsPatchSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId, channels } = result.data;

  try {
    const updated = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.updateChannels(channels),
      'updateChannels'
    );
    return c.json(updated, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'channels patch');
    return jsonError(message, status);
  }
});

// PATCH /api/platform/exec-preset
const ExecPresetPatchSchema = z.object({
  userId: z.string().min(1),
  security: z.string().optional(),
  ask: z.string().optional(),
});

const BotIdentityPatchSchema = z.object({
  userId: z.string().min(1),
  botName: z.string().trim().min(1).max(80).nullable().optional(),
  botNature: z.string().trim().min(1).max(120).nullable().optional(),
  botVibe: z.string().trim().min(1).max(120).nullable().optional(),
  botEmoji: z.string().trim().min(1).max(16).nullable().optional(),
});

platform.patch('/exec-preset', async c => {
  const result = await parseBody(c, ExecPresetPatchSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId, security, ask } = result.data;

  try {
    const updated = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.updateExecPreset({ security, ask }),
      'updateExecPreset'
    );
    return c.json(updated, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'exec-preset patch');
    return jsonError(message, status);
  }
});

platform.patch('/bot-identity', async c => {
  const result = await parseBody(c, BotIdentityPatchSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId, botName, botNature, botVibe, botEmoji } = result.data;

  try {
    const updated = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.updateBotIdentity({ botName, botNature, botVibe, botEmoji }),
      'updateBotIdentity'
    );
    return c.json(updated, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'bot-identity patch');
    return jsonError(message, status);
  }
});

// POST /api/platform/google-credentials
const GoogleCredentialsPatchSchema = z.object({
  userId: z.string().min(1),
  googleCredentials: GoogleCredentialsSchema,
});

platform.post('/google-credentials', async c => {
  const result = await parseBody(c, GoogleCredentialsPatchSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId, googleCredentials } = result.data;

  try {
    const updated = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.updateGoogleCredentials(googleCredentials),
      'updateGoogleCredentials'
    );
    return c.json(updated, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'google-credentials');
    return jsonError(message, status);
  }
});

// DELETE /api/platform/google-credentials?userId=...
platform.delete('/google-credentials', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) return c.json({ error: 'userId is required' }, 400);

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const updated = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.clearGoogleCredentials(),
      'clearGoogleCredentials'
    );
    return c.json(updated, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'google-credentials delete');
    return jsonError(message, status);
  }
});

// POST /api/platform/gmail-notifications
platform.post('/gmail-notifications', async c => {
  const result = await parseBody(c, UserIdRequestSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId } = result.data;

  try {
    const updated = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.updateGmailNotifications(true),
      'enableGmailNotifications'
    );
    return c.json(updated, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'gmail-notifications enable');
    return jsonError(message, status);
  }
});

// DELETE /api/platform/gmail-notifications?userId=...
platform.delete('/gmail-notifications', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) return c.json({ error: 'userId is required' }, 400);

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const updated = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.updateGmailNotifications(false),
      'disableGmailNotifications'
    );
    return c.json(updated, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'gmail-notifications disable');
    return jsonError(message, status);
  }
});

const GoogleOAuthConnectionPatchSchema = z.object({
  userId: z.string().min(1),
  googleOAuthConnection: GoogleOAuthConnectionSchema,
});

// POST /api/platform/google-oauth-connection
platform.post('/google-oauth-connection', async c => {
  const result = await parseBody(c, GoogleOAuthConnectionPatchSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId, googleOAuthConnection } = result.data;

  try {
    const updated = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub =>
        stub.updateGoogleOAuthConnection({
          status: googleOAuthConnection.status,
          accountEmail: googleOAuthConnection.accountEmail,
          accountSubject: googleOAuthConnection.accountSubject,
          scopes: googleOAuthConnection.scopes,
          capabilities: googleOAuthConnection.capabilities,
          lastError: googleOAuthConnection.lastError,
        }),
      'updateGoogleOAuthConnection'
    );
    return c.json(updated, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'google-oauth-connection');
    return jsonError(message, status);
  }
});

// DELETE /api/platform/google-oauth-connection?userId=...
platform.delete('/google-oauth-connection', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) return c.json({ error: 'userId is required' }, 400);

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const updated = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.clearGoogleOAuthConnection(),
      'clearGoogleOAuthConnection'
    );
    return c.json(updated, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'google-oauth-connection delete');
    return jsonError(message, status);
  }
});

// POST /api/platform/gmail-history-id — best-effort historyId tracking from queue consumer
platform.post('/gmail-history-id', async c => {
  const result = await parseBody(c, GmailHistoryIdSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId, historyId } = result.data;

  try {
    await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.updateGmailHistoryId(historyId),
      'updateGmailHistoryId'
    );
    return c.json({ ok: true }, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'gmail-history-id update');
    return jsonError(message, status);
  }
});

// GET /api/platform/gmail-oidc-email?userId=...
// Lightweight lookup for the push worker — no Fly live check.
platform.get('/gmail-oidc-email', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) return c.json({ error: 'userId is required' }, 400);

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const result = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.getGmailOidcEmail(),
      'getGmailOidcEmail'
    );
    return c.json(result);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'gmail-oidc-email');
    return jsonError(message, status);
  }
});

// PATCH /api/platform/secrets
platform.patch('/secrets', async c => {
  const result = await parseBody(c, SecretsPatchSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId, secrets, meta } = result.data;

  try {
    const updated = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.updateSecrets(secrets, meta),
      'updateSecrets'
    );
    return c.json(updated, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'secrets patch');
    return jsonError(message, status);
  }
});

// GET /api/platform/pairing?userId=...&refresh=true
platform.get('/pairing', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) return c.json({ error: 'userId is required' }, 400);

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const forceRefresh = c.req.query('refresh') === 'true';

  try {
    const pairing = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.listPairingRequests(forceRefresh),
      'listPairingRequests'
    );
    return c.json(pairing, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'pairing list');
    return jsonError(message, status);
  }
});

// POST /api/platform/pairing/approve
const PairingApproveSchema = z.object({
  userId: z.string().min(1),
  channel: z.string().min(1),
  code: z.string().min(1),
});

platform.post('/pairing/approve', async c => {
  const result = await parseBody(c, PairingApproveSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId, channel, code } = result.data;

  try {
    const approved = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.approvePairingRequest(channel, code),
      'approvePairingRequest'
    );
    return c.json(approved, approved.success ? 200 : 500);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'pairing approve');
    return jsonError(message, status);
  }
});

// GET /api/platform/device-pairing?userId=...&refresh=true
platform.get('/device-pairing', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) return c.json({ error: 'userId is required' }, 400);

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const forceRefresh = c.req.query('refresh') === 'true';

  try {
    const pairing = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.listDevicePairingRequests(forceRefresh),
      'listDevicePairingRequests'
    );
    return c.json(pairing, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'device pairing list');
    return jsonError(message, status);
  }
});

// POST /api/platform/device-pairing/approve
const DevicePairingApproveSchema = z.object({
  userId: z.string().min(1),
  requestId: z.string().uuid(),
});

platform.post('/device-pairing/approve', async c => {
  const result = await parseBody(c, DevicePairingApproveSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId, requestId } = result.data;

  try {
    const approved = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.approveDevicePairingRequest(requestId),
      'approveDevicePairingRequest'
    );
    return c.json(approved, approved.success ? 200 : 500);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'device pairing approve');
    return jsonError(message, status);
  }
});

// GET /api/platform/gateway/status?userId=...
platform.get('/gateway/status', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) {
    return c.json({ error: 'userId query parameter is required' }, 400);
  }

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const sentinel = await shortCircuitIfNotRunning(c.env, userId, iidResult.instanceId);
    if (sentinel) return sentinel;

    const gatewayStatus = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.getGatewayProcessStatus(),
      'getGatewayProcessStatus'
    );
    return c.json(gatewayStatus, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'gateway status');
    return jsonError(message, status);
  }
});

// GET /api/platform/gateway/ready?userId=...
// Non-fatal polling endpoint — always returns 200 so the frontend poll
// doesn't generate a wall of errors during startup. Polled aggressively
// (every 5s on the user dashboard) so it shares the wake-bug exposure with
// the other guarded routes; the guard below short-circuits it for the same
// reason. The response keeps its existing `{ ready, ... }` shape rather
// than the unified `{ ok, reason }` sentinel so consumers that already
// check `gatewayReady?.ready` keep working unchanged.
platform.get('/gateway/ready', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) {
    return c.json({ error: 'userId query parameter is required' }, 400);
  }

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const check = await checkInstanceRunningState(c.env, userId, iidResult.instanceId);
    if (!check.running) {
      return c.json({ ready: false, reason: 'instance_not_running', status: check.status }, 200);
    }

    const result = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.getGatewayReady(),
      'getGatewayReady'
    );
    return c.json(result ?? { ready: false, error: 'controller too old' }, 200);
  } catch (err) {
    const { message } = sanitizeError(err, 'gateway ready');
    return c.json({ ready: false, error: message }, 200);
  }
});

// GET /api/platform/controller-version?userId=...
platform.get('/controller-version', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) {
    return c.json({ error: 'userId query parameter is required' }, 400);
  }

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const sentinel = await shortCircuitIfNotRunning(c.env, userId, iidResult.instanceId);
    if (sentinel) return sentinel;

    const result = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.getControllerVersion(),
      'getControllerVersion'
    );
    // null means the controller is too old to have /_kilo/version
    return c.json(result ?? { version: null, commit: null }, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const status = statusCodeFromError(err);
    console.error(`[platform] controller version failed: ${message} status=${status}`);
    return jsonError(message, status);
  }
});

// POST /api/platform/gateway/start
platform.post('/gateway/start', async c => {
  const result = await parseBody(c, UserIdRequestSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const response = await withResolvedDORetry(
      c.env,
      result.data.userId,
      iidResult.instanceId,
      stub => stub.startGatewayProcess(),
      'startGatewayProcess'
    );
    return c.json(response, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'gateway start');
    return jsonError(message, status);
  }
});

// POST /api/platform/gateway/stop
platform.post('/gateway/stop', async c => {
  const result = await parseBody(c, UserIdRequestSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const response = await withResolvedDORetry(
      c.env,
      result.data.userId,
      iidResult.instanceId,
      stub => stub.stopGatewayProcess(),
      'stopGatewayProcess'
    );
    return c.json(response, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'gateway stop');
    return jsonError(message, status);
  }
});

// POST /api/platform/gateway/restart
platform.post('/gateway/restart', async c => {
  const result = await parseBody(c, UserIdRequestSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const response = await withResolvedDORetry(
      c.env,
      result.data.userId,
      iidResult.instanceId,
      stub => stub.restartGatewayProcess(),
      'restartGatewayProcess'
    );
    return c.json(response, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'gateway restart');
    return jsonError(message, status);
  }
});

// POST /api/platform/config/restore
const ConfigRestoreSchema = z.object({
  userId: z.string().min(1),
  version: z.literal('base'),
});

platform.post('/config/restore', async c => {
  const result = await parseBody(c, ConfigRestoreSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId, version } = result.data;

  try {
    const response = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.restoreConfig(version),
      'restoreConfig'
    );
    return c.json(response, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const status = statusCodeFromError(err);
    console.error('[platform] config restore failed:', message);
    return jsonError(message, status);
  }
});

// GET /api/platform/openclaw-config?userId=...
// Returns the live openclaw.json from the running machine.
platform.get('/openclaw-config', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) {
    return c.json({ error: 'userId query parameter is required' }, 400);
  }

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const config = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.getOpenclawConfig(),
      'getOpenclawConfig'
    );
    if (!config) {
      return jsonError('Failed to get OpenClaw config', 404, 'controller_route_unavailable');
    }
    return c.json(config, 200);
  } catch (err) {
    const { message, status, code } = sanitizeOpenclawConfigError(err, 'openclaw-config read');
    return jsonError(message, status, code);
  }
});

// POST /api/platform/openclaw-config
// Replace the entire openclaw.json on the running machine.
const ReplaceOpenclawConfigSchema = z.object({
  userId: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
  etag: z.string().optional(),
});

platform.post('/openclaw-config', async c => {
  const result = await parseBody(c, ReplaceOpenclawConfigSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId, config, etag } = result.data;

  try {
    const response = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.replaceConfigOnMachine(config, etag),
      'replaceConfigOnMachine'
    );
    if (!response) {
      return jsonError('Failed to update OpenClaw config', 404, 'controller_route_unavailable');
    }
    return c.json(response, 200);
  } catch (err) {
    const { message, status, code } = sanitizeOpenclawConfigError(err, 'openclaw-config replace');
    return jsonError(message, status, code);
  }
});

// PATCH /api/platform/openclaw-config
// Deep-merge a JSON patch into the live openclaw.json on the running machine.
const PatchOpenclawConfigSchema = z.object({
  userId: z.string().min(1),
  patch: z.record(z.string(), z.unknown()),
});

platform.patch('/openclaw-config', async c => {
  const result = await parseBody(c, PatchOpenclawConfigSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId, patch } = result.data;

  try {
    const response = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.patchOpenclawConfig(patch),
      'patchOpenclawConfig'
    );
    return c.json(response, 200);
  } catch (err) {
    const { message, status, code } = sanitizeOpenclawConfigError(err, 'openclaw-config patch');
    return jsonError(message, status, code);
  }
});

const MorningBriefingSetupSchema = z.object({
  userId: z.string().min(1),
  cron: z.string().min(1).optional(),
  timezone: z.string().min(1).optional(),
});

// Caps protect both the plugin (config.json size) and the eventual
// web-search query (PR-4c) from runaway input.
const MAX_INTEREST_TOPICS = 20;
const MAX_INTEREST_TOPIC_LENGTH = 64;
const MorningBriefingInterestsSchema = z.object({
  userId: z.string().min(1),
  topics: z.array(z.string().trim().min(1).max(MAX_INTEREST_TOPIC_LENGTH)).max(MAX_INTEREST_TOPICS),
});

type MorningBriefingWarmupRetryPolicy = {
  includeTimeout: boolean;
};

function isMorningBriefingTimeoutError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  const normalized = raw.replace(/^(?:[A-Za-z]+Error:\s*)+/, '');
  return normalized.includes('operation was aborted due to timeout');
}

function isMorningBriefingWarmupError(
  err: unknown,
  policy: MorningBriefingWarmupRetryPolicy = { includeTimeout: true }
): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  const normalized = raw.replace(/^(?:[A-Za-z]+Error:\s*)+/, '');
  if (
    normalized.includes('Gateway not running') ||
    normalized.includes('Instance is not running') ||
    normalized.includes('Failed to reach gateway')
  ) {
    return true;
  }
  return policy.includeTimeout && isMorningBriefingTimeoutError(err);
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function withMorningBriefingWarmupRetry<T>(
  operation: () => Promise<T>,
  policy: MorningBriefingWarmupRetryPolicy = { includeTimeout: true }
): Promise<T> {
  const delaysMs = [0, 750, 1500];
  let lastError: unknown = null;

  for (const delayMs of delaysMs) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (!isMorningBriefingWarmupError(err, policy)) {
        throw err;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Gateway warming up');
}

// GET /api/platform/morning-briefing/status?userId=...
platform.get('/morning-briefing/status', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) {
    return c.json({ error: 'userId query parameter is required' }, 400);
  }

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const sentinel = await shortCircuitIfNotRunning(c.env, userId, iidResult.instanceId);
    if (sentinel) return sentinel;

    const result = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.getMorningBriefingStatus(),
      'getMorningBriefingStatus'
    );
    if (!result) {
      // Controller predates this route. The dashboard polls status every 30s,
      // so a 404 here would generate continuous user-facing errors. Return a
      // typed "unavailable" payload at 200 instead — same shape pattern as
      // the gateway_warming_up branch below.
      return c.json(
        {
          ok: false,
          enabled: false,
          desiredEnabled: false,
          observedEnabled: false,
          reconcileState: 'idle',
          code: 'controller_route_unavailable',
          error: 'Morning Briefing unavailable (controller too old)',
        },
        200
      );
    }
    return c.json(result, 200);
  } catch (err) {
    if (isMorningBriefingWarmupError(err)) {
      return c.json(
        {
          ok: true,
          reconcileState: 'in_progress',
          error: 'Gateway warming up, retrying shortly.',
          code: 'gateway_warming_up',
          retryAfterSec: 2,
        },
        200
      );
    }
    const { message, status, code } = sanitizeOpenclawConfigError(err, 'morning-briefing/status');
    return jsonError(message, status, code);
  }
});

// POST /api/platform/morning-briefing/enable
platform.post('/morning-briefing/enable', async c => {
  const result = await parseBody(c, MorningBriefingSetupSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId, cron, timezone } = result.data;
  try {
    const response = await withMorningBriefingWarmupRetry(() =>
      withResolvedDORetry(
        c.env,
        userId,
        iidResult.instanceId,
        stub => stub.enableMorningBriefing({ cron, timezone }),
        'enableMorningBriefing'
      )
    );
    if (!response) {
      return jsonError(
        'Morning Briefing unavailable (controller too old)',
        404,
        'controller_route_unavailable'
      );
    }
    return c.json(response, 200);
  } catch (err) {
    if (isMorningBriefingWarmupError(err)) {
      return jsonError('Gateway warming up, retrying shortly.', 503, 'gateway_warming_up');
    }
    const { message, status, code } = sanitizeOpenclawConfigError(err, 'morning-briefing/enable');
    return jsonError(message, status, code);
  }
});

// POST /api/platform/morning-briefing/disable
platform.post('/morning-briefing/disable', async c => {
  const result = await parseBody(c, UserIdRequestSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const response = await withMorningBriefingWarmupRetry(() =>
      withResolvedDORetry(
        c.env,
        result.data.userId,
        iidResult.instanceId,
        stub => stub.disableMorningBriefing(),
        'disableMorningBriefing'
      )
    );
    if (!response) {
      return jsonError(
        'Morning Briefing unavailable (controller too old)',
        404,
        'controller_route_unavailable'
      );
    }
    return c.json(response, 200);
  } catch (err) {
    if (isMorningBriefingWarmupError(err)) {
      return jsonError('Gateway warming up, retrying shortly.', 503, 'gateway_warming_up');
    }
    const { message, status, code } = sanitizeOpenclawConfigError(err, 'morning-briefing/disable');
    return jsonError(message, status, code);
  }
});

// POST /api/platform/morning-briefing/interests
platform.post('/morning-briefing/interests', async c => {
  const result = await parseBody(c, MorningBriefingInterestsSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId, topics } = result.data;
  try {
    const response = await withMorningBriefingWarmupRetry(() =>
      withResolvedDORetry(
        c.env,
        userId,
        iidResult.instanceId,
        stub => stub.updateBriefingInterests({ topics }),
        'updateBriefingInterests'
      )
    );
    if (!response) {
      return jsonError(
        'Morning Briefing unavailable (controller too old)',
        404,
        'controller_route_unavailable'
      );
    }
    return c.json(response, 200);
  } catch (err) {
    if (isMorningBriefingWarmupError(err)) {
      return jsonError('Gateway warming up, retrying shortly.', 503, 'gateway_warming_up');
    }
    const { message, status, code } = sanitizeOpenclawConfigError(
      err,
      'morning-briefing/interests'
    );
    return jsonError(message, status, code);
  }
});

// POST /api/platform/morning-briefing/run
platform.post('/morning-briefing/run', async c => {
  const result = await parseBody(c, UserIdRequestSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const response = await withMorningBriefingWarmupRetry(
      () =>
        withResolvedDORetry(
          c.env,
          result.data.userId,
          iidResult.instanceId,
          stub => stub.runMorningBriefing(),
          'runMorningBriefing'
        ),
      { includeTimeout: false }
    );
    if (!response) {
      return jsonError(
        'Morning Briefing unavailable (controller too old)',
        404,
        'controller_route_unavailable'
      );
    }
    return c.json(response, 200);
  } catch (err) {
    if (isMorningBriefingWarmupError(err, { includeTimeout: false })) {
      return jsonError('Gateway warming up, retrying shortly.', 503, 'gateway_warming_up');
    }
    if (isMorningBriefingTimeoutError(err)) {
      return jsonError(
        'Morning Briefing run timed out while work may still be in progress. Check Last generated and Last delivery before retrying.',
        504,
        'morning_briefing_run_timeout'
      );
    }
    const { message, status, code } = sanitizeOpenclawConfigError(err, 'morning-briefing/run');
    return jsonError(message, status, code);
  }
});

// GET /api/platform/morning-briefing/read/{today|yesterday}?userId=...
platform.get('/morning-briefing/read/:day', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) {
    return c.json({ error: 'userId query parameter is required' }, 400);
  }

  const day = c.req.param('day');
  if (day !== 'today' && day !== 'yesterday') {
    return c.json({ error: 'day must be today or yesterday' }, 400);
  }

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const response = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.readMorningBriefing(day),
      'readMorningBriefing'
    );
    if (!response) {
      return jsonError(
        'Morning Briefing unavailable (controller too old)',
        404,
        'controller_route_unavailable'
      );
    }
    return c.json(response, 200);
  } catch (err) {
    const { message, status, code } = sanitizeOpenclawConfigError(
      err,
      `morning-briefing/read/${day}`
    );
    return jsonError(message, status, code);
  }
});

// GET /api/platform/files/tree?userId=...
platform.get('/files/tree', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) {
    return c.json({ error: 'userId query parameter is required' }, 400);
  }

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const result = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.getFileTree(),
      'getFileTree'
    );
    if (!result) {
      return jsonError(
        'File browsing not available (controller too old)',
        404,
        'controller_route_unavailable'
      );
    }
    return c.json(result, 200);
  } catch (err) {
    const { message, status, code } = sanitizeOpenclawConfigError(err, 'files/tree');
    return jsonError(message, status, code);
  }
});

// GET /api/platform/files/read?userId=...&path=...
platform.get('/files/read', async c => {
  const userId = setValidatedQueryUserId(c);
  const filePath = c.req.query('path');
  if (!userId) {
    return c.json({ error: 'userId query parameter is required' }, 400);
  }
  if (!filePath) {
    return c.json({ error: 'path query parameter is required' }, 400);
  }

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const result = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.readFile(filePath),
      'readFile'
    );
    if (!result) {
      return jsonError(
        'File reading not available (controller too old)',
        404,
        'controller_route_unavailable'
      );
    }
    return c.json(result, 200);
  } catch (err) {
    const { message, status, code } = sanitizeOpenclawConfigError(err, 'files/read');
    return jsonError(message, status, code);
  }
});

const WriteFileSchema = z.object({
  userId: z.string().min(1),
  path: z.string().min(1),
  content: z.string(),
  etag: z.string().optional(),
});

const OpenclawWorkspaceImportSchema = z.object({
  userId: z.string().min(1),
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        content: z.string(),
      })
    )
    .min(1)
    .max(500),
});

// POST /api/platform/files/write
platform.post('/files/write', async c => {
  const result = await parseBody(c, WriteFileSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId, path: filePath, content, etag } = result.data;
  try {
    const response = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.writeFile(filePath, content, etag),
      'writeFile'
    );
    if (!response) {
      return jsonError(
        'File writing not available (controller too old)',
        404,
        'controller_route_unavailable'
      );
    }
    return c.json(response, 200);
  } catch (err) {
    const { message, status, code } = sanitizeOpenclawConfigError(err, 'files/write');
    return jsonError(message, status, code);
  }
});

// POST /api/platform/files/import-openclaw-workspace
platform.post('/files/import-openclaw-workspace', async c => {
  const result = await parseBody(c, OpenclawWorkspaceImportSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId, files } = result.data;

  try {
    const status = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.getStatus(),
      'getStatus'
    );

    if (status.status !== 'running') {
      return jsonError('Instance is not running', 503, 'instance_not_running');
    }

    const response = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.importOpenclawWorkspace(files),
      'importOpenclawWorkspace'
    );
    if (!response) {
      return jsonError(
        'OpenClaw import not available (controller too old)',
        404,
        'controller_route_unavailable'
      );
    }
    return c.json(response, 200);
  } catch (err) {
    const { message, status, code } = sanitizeOpenclawConfigError(
      err,
      'files/import-openclaw-workspace'
    );
    return jsonError(message, status, code);
  }
});

// POST /api/platform/doctor
platform.post('/doctor', async c => {
  const result = await parseBody(c, UserIdRequestSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const doctor = await withResolvedDORetry(
      c.env,
      result.data.userId,
      iidResult.instanceId,
      stub => stub.runDoctor(),
      'runDoctor'
    );
    return c.json(doctor, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'doctor');
    return jsonError(message, status);
  }
});

// POST /api/platform/doctor-controller/start
//
// Starts `openclaw doctor` via the machine's controller HTTP API (NOT the Fly
// Machines exec API). The run is async and status/output is polled separately.
// Intended to replace /api/platform/doctor once validated; both paths are live
// in parallel during the migration.
const DoctorControllerRunSchema = z.object({
  userId: z.string().min(1),
  fix: z.boolean().optional(),
});

platform.post('/doctor-controller/start', async c => {
  const result = await parseBody(c, DoctorControllerRunSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    // The DO returns a discriminated union: success | { conflict } | null.
    // `.then(r => r)` collapses CF Workers' RPC Promise wrapping back to a
    // plain Promise union (same pattern as startKiloCliRun).
    const response = await withResolvedDORetry(
      c.env,
      result.data.userId,
      iidResult.instanceId,
      // Default is `true` to match the Fly-exec flow (which always passed
      // --fix) and the admin UI checkbox default. Explicit `false` opts into
      // read-only diagnostics.
      stub => stub.startDoctorViaController(result.data.fix ?? true).then(r => r),
      'startDoctorViaController'
    );
    if (!response) {
      return jsonError(
        'Doctor runner not available (controller too old)',
        404,
        'controller_route_unavailable'
      );
    }
    const conflictResponse = doctorRunConflictResponse(response);
    if (conflictResponse) return conflictResponse;
    return c.json(response, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'doctor-controller/start');
    return jsonError(message, status);
  }
});

// GET /api/platform/doctor-controller/status?userId=...
platform.get('/doctor-controller/status', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) {
    return c.json({ error: 'userId query parameter is required' }, 400);
  }

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const response = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.getDoctorViaControllerStatus().then(r => r),
      'getDoctorViaControllerStatus'
    );
    if (!response) {
      return jsonError(
        'Doctor runner not available (controller too old)',
        404,
        'controller_route_unavailable'
      );
    }
    const conflictResponse = doctorRunConflictResponse(response);
    if (conflictResponse) return conflictResponse;
    return c.json(response, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'doctor-controller/status');
    return jsonError(message, status);
  }
});

// POST /api/platform/doctor-controller/cancel
platform.post('/doctor-controller/cancel', async c => {
  const result = await parseBody(c, UserIdRequestSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const response = await withResolvedDORetry(
      c.env,
      result.data.userId,
      iidResult.instanceId,
      stub => stub.cancelDoctorViaController().then(r => r),
      'cancelDoctorViaController'
    );
    if (!response) {
      return jsonError(
        'Doctor runner not available (controller too old)',
        404,
        'controller_route_unavailable'
      );
    }
    const conflictResponse = doctorRunConflictResponse(response);
    if (conflictResponse) return conflictResponse;
    return c.json(response, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'doctor-controller/cancel');
    return jsonError(message, status);
  }
});

// ── Kilo CLI Run ──────────────────────────────────────────────────────

const KiloCliRunStartSchema = z.object({
  userId: z.string().min(1),
  prompt: z.string().min(1).max(10_000),
});

// POST /api/platform/kilo-cli-run/start
platform.post('/kilo-cli-run/start', async c => {
  const result = await parseBody(c, KiloCliRunStartSchema);
  if ('error' in result) return result.error;
  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    // The DO returns a discriminated union: success | { conflict } | null.
    // CF Workers' RPC type wrapping turns this into `Promise<A> | Promise<B>`
    // instead of `Promise<A | B>`, which breaks narrowing. The `.then(r => r)`
    // collapses the RPC wrapper back to a plain Promise union.
    const response = await withResolvedDORetry(
      c.env,
      result.data.userId,
      iidResult.instanceId,
      stub => stub.startKiloCliRun(result.data.prompt).then(r => r),
      'startKiloCliRun'
    );
    if (!response) {
      return jsonError(
        'Kilo CLI agent not available (controller too old)',
        404,
        'controller_route_unavailable'
      );
    }
    const conflictResponse = kiloCliRunConflictResponse(response);
    if (conflictResponse) return conflictResponse;
    return c.json(response, 200);
  } catch (err) {
    const { message, status, code } = sanitizeOpenclawConfigError(err, 'kilo-cli-run start');
    return jsonError(message, status, code);
  }
});

// GET /api/platform/kilo-cli-run/status?userId=...
platform.get('/kilo-cli-run/status', async c => {
  const userId = c.req.query('userId');
  if (!userId) return jsonError('Missing userId', 400);
  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const response = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.getKiloCliRunStatus(),
      'getKiloCliRunStatus'
    );
    return c.json(response, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'kilo-cli-run status');
    return jsonError(message, status);
  }
});

// POST /api/platform/kilo-cli-run/cancel
platform.post('/kilo-cli-run/cancel', async c => {
  const result = await parseBody(c, UserIdRequestSchema);
  if ('error' in result) return result.error;
  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    // The DO returns a discriminated union: success | { conflict }.
    // See startKiloCliRun for the same pattern and the reason for .then(r => r).
    const response = await withResolvedDORetry(
      c.env,
      result.data.userId,
      iidResult.instanceId,
      stub => stub.cancelKiloCliRun().then(r => r),
      'cancelKiloCliRun'
    );
    const conflictResponse = kiloCliRunConflictResponse(response);
    if (conflictResponse) return conflictResponse;
    return c.json(response, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'kilo-cli-run cancel');
    return jsonError(message, status);
  }
});

// POST /api/platform/start
const StartRequestSchema = UserIdRequestSchema.extend({
  skipCooldown: z.boolean().optional(),
  reason: KiloclawStartReasonSchema.optional(),
});

async function handleStartRequest(c: Context<AppEnv>, mode: 'sync' | 'async') {
  const result = await parseBody(c, StartRequestSchema);
  if ('error' in result) return result.error;
  const startedAt = performance.now();

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;
  const { instanceId } = iidResult;

  try {
    const route = mode === 'async' ? '/api/platform/start-async' : '/api/platform/start';
    const startOptions =
      result.data.skipCooldown || result.data.reason
        ? {
            ...(result.data.skipCooldown ? { skipCooldown: true } : {}),
            ...(result.data.reason ? { reason: result.data.reason } : {}),
          }
        : undefined;
    const asyncStartOptions = result.data.reason ? { reason: result.data.reason } : undefined;

    if (mode === 'async') {
      await withResolvedDORetry(
        c.env,
        result.data.userId,
        instanceId,
        stub => stub.startAsync(result.data.userId, asyncStartOptions),
        'startAsync'
      );

      writeEvent(c.env, {
        event: 'instance.async_start_requested',
        delivery: 'http',
        route,
        userId: result.data.userId,
        label: result.data.reason,
        durationMs: performance.now() - startedAt,
      });
      return c.json({ ok: true });
    }

    const startResult = await withResolvedDORetry(
      c.env,
      result.data.userId,
      instanceId,
      stub => stub.start(result.data.userId, startOptions),
      'start'
    );

    if (startResult.currentStatus === 'running') {
      writeEvent(c.env, {
        event: 'instance.manual_start_succeeded',
        delivery: 'http',
        route,
        userId: result.data.userId,
        label: result.data.reason,
        durationMs: performance.now() - startedAt,
      });
    }

    return c.json({ ok: true, ...startResult });
  } catch (err) {
    const { message, status } = sanitizeError(err, 'start');
    writeEvent(c.env, {
      event:
        mode === 'async' ? 'instance.async_start_request_failed' : 'instance.manual_start_failed',
      delivery: 'http',
      route: mode === 'async' ? '/api/platform/start-async' : '/api/platform/start',
      userId: result.data.userId,
      label: result.data.reason,
      error: message,
      durationMs: performance.now() - startedAt,
    });
    return jsonError(message, status);
  }
}

platform.post('/start', async c => {
  return handleStartRequest(c, 'sync');
});

platform.post('/start-async', async c => {
  return handleStartRequest(c, 'async');
});

// POST /api/platform/force-retry-recovery
platform.post('/force-retry-recovery', async c => {
  const result = await parseBody(c, UserIdRequestSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const startedAt = performance.now();

  try {
    const { ok } = await withResolvedDORetry(
      c.env,
      result.data.userId,
      iidResult.instanceId,
      stub => stub.forceRetryRecovery(),
      'forceRetryRecovery'
    );
    writeEvent(c.env, {
      event: 'instance.force_retry_recovery_succeeded',
      delivery: 'http',
      route: '/api/platform/force-retry-recovery',
      userId: result.data.userId,
      durationMs: performance.now() - startedAt,
    });
    return c.json({ ok });
  } catch (err) {
    const { message, status } = sanitizeError(err, 'forceRetryRecovery');
    writeEvent(c.env, {
      event: 'instance.force_retry_recovery_failed',
      delivery: 'http',
      route: '/api/platform/force-retry-recovery',
      userId: result.data.userId,
      error: message,
      durationMs: performance.now() - startedAt,
    });
    return jsonError(message, status);
  }
});

// POST /api/platform/cleanup-recovery-previous-volume
platform.post('/cleanup-recovery-previous-volume', async c => {
  const result = await parseBody(c, UserIdRequestSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const response = await withResolvedDORetry(
      c.env,
      result.data.userId,
      iidResult.instanceId,
      stub => stub.cleanupRecoveryPreviousVolume(),
      'cleanupRecoveryPreviousVolume'
    );
    return c.json(response);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'cleanup-recovery-previous-volume');
    return jsonError(message, status);
  }
});

const StopRequestSchema = UserIdRequestSchema.extend({
  reason: KiloclawStopReasonSchema.optional(),
});

// POST /api/platform/stop
platform.post('/stop', async c => {
  const result = await parseBody(c, StopRequestSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;
  const { instanceId } = iidResult;

  try {
    const stopOptions = result.data.reason ? { reason: result.data.reason } : undefined;
    const stopResult = await withResolvedDORetry(
      c.env,
      result.data.userId,
      instanceId,
      stub => stub.stop(stopOptions),
      'stop'
    );
    return c.json({ ok: true, ...stopResult });
  } catch (err) {
    const { message, status } = sanitizeError(err, 'stop');
    return jsonError(message, status);
  }
});

// POST /api/platform/destroy
platform.post('/destroy', async c => {
  const result = await parseBody(c, DestroyRequestSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;
  const { instanceId } = iidResult;

  const { userId } = result.data;
  const doKey = await resolveInstanceDoKey(c.env, userId, instanceId);

  // Read the instance's orgId before destroying so we can update the correct registry.
  let orgId: string | null = null;
  if (instanceId) {
    try {
      const statusStub = (await instanceStubFactory(c.env, userId, instanceId))();
      const status = await statusStub.getStatus();
      orgId = status.orgId;
    } catch {
      // Can't determine orgId. We'll clean up the user registry below; if the
      // instance was org-owned, its org registry entry becomes stale but harmless
      // (points to a destroyed DO that returns no machineId).
      console.warn(
        '[platform] Could not read orgId before destroy, org registry entry may be stale'
      );
    }
  }

  try {
    const destroyOptions = result.data.reason ? { reason: result.data.reason } : undefined;
    await withResolvedDORetry(
      c.env,
      userId,
      instanceId,
      stub => stub.destroy(destroyOptions),
      'destroy'
    );

    // Remove the instance from the registry (best-effort).
    // When instanceId is provided, destroy by instanceId directly.
    // When absent (legacy destroy), find the entry with doKey=userId
    // and destroy it by its instanceId from the registry.
    // Note: The Instance DO also cleans up on finalization (belt-and-suspenders).
    try {
      const registryKeys = [`user:${userId}`];
      if (orgId) registryKeys.push(`org:${orgId}`);
      for (const registryKey of registryKeys) {
        const registryStub = c.env.KILOCLAW_REGISTRY.get(
          c.env.KILOCLAW_REGISTRY.idFromName(registryKey)
        );
        if (instanceId) {
          await registryStub.destroyInstance(registryKey, instanceId);
          console.log('[platform] Registry entry destroyed:', { registryKey, instanceId });
        } else {
          // Legacy destroy (no instanceId): find the registry entry by the
          // original legacy DO key recovered from sandboxId/Postgres state.
          const entries = await registryStub.listInstances(registryKey);
          const doKeysToMatch = doKey === userId ? [userId] : [userId, doKey];
          const legacyEntry = entries.find(e => doKeysToMatch.includes(e.doKey));
          if (legacyEntry) {
            await registryStub.destroyInstance(registryKey, legacyEntry.instanceId);
            console.log('[platform] Registry entry destroyed (legacy):', {
              registryKey,
              instanceId: legacyEntry.instanceId,
              doKeysTried: doKeysToMatch,
              matchedDoKey: legacyEntry.doKey,
            });
          } else {
            console.log('[platform] No registry entry found for legacy destroy:', {
              registryKey,
              doKeysTried: doKeysToMatch,
              entriesCount: entries.length,
            });
          }
        }
      }
    } catch (registryErr) {
      console.error('[platform] Registry destroy failed (non-fatal):', registryErr);
    }

    return c.json({ ok: true });
  } catch (err) {
    const { message, status } = sanitizeError(err, 'destroy');
    return jsonError(message, status);
  }
});

// GET /api/platform/status?userId=...&instanceId=...
platform.get('/status', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) {
    return c.json({ error: 'userId query parameter is required' }, 400);
  }
  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;
  const { instanceId } = iidResult;

  try {
    const status = await withResolvedDORetry(
      c.env,
      userId,
      instanceId,
      stub => stub.getStatus(),
      'getStatus'
    );
    return c.json(status);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'status');
    return jsonError(message, status);
  }
});

const MAX_INBOUND_EMAIL_TITLE_SLUG_LENGTH = 80;

const InboundEmailSchema = z.object({
  instanceId: z.string().uuid(),
  messageId: z.string().trim().min(1).max(512),
  from: z.string().trim().min(1).max(512),
  to: z.string().trim().min(1).max(512),
  recipientAlias: z.string().trim().min(1).max(512).optional(),
  subject: z.string().max(1_000),
  text: z.string().min(1).max(32_000),
  receivedAt: z.string().datetime(),
});

type InboundEmailDelivery = z.infer<typeof InboundEmailSchema>;

function inboundEmailTitleSlug(subject: string): string {
  const slug = subject
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_INBOUND_EMAIL_TITLE_SLUG_LENGTH)
    .replace(/-+$/g, '');

  return slug || 'no-subject';
}

function inboundEmailSessionKey(subject: string, receivedAt: string): string {
  return `inbound-email:${receivedAt.slice(0, 10)}-${inboundEmailTitleSlug(subject)}`;
}

function inboundEmailAddressParts(address: string): {
  localPart: string;
  domain: string;
  validSingleAddress: boolean;
} {
  const [localPart, domain, ...extra] = address.trim().toLowerCase().split('@');
  return {
    localPart: localPart ?? '',
    domain: domain ?? '',
    validSingleAddress: Boolean(localPart && domain && extra.length === 0),
  };
}

function inboundEmailLogContext(delivery: InboundEmailDelivery) {
  const recipient = inboundEmailAddressParts(delivery.to);
  const sender = inboundEmailAddressParts(delivery.from);

  return {
    instanceId: delivery.instanceId,
    messageIdLength: delivery.messageId.length,
    fromDomain: sender.domain,
    toLocalPart: recipient.localPart,
    toDomain: recipient.domain,
    toAddressValid: recipient.validSingleAddress,
    recipientAlias: delivery.recipientAlias ?? null,
    subjectLength: delivery.subject.length,
    textLength: delivery.text.length,
    receivedAt: delivery.receivedAt,
  };
}

async function resolveInboundEmailDoKey(
  env: AppEnv['Bindings'],
  instance: { id: string; userId: string; sandboxId: string; orgId: string | null }
): Promise<string> {
  const ownerKey = instance.orgId ? `org:${instance.orgId}` : `user:${instance.userId}`;
  try {
    const registryStub = env.KILOCLAW_REGISTRY.get(env.KILOCLAW_REGISTRY.idFromName(ownerKey));
    const doKey = await registryStub.resolveDoKey(ownerKey, instance.id);
    if (doKey) return doKey;
  } catch (err) {
    console.warn(
      '[platform] inbound-email registry lookup failed, falling back to instance identity',
      {
        instanceId: instance.id,
        error: err instanceof Error ? err.message : String(err),
      }
    );
  }
  return doKeyFromActiveInstance(instance);
}

// POST /api/platform/inbound-email
// Deliver a Cloudflare Email Routing message to an instance's OpenClaw hook endpoint.
platform.post('/inbound-email', async c => {
  const startedAt = performance.now();
  const result = await parseBody(c, InboundEmailSchema);
  if ('error' in result) return result.error;

  const delivery = result.data;
  const logContext = inboundEmailLogContext(delivery);
  const recipientAlias = delivery.recipientAlias?.toLowerCase();
  console.log('[platform] inbound email received', logContext);
  if (!recipientAlias) {
    console.warn('[platform] inbound email missing alias metadata', logContext);
    return jsonError('Inbound email address is no longer available', 410);
  }

  const connectionString = c.env.HYPERDRIVE?.connectionString;
  if (!connectionString) {
    console.error('[platform] inbound email database unavailable', logContext);
    return jsonError('Database is not configured', 503);
  }
  if (!c.env.GATEWAY_TOKEN_SECRET) {
    console.error('[platform] inbound email gateway token secret unavailable', logContext);
    return jsonError('GATEWAY_TOKEN_SECRET is not configured', 503);
  }

  try {
    const db = getWorkerDb(connectionString);
    const instance = await getInstanceById(db, delivery.instanceId);
    if (!instance) {
      console.warn('[platform] inbound email instance not found', logContext);
      return jsonError('Instance not found', 404);
    }
    if (!instance.inboundEmailEnabled) {
      console.warn('[platform] inbound email disabled for instance', logContext);
      return jsonError('Inbound email is disabled for this instance', 410);
    }

    const [activeAlias] = await db
      .select({ alias: kiloclaw_inbound_email_aliases.alias })
      .from(kiloclaw_inbound_email_aliases)
      .where(
        and(
          eq(kiloclaw_inbound_email_aliases.instance_id, instance.id),
          eq(kiloclaw_inbound_email_aliases.alias, recipientAlias),
          isNull(kiloclaw_inbound_email_aliases.retired_at)
        )
      )
      .limit(1);
    if (!activeAlias) {
      console.warn('[platform] inbound email alias is not active', logContext);
      return jsonError('Inbound email address is no longer available', 410);
    }

    c.set('userId', instance.userId);
    console.log('[platform] inbound email instance resolved', {
      ...logContext,
      userId: instance.userId,
      sandboxId: instance.sandboxId,
      orgId: instance.orgId,
    });

    const doKey = await resolveInboundEmailDoKey(c.env, instance);
    console.log('[platform] inbound email DO resolved', {
      ...logContext,
      userId: instance.userId,
      orgId: instance.orgId,
      doKey,
      doKeyMatchesInstanceId: doKey === instance.id,
    });

    const stub = c.env.KILOCLAW_INSTANCE.get(c.env.KILOCLAW_INSTANCE.idFromName(doKey));
    const status = await stub.getStatus();
    console.log('[platform] inbound email status resolved', {
      ...logContext,
      userId: instance.userId,
      doKey,
      instanceStatus: status.status,
      statusUserId: status.userId,
      statusSandboxId: status.sandboxId,
      hasSandboxId: Boolean(status.sandboxId),
    });

    if (status.status !== 'running') {
      console.warn('[platform] inbound email instance is not running', {
        ...logContext,
        userId: instance.userId,
        doKey,
        instanceStatus: status.status,
      });
      return jsonError('Instance is not running', 503);
    }
    if (!status.sandboxId) {
      console.error('[platform] inbound email instance has no sandboxId', {
        ...logContext,
        userId: instance.userId,
        doKey,
        instanceStatus: status.status,
      });
      return jsonError('Instance has no sandboxId', 500);
    }

    const routingTarget = await stub.getRoutingTarget();
    if (!routingTarget) {
      console.warn('[platform] inbound email instance not routable', {
        ...logContext,
        userId: instance.userId,
        doKey,
        instanceStatus: status.status,
      });
      return jsonError('Instance not routable', 503);
    }
    console.log('[platform] inbound email routing target resolved', {
      ...logContext,
      userId: instance.userId,
      doKey,
      targetOrigin: routingTarget.origin,
      hasFlyForceInstanceId: 'fly-force-instance-id' in routingTarget.headers,
    });

    const gatewayToken = await deriveGatewayToken(status.sandboxId, c.env.GATEWAY_TOKEN_SECRET);
    const sessionKey = inboundEmailSessionKey(delivery.subject, delivery.receivedAt);
    console.log('[platform] inbound email forwarding to controller', {
      ...logContext,
      userId: instance.userId,
      doKey,
      targetOrigin: routingTarget.origin,
      sessionKeyPrefix: sessionKey.split(':')[0] ?? '',
      sessionKeyLength: sessionKey.length,
    });
    const response = await fetch(`${routingTarget.origin}/_kilo/hooks/email`, {
      method: 'POST',
      headers: {
        ...routingTarget.headers,
        authorization: `Bearer ${gatewayToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sessionKey,
        messageId: delivery.messageId,
        from: delivery.from,
        to: delivery.to,
        subject: delivery.subject,
        text: delivery.text,
        receivedAt: delivery.receivedAt,
      }),
    });

    console.log('[platform] inbound email controller response', {
      ...logContext,
      userId: instance.userId,
      doKey,
      status: response.status,
      ok: response.ok,
      durationMs: performance.now() - startedAt,
    });

    if (response.ok) {
      writeEvent(c.env, {
        event: 'instance.webhook_chat_message_sent',
        delivery: 'http',
        route: '/api/platform/inbound-email',
        userId: instance.userId,
        instanceId: instance.id,
      });
      return c.json({ success: true }, 202);
    }

    const error = await response.text().catch(() => '');
    let controllerErrorMessage: string | undefined;
    try {
      const parsed: unknown = JSON.parse(error);
      if (parsed && typeof parsed === 'object' && 'error' in parsed) {
        const candidate = (parsed as { error: unknown }).error;
        if (typeof candidate === 'string') controllerErrorMessage = candidate;
      }
    } catch {
      // body wasn't JSON; the raw `error` field below preserves it
    }
    const controllerFailure = {
      ...logContext,
      userId: instance.userId,
      doKey,
      status: response.status,
      error: error.slice(0, 2000),
      controllerErrorMessage,
      durationMs: performance.now() - startedAt,
    };
    if (response.status >= 500) {
      console.error('[platform] inbound email controller delivery failed', controllerFailure);
    } else {
      console.warn('[platform] inbound email controller rejected delivery', controllerFailure);
    }

    const responseStatus = response.status >= 400 && response.status < 600 ? response.status : 502;
    return jsonError('Inbound email delivery failed', responseStatus);
  } catch (err) {
    console.error('[platform] inbound email delivery threw', {
      ...logContext,
      error: err instanceof Error ? err.message : String(err),
      durationMs: performance.now() - startedAt,
    });
    const { message, status } = sanitizeError(err, 'inbound-email');
    return jsonError(message, status);
  }
});

// GET /api/platform/debug-status?userId=...&instanceId=...
// Internal/admin-only debug status that includes DO destroy internals.
platform.get('/debug-status', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) {
    return c.json({ error: 'userId query parameter is required' }, 400);
  }
  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;
  const { instanceId } = iidResult;

  try {
    // No guard here: getDebugState() reads DO storage only and never proxies
    // through Fly's edge to the machine. The wake-up bug (services that proxy
    // to port 18789) does not apply.
    const status = await withResolvedDORetry(
      c.env,
      userId,
      instanceId,
      stub => stub.getDebugState(),
      'getDebugState'
    );
    return c.json(status);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'debug-status');
    return jsonError(message, status);
  }
});

// GET /api/platform/registry-entries?userId=...&orgId=...
// Returns all registry entries (including destroyed) for admin inspection.
// Queries the personal registry and optionally the org registry.
platform.get('/registry-entries', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) return c.json({ error: 'userId query parameter is required' }, 400);
  const orgId = c.req.query('orgId') ?? null;

  const results: Array<{
    registryKey: string;
    entries: Array<{
      instanceId: string;
      doKey: string;
      assignedUserId: string;
      createdAt: string;
      destroyedAt: string | null;
    }>;
    migrated: boolean;
  }> = [];

  try {
    // Always query the personal registry
    const userKey = `user:${userId}`;
    const userStub = c.env.KILOCLAW_REGISTRY.get(c.env.KILOCLAW_REGISTRY.idFromName(userKey));
    const userResult = await userStub.listAllInstances(userKey);
    results.push({ registryKey: userKey, ...userResult });

    // If orgId is provided, also query the org registry
    if (orgId) {
      const orgKey = `org:${orgId}`;
      const orgStub = c.env.KILOCLAW_REGISTRY.get(c.env.KILOCLAW_REGISTRY.idFromName(orgKey));
      const orgResult = await orgStub.listAllInstances(orgKey);
      results.push({ registryKey: orgKey, ...orgResult });
    }

    return c.json({ registries: results });
  } catch (err) {
    const { message, status } = sanitizeError(err, 'registry-entries');
    return jsonError(message, status);
  }
});

// GET /api/platform/gateway-token?userId=...&instanceId=...
// Returns the derived gateway token for a user's sandbox. The Next.js
// dashboard calls this so it never needs GATEWAY_TOKEN_SECRET directly.
platform.get('/gateway-token', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) {
    return c.json({ error: 'userId query parameter is required' }, 400);
  }
  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;
  const { instanceId } = iidResult;

  if (!c.env.GATEWAY_TOKEN_SECRET) {
    return c.json({ error: 'GATEWAY_TOKEN_SECRET is not configured' }, 503);
  }

  try {
    const status = await withResolvedDORetry(
      c.env,
      userId,
      instanceId,
      stub => stub.getStatus(),
      'getStatus'
    );

    if (!status.sandboxId) {
      return c.json({ error: 'Instance not provisioned' }, 404);
    }

    const gatewayToken = await deriveGatewayToken(status.sandboxId, c.env.GATEWAY_TOKEN_SECRET);
    return c.json({ gatewayToken });
  } catch (err) {
    const { message, status } = sanitizeError(err, 'gateway-token');
    return jsonError(message, status);
  }
});

// GET /api/platform/volume-snapshots?userId=...
// Returns the list of Fly volume snapshots for the user's instance.
platform.get('/volume-snapshots', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) {
    return c.json({ error: 'userId query parameter is required' }, 400);
  }

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const unsupported = await requireProviderCapability(
    c,
    userId,
    iidResult.instanceId,
    'volumeSnapshots',
    'volume-snapshots',
    { failOpen: true }
  );
  if (unsupported) return unsupported;

  try {
    const snapshots = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.listVolumeSnapshots(),
      'listVolumeSnapshots'
    );
    return c.json({ snapshots });
  } catch (err) {
    const { message, status } = sanitizeError(err, 'volume-snapshots');
    return jsonError(message, status);
  }
});

// GET /api/platform/candidate-volumes?userId=...
// Returns all usable volumes in the user's Fly app for admin volume reassociation.
platform.get('/candidate-volumes', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) {
    return c.json({ error: 'userId query parameter is required' }, 400);
  }

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const unsupported = await requireProviderCapability(
    c,
    userId,
    iidResult.instanceId,
    'candidateVolumes',
    'candidate-volumes',
    { failOpen: true }
  );
  if (unsupported) return unsupported;

  try {
    const result = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.listCandidateVolumes(),
      'listCandidateVolumes'
    );
    return c.json(result);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'candidate-volumes');
    return jsonError(message, status);
  }
});

// POST /api/platform/reassociate-volume
// Changes the flyVolumeId on a stopped instance. Requires reason for audit trail.
const ReassociateVolumeSchema = z.object({
  userId: z.string().min(1),
  newVolumeId: z.string().min(1),
  reason: z.string().min(10).max(500),
});

platform.post('/reassociate-volume', async c => {
  const result = await parseBody(c, ReassociateVolumeSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const unsupported = await requireProviderCapability(
    c,
    result.data.userId,
    iidResult.instanceId,
    'volumeReassociation',
    'reassociate-volume',
    { failOpen: true }
  );
  if (unsupported) return unsupported;

  try {
    const response = await withResolvedDORetry(
      c.env,
      result.data.userId,
      iidResult.instanceId,
      stub => stub.reassociateVolume(result.data.newVolumeId, result.data.reason),
      'reassociateVolume'
    );
    return c.json(response);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'reassociate-volume');
    return jsonError(message, status);
  }
});

// POST /api/platform/resize-machine
// Updates the machine size for an instance. Takes effect on next start/restart.
const ResizeMachineSchema = z.object({
  userId: z.string().min(1),
  instanceType: InstanceTierKeySchema,
  actorId: z.string().min(1),
  actorEmail: z.string().email(),
});

platform.post('/resize-machine', async c => {
  const result = await parseBody(c, ResizeMachineSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const response = await withResolvedDORetry(
      c.env,
      result.data.userId,
      iidResult.instanceId,
      stub =>
        stub.resizeMachine({
          targetTierKey: result.data.instanceType,
          actorId: result.data.actorId,
          actorEmail: result.data.actorEmail,
        }),
      'resizeMachine'
    );
    return c.json(response);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'resize-machine');
    return jsonError(message, status);
  }
});

// POST /api/platform/admin-size-override/set
// Admin-only: set a temporary CPU/RAM override that wins over the
// tier-derived machineSize until cleared. Does NOT change instanceType
// or volumeSizeGb (billing stays on the tier). Stopped-machine-only.
const SetAdminSizeOverrideSchema = z.object({
  userId: z.string().min(1),
  size: MachineSizeSchema,
  reason: z.string().min(10).max(500),
  actorId: z.string().min(1),
  actorEmail: z.string().email(),
});

platform.post('/admin-size-override/set', async c => {
  const result = await parseBody(c, SetAdminSizeOverrideSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const response = await withResolvedDORetry(
      c.env,
      result.data.userId,
      iidResult.instanceId,
      stub =>
        stub.setAdminMachineSizeOverride({
          size: result.data.size,
          reason: result.data.reason,
          actorId: result.data.actorId,
          actorEmail: result.data.actorEmail,
        }),
      'setAdminMachineSizeOverride'
    );
    return c.json(response);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'admin-size-override-set');
    return jsonError(message, status);
  }
});

// POST /api/platform/admin-size-override/clear
const ClearAdminSizeOverrideSchema = z.object({
  userId: z.string().min(1),
  reason: z.string().min(10).max(500),
  actorId: z.string().min(1),
  actorEmail: z.string().email(),
});

platform.post('/admin-size-override/clear', async c => {
  const result = await parseBody(c, ClearAdminSizeOverrideSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const response = await withResolvedDORetry(
      c.env,
      result.data.userId,
      iidResult.instanceId,
      stub =>
        stub.clearAdminMachineSizeOverride({
          reason: result.data.reason,
          actorId: result.data.actorId,
          actorEmail: result.data.actorEmail,
        }),
      'clearAdminMachineSizeOverride'
    );
    return c.json(response);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'admin-size-override-clear');
    return jsonError(message, status);
  }
});

// POST /api/platform/restore-volume-snapshot
// Enqueues a snapshot restore job. Returns immediately; restore runs async via CF Queue.
const RestoreVolumeSnapshotSchema = z.object({
  userId: z.string().min(1),
  snapshotId: z.string().min(1),
});

platform.post('/restore-volume-snapshot', async c => {
  const result = await parseBody(c, RestoreVolumeSnapshotSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const unsupported = await requireProviderCapability(
    c,
    result.data.userId,
    iidResult.instanceId,
    'snapshotRestore',
    'restore-volume-snapshot',
    { failOpen: true }
  );
  if (unsupported) return unsupported;

  try {
    const response = await withResolvedDORetry(
      c.env,
      result.data.userId,
      iidResult.instanceId,
      stub => stub.enqueueSnapshotRestore(result.data.snapshotId),
      'enqueueSnapshotRestore'
    );
    return c.json(response);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'restore-volume-snapshot');
    return jsonError(message, status);
  }
});

// GET /api/platform/versions
// Lists all registered image versions from KV.
// Used by admin triggerSync for reconciliation/backfill.
platform.get('/versions', async c => {
  try {
    const versions = await listAllVersions(c.env.KV_CLAW_CACHE);
    return c.json(versions);
  } catch (err) {
    console.error('[platform] Failed to list versions:', err);
    return c.json({ error: 'Failed to list versions' }, 500);
  }
});

// GET /api/platform/versions/latest
// Resolves the image version this caller should be on next.
//
// Query params (all optional):
//   instanceId       — bucket subject for rollout candidate selection
//   currentImageTag  — caller's current image; used to suppress self-upgrades
//
// Without instanceId, returns the current :latest pointer (back-compat for
// anonymous callers — public version banner, CI, etc.). With instanceId, runs
// the rollout-aware selector and returns the candidate when the instance falls
// in cohort, the :latest baseline when not, or 404 when the caller is already
// on the newest applicable image (banner: "no upgrade").
//
// The Early Access flag is looked up server-side from the instance's owning
// user — callers cannot pass it as a query param. This keeps the service as
// the single authoritative source: even an internal-key-holding caller can't
// claim Early Access for an arbitrary instance.
platform.get('/versions/latest', async c => {
  try {
    const instanceId = c.req.query('instanceId');
    const currentImageTag = c.req.query('currentImageTag') ?? null;

    if (!instanceId) {
      const latest = await resolveLatestVersion(c.env.KV_CLAW_CACHE, 'default');
      if (!latest) return c.json({ error: 'No latest version registered' }, 404);
      return c.json(latest);
    }

    // Resolve Early Access from the instance's owner. This requires Hyperdrive;
    // without it we degrade gracefully to autoEnroll=false (the bucket math
    // still works correctly — only the staff/beta-tester override is missing).
    let autoEnroll = false;
    const connectionString = c.env.HYPERDRIVE?.connectionString;
    if (connectionString) {
      try {
        autoEnroll = await lookupKiloclawEarlyAccessByInstanceId(connectionString, instanceId);
      } catch (err) {
        console.warn(
          '[platform] Early Access lookup failed; treating as false:',
          err instanceof Error ? err.message : err
        );
      }
    }

    const selected = await selectImageVersionForInstance({
      kv: c.env.KV_CLAW_CACHE,
      variant: 'default',
      instanceId,
      currentImageTag,
      autoEnroll,
    });
    if (!selected) return c.json({ error: 'No upgrade available' }, 404);
    return c.json(selected);
  } catch (err) {
    console.error('[platform] Failed to get latest version:', err);
    return c.json({ error: 'Failed to get latest version' }, 500);
  }
});

// POST /api/platform/versions/rollout
// Set an image's rollout percent (0..100). Updates Postgres + KV pointers.
const SetRolloutPercentBody = z.object({
  imageTag: z.string().min(1),
  percent: z.number().int().min(0).max(100),
});

// POST /api/platform/versions/disable-with-clear
// Mark a tag as disabled AND set its rollout_percent to 0 atomically.
// Used by the admin "Disable image" flow so a disabled tag never lingers as
// a rollout candidate.
const DisableWithClearBody = z.object({
  imageTag: z.string().min(1),
  updatedBy: z.string().min(1),
});

platform.post('/versions/disable-with-clear', async c => {
  const result = await parseBody(c, DisableWithClearBody);
  if ('error' in result) return result.error;

  const connectionString = c.env.HYPERDRIVE?.connectionString;
  if (!connectionString) return c.json({ error: 'Database not configured' }, 503);

  try {
    await disableImageAndClearRollout({
      kv: c.env.KV_CLAW_CACHE,
      hyperdriveConnectionString: connectionString,
      imageTag: result.data.imageTag,
      updatedBy: result.data.updatedBy,
    });
    return c.json({ ok: true });
  } catch (err) {
    console.error('[platform] Failed to disable + clear rollout:', err);
    return c.json({ error: 'Failed to disable image' }, 500);
  }
});

// POST /api/platform/users/:userId/kiloclaw-early-access
// Toggle the per-user kiloclaw_early_access flag. Affects all of the user's
// instances (personal + every org instance they own).
const SetEarlyAccessBody = z.object({
  value: z.boolean(),
});

platform.post('/users/:userId/kiloclaw-early-access', async c => {
  const userId = c.req.param('userId');
  if (!userId) return c.json({ error: 'Missing userId' }, 400);

  const result = await parseBody(c, SetEarlyAccessBody);
  if ('error' in result) return result.error;

  const connectionString = c.env.HYPERDRIVE?.connectionString;
  if (!connectionString) return c.json({ error: 'Database not configured' }, 503);

  try {
    const updated = await setKiloclawEarlyAccess(connectionString, userId, result.data.value);
    if (!updated) return c.json({ error: 'User not found' }, 404);
    return c.json({ ok: true, userId, earlyAccess: result.data.value });
  } catch (err) {
    console.error('[platform] Failed to set kiloclaw_early_access:', err);
    return c.json({ error: 'Failed to set kiloclaw_early_access' }, 500);
  }
});

platform.post('/versions/rollout', async c => {
  const result = await parseBody(c, SetRolloutPercentBody);
  if ('error' in result) return result.error;

  const connectionString = c.env.HYPERDRIVE?.connectionString;
  if (!connectionString) {
    return c.json({ error: 'Database not configured' }, 503);
  }

  try {
    const updated = await setRolloutPercent({
      kv: c.env.KV_CLAW_CACHE,
      hyperdriveConnectionString: connectionString,
      imageTag: result.data.imageTag,
      percent: result.data.percent,
    });
    return c.json({ ok: true, ...updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    if (msg.startsWith('Image not found')) return c.json({ error: msg }, 404);
    if (
      msg.startsWith('Invalid rollout percent') ||
      msg.startsWith('Image not available') ||
      msg.startsWith('Cannot set rollout percent')
    ) {
      return c.json({ error: msg }, 400);
    }
    console.error('[platform] Failed to set rollout percent:', err);
    return c.json({ error: 'Failed to set rollout percent' }, 500);
  }
});

// POST /api/platform/versions/mark-latest
// Mark an image as the production :latest for its variant. Atomically clears
// is_latest from the previous :latest in the same variant. Independent of
// rollout_percent.
const MarkLatestBody = z.object({
  imageTag: z.string().min(1),
});

// POST /api/platform/versions/apply-pin
// Pushes a resolved admin pin (or pin clear) into the target instance's DO
// state so the next redeploy/restart boots the pinned image. Does NOT
// restart the machine — the caller triggers that separately if desired.
const ApplyPinSchema = z.object({
  userId: z.string().min(1),
  instanceId: z.string().min(1),
  imageTag: z.string().min(1).nullable(),
});

platform.post('/versions/apply-pin', async c => {
  const result = await parseBody(c, ApplyPinSchema);
  if ('error' in result) return result.error;

  const { userId, instanceId, imageTag } = result.data;

  try {
    const applied = await withResolvedDORetry(
      c.env,
      userId,
      instanceId,
      stub => stub.applyPinnedVersion(imageTag, instanceId),
      'applyPinnedVersion'
    );
    return c.json({ ok: true, ...applied });
  } catch (err) {
    const { message, status } = sanitizeError(err, 'apply-pin');
    return jsonError(message, status);
  }
});

platform.post('/versions/mark-latest', async c => {
  const result = await parseBody(c, MarkLatestBody);
  if ('error' in result) return result.error;

  const connectionString = c.env.HYPERDRIVE?.connectionString;
  if (!connectionString) return c.json({ error: 'Database not configured' }, 503);

  try {
    const updated = await markImageAsLatest({
      kv: c.env.KV_CLAW_CACHE,
      hyperdriveConnectionString: connectionString,
      imageTag: result.data.imageTag,
    });
    return c.json({ ok: true, ...updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    if (msg.startsWith('Image not found')) return c.json({ error: msg }, 404);
    if (msg.startsWith('Image is disabled')) return c.json({ error: msg }, 400);
    console.error('[platform] Failed to mark image as latest:', err);
    return c.json({ error: 'Failed to mark image as latest' }, 500);
  }
});

// POST /api/platform/publish-image-version
// Manual fallback for publishing/correcting version entries. Newly published
// images land at rollout_percent=0 (not exposed). Ops slides the percent up
// from the admin Versions page.
const PublishImageVersionSchema = z.object({
  openclawVersion: z.string().min(1),
  variant: z.string().min(1).default('default'),
  imageTag: z.string().min(1),
  imageDigest: z.string().nullable().optional(),
});

platform.post('/publish-image-version', async c => {
  const result = await parseBody(c, PublishImageVersionSchema);
  if ('error' in result) return result.error;

  const { openclawVersion, variant, imageTag, imageDigest } = result.data;

  if (openclawVersion === 'latest') {
    return c.json({ error: '"latest" is reserved and cannot be used as a version' }, 400);
  }

  const entry = {
    openclawVersion,
    variant,
    imageTag,
    imageDigest: imageDigest ?? null,
    publishedAt: new Date().toISOString(),
    rolloutPercent: 0,
  };

  // Validate against schema
  const parsed = ImageVersionEntrySchema.safeParse(entry);
  if (!parsed.success) {
    return c.json({ error: 'Invalid version entry', details: parsed.error.flatten() }, 400);
  }

  // Write the versioned key + tag lookup. Do NOT touch :latest — that
  // pointer is owned by the rollout flow now.
  const serialized = JSON.stringify(parsed.data);
  await Promise.all([
    c.env.KV_CLAW_CACHE.put(imageVersionKey(openclawVersion, variant), serialized),
    c.env.KV_CLAW_CACHE.put(`image-version-tag:${imageTag}`, serialized),
  ]);

  // Maintain KV tag index
  await updateTagIndex(c.env.KV_CLAW_CACHE, imageTag);

  // Write to Postgres catalog (best-effort)
  const connectionString = c.env.HYPERDRIVE?.connectionString;
  if (connectionString) {
    try {
      await upsertCatalogVersion(connectionString, {
        openclawVersion,
        variant,
        imageTag,
        imageDigest: imageDigest ?? null,
        publishedAt: parsed.data.publishedAt,
      });
    } catch (e) {
      console.warn('[platform] Failed to write catalog entry to Postgres:', e);
    }
  }

  console.log(
    '[platform] Published image version (at 0% rollout):',
    openclawVersion,
    variant,
    '→',
    imageTag
  );
  return c.json(
    {
      ok: true,
      ...parsed.data,
      // Surfaced in CI logs / curl output so devs aren't surprised when their
      // newly-pushed image isn't immediately picked up by instances.
      promotionHint:
        'Image registered at rollout_percent=0 and is_latest=false. It will not be served to ' +
        'any instance until ops promotes it. Open /admin/kiloclaw?tab=versions and either ' +
        'click "Make :latest" (full immediate rollout) or "Start rollout" with a percent ' +
        '(staged rollout).',
    },
    201
  );
});

// ---------------------------------------------------------------------------
// Region configuration
// ---------------------------------------------------------------------------

import { FLY_REGIONS_KV_KEY, parseRegions, ALL_VALID_REGIONS } from '../durable-objects/regions';
import { DEFAULT_FLY_REGION } from '../config';
import { FLY_API_BASE } from '../fly/client';

const UpdateRegionsSchema = z.object({
  regions: z
    .array(z.enum(ALL_VALID_REGIONS))
    .min(2, 'At least 2 regions required')
    .refine(
      regions => new Set(regions).size >= 2,
      'Must include at least 2 distinct regions (duplicates bias the shuffle, but need 2+ unique for fallback)'
    ),
});

// GET /api/platform/regions
// Returns the current region configuration with its source.
platform.get('/regions', async c => {
  try {
    const kvValue = await c.env.KV_CLAW_CACHE.get(FLY_REGIONS_KV_KEY);
    const source = kvValue ? 'kv' : c.env.FLY_REGION ? 'env' : 'default';
    const raw = kvValue ?? c.env.FLY_REGION ?? DEFAULT_FLY_REGION;
    const regions = parseRegions(raw);
    return c.json({ regions, source, raw });
  } catch (err) {
    console.error('[platform] Failed to read regions:', err);
    return c.json({ error: 'Failed to read regions' }, 500);
  }
});

// PUT /api/platform/regions
// Updates the region configuration in KV.
platform.put('/regions', async c => {
  const result = await parseBody(c, UpdateRegionsSchema);
  if ('error' in result) return result.error;

  const raw = result.data.regions.join(',');
  try {
    await c.env.KV_CLAW_CACHE.put(FLY_REGIONS_KV_KEY, raw);
  } catch (err) {
    console.error('[platform] Failed to write regions to KV:', err);
    return c.json({ error: 'Failed to write regions' }, 500);
  }

  console.log('[platform] Regions updated:', raw);
  return c.json({ ok: true, regions: result.data.regions, raw });
});

// GET /api/platform/providers/rollout
// Returns runtime provider rollout configuration from KV.
platform.get('/providers/rollout', async c => {
  try {
    const { config, source } = await readProviderRolloutConfig(c.env.KV_CLAW_CACHE);
    return c.json({ rollout: config, availability: providerRolloutAvailability(), source });
  } catch (err) {
    console.error('[platform] Failed to read provider rollout config:', err);
    return c.json({ error: 'Failed to read provider rollout config' }, 500);
  }
});

// PUT /api/platform/providers/rollout
// Updates runtime provider rollout configuration in KV.
platform.put('/providers/rollout', async c => {
  const result = await parseBody(c, ProviderRolloutConfigSchema);
  if ('error' in result) return result.error;

  try {
    await writeProviderRolloutConfig(c.env.KV_CLAW_CACHE, result.data);
    return c.json({ ok: true, rollout: result.data, availability: providerRolloutAvailability() });
  } catch (err) {
    console.error('[platform] Failed to write provider rollout config:', err);
    return c.json({ error: 'Failed to write provider rollout config' }, 500);
  }
});

// POST /api/platform/destroy-fly-machine
// This is for admin cleanup only.
// It directly destroys a Fly machine via the Machines API (force=true).
// It does not destroy the Fly app or volume.
const DestroyFlyMachineSchema = z.object({
  userId: z.string().min(1),
  appName: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'Invalid Fly app name'),
  machineId: z
    .string()
    .min(1)
    .regex(/^[a-z0-9]+$/, 'Invalid Fly machine ID'),
});

platform.post('/destroy-fly-machine', async c => {
  const result = await parseBody(c, DestroyFlyMachineSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId, appName, machineId } = result.data;
  const unsupported = await requireProviderCapability(
    c,
    userId,
    iidResult.instanceId,
    'directMachineDestroy',
    'destroy-fly-machine',
    { failOpen: true }
  );
  if (unsupported) return unsupported;

  const apiToken = c.env.FLY_API_TOKEN;
  if (!apiToken) {
    return c.json({ error: 'FLY_API_TOKEN is not configured' }, 503);
  }

  const url = `${FLY_API_BASE}/v1/apps/${appName}/machines/${machineId}?force=true`;
  try {
    const resp = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiToken}` },
    });

    if (!resp.ok) {
      const body = await resp.text();
      console.error(
        `[platform] destroy-fly-machine failed (${resp.status}) app=${appName} machine=${machineId}:`,
        body
      );
      return jsonError(`Fly API error (${resp.status}): ${body}`, resp.status);
    }

    console.log(`[platform] destroy-fly-machine ok: app=${appName} machine=${machineId}`);

    // Trigger immediate reconcile so the DO discovers the machine is gone.
    try {
      await withResolvedDORetry(
        c.env,
        userId,
        iidResult.instanceId,
        stub => stub.forceRetryRecovery(),
        'forceRetryRecovery'
      );
    } catch (err) {
      console.warn(
        `[platform] destroy-fly-machine: forceRetryRecovery failed for user=${userId}:`,
        err
      );
    }

    return c.json({ ok: true });
  } catch (err) {
    const { message, status } = sanitizeError(err, 'destroy-fly-machine');
    return jsonError(message, status);
  }
});

// POST /api/platform/extend-volume
// Admin workaround for granting users temporary additional storage.
// Fly volumes can grow but cannot shrink, so once extended an instance
// is effectively pinned to the larger size — flips DO instanceType to
// 'custom' to reflect that.
const ExtendVolumeSchema = z.object({
  userId: z.string().min(1),
  appName: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'Invalid Fly app name'),
  volumeId: z
    .string()
    .min(1)
    .regex(/^vol_[a-zA-Z0-9]+$/, 'Invalid Fly volume ID'),
  targetSizeGb: z.number().int().min(1).max(500),
});

const FlyExtendVolumeResponseSchema = z.object({
  needs_restart: z.boolean().optional(),
});

platform.post('/extend-volume', async c => {
  const result = await parseBody(c, ExtendVolumeSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { appName, volumeId, targetSizeGb, userId } = result.data;
  const apiToken = c.env.FLY_API_TOKEN;
  if (!apiToken) {
    return c.json({ error: 'FLY_API_TOKEN is not configured' }, 503);
  }

  const url = `${FLY_API_BASE}/v1/apps/${appName}/volumes/${volumeId}/extend`;
  try {
    const resp = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ size_gb: targetSizeGb }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      console.error(
        `[platform] extend-volume failed (${resp.status}) volume=${volumeId} size=${targetSizeGb}:`,
        body
      );
      return jsonError(`Fly API error (${resp.status}): ${body}`, resp.status);
    }

    const extendParsed = FlyExtendVolumeResponseSchema.safeParse(await resp.json());
    if (!extendParsed.success) {
      console.error(
        `[platform] extend-volume unexpected response shape volume=${volumeId}:`,
        flattenError(extendParsed.error)
      );
      return jsonError('Unexpected Fly extend-volume response', 502);
    }
    // Default to true so the admin always sees the redeploy warning when Fly omits the flag
    const needsRestart = extendParsed.data.needs_restart ?? true;

    // Catch the DO up to the new on-disk size so resize-policy comparisons stay honest.
    try {
      await withResolvedDORetry(
        c.env,
        userId,
        iidResult.instanceId,
        stub => stub.recordVolumeExtend(targetSizeGb),
        'recordVolumeExtend'
      );
    } catch (err) {
      // Don't fail the whole request — Fly is already extended; the request
      // would have to be retried anyway and the Fly extend is idempotent
      // (re-extending to the same size is a no-op on Fly).
      //
      // RECOVERY: there is no alarm-driven volume-size observation today
      // (the alarm reconciles `machineSize` from `getMachine` but does not
      // call `getVolume`), so this divergence does NOT auto-heal. The
      // admin re-runs `/extend-volume` with the same target size — both
      // calls are idempotent on retry. The "Has size override" / list
      // tooling is not affected because volumeSizeGb is not surfaced in
      // those filters.
      //
      // FOLLOW-UP: a later PR could add `getVolume`-driven volume-size
      // reconciliation to `backfillMachineSizeFromFlyConfig` so this
      // self-heals on the next alarm tick.
      console.error(
        `[platform] extend-volume: Fly extended succeeded but DO recordVolumeExtend failed for ` +
          `volume=${volumeId} targetSizeGb=${targetSizeGb}. ` +
          `DO state will lag until admin re-runs this route.`,
        err
      );
    }

    console.log(
      `[platform] extend-volume ok: volume=${volumeId} size=${targetSizeGb}GB needsRestart=${needsRestart}`
    );
    return c.json({ ok: true as const, needsRestart });
  } catch (err) {
    const { message, status } = sanitizeError(err, 'extend-volume');
    return jsonError(message, status);
  }
});

// POST /api/platform/scheduled-action/wake
//
// Called by the web's scheduleAction tRPC right after persisting a new
// scheduled-action row in Postgres. Resolves the target instance's DO
// and calls notifyScheduledActionPending() — which just re-arms the
// existing reconcile alarm so the next alarm tick picks up the new
// row via the existing wedge in alarm().
//
// In production this is belt-and-suspenders (the platform proactively
// fires past-due alarms anyway). In `wrangler dev`, stale alarm
// timestamps don't auto-fire — this route is what prevents the dev
// scheduler from sitting forever with a never-firing pre-existing
// alarm.
const ScheduledActionWakeSchema = z.object({
  userId: z.string().min(1),
  instanceId: z.string().uuid(),
});

platform.post('/scheduled-action/wake', async c => {
  const result = await parseBody(c, ScheduledActionWakeSchema);
  if ('error' in result) return result.error;

  const { userId, instanceId } = result.data;

  try {
    const woken = await withResolvedDORetry(
      c.env,
      userId,
      instanceId,
      stub => stub.notifyScheduledActionPending(),
      'notifyScheduledActionPending'
    );
    return c.json(woken);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'scheduled-action-wake');
    return jsonError(message, status);
  }
});

// POST /api/platform/scheduled-action/run-notice-sweep
//
// Synchronously runs the notice sweep that the cron normally drives.
// Useful for local dev (where wrangler does not fire scheduled() on
// the cron cadence) and for ad-hoc admin testing in production. The
// sweep is idempotent and bounded (MAX_NOTIFICATIONS_PER_TICK), so
// invoking it on demand is safe.
platform.post('/scheduled-action/run-notice-sweep', async c => {
  try {
    const result = await runScheduledActionNoticesSweep(c.env);
    return c.json(result);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'scheduled-action-run-notice-sweep');
    return jsonError(message, status);
  }
});

export { platform };
