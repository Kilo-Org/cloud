import { TRPCError } from '@trpc/server';
import { cloud_billing_sku, container_usage_interval } from '@kilocode/db/schema';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import { hasOrganizationAccess } from '@kilocode/worker-utils';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getPgDb } from '../../db/pg.js';
import { getSandboxSessionStub } from '../../sandbox-session/session-stub.js';
import {
  SandboxLifecycleStatusSchema,
  SandboxProviderLabelSchema,
  SandboxStatusDetailCodeSchema,
  type SandboxStatusSnapshot,
} from '../../shared/sandbox-status.js';
import type { WorkspaceRuntimeStatus } from '../../shared/workspace-runtime-status.js';
import type { TRPCContext } from '../../types.js';
import { withDORetry } from '../../utils/do-retry.js';
import { protectedProcedure } from '../auth.js';

const ROOT_STATUS_ATTEMPTS = 3;

const workspacePayerSchema = z.object({ type: z.enum(['user', 'org']), id: z.string() }).strict();
const workspaceActorSchema = z.object({ type: z.enum(['user', 'bot']), id: z.string() }).strict();

export const getHostedWorkspaceStatusInput = z
  .object({
    workspaceId: cloudAgentWorktreeIdSchema,
    kilocodeOrganizationId: z.uuid().optional(),
  })
  .strict();

export const hostedWorkspaceComputeSchema = z
  .object({
    status: SandboxLifecycleStatusSchema,
    detailCode: SandboxStatusDetailCodeSchema,
    provider: SandboxProviderLabelSchema,
    observedAt: z.number().int().nonnegative(),
    estimatedSleepAt: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const getHostedWorkspaceStatusOutput = z
  .object({
    workspaceId: cloudAgentWorktreeIdSchema,
    userId: z.string().min(1),
    organizationId: z.string().nullable(),
    deletionState: z.enum(['active', 'deleting', 'deleted']),
    observedAt: z.number().int().nonnegative(),
    compute: hostedWorkspaceComputeSchema,
    activity: z
      .object({
        activeSessionCount: z.number().int().nonnegative(),
        hasActiveTurn: z.boolean(),
      })
      .strict(),
    wakeOnInput: z
      .object({
        available: z.boolean(),
        blockedReason: z
          .enum(['deleting', 'deleted', 'billing_blocked', 'billing_status_unavailable'])
          .nullable(),
      })
      .strict(),
    billing: z
      .object({
        payer: workspacePayerSchema.nullable(),
        actor: workspaceActorSchema.nullable(),
        onBehalfOf: workspacePayerSchema.nullable(),
        sku: z.string().min(1).max(128).nullable(),
        blocked: z.boolean().nullable(),
        enforcementRequested: z.boolean(),
        intervalStartedAt: z.number().int().nonnegative().nullable(),
        rate: z
          .object({
            rateCentsPerSecond: z.string().min(1).max(32),
            estimatedHourlyMicrodollars: z.number().int().nonnegative(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    deletion: z
      .object({
        started: z.boolean(),
        completed: z.boolean(),
        startedAt: z.number().int().nonnegative().nullable(),
        phase: z.enum(['not_started', 'runtime_cleanup', 'finalizing', 'completed']),
        sessionCount: z.number().int().nonnegative(),
        runtimeLocationCount: z.number().int().nonnegative(),
        completedRuntimeLocationCount: z.number().int().nonnegative(),
        remainingRuntimeLocationCount: z.number().int().nonnegative(),
        deletedSessionIds: z.array(z.string().min(1)),
      })
      .strict(),
  })
  .strict();

export type GetHostedWorkspaceStatusInput = z.infer<typeof getHostedWorkspaceStatusInput>;
export type GetHostedWorkspaceStatusOutput = z.infer<typeof getHostedWorkspaceStatusOutput>;

/**
 * Passive, workspace-keyed status and billing projection.
 *
 * Every read here is snapshot-only: owner-scoped catalog/journal rows, the
 * stored sandbox allocation snapshot, stored per-provider billing state and the
 * immutable billing-SKU rate. None of them allocates compute, prepares a
 * runtime, admits work or opens a billing interval. Automatic idle shutdown and
 * wake-on-next-input remain Cloud's only workspace lifecycle.
 *
 * Removing a workspace from one IDE's Agent Manager is a client-local action:
 * it performs no Cloud mutation and is not represented by any operation here or
 * in the delete-workspace mutation. Only `deleteWorktree` destroys Cloud state.
 */
export const getHostedWorkspaceStatus = protectedProcedure
  .input(getHostedWorkspaceStatusInput)
  .output(getHostedWorkspaceStatusOutput)
  .query(async ({ input, ctx }) => {
    const requestedOrganizationId = input.kilocodeOrganizationId ?? null;
    if (
      requestedOrganizationId !== null &&
      !(await hasOrganizationAccess(getPgDb(ctx.env), {
        kiloUserId: ctx.userId,
        organizationId: requestedOrganizationId,
      }))
    ) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Workspace access denied' });
    }
    const workspace = await ctx.env.SESSION_INGEST.getCloudAgentWorkspace({
      kiloUserId: ctx.userId,
      workspaceId: input.workspaceId,
      sessionLimit: ROOT_STATUS_ATTEMPTS,
    });
    if (!workspace) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found' });
    }
    if (requestedOrganizationId !== null && workspace.organizationId !== requestedOrganizationId) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Workspace scope mismatch' });
    }
    if (
      workspace.organizationId !== null &&
      !(await hasOrganizationAccess(getPgDb(ctx.env), {
        kiloUserId: ctx.userId,
        organizationId: workspace.organizationId,
      }))
    ) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Workspace access denied' });
    }
    const status = await ctx.env.SESSION_INGEST.getCloudAgentWorkspaceStatus({
      kiloUserId: ctx.userId,
      workspaceId: input.workspaceId,
      authorizedWorkspace: {
        userId: workspace.userId,
        organizationId: workspace.organizationId,
        deletionState: workspace.deletionState,
      },
    });
    if (!status) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found' });
    }

    const runtime =
      status.deletionState === 'deleted' ? null : await readWorkspaceRuntime(ctx, workspace);
    const billingBlocked = runtime?.billing?.blocked ?? null;
    const billingStatusUnavailable =
      runtime?.billing?.enforcementRequested === true && billingBlocked === null;
    const deleted = status.deletionState === 'deleted';
    const deleting = status.deletionState === 'deleting';
    return getHostedWorkspaceStatusOutput.parse({
      workspaceId: status.workspaceId,
      userId: ctx.userId,
      organizationId: workspace.organizationId,
      deletionState: status.deletionState,
      observedAt: Date.now(),
      compute: projectCompute(runtime?.sandbox ?? null),
      activity: {
        activeSessionCount: status.activeSessionCount,
        hasActiveTurn: status.activeSessionCount > 0,
      },
      wakeOnInput: {
        available: !deleted && !deleting && billingBlocked !== true && !billingStatusUnavailable,
        blockedReason: deleted
          ? 'deleted'
          : deleting
            ? 'deleting'
            : billingBlocked === true
              ? 'billing_blocked'
              : billingStatusUnavailable
                ? 'billing_status_unavailable'
                : null,
      },
      billing: await projectBilling(ctx, runtime),
      deletion: status.deletion,
    });
  });

async function readWorkspaceRuntime(
  ctx: TRPCContext,
  workspace: { sessions: ReadonlyArray<{ cloudAgentSessionId: string }> }
): Promise<WorkspaceRuntimeStatus | null> {
  let fallback: WorkspaceRuntimeStatus | null = null;
  for (const session of workspace.sessions.slice(0, ROOT_STATUS_ATTEMPTS)) {
    let candidate: WorkspaceRuntimeStatus;
    try {
      candidate = await withDORetry(
        () => getSandboxSessionStub(ctx.env, ctx.userId, session.cloudAgentSessionId),
        stub => stub.getWorkspaceRuntimeStatus(),
        'getWorkspaceRuntimeStatus'
      );
    } catch {
      continue;
    }
    if (candidate.sandbox.detailCode !== 'status_unavailable' || candidate.billing !== null) {
      return candidate;
    }
    fallback ??= candidate;
  }
  return fallback;
}

function projectCompute(
  snapshot: SandboxStatusSnapshot | null
): GetHostedWorkspaceStatusOutput['compute'] {
  if (snapshot === null) {
    return {
      status: 'unknown',
      detailCode: 'status_unavailable',
      provider: 'Unknown',
      observedAt: Date.now(),
      estimatedSleepAt: null,
    };
  }
  return {
    status: snapshot.status,
    detailCode: snapshot.detailCode,
    provider: snapshot.provider,
    observedAt: snapshot.observedAt,
    estimatedSleepAt: snapshot.estimatedSleepAt,
  };
}

async function projectBilling(
  ctx: TRPCContext,
  runtime: WorkspaceRuntimeStatus | null
): Promise<GetHostedWorkspaceStatusOutput['billing']> {
  const billing = runtime?.billing ?? null;
  const resolved = await resolveWorkspaceRate(
    ctx,
    billing?.sku ?? null,
    billing?.meterInstanceId ?? null
  );
  return {
    payer: billing?.payer ?? null,
    actor: billing?.actor ?? null,
    onBehalfOf: billing?.onBehalfOf ?? null,
    sku: resolved?.sku ?? null,
    blocked: billing?.blocked ?? null,
    enforcementRequested: billing?.enforcementRequested === true,
    intervalStartedAt: billing?.intervalStartedAt ?? null,
    rate: resolved?.rate ?? null,
  };
}

type ResolvedWorkspaceRate = {
  sku: string;
  rate: NonNullable<GetHostedWorkspaceStatusOutput['billing']['rate']>;
};

/**
 * Resolves the workspace's one compute rate. The live allocation carries the
 * SKU; a sleeping workspace recovers the last metered SKU from the immutable
 * usage interval for its sandbox. Neither read opens an interval.
 */
async function resolveWorkspaceRate(
  ctx: TRPCContext,
  liveSku: string | null,
  meterInstanceId: string | null
): Promise<ResolvedWorkspaceRate | null> {
  try {
    let sku = liveSku;
    let rateCentsPerSecond: string | null = null;
    if (sku === null && meterInstanceId !== null) {
      const [interval] = await getPgDb(ctx.env)
        .select({
          sku: container_usage_interval.cloud_billing_sku_id,
          rateCentsPerSecond: container_usage_interval.rate_cents_per_unit,
        })
        .from(container_usage_interval)
        .where(eq(container_usage_interval.instance_id, meterInstanceId))
        .orderBy(desc(container_usage_interval.started_at))
        .limit(1);
      if (!interval) return null;
      sku = interval.sku;
      rateCentsPerSecond = interval.rateCentsPerSecond;
    }
    if (sku === null) return null;
    if (rateCentsPerSecond === null) {
      const [row] = await getPgDb(ctx.env)
        .select({ rateCentsPerSecond: cloud_billing_sku.rate_cents_per_unit })
        .from(cloud_billing_sku)
        .where(eq(cloud_billing_sku.id, sku))
        .limit(1);
      rateCentsPerSecond = row?.rateCentsPerSecond ?? null;
    }
    if (rateCentsPerSecond === null) return null;
    const estimatedHourlyMicrodollars = hourlyMicrodollars(rateCentsPerSecond);
    if (estimatedHourlyMicrodollars === undefined) return null;
    return {
      sku,
      rate: { rateCentsPerSecond, estimatedHourlyMicrodollars },
    };
  } catch {
    return null;
  }
}

const BILLING_RATE_PATTERN = /^(0|[1-9]\d{0,11})(?:\.(\d{1,12}))?$/;

/**
 * Converts the immutable per-second SKU rate (cents, up to 12 decimals) into
 * whole microdollars per hour using integer arithmetic.
 */
export function hourlyMicrodollars(rate: string): number | undefined {
  const match = BILLING_RATE_PATTERN.exec(rate);
  if (!match) return undefined;
  const fraction = (match[2] ?? '').padEnd(12, '0');
  const scaled = BigInt(`${match[1]}${fraction}`);
  if (scaled <= 0n) return undefined;
  // rate * 3600 seconds * 10_000 microdollars per cent, floored.
  const value = (scaled * 36n) / 1_000_000n;
  const microdollars = Number(value);
  return Number.isSafeInteger(microdollars) ? microdollars : undefined;
}
