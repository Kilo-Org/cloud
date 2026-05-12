import { adminProcedure, createTRPCRouter, UpstreamApiError } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { insertKiloClawSubscriptionChangeLog } from '@kilocode/db';
import { createHash } from 'crypto';
import {
  kiloclaw_instances,
  kiloclaw_subscriptions,
  kiloclaw_email_log,
  kiloclaw_cli_runs,
  kiloclaw_version_pins,
  kiloclaw_image_catalog,
  kiloclaw_scheduled_actions,
  kiloclaw_scheduled_action_stages,
  kiloclaw_scheduled_action_targets,
  kiloclaw_scheduled_action_notifications,
  kilocode_users,
} from '@kilocode/db/schema';
import type { KiloClawSubscriptionStatus } from '@kilocode/db/schema-types';
import type { NewKiloClawScheduledActionNotification } from '@kilocode/db/schema';
import {
  cycleInboundEmailAddressForInstance,
  getInboundEmailAddressForInstance,
} from '@/lib/kiloclaw/inbound-email-alias';
import { KiloClawInternalClient, KiloClawApiError } from '@/lib/kiloclaw/kiloclaw-internal-client';
import { KiloClawUserClient } from '@/lib/kiloclaw/kiloclaw-user-client';
import { pushPinToWorker } from '@/lib/kiloclaw/pin-sync';
import {
  getActiveInstance,
  getInstanceById,
  markActiveInstanceDestroyed,
  markInstanceDestroyedById,
  restoreDestroyedInstance,
  workerInstanceId,
} from '@/lib/kiloclaw/instance-registry';
import {
  createKiloClawAdminAuditLog,
  listKiloClawAdminAuditLogs,
} from '@/lib/kiloclaw/admin-audit-log';
import { cancelCliRun, createCliRun, getCliRunStatus } from '@/lib/kiloclaw/cli-runs';
import { clearTrialInactivityStopAfterStart } from '@/lib/kiloclaw/instance-lifecycle';
import type {
  PlatformDebugStatusResponse,
  VolumeSnapshot,
  CandidateVolumesResponse,
  ReassociateVolumeResponse,
  ResizeMachineResponse,
  RestoreVolumeSnapshotResponse,
} from '@/lib/kiloclaw/types';
import { generateApiToken, TOKEN_EXPIRY } from '@/lib/tokens';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { InstanceTierKeySchema } from '@kilocode/kiloclaw-instance-tiers';
import {
  AdminSizeOverridePayloadSchema,
  AdminSizeOverridePresetSchema,
  presetToMachineSize,
  type AdminSizeOverridePayload,
} from '@/lib/kiloclaw/admin-size-override';
import { alias } from 'drizzle-orm/pg-core';
import {
  eq,
  and,
  or,
  desc,
  asc,
  ilike,
  isNull,
  isNotNull,
  inArray,
  sql,
  gte,
  lte,
  type SQL,
} from 'drizzle-orm';

const initiatingAdminUsers = alias(kilocode_users, 'initiating_admin_users');
const pinnedByUsers = alias(kilocode_users, 'pinned_by_users');
const fleetSourceCatalog = alias(kiloclaw_image_catalog, 'fleet_source_catalog');

/**
 * Validate the JSONB `admin_size_override` column via the shared Zod
 * schema. Bad payloads return null and emit a warn so DO/Postgres
 * divergence surfaces (the DO is the only writer; a malformed payload
 * means schema drift or a manually-edited row).
 */
function parseAdminSizeOverride(value: unknown): AdminSizeOverrideRow | null {
  if (value === null || value === undefined) return null;
  const parsed = AdminSizeOverridePayloadSchema.safeParse(value);
  if (!parsed.success) {
    console.warn('[admin-kiloclaw] Dropping malformed admin_size_override payload', {
      value,
      issues: parsed.error.issues,
    });
    return null;
  }
  return parsed.data;
}

/**
 * Sentinel for `imageTag` filter — matches rows where `tracked_image_tag IS NULL`
 * (DO alarm hasn't ticked yet, hibernated DOs).
 */
const IMAGE_TAG_FILTER_UNKNOWN = '__unknown__';

const ListInstancesSchema = z.object({
  offset: z.number().min(0).default(0),
  limit: z.number().min(1).max(100).default(25),
  sortBy: z.enum(['created_at', 'destroyed_at']).default('created_at'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  search: z.string().optional(),
  status: z
    .enum(['all', 'active', 'inactive_trial_stopped', 'suspended', 'destroyed'])
    .default('all'),
  imageTag: z.string().max(128).optional(),
  /**
   * When true, restrict the list to instances with an active admin
   * `admin_size_override`. Powered by the partial index on
   * `kiloclaw_instances.admin_size_override`. Used by the admin list
   * page's "Has size override" filter.
   */
  hasSizeOverride: z.boolean().optional(),
});

const DetectOrphansSchema = z.object({
  /** ISO date string — only check instances created on or after this date. */
  createdAfter: z.string().datetime(),
  /** ISO date string — only check instances created on or before this date. */
  createdBefore: z.string().datetime(),
});

const GetInstanceSchema = z.object({
  id: z.string().uuid(),
});

const DestroyInstanceSchema = z.object({
  id: z.string().uuid(),
});

const SetInboundEmailEnabledSchema = z.object({
  id: z.string().uuid(),
  enabled: z.boolean(),
});

const VolumeSnapshotsSchema = z.object({
  userId: z.string().min(1),
  instanceId: z.string().uuid().optional(),
});

const GatewayProcessSchema = z.object({
  userId: z.string().min(1),
  instanceId: z.string().uuid().optional(),
});

const StatsSchema = z.object({
  days: z.number().min(1).max(365).default(30),
});

const NoticeConfigSchema = z.object({
  notify: z.boolean().default(true),
  noticeLeadHours: z.number().int().min(0).max(168).default(24),
  noticeSubject: z.string().max(120).default(''),
  noticeBody: z.string().max(2000).default(''),
  noticeChannels: z
    .array(z.enum(['email', 'webapp', 'mobile_push']))
    .min(1)
    .default(['email', 'webapp', 'mobile_push']),
});

const ImageTagSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

const CalVerSchema = z
  .string()
  .regex(/^\d{4}\.\d{1,2}\.\d{1,2}$/, 'Version must use YYYY.M.D format');

const FleetUpgradeFilterSchema = NoticeConfigSchema.extend({
  versionBelow: CalVerSchema,
  targetImageTag: ImageTagSchema,
  overridePins: z.boolean().default(false),
  startsAt: z.string().datetime(),
  tranchePercent: z.number().int().min(1).max(100),
  intervalDays: z.number().int().min(1).max(30),
  reason: z.string().max(256).optional(),
});

type KiloclawTrpcCode =
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'TOO_MANY_REQUESTS'
  | 'PRECONDITION_FAILED'
  | 'INTERNAL_SERVER_ERROR';

function kiloclawStatusToTrpcCode(statusCode: number): KiloclawTrpcCode {
  switch (statusCode) {
    case 400:
      return 'BAD_REQUEST';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 412:
      return 'PRECONDITION_FAILED';
    case 429:
      return 'TOO_MANY_REQUESTS';
    default:
      return 'INTERNAL_SERVER_ERROR';
  }
}

function getKiloclawApiErrorPayload(
  err: KiloClawApiError,
  fallbackMessage: string
): { code?: string; message: string } {
  if (!err.responseBody) return { message: fallbackMessage };

  try {
    const parsed: unknown = JSON.parse(err.responseBody);
    if (typeof parsed === 'object' && parsed !== null) {
      const code = 'code' in parsed && typeof parsed.code === 'string' ? parsed.code : undefined;
      const error = 'error' in parsed ? parsed.error : undefined;
      const message = 'message' in parsed ? parsed.message : undefined;
      if (typeof error === 'string') return { code, message: error };
      if (typeof message === 'string') return { code, message };
      return { code, message: fallbackMessage };
    }
  } catch {
    // Fall back to the raw response body when the controller did not return JSON.
  }

  return { message: err.responseBody.trim() || fallbackMessage };
}

function throwKiloclawAdminError(
  err: unknown,
  fallbackMessage: string,
  options?: {
    statusCodeOverrides?: Partial<Record<number, KiloclawTrpcCode>>;
    messageOverrides?: Partial<Record<number, string>>;
  }
): never {
  if (err instanceof TRPCError) {
    throw err;
  }

  if (err instanceof KiloClawApiError) {
    const payload = getKiloclawApiErrorPayload(err, fallbackMessage);
    if (payload.code === 'controller_route_unavailable') {
      throw new TRPCError({
        code: options?.statusCodeOverrides?.[err.statusCode] ?? 'PRECONDITION_FAILED',
        message:
          options?.messageOverrides?.[err.statusCode] ??
          'Instance needs redeploy to support recovery',
        cause: new UpstreamApiError('controller_route_unavailable'),
      });
    }

    throw new TRPCError({
      code:
        options?.statusCodeOverrides?.[err.statusCode] ?? kiloclawStatusToTrpcCode(err.statusCode),
      message: options?.messageOverrides?.[err.statusCode] ?? payload.message,
      cause: payload.code ? new UpstreamApiError(payload.code) : err,
    });
  }

  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: err instanceof Error ? `${fallbackMessage}: ${err.message}` : fallbackMessage,
    cause: err instanceof Error ? err : undefined,
  });
}

type KiloclawSubscriptionRow = typeof kiloclaw_subscriptions.$inferSelect;

async function clearAdminInstanceDestructionDeadlineWithChangeLog(params: {
  actorUserId: string;
  userId: string;
  instanceId: string;
  reason: string;
}) {
  const [before] = await db
    .select()
    .from(kiloclaw_subscriptions)
    .where(
      and(
        eq(kiloclaw_subscriptions.user_id, params.userId),
        eq(kiloclaw_subscriptions.instance_id, params.instanceId)
      )
    )
    .limit(1);

  if (!before) {
    return;
  }

  const [after] = await db
    .update(kiloclaw_subscriptions)
    .set({ destruction_deadline: null })
    .where(
      and(
        eq(kiloclaw_subscriptions.user_id, params.userId),
        eq(kiloclaw_subscriptions.instance_id, params.instanceId)
      )
    )
    .returning();

  if (!after) {
    return;
  }

  try {
    await insertKiloClawSubscriptionChangeLog(db, {
      subscriptionId: after.id,
      actor: {
        actorType: 'user',
        actorId: params.actorUserId,
      },
      action: 'admin_override',
      reason: params.reason,
      before: before satisfies KiloclawSubscriptionRow,
      after: after satisfies KiloclawSubscriptionRow,
    });
  } catch (error) {
    console.error('[admin-kiloclaw] Failed to write subscription change log:', error);
  }
}

/**
 * Resolve the target instance for admin operations.
 * When instanceId is provided, look it up directly and throw NOT_FOUND if missing.
 * Otherwise fall back to the user's active (personal) instance.
 */
async function resolveInstance(userId: string, instanceId?: string) {
  if (instanceId) {
    const instance = await getInstanceById(instanceId);
    if (!instance) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: `Instance ${instanceId} not found`,
        cause: new UpstreamApiError('instance_not_found'),
      });
    }
    return instance;
  }

  return getActiveInstance(userId);
}

function assertInstanceBelongsToUser(
  instance: Awaited<ReturnType<typeof resolveInstance>>,
  userId: string
): asserts instance is NonNullable<Awaited<ReturnType<typeof resolveInstance>>> {
  if (!instance || instance.userId !== userId) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Instance not found',
      cause: new UpstreamApiError('instance_not_found'),
    });
  }
}

export type AdminKiloclawLifecycleState =
  | 'active'
  | 'inactive_trial_stopped'
  | 'suspended'
  | 'destroyed';

function getAdminKiloclawLifecycleState(input: {
  destroyed_at: string | null;
  suspended_at: string | null;
  inactive_trial_stopped_at: string | null;
}): AdminKiloclawLifecycleState {
  if (input.destroyed_at !== null) {
    return 'destroyed';
  }
  if (input.suspended_at !== null) {
    return 'suspended';
  }
  if (input.inactive_trial_stopped_at !== null) {
    return 'inactive_trial_stopped';
  }
  return 'active';
}

export type AdminKiloclawInstance = {
  id: string;
  user_id: string;
  sandbox_id: string;
  organization_id: string | null;
  created_at: string;
  destroyed_at: string | null;
  inbound_email_enabled: boolean;
  inactive_trial_stopped_at: string | null;
  lifecycle_state: AdminKiloclawLifecycleState;
  suspended_at: string | null;
  user_email: string | null;
  subscription_id: string | null;
  subscription_status: KiloClawSubscriptionStatus | null;
  /**
   * The owning user's `kiloclaw_early_access` flag. Sourced from
   * `kilocode_users` (per user, applies across all of their instances).
   */
  user_kiloclaw_early_access: boolean;
  /**
   * The image tag the DO last reported running. Denormalized from DO state by
   * the alarm reconciler. Null when the DO hasn't ticked since the column was
   * added (≤30min after first deploy) or for hibernated DOs.
   */
  tracked_image_tag: string | null;
  /**
   * Active version pin, if any. Null when the instance has no pin row.
   */
  pin: {
    image_tag: string;
    pinned_by_user_id: string;
    is_admin_pin: boolean;
  } | null;
  /**
   * Active admin size override, if any. Mirrors the DO's
   * `adminMachineSizeOverride` + metadata. Non-null means the instance is
   * running on hardware that diverges from its billable tier.
   */
  admin_size_override: AdminSizeOverrideRow | null;
};

// Re-export the shared payload as the row type so the router and the lib
// share a single canonical schema. The shape is whatever
// `AdminSizeOverridePayloadSchema` enforces (validated at the JSONB column
// boundary by `parseAdminSizeOverride`).
export type AdminSizeOverrideRow = AdminSizeOverridePayload;

export type AdminKiloclawInstanceDetail = AdminKiloclawInstance & {
  inbound_email_address: string | null;
  workerStatus: PlatformDebugStatusResponse | null;
  workerStatusError: string | null;
};

type NoticeChannel = z.infer<typeof NoticeConfigSchema>['noticeChannels'][number];
type ScheduledActionType = 'scheduled_restart' | 'version_change';
type ScheduledActionInstanceRow = {
  instance: typeof kiloclaw_instances.$inferSelect;
  owner_id: string;
};
type ScheduledActionTargetRow = ScheduledActionInstanceRow & {
  stageIndex: number;
};
type ScheduledActionStageInput = {
  stageIndex: number;
  scheduledAt: string;
};

function assertScheduledTimeInFuture(value: string, fieldName: string) {
  const scheduledAtMs = new Date(value).getTime();
  if (Number.isNaN(scheduledAtMs) || scheduledAtMs - Date.now() < 60_000) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `${fieldName} must be at least 1 minute in the future`,
    });
  }
}

async function validateAvailableImageTag(imageTag: string) {
  const [catalogEntry] = await db
    .select({
      image_tag: kiloclaw_image_catalog.image_tag,
      status: kiloclaw_image_catalog.status,
    })
    .from(kiloclaw_image_catalog)
    .where(eq(kiloclaw_image_catalog.image_tag, imageTag))
    .limit(1);

  if (!catalogEntry) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Target image tag not found in catalog: ${imageTag}`,
    });
  }
  if (catalogEntry.status === 'disabled') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Target image tag is disabled: ${imageTag}`,
    });
  }
}

async function findPendingScheduledActionConflicts(instanceIds: string[]) {
  if (instanceIds.length === 0) return [];
  const existingPending = await db
    .select({
      instance_id: kiloclaw_scheduled_action_targets.instance_id,
      scheduled_action_id: kiloclaw_scheduled_action_targets.scheduled_action_id,
    })
    .from(kiloclaw_scheduled_action_targets)
    .innerJoin(
      kiloclaw_scheduled_actions,
      eq(kiloclaw_scheduled_actions.id, kiloclaw_scheduled_action_targets.scheduled_action_id)
    )
    .where(
      and(
        inArray(kiloclaw_scheduled_action_targets.instance_id, instanceIds),
        inArray(kiloclaw_scheduled_action_targets.status, ['pending', 'running']),
        inArray(kiloclaw_scheduled_actions.status, ['scheduled', 'running'])
      )
    );
  return Array.from(new Set(existingPending.map(e => e.instance_id)));
}

async function createScheduledActionRows(params: {
  actionType: ScheduledActionType;
  targetImageTag: string | null;
  overridePins: boolean;
  noticeLeadHours: number;
  noticeSubject: string;
  noticeBody: string;
  reason: string | null;
  createdBy: string;
  stages: ScheduledActionStageInput[];
  targets: ScheduledActionTargetRow[];
  notify: boolean;
  noticeChannels: NoticeChannel[];
}) {
  const liveInstanceIds = Array.from(new Set(params.targets.map(row => row.instance.id)));
  if (liveInstanceIds.length === 0) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'No target instances to schedule',
    });
  }

  return db.transaction(
    async tx => {
      const existingPending = await tx
        .select({
          instance_id: kiloclaw_scheduled_action_targets.instance_id,
          scheduled_action_id: kiloclaw_scheduled_action_targets.scheduled_action_id,
        })
        .from(kiloclaw_scheduled_action_targets)
        .innerJoin(
          kiloclaw_scheduled_actions,
          eq(kiloclaw_scheduled_actions.id, kiloclaw_scheduled_action_targets.scheduled_action_id)
        )
        .where(
          and(
            inArray(kiloclaw_scheduled_action_targets.instance_id, liveInstanceIds),
            inArray(kiloclaw_scheduled_action_targets.status, ['pending', 'running']),
            inArray(kiloclaw_scheduled_actions.status, ['scheduled', 'running'])
          )
        );

      if (existingPending.length > 0) {
        const conflictIds = Array.from(new Set(existingPending.map(e => e.instance_id)));
        throw new TRPCError({
          code: 'CONFLICT',
          message:
            conflictIds.length === 1
              ? `Instance ${conflictIds[0]} already has a pending or in-flight scheduled action; cancel it first`
              : `${conflictIds.length} instances already have pending or in-flight scheduled actions; cancel those first: ${conflictIds.join(', ')}`,
        });
      }

      const [parentRow] = await tx
        .insert(kiloclaw_scheduled_actions)
        .values({
          action_type: params.actionType,
          target_image_tag: params.targetImageTag,
          override_pins: params.overridePins,
          notice_lead_hours: params.noticeLeadHours,
          notice_subject: params.noticeSubject,
          notice_body: params.noticeBody,
          reason: params.reason,
          status: 'scheduled',
          created_by: params.createdBy,
          total_count: liveInstanceIds.length,
        })
        .returning({ id: kiloclaw_scheduled_actions.id });

      const stageRows = await tx
        .insert(kiloclaw_scheduled_action_stages)
        .values(
          params.stages.map(stage => ({
            scheduled_action_id: parentRow.id,
            stage_index: stage.stageIndex,
            scheduled_at: stage.scheduledAt,
            status: 'pending' as const,
          }))
        )
        .returning({
          id: kiloclaw_scheduled_action_stages.id,
          stage_index: kiloclaw_scheduled_action_stages.stage_index,
        });

      const stageIdByIndex = new Map(stageRows.map(stage => [stage.stage_index, stage.id]));

      const insertedTargets = await tx
        .insert(kiloclaw_scheduled_action_targets)
        .values(
          params.targets.map(row => {
            const stageId = stageIdByIndex.get(row.stageIndex);
            if (!stageId) throw new Error(`Missing stage id for stage ${row.stageIndex}`);
            return {
              scheduled_action_id: parentRow.id,
              stage_id: stageId,
              instance_id: row.instance.id,
              source_image_tag: row.instance.tracked_image_tag,
              target_image_tag: params.targetImageTag,
              user_id: row.owner_id,
              status: 'pending' as const,
            };
          })
        )
        .returning({
          id: kiloclaw_scheduled_action_targets.id,
          instance_id: kiloclaw_scheduled_action_targets.instance_id,
        });

      if (params.notify && params.noticeChannels.length > 0) {
        const notificationRows: NewKiloClawScheduledActionNotification[] = [];
        for (const target of insertedTargets) {
          for (const channel of params.noticeChannels) {
            notificationRows.push({
              target_id: target.id,
              channel,
              kind: 'notice',
              status: 'pending',
            });
          }
        }
        await tx.insert(kiloclaw_scheduled_action_notifications).values(notificationRows);
      }

      return {
        id: parentRow.id,
        stageIds: stageRows.sort((a, b) => a.stage_index - b.stage_index).map(stage => stage.id),
        insertedTargets,
      };
    },
    { isolationLevel: 'serializable' }
  );
}

function buildFleetStagePlan(params: {
  targetCount: number;
  startsAt: string;
  tranchePercent: number;
  intervalDays: number;
}) {
  if (params.targetCount === 0) return [];
  const trancheSize = Math.max(1, Math.ceil((params.targetCount * params.tranchePercent) / 100));
  const startsAtMs = new Date(params.startsAt).getTime();
  const stages: Array<{ stageIndex: number; scheduledAt: string; targetCount: number }> = [];
  let remaining = params.targetCount;
  let stageIndex = 0;
  while (remaining > 0) {
    const targetCount = Math.min(trancheSize, remaining);
    stages.push({
      stageIndex,
      scheduledAt: new Date(
        startsAtMs + stageIndex * params.intervalDays * 86_400_000
      ).toISOString(),
      targetCount,
    });
    remaining -= targetCount;
    stageIndex += 1;
  }
  return stages;
}

function fleetSortKey(seed: string, instanceId: string) {
  return createHash('sha256').update(`${seed}:${instanceId}`).digest('hex');
}

async function getFleetUpgradePlan(input: z.infer<typeof FleetUpgradeFilterSchema>) {
  await validateAvailableImageTag(input.targetImageTag);

  const rows = await db
    .select({
      instance: kiloclaw_instances,
      owner_id: kilocode_users.id,
      source_openclaw_version: fleetSourceCatalog.openclaw_version,
      source_is_below_cutoff: sql<boolean | null>`
        string_to_array(${fleetSourceCatalog.openclaw_version}, '.')::int[]
        < string_to_array(${input.versionBelow}, '.')::int[]
      `,
      pin_id: kiloclaw_version_pins.id,
    })
    .from(kiloclaw_instances)
    .innerJoin(kilocode_users, eq(kiloclaw_instances.user_id, kilocode_users.id))
    .innerJoin(
      kiloclaw_subscriptions,
      eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id)
    )
    .leftJoin(
      fleetSourceCatalog,
      eq(kiloclaw_instances.tracked_image_tag, fleetSourceCatalog.image_tag)
    )
    .leftJoin(kiloclaw_version_pins, eq(kiloclaw_version_pins.instance_id, kiloclaw_instances.id))
    .where(
      and(
        isNull(kiloclaw_instances.destroyed_at),
        isNull(kiloclaw_instances.inactive_trial_stopped_at),
        isNull(kiloclaw_subscriptions.suspended_at)
      )
    );

  const unknownVersionRows = rows.filter(
    row => !row.instance.tracked_image_tag || !row.source_openclaw_version
  );
  const alreadyOnTargetRows = rows.filter(
    row => row.instance.tracked_image_tag === input.targetImageTag
  );
  const eligibleRows = rows.filter(
    row =>
      row.source_openclaw_version &&
      row.source_is_below_cutoff === true &&
      row.instance.tracked_image_tag !== input.targetImageTag
  );
  const pinnedRows = eligibleRows.filter(row => row.pin_id !== null);
  const preConflictRows = eligibleRows.filter(row => input.overridePins || row.pin_id === null);
  const conflictInstanceIds = await findPendingScheduledActionConflicts(
    preConflictRows.map(row => row.instance.id)
  );
  const conflictIdSet = new Set(conflictInstanceIds);
  const seed = [
    input.versionBelow,
    input.targetImageTag,
    input.startsAt,
    input.tranchePercent,
    input.intervalDays,
  ].join('|');
  const actionableRows = preConflictRows
    .filter(row => !conflictIdSet.has(row.instance.id))
    .map(row => ({ row, sortKey: fleetSortKey(seed, row.instance.id) }))
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
    .map(({ row }) => row);
  const stages = buildFleetStagePlan({
    targetCount: actionableRows.length,
    startsAt: input.startsAt,
    tranchePercent: input.tranchePercent,
    intervalDays: input.intervalDays,
  });

  return {
    counts: {
      eligible: eligibleRows.length,
      actionable: actionableRows.length,
      pinned: pinnedRows.length,
      conflicts: conflictInstanceIds.length,
      alreadyOnTarget: alreadyOnTargetRows.length,
      unknownVersion: unknownVersionRows.length,
    },
    stages,
    actionableRows,
    actionableInstanceIds: actionableRows.map(row => row.instance.id),
    excluded: {
      pinnedInstanceIds: pinnedRows.map(row => row.instance.id),
      conflictInstanceIds,
      alreadyOnTargetInstanceIds: alreadyOnTargetRows.map(row => row.instance.id),
      unknownVersionInstanceIds: unknownVersionRows.map(row => row.instance.id),
    },
  };
}

export const adminKiloclawInstancesRouter = createTRPCRouter({
  get: adminProcedure.input(GetInstanceSchema).query(async ({ input }) => {
    const [result] = await db
      .select({
        instance: kiloclaw_instances,
        user_email: kilocode_users.google_user_email,
        user_kiloclaw_early_access: kilocode_users.kiloclaw_early_access,
        suspended_at: kiloclaw_subscriptions.suspended_at,
        subscription_id: kiloclaw_subscriptions.id,
        subscription_status: kiloclaw_subscriptions.status,
        pin_image_tag: kiloclaw_version_pins.image_tag,
        pin_pinned_by: kiloclaw_version_pins.pinned_by,
        pin_pinned_by_is_admin: pinnedByUsers.is_admin,
      })
      .from(kiloclaw_instances)
      .leftJoin(kilocode_users, eq(kiloclaw_instances.user_id, kilocode_users.id))
      .leftJoin(
        kiloclaw_subscriptions,
        eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id)
      )
      .leftJoin(kiloclaw_version_pins, eq(kiloclaw_version_pins.instance_id, kiloclaw_instances.id))
      .leftJoin(pinnedByUsers, eq(pinnedByUsers.id, kiloclaw_version_pins.pinned_by))
      .where(eq(kiloclaw_instances.id, input.id))
      .limit(1);

    if (!result) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Instance not found' });
    }

    const instance: AdminKiloclawInstance = {
      id: result.instance.id,
      user_id: result.instance.user_id,
      sandbox_id: result.instance.sandbox_id,
      organization_id: result.instance.organization_id,
      created_at: result.instance.created_at,
      destroyed_at: result.instance.destroyed_at,
      inbound_email_enabled: result.instance.inbound_email_enabled,
      inactive_trial_stopped_at: result.instance.inactive_trial_stopped_at,
      lifecycle_state: getAdminKiloclawLifecycleState({
        destroyed_at: result.instance.destroyed_at,
        suspended_at: result.suspended_at ?? null,
        inactive_trial_stopped_at: result.instance.inactive_trial_stopped_at,
      }),
      suspended_at: result.suspended_at ?? null,
      user_email: result.user_email,
      subscription_id: result.subscription_id ?? null,
      subscription_status: result.subscription_status ?? null,
      user_kiloclaw_early_access: result.user_kiloclaw_early_access ?? false,
      tracked_image_tag: result.instance.tracked_image_tag,
      pin:
        result.pin_image_tag && result.pin_pinned_by
          ? {
              image_tag: result.pin_image_tag,
              pinned_by_user_id: result.pin_pinned_by,
              is_admin_pin: result.pin_pinned_by_is_admin ?? false,
            }
          : null,
      admin_size_override: parseAdminSizeOverride(result.instance.admin_size_override),
    };

    const inboundEmailAddress = await getInboundEmailAddressForInstance(instance.id);

    // Fetch live worker status for all instances.
    // DB may be marked destroyed while DO is still retrying destroy.
    let workerStatus: PlatformDebugStatusResponse | null = null;
    let workerStatusError: string | null = null;

    try {
      const client = new KiloClawInternalClient();
      workerStatus = await client.getDebugStatus(instance.user_id, workerInstanceId(instance));
    } catch (err) {
      workerStatusError =
        err instanceof KiloClawApiError
          ? getKiloclawApiErrorPayload(err, 'Failed to fetch worker status').message
          : err instanceof Error
            ? err.message
            : 'Failed to fetch worker status';
    }

    return {
      ...instance,
      inbound_email_address: inboundEmailAddress,
      workerStatus,
      workerStatusError,
    } satisfies AdminKiloclawInstanceDetail;
  }),

  cycleInboundEmailAddress: adminProcedure
    .input(GetInstanceSchema)
    .mutation(async ({ input, ctx }) => {
      const [instance] = await db
        .select({ id: kiloclaw_instances.id, user_id: kiloclaw_instances.user_id })
        .from(kiloclaw_instances)
        .where(eq(kiloclaw_instances.id, input.id))
        .limit(1);
      if (!instance) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Instance not found' });
      }

      const inboundEmailAddress = await cycleInboundEmailAddressForInstance(instance.id);
      await createKiloClawAdminAuditLog({
        action: 'kiloclaw.inbound_email.cycle',
        actor_id: ctx.user.id,
        actor_email: ctx.user.google_user_email,
        actor_name: ctx.user.google_user_name,
        target_user_id: instance.user_id,
        message: `Inbound email address cycled for instance ${instance.id}`,
        metadata: { instanceId: instance.id },
      });
      return { inboundEmailAddress };
    }),

  setInboundEmailEnabled: adminProcedure
    .input(SetInboundEmailEnabledSchema)
    .mutation(async ({ input, ctx }) => {
      const [instance] = await db
        .update(kiloclaw_instances)
        .set({ inbound_email_enabled: input.enabled })
        .where(eq(kiloclaw_instances.id, input.id))
        .returning({ id: kiloclaw_instances.id, user_id: kiloclaw_instances.user_id });
      if (!instance) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Instance not found' });
      }

      await createKiloClawAdminAuditLog({
        action: 'kiloclaw.inbound_email.update_enabled',
        actor_id: ctx.user.id,
        actor_email: ctx.user.google_user_email,
        actor_name: ctx.user.google_user_name,
        target_user_id: instance.user_id,
        message: `Inbound email ${input.enabled ? 'enabled' : 'disabled'} for instance ${instance.id}`,
        metadata: { instanceId: instance.id, enabled: input.enabled },
      });
      return { ok: true };
    }),

  registryEntries: adminProcedure
    .input(z.object({ userId: z.string().min(1), orgId: z.string().optional() }))
    .query(async ({ input }) => {
      const client = new KiloClawInternalClient();
      return client.getRegistryEntries(input.userId, input.orgId ?? undefined);
    }),

  list: adminProcedure.input(ListInstancesSchema).query(async ({ input }) => {
    const { offset, limit, sortBy, sortOrder, search, status, imageTag, hasSizeOverride } = input;
    const searchTerm = search?.trim() || '';

    const conditions: SQL[] = [];

    if (searchTerm) {
      const escapedTerm = searchTerm.replace(/[%_\\]/g, '\\$&');
      const ilikePattern = `%${escapedTerm}%`;
      const searchConditions: SQL[] = [
        ilike(kiloclaw_instances.sandbox_id, ilikePattern),
        ilike(kilocode_users.google_user_email, ilikePattern),
      ];

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (uuidRegex.test(searchTerm)) {
        searchConditions.push(eq(kiloclaw_instances.id, searchTerm));
        searchConditions.push(eq(kiloclaw_instances.user_id, searchTerm));
      }

      const searchCondition = or(...searchConditions);
      if (searchCondition) {
        conditions.push(searchCondition);
      }
    }

    if (status === 'active') {
      conditions.push(isNull(kiloclaw_instances.destroyed_at));
      conditions.push(isNull(kiloclaw_subscriptions.suspended_at));
      conditions.push(isNull(kiloclaw_instances.inactive_trial_stopped_at));
    } else if (status === 'inactive_trial_stopped') {
      conditions.push(isNull(kiloclaw_instances.destroyed_at));
      conditions.push(isNull(kiloclaw_subscriptions.suspended_at));
      conditions.push(isNotNull(kiloclaw_instances.inactive_trial_stopped_at));
    } else if (status === 'suspended') {
      conditions.push(isNull(kiloclaw_instances.destroyed_at));
      conditions.push(isNotNull(kiloclaw_subscriptions.suspended_at));
    } else if (status === 'destroyed') {
      conditions.push(isNotNull(kiloclaw_instances.destroyed_at));
    }

    if (imageTag === IMAGE_TAG_FILTER_UNKNOWN) {
      conditions.push(isNull(kiloclaw_instances.tracked_image_tag));
    } else if (imageTag) {
      conditions.push(eq(kiloclaw_instances.tracked_image_tag, imageTag));
    }

    if (hasSizeOverride) {
      // Match the partial-index predicate exactly so the planner can use it.
      // Intent is "outstanding overrides on live instances" — a destroyed
      // instance with a leftover override is not actionable for support.
      conditions.push(isNotNull(kiloclaw_instances.admin_size_override));
      conditions.push(isNull(kiloclaw_instances.destroyed_at));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    const orderFunction = sortOrder === 'asc' ? asc : desc;
    const orderCondition = orderFunction(kiloclaw_instances[sortBy]);

    const instancesResult = await db
      .select({
        instance: kiloclaw_instances,
        user_email: kilocode_users.google_user_email,
        user_kiloclaw_early_access: kilocode_users.kiloclaw_early_access,
        suspended_at: kiloclaw_subscriptions.suspended_at,
        subscription_id: kiloclaw_subscriptions.id,
        subscription_status: kiloclaw_subscriptions.status,
        pin_image_tag: kiloclaw_version_pins.image_tag,
        pin_pinned_by: kiloclaw_version_pins.pinned_by,
        pin_pinned_by_is_admin: pinnedByUsers.is_admin,
      })
      .from(kiloclaw_instances)
      .leftJoin(kilocode_users, eq(kiloclaw_instances.user_id, kilocode_users.id))
      .leftJoin(
        kiloclaw_subscriptions,
        eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id)
      )
      .leftJoin(kiloclaw_version_pins, eq(kiloclaw_version_pins.instance_id, kiloclaw_instances.id))
      .leftJoin(pinnedByUsers, eq(pinnedByUsers.id, kiloclaw_version_pins.pinned_by))
      .where(whereCondition)
      .orderBy(orderCondition)
      .limit(limit)
      .offset(offset);

    const totalCountResult = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(kiloclaw_instances)
      .leftJoin(kilocode_users, eq(kiloclaw_instances.user_id, kilocode_users.id))
      .leftJoin(
        kiloclaw_subscriptions,
        eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id)
      )
      .where(whereCondition);

    const totalCount = totalCountResult[0]?.count || 0;
    const totalPages = Math.ceil(totalCount / limit);

    const instances: AdminKiloclawInstance[] = instancesResult.map(row => ({
      id: row.instance.id,
      user_id: row.instance.user_id,
      sandbox_id: row.instance.sandbox_id,
      organization_id: row.instance.organization_id,
      created_at: row.instance.created_at,
      destroyed_at: row.instance.destroyed_at,
      inbound_email_enabled: row.instance.inbound_email_enabled,
      inactive_trial_stopped_at: row.instance.inactive_trial_stopped_at,
      lifecycle_state: getAdminKiloclawLifecycleState({
        destroyed_at: row.instance.destroyed_at,
        suspended_at: row.suspended_at ?? null,
        inactive_trial_stopped_at: row.instance.inactive_trial_stopped_at,
      }),
      suspended_at: row.suspended_at ?? null,
      user_email: row.user_email,
      subscription_id: row.subscription_id ?? null,
      subscription_status: row.subscription_status ?? null,
      user_kiloclaw_early_access: row.user_kiloclaw_early_access ?? false,
      tracked_image_tag: row.instance.tracked_image_tag,
      pin:
        row.pin_image_tag && row.pin_pinned_by
          ? {
              image_tag: row.pin_image_tag,
              pinned_by_user_id: row.pin_pinned_by,
              is_admin_pin: row.pin_pinned_by_is_admin ?? false,
            }
          : null,
      admin_size_override: parseAdminSizeOverride(row.instance.admin_size_override),
    }));

    return {
      instances,
      pagination: {
        offset,
        limit,
        total: totalCount,
        totalPages,
      },
    };
  }),

  stats: adminProcedure.input(StatsSchema).query(async ({ input }) => {
    const { days } = input;

    // Overview counts (join subscriptions to derive suspended state)
    const [overview] = await db
      .select({
        total_instances: sql<number>`COUNT(*)::int`,
        active_instances: sql<number>`COUNT(CASE WHEN ${kiloclaw_instances.destroyed_at} IS NULL AND ${kiloclaw_subscriptions.suspended_at} IS NULL AND ${kiloclaw_instances.inactive_trial_stopped_at} IS NULL THEN 1 END)::int`,
        inactive_trial_stopped_instances: sql<number>`COUNT(CASE WHEN ${kiloclaw_instances.destroyed_at} IS NULL AND ${kiloclaw_subscriptions.suspended_at} IS NULL AND ${kiloclaw_instances.inactive_trial_stopped_at} IS NOT NULL THEN 1 END)::int`,
        suspended_instances: sql<number>`COUNT(CASE WHEN ${kiloclaw_instances.destroyed_at} IS NULL AND ${kiloclaw_subscriptions.suspended_at} IS NOT NULL THEN 1 END)::int`,
        destroyed_instances: sql<number>`COUNT(CASE WHEN ${kiloclaw_instances.destroyed_at} IS NOT NULL THEN 1 END)::int`,
        unique_users: sql<number>`COUNT(DISTINCT ${kiloclaw_instances.user_id})::int`,
      })
      .from(kiloclaw_instances)
      .leftJoin(
        kiloclaw_subscriptions,
        eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id)
      );

    // Time-windowed counts
    const [last24h] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(kiloclaw_instances)
      .where(sql`${kiloclaw_instances.created_at} >= NOW() - INTERVAL '24 hours'`);

    const [last7d] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(kiloclaw_instances)
      .where(sql`${kiloclaw_instances.created_at} >= NOW() - INTERVAL '7 days'`);

    const [activeUsers7d] = await db
      .select({
        count: sql<number>`COUNT(DISTINCT ${kiloclaw_instances.user_id})::int`,
      })
      .from(kiloclaw_instances)
      .where(
        and(
          isNull(kiloclaw_instances.destroyed_at),
          gte(kiloclaw_instances.created_at, sql`NOW() - INTERVAL '7 days'`)
        )
      );

    // Average lifespan of destroyed instances
    const [lifespan] = await db
      .select({
        avg_lifespan_minutes: sql<
          number | null
        >`AVG(EXTRACT(EPOCH FROM (${kiloclaw_instances.destroyed_at}::timestamp - ${kiloclaw_instances.created_at}::timestamp)) / 60)`,
      })
      .from(kiloclaw_instances)
      .where(isNotNull(kiloclaw_instances.destroyed_at));

    // Daily stats for chart
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const dailyStats = await db
      .select({
        date: sql<string>`DATE(${kiloclaw_instances.created_at})`.as('date'),
        created: sql<number>`COUNT(*)::int`.as('created'),
      })
      .from(kiloclaw_instances)
      .where(gte(kiloclaw_instances.created_at, startDate.toISOString()))
      .groupBy(sql`DATE(${kiloclaw_instances.created_at})`)
      .orderBy(sql`DATE(${kiloclaw_instances.created_at})`);

    const dailyDestroyed = await db
      .select({
        date: sql<string>`DATE(${kiloclaw_instances.destroyed_at})`.as('date'),
        destroyed: sql<number>`COUNT(*)::int`.as('destroyed'),
      })
      .from(kiloclaw_instances)
      .where(
        and(
          isNotNull(kiloclaw_instances.destroyed_at),
          gte(kiloclaw_instances.destroyed_at, startDate.toISOString())
        )
      )
      .groupBy(sql`DATE(${kiloclaw_instances.destroyed_at})`)
      .orderBy(sql`DATE(${kiloclaw_instances.destroyed_at})`);

    // Merge created and destroyed into a single daily series
    const destroyedByDate = new Map(dailyDestroyed.map(d => [d.date, d.destroyed]));
    const createdByDate = new Map(dailyStats.map(d => [d.date, d.created]));

    const allDates = new Set([...createdByDate.keys(), ...destroyedByDate.keys()]);
    const dailyChart = [...allDates].sort().map(date => ({
      date,
      created: createdByDate.get(date) ?? 0,
      destroyed: destroyedByDate.get(date) ?? 0,
    }));

    return {
      overview: {
        totalInstances: overview?.total_instances ?? 0,
        activeInstances: overview?.active_instances ?? 0,
        inactiveTrialStoppedInstances: overview?.inactive_trial_stopped_instances ?? 0,
        suspendedInstances: overview?.suspended_instances ?? 0,
        destroyedInstances: overview?.destroyed_instances ?? 0,
        uniqueUsers: overview?.unique_users ?? 0,
        last24hCreated: last24h?.count ?? 0,
        last7dCreated: last7d?.count ?? 0,
        activeUsers7d: activeUsers7d?.count ?? 0,
        avgLifespanMinutes: lifespan?.avg_lifespan_minutes ?? null,
      },
      dailyChart,
    };
  }),

  volumeSnapshots: adminProcedure
    .input(VolumeSnapshotsSchema)
    .query(async ({ input }): Promise<{ snapshots: VolumeSnapshot[] }> => {
      const fallbackMessage = 'Failed to fetch volume snapshots';
      try {
        const instance = await resolveInstance(input.userId, input.instanceId);
        const client = new KiloClawInternalClient();
        return await client.listVolumeSnapshots(input.userId, workerInstanceId(instance));
      } catch (err) {
        console.error('Failed to fetch volume snapshots for user:', input.userId, err);
        throwKiloclawAdminError(err, fallbackMessage);
      }
    }),

  controllerVersion: adminProcedure.input(GatewayProcessSchema).query(async ({ input }) => {
    const fallbackMessage = 'Failed to fetch controller version';
    try {
      const instance = await resolveInstance(input.userId, input.instanceId);
      const client = new KiloClawInternalClient();
      return await client.getControllerVersion(input.userId, workerInstanceId(instance));
    } catch (err) {
      console.error('Failed to fetch controller version for user:', input.userId, err);
      throwKiloclawAdminError(err, fallbackMessage);
    }
  }),

  gatewayStatus: adminProcedure.input(GatewayProcessSchema).query(async ({ input }) => {
    const fallbackMessage = 'Failed to fetch gateway status';
    try {
      const instance = await resolveInstance(input.userId, input.instanceId);
      const client = new KiloClawInternalClient();
      return await client.getGatewayStatus(input.userId, workerInstanceId(instance));
    } catch (err) {
      console.error('Failed to fetch gateway status for user:', input.userId, err);
      throwKiloclawAdminError(err, fallbackMessage, {
        statusCodeOverrides: { 409: 'NOT_FOUND' },
        messageOverrides: {
          404: 'Gateway control unavailable',
          409: 'Gateway control unavailable',
        },
      });
    }
  }),

  gatewayStart: adminProcedure.input(GatewayProcessSchema).mutation(async ({ input }) => {
    const fallbackMessage = 'Failed to start gateway';
    try {
      const instance = await resolveInstance(input.userId, input.instanceId);
      const client = new KiloClawInternalClient();
      return await client.startGateway(input.userId, workerInstanceId(instance));
    } catch (err) {
      console.error('Failed to start gateway for user:', input.userId, err);
      throwKiloclawAdminError(err, fallbackMessage);
    }
  }),

  gatewayStop: adminProcedure.input(GatewayProcessSchema).mutation(async ({ input }) => {
    const fallbackMessage = 'Failed to stop gateway';
    try {
      const instance = await resolveInstance(input.userId, input.instanceId);
      const client = new KiloClawInternalClient();
      return await client.stopGateway(input.userId, workerInstanceId(instance));
    } catch (err) {
      console.error('Failed to stop gateway for user:', input.userId, err);
      throwKiloclawAdminError(err, fallbackMessage);
    }
  }),

  gatewayRestart: adminProcedure.input(GatewayProcessSchema).mutation(async ({ input }) => {
    const fallbackMessage = 'Failed to restart gateway';
    try {
      const instance = await resolveInstance(input.userId, input.instanceId);
      const client = new KiloClawInternalClient();
      return await client.restartGatewayProcess(input.userId, workerInstanceId(instance));
    } catch (err) {
      console.error('Failed to restart gateway for user:', input.userId, err);
      throwKiloclawAdminError(err, fallbackMessage);
    }
  }),

  runDoctor: adminProcedure.input(GatewayProcessSchema).mutation(async ({ input }) => {
    const fallbackMessage = 'Failed to run doctor';
    try {
      const instance = await resolveInstance(input.userId, input.instanceId);
      const client = new KiloClawInternalClient();
      return await client.runDoctor(input.userId, workerInstanceId(instance));
    } catch (err) {
      console.error('Failed to run doctor for user:', input.userId, err);
      throwKiloclawAdminError(err, fallbackMessage);
    }
  }),

  startDoctorViaController: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        instanceId: z.string().uuid().optional(),
        fix: z.boolean().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const fallbackMessage = 'Failed to start doctor (controller)';
      try {
        const instance = await resolveInstance(input.userId, input.instanceId);
        assertInstanceBelongsToUser(instance, input.userId);
        const client = new KiloClawInternalClient();
        return await client.startDoctorViaController(
          input.userId,
          input.fix ?? true,
          workerInstanceId(instance)
        );
      } catch (err) {
        console.error('Failed to start doctor (controller) for user:', input.userId, err);
        throwKiloclawAdminError(err, fallbackMessage);
      }
    }),

  doctorViaControllerStatus: adminProcedure.input(GatewayProcessSchema).query(async ({ input }) => {
    const fallbackMessage = 'Failed to fetch doctor status (controller)';
    try {
      const instance = await resolveInstance(input.userId, input.instanceId);
      assertInstanceBelongsToUser(instance, input.userId);
      const client = new KiloClawInternalClient();
      return await client.getDoctorViaControllerStatus(input.userId, workerInstanceId(instance));
    } catch (err) {
      console.error('Failed to fetch doctor status (controller) for user:', input.userId, err);
      throwKiloclawAdminError(err, fallbackMessage);
    }
  }),

  cancelDoctorViaController: adminProcedure
    .input(GatewayProcessSchema)
    .mutation(async ({ input }) => {
      const fallbackMessage = 'Failed to cancel doctor (controller)';
      try {
        const instance = await resolveInstance(input.userId, input.instanceId);
        assertInstanceBelongsToUser(instance, input.userId);
        const client = new KiloClawInternalClient();
        return await client.cancelDoctorViaController(input.userId, workerInstanceId(instance));
      } catch (err) {
        console.error('Failed to cancel doctor (controller) for user:', input.userId, err);
        throwKiloclawAdminError(err, fallbackMessage);
      }
    }),

  startKiloCliRun: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        instanceId: z.string().uuid().optional(),
        prompt: z.string().min(1).max(10_000),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const fallbackMessage = 'Failed to start kilo CLI run';
      try {
        const instance = await resolveInstance(input.userId, input.instanceId);
        assertInstanceBelongsToUser(instance, input.userId);
        const client = new KiloClawInternalClient();
        const result = await client.startKiloCliRun(
          input.userId,
          input.prompt,
          workerInstanceId(instance)
        );

        const runId = await createCliRun({
          userId: input.userId,
          instanceId: instance.id,
          prompt: input.prompt,
          startedAt: result.startedAt,
          initiatedByAdminId: ctx.user.id,
        });

        try {
          await createKiloClawAdminAuditLog({
            action: 'kiloclaw.cli_run.start',
            actor_id: ctx.user.id,
            actor_email: ctx.user.google_user_email,
            actor_name: ctx.user.google_user_name,
            target_user_id: input.userId,
            message: `CLI run started on instance ${instance.id}`,
            metadata: {
              runId,
              instanceId: instance.id,
              promptLength: input.prompt.length,
            },
          });
        } catch (auditErr) {
          console.error('Failed to write audit log for startKiloCliRun:', auditErr);
        }

        return { ...result, id: runId };
      } catch (err) {
        console.error('Failed to start kilo CLI run for user:', input.userId, err);
        throwKiloclawAdminError(err, fallbackMessage);
      }
    }),

  getKiloCliRunStatus: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        instanceId: z.uuid().optional(),
        runId: z.uuid(),
      })
    )
    .query(async ({ input }) => {
      const fallbackMessage = 'Failed to get kilo CLI run status';
      try {
        const instance = input.instanceId
          ? await getInstanceById(input.instanceId)
          : await getActiveInstance(input.userId);
        if (instance) {
          assertInstanceBelongsToUser(instance, input.userId);
        }

        return getCliRunStatus({
          runId: input.runId,
          userId: input.userId,
          instanceId: instance?.id ?? null,
          workerInstanceId: workerInstanceId(instance),
        });
      } catch (err) {
        console.error('Failed to get kilo CLI run status for user:', input.userId, err);
        throwKiloclawAdminError(err, fallbackMessage);
      }
    }),

  cancelKiloCliRun: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        instanceId: z.uuid().optional(),
        runId: z.uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const fallbackMessage = 'Failed to cancel kilo CLI run';
      try {
        const instance = input.instanceId
          ? await getInstanceById(input.instanceId)
          : await getActiveInstance(input.userId);
        if (instance) {
          assertInstanceBelongsToUser(instance, input.userId);
        }
        const result = await cancelCliRun({
          runId: input.runId,
          userId: input.userId,
          instanceId: instance?.id ?? null,
          workerInstanceId: workerInstanceId(instance),
        });

        if (!result.runFound) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'CLI run not found' });
        }

        if (result.cancelled) {
          try {
            await createKiloClawAdminAuditLog({
              action: 'kiloclaw.cli_run.cancel',
              actor_id: ctx.user.id,
              actor_email: ctx.user.google_user_email,
              actor_name: ctx.user.google_user_name,
              target_user_id: input.userId,
              message: 'CLI run cancelled',
              metadata: {
                instanceId: result.instanceId,
                requestedInstanceId: input.instanceId ?? null,
                usedFallback: !instance,
                runId: input.runId,
              },
            });
          } catch (auditErr) {
            console.error('Failed to write audit log for cancelKiloCliRun:', auditErr);
          }
        }

        return { ok: result.ok };
      } catch (err) {
        console.error('Failed to cancel kilo CLI run for user:', input.userId, err);
        throwKiloclawAdminError(err, fallbackMessage);
      }
    }),

  listKiloCliRuns: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        instanceId: z.uuid().optional(),
        limit: z.number().min(1).max(50).default(20),
      })
    )
    .query(async ({ input }) => {
      const conditions: SQL[] = [eq(kiloclaw_cli_runs.user_id, input.userId)];

      if (input.instanceId) {
        conditions.push(eq(kiloclaw_cli_runs.instance_id, input.instanceId));
      }

      const runs = await db
        .select()
        .from(kiloclaw_cli_runs)
        .where(and(...conditions))
        .orderBy(desc(kiloclaw_cli_runs.started_at))
        .limit(input.limit);

      return { runs };
    }),

  listAllCliRuns: adminProcedure
    .input(
      z.object({
        offset: z.number().min(0).default(0),
        limit: z.number().min(1).max(100).default(25),
        search: z.string().optional(),
        status: z.enum(['all', 'running', 'completed', 'failed', 'cancelled']).default('all'),
        initiatedBy: z.enum(['all', 'admin', 'user']).default('all'),
      })
    )
    .query(async ({ input }) => {
      const { offset, limit, search, status, initiatedBy } = input;
      const conditions: SQL[] = [];

      if (status !== 'all') {
        conditions.push(eq(kiloclaw_cli_runs.status, status));
      }

      if (initiatedBy !== 'all') {
        conditions.push(
          initiatedBy === 'admin'
            ? isNotNull(kiloclaw_cli_runs.initiated_by_admin_id)
            : isNull(kiloclaw_cli_runs.initiated_by_admin_id)
        );
      }

      const searchTerm = search?.trim();
      if (searchTerm) {
        const escaped = searchTerm.replace(/[%_\\]/g, '\\$&');
        const pattern = `%${escaped}%`;
        const searchCond = or(
          ilike(kilocode_users.google_user_email, pattern),
          ilike(kiloclaw_cli_runs.prompt, pattern),
          ilike(sql`${kiloclaw_cli_runs.instance_id}::text`, pattern)
        );
        if (searchCond) conditions.push(searchCond);
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [rows, countResult] = await Promise.all([
        db
          .select({
            id: kiloclaw_cli_runs.id,
            user_id: kiloclaw_cli_runs.user_id,
            user_email: kilocode_users.google_user_email,
            instance_id: kiloclaw_cli_runs.instance_id,
            initiated_by_admin_id: kiloclaw_cli_runs.initiated_by_admin_id,
            initiated_by_admin_email: initiatingAdminUsers.google_user_email,
            prompt: kiloclaw_cli_runs.prompt,
            status: kiloclaw_cli_runs.status,
            exit_code: kiloclaw_cli_runs.exit_code,
            started_at: kiloclaw_cli_runs.started_at,
            completed_at: kiloclaw_cli_runs.completed_at,
          })
          .from(kiloclaw_cli_runs)
          .leftJoin(kilocode_users, eq(kiloclaw_cli_runs.user_id, kilocode_users.id))
          .leftJoin(
            initiatingAdminUsers,
            eq(kiloclaw_cli_runs.initiated_by_admin_id, initiatingAdminUsers.id)
          )
          .where(where)
          .orderBy(desc(kiloclaw_cli_runs.started_at))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`COUNT(*)::int` })
          .from(kiloclaw_cli_runs)
          .leftJoin(kilocode_users, eq(kiloclaw_cli_runs.user_id, kilocode_users.id))
          .where(where),
      ]);

      const total = countResult[0]?.count ?? 0;

      return {
        runs: rows,
        pagination: { offset, limit, total, totalPages: Math.ceil(total / limit) },
      };
    }),

  getCliRunOutput: adminProcedure
    .input(z.object({ userId: z.string().min(1), runId: z.uuid() }))
    .query(async ({ input }) => {
      const [row] = await db
        .select({ output: kiloclaw_cli_runs.output })
        .from(kiloclaw_cli_runs)
        .where(
          and(eq(kiloclaw_cli_runs.id, input.runId), eq(kiloclaw_cli_runs.user_id, input.userId))
        )
        .limit(1);

      return { output: row?.output ?? null };
    }),

  restoreConfig: adminProcedure.input(GatewayProcessSchema).mutation(async ({ input }) => {
    const fallbackMessage = 'Failed to restore config';
    try {
      const instance = await resolveInstance(input.userId, input.instanceId);
      const client = new KiloClawInternalClient();
      return await client.restoreConfig(input.userId, undefined, workerInstanceId(instance));
    } catch (err) {
      console.error('Failed to restore config for user:', input.userId, err);
      throwKiloclawAdminError(err, fallbackMessage);
    }
  }),

  fileTree: adminProcedure
    .input(z.object({ userId: z.string().min(1), instanceId: z.string().uuid().optional() }))
    .query(async ({ input }) => {
      try {
        const instance = await resolveInstance(input.userId, input.instanceId);
        const client = new KiloClawInternalClient();
        const result = await client.getFileTree(input.userId, workerInstanceId(instance));
        return result.tree;
      } catch (err) {
        throwKiloclawAdminError(err, 'Failed to fetch file tree');
      }
    }),

  readFile: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        instanceId: z.string().uuid().optional(),
        path: z.string().min(1),
      })
    )
    .query(async ({ input }) => {
      try {
        const instance = await resolveInstance(input.userId, input.instanceId);
        const client = new KiloClawInternalClient();
        return await client.readFile(input.userId, input.path, workerInstanceId(instance));
      } catch (err) {
        throwKiloclawAdminError(err, 'Failed to read file');
      }
    }),

  writeFile: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        instanceId: z.string().uuid().optional(),
        path: z.string().min(1),
        content: z.string(),
        etag: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      try {
        const instance = await resolveInstance(input.userId, input.instanceId);
        const client = new KiloClawInternalClient();
        return await client.writeFile(
          input.userId,
          input.path,
          input.content,
          input.etag,
          workerInstanceId(instance)
        );
      } catch (err) {
        // Propagate file_etag_conflict with UpstreamApiError so the UI can detect it
        if (err instanceof KiloClawApiError && err.statusCode === 409) {
          const parsed = JSON.parse(err.responseBody || '{}') as { code?: string; error?: string };
          if (parsed.code === 'file_etag_conflict') {
            throw new TRPCError({
              code: 'CONFLICT',
              message: parsed.error ?? 'File was modified externally',
              cause: new UpstreamApiError('file_etag_conflict'),
            });
          }
        }
        throwKiloclawAdminError(err, 'Failed to write file');
      }
    }),

  machineStart: adminProcedure.input(GatewayProcessSchema).mutation(async ({ input }) => {
    const fallbackMessage = 'Failed to start machine';
    try {
      const instance = await resolveInstance(input.userId, input.instanceId);
      const client = new KiloClawInternalClient();
      const result = await client.start(input.userId, workerInstanceId(instance), {
        skipCooldown: true,
        reason: 'admin_request',
      });
      if (instance && result.currentStatus === 'running') {
        try {
          await clearTrialInactivityStopAfterStart({
            kiloUserId: input.userId,
            instanceId: instance.id,
          });
        } catch (error) {
          console.error('Failed to clear trial inactivity stop marker after admin start:', error);
        }
      }
      return result;
    } catch (err) {
      console.error('Failed to start machine for user:', input.userId, err);
      throwKiloclawAdminError(err, fallbackMessage);
    }
  }),

  forceRetryRecovery: adminProcedure.input(GatewayProcessSchema).mutation(async ({ input }) => {
    const fallbackMessage = 'Failed to retry recovery';
    try {
      const instance = await resolveInstance(input.userId, input.instanceId);
      const client = new KiloClawInternalClient();
      return await client.forceRetryRecovery(input.userId, workerInstanceId(instance));
    } catch (err) {
      console.error('Failed to retry recovery for user:', input.userId, err);
      throwKiloclawAdminError(err, fallbackMessage);
    }
  }),

  cleanupRecoveryPreviousVolume: adminProcedure
    .input(GatewayProcessSchema)
    .mutation(async ({ input, ctx }) => {
      const fallbackMessage = 'Failed to clean up retained recovery volume';
      try {
        const instance = await resolveInstance(input.userId, input.instanceId);
        const client = new KiloClawInternalClient();
        const result = await client.cleanupRecoveryPreviousVolume(
          input.userId,
          workerInstanceId(instance)
        );

        if (result.deletedVolumeId) {
          try {
            await createKiloClawAdminAuditLog({
              action: 'kiloclaw.recovery.cleanup_retained_volume',
              actor_id: ctx.user.id,
              actor_email: ctx.user.google_user_email,
              actor_name: ctx.user.google_user_name,
              target_user_id: input.userId,
              message: `Retained recovery volume deleted: ${result.deletedVolumeId}`,
              metadata: {
                deletedVolumeId: result.deletedVolumeId,
              },
            });
          } catch (auditErr) {
            console.error('Failed to write audit log for cleanupRecoveryPreviousVolume:', auditErr);
          }
        }

        return result;
      } catch (err) {
        console.error('Failed to clean up retained recovery volume for user:', input.userId, err);
        throwKiloclawAdminError(err, fallbackMessage);
      }
    }),

  machineStop: adminProcedure.input(GatewayProcessSchema).mutation(async ({ input }) => {
    const fallbackMessage = 'Failed to stop machine';
    try {
      const instance = await resolveInstance(input.userId, input.instanceId);
      const client = new KiloClawInternalClient();
      return await client.stop(input.userId, workerInstanceId(instance), {
        reason: 'admin_request',
      });
    } catch (err) {
      console.error('Failed to stop machine for user:', input.userId, err);
      throwKiloclawAdminError(err, fallbackMessage);
    }
  }),

  restartMachine: adminProcedure
    .input(
      z.object({
        instanceId: z.string().uuid(),
        imageTag: z
          .string()
          .max(128, 'Image tag too long')
          .regex(
            /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
            'Image tag must be alphanumeric with dots, hyphens, or underscores'
          )
          .optional(),
        // When true, the admin has confirmed they are intentionally
        // overriding any pin set on the instance (user-set or admin-set).
        // The override deletes the pin row before redeploying. No
        // replacement pin is written so the user retains the ability to
        // re-pin afterward (Decision: encourage adoption of new releases).
        acknowledgeOverride: z.boolean().default(false),
      })
    )
    .mutation(async ({ input }) => {
      const [row] = await db
        .select({
          user: kilocode_users,
          instance: {
            id: kiloclaw_instances.id,
            sandbox_id: kiloclaw_instances.sandbox_id,
          },
        })
        .from(kiloclaw_instances)
        .innerJoin(kilocode_users, eq(kiloclaw_instances.user_id, kilocode_users.id))
        .where(eq(kiloclaw_instances.id, input.instanceId))
        .limit(1);

      if (!row) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Instance not found' });
      }

      // Pin consent gate: an admin redeploy with a specific imageTag
      // (whether forward-upgrading, downgrading, or switching variants)
      // overrides whatever pin is currently set on the instance. The DO
      // does not consult the pin table on restart, so the gate lives at
      // the web layer where authorization context exists. See the
      // personal kiloclaw-router for the residual concurrency note: a
      // pin written between this SELECT and the worker call is not
      // consulted by the worker on restart, by design.
      if (input.imageTag) {
        const [pin] = await db
          .select({
            id: kiloclaw_version_pins.id,
            image_tag: kiloclaw_version_pins.image_tag,
            pinned_by: kiloclaw_version_pins.pinned_by,
            updated_at: kiloclaw_version_pins.updated_at,
          })
          .from(kiloclaw_version_pins)
          .where(eq(kiloclaw_version_pins.instance_id, input.instanceId))
          .limit(1);

        if (pin && !input.acknowledgeOverride) {
          // Frontend uses its existing getUserPin query for pin details
          // (current tag, set by user vs admin) to render the override
          // confirmation dialog. Re-call with acknowledgeOverride: true
          // proceeds.
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'PIN_EXISTS',
          });
        }

        if (pin) {
          // Conditional delete tied to both the row id and the updated_at
          // we observed. setMyPin uses onConflictDoUpdate which keeps the
          // same row id but bumps updated_at, so checking id alone would
          // miss in-place edits. Pinning updated_at catches both
          // replacement (different id) and update (same id, newer
          // updated_at). Empty returning() means the row changed.
          // Admin override deletes any pin (user-set or admin-set). No
          // replacement pin written — once the consent gate has been
          // spent, the user is free to re-establish their own pin.
          const deleted = await db
            .delete(kiloclaw_version_pins)
            .where(
              and(
                eq(kiloclaw_version_pins.instance_id, input.instanceId),
                eq(kiloclaw_version_pins.id, pin.id),
                eq(kiloclaw_version_pins.updated_at, pin.updated_at)
              )
            )
            .returning({ id: kiloclaw_version_pins.id });

          if (deleted.length === 0) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'PIN_EXISTS',
            });
          }

          // Sync the cleared pin into DO state. The follow-up restartMachine
          // call overwrites trackedImageTag anyway, but pushing the clear
          // keeps DB and DO state consistent if the restart fails after
          // this point. Mirrors the removeMyPin / removePin pattern.
          // Failures are logged inside pushPinToWorker.
          await pushPinToWorker(row.user.id, input.instanceId, null);
        }
      }

      const token = generateApiToken(row.user, undefined, { expiresIn: TOKEN_EXPIRY.fiveMinutes });
      const client = new KiloClawUserClient(token);
      const fallbackMessage = 'Failed to restart machine';
      try {
        return await client.restartMachine(
          input.imageTag ? { imageTag: input.imageTag } : undefined,
          { userId: row.user.id, instanceId: workerInstanceId(row.instance) }
        );
      } catch (err) {
        console.error('Failed to restart machine for user:', row.user.id, err);
        throwKiloclawAdminError(err, fallbackMessage);
      }
    }),

  /**
   * Apply a version change across many instances in one call. Thin partition +
   * concurrency layer over the same primitive `restartMachine` uses
   * (pin-clear + worker restart). Synchronous: returns when every instance has
   * been processed.
   *
   * Partition order matters — an instance with multiple disqualifying
   * conditions reports the most actionable reason. `destroyed` outranks
   * `pinned_*`, `pinned_*` outranks `already_on_target`.
   */
  bulkChangeVersion: adminProcedure
    .input(
      z.object({
        // Practical limit: the UI only allows per-page selection, so 500
        // leaves ample headroom while keeping the inArray clause performant.
        // If a future "select all across pages" feature lands, revisit.
        instanceIds: z.array(z.string().uuid()).min(1).max(500),
        imageTag: z
          .string()
          .min(1)
          .max(128, 'Image tag too long')
          .regex(
            /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
            'Image tag must be alphanumeric with dots, hyphens, or underscores'
          ),
        // When true, deletes any existing pin (user-set OR admin-set) before
        // restarting. Same semantics as restartMachine.acknowledgeOverride —
        // single toggle covers both pin types per Phase 1.5 Decision #5.
        overridePins: z.boolean().default(false),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // 1. Validate target tag in catalog. Worker would happily redeploy a
      // disabled tag, so the explicit guard lives here.
      const [catalogEntry] = await db
        .select({
          image_tag: kiloclaw_image_catalog.image_tag,
          status: kiloclaw_image_catalog.status,
        })
        .from(kiloclaw_image_catalog)
        .where(eq(kiloclaw_image_catalog.image_tag, input.imageTag))
        .limit(1);

      if (!catalogEntry) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Target image tag not found in catalog: ${input.imageTag}`,
        });
      }
      if (catalogEntry.status === 'disabled') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Target image tag is disabled: ${input.imageTag}`,
        });
      }

      // 2. One SELECT to gather instance + pin + admin-status per id.
      // is_admin lives on kilocode_users — there is no separate admin_users
      // table.
      const rows = await db
        .select({
          instance_id: kiloclaw_instances.id,
          user_id: kiloclaw_instances.user_id,
          sandbox_id: kiloclaw_instances.sandbox_id,
          destroyed_at: kiloclaw_instances.destroyed_at,
          tracked_image_tag: kiloclaw_instances.tracked_image_tag,
          pin_id: kiloclaw_version_pins.id,
          pin_pinned_by: kiloclaw_version_pins.pinned_by,
          pin_updated_at: kiloclaw_version_pins.updated_at,
          pin_pinned_by_is_admin: pinnedByUsers.is_admin,
        })
        .from(kiloclaw_instances)
        .leftJoin(
          kiloclaw_version_pins,
          eq(kiloclaw_version_pins.instance_id, kiloclaw_instances.id)
        )
        .leftJoin(pinnedByUsers, eq(pinnedByUsers.id, kiloclaw_version_pins.pinned_by))
        .where(inArray(kiloclaw_instances.id, input.instanceIds));

      // Look up owning users in one shot — generateApiToken needs a full
      // kilocode_users row. Map by id for O(1) lookup in the apply loop.
      const ownerUserIds = Array.from(new Set(rows.map(r => r.user_id)));
      const ownerUsers =
        ownerUserIds.length > 0
          ? await db.select().from(kilocode_users).where(inArray(kilocode_users.id, ownerUserIds))
          : [];
      const ownerUserById = new Map(ownerUsers.map(u => [u.id, u]));

      // 3. Partition. Order: destroyed → pinned_by_admin → pinned_by_user →
      // already_on_target → apply.
      type ApplyTarget = (typeof rows)[number] & { ownerUserRecord: (typeof ownerUsers)[number] };
      type SkipReason =
        | 'destroyed'
        | 'pinned_by_user'
        | 'pinned_by_admin'
        | 'already_on_target'
        | 'pin_changed_in_flight';

      type ApplyOutcome = { status: 'applied' } | { status: 'skipped'; reason: SkipReason };

      const applied: string[] = [];
      const skipped: Array<{ instanceId: string; reason: SkipReason }> = [];
      const failed: Array<{ instanceId: string; error: string }> = [];
      const applyQueue: ApplyTarget[] = [];

      // Track which input ids matched a row — anything missing surfaces in
      // failed[{ error: 'not_found' }].
      const seenIds = new Set(rows.map(r => r.instance_id));
      for (const id of input.instanceIds) {
        if (!seenIds.has(id)) {
          failed.push({ instanceId: id, error: 'not_found' });
        }
      }

      for (const row of rows) {
        if (row.destroyed_at) {
          skipped.push({ instanceId: row.instance_id, reason: 'destroyed' });
          continue;
        }
        if (row.pin_id && !input.overridePins) {
          skipped.push({
            instanceId: row.instance_id,
            reason: row.pin_pinned_by_is_admin ? 'pinned_by_admin' : 'pinned_by_user',
          });
          continue;
        }
        if (row.tracked_image_tag === input.imageTag) {
          skipped.push({ instanceId: row.instance_id, reason: 'already_on_target' });
          continue;
        }
        const ownerUserRecord = ownerUserById.get(row.user_id);
        if (!ownerUserRecord) {
          failed.push({
            instanceId: row.instance_id,
            error: 'owner user not found',
          });
          continue;
        }
        applyQueue.push({ ...row, ownerUserRecord });
      }

      // 4. Apply with bounded concurrency. Manual chunking matches the
      // detectOrphans pattern already in this router.
      const CONCURRENCY = 10;

      const applyOne = async (target: ApplyTarget): Promise<ApplyOutcome> => {
        if (target.pin_id && input.overridePins) {
          // Atomic delete tied to id + updated_at — same three-predicate
          // guard restartMachine uses. Catches both replacement (different
          // id) and in-place updates (same id, newer updated_at).
          const deleted = await db
            .delete(kiloclaw_version_pins)
            .where(
              and(
                eq(kiloclaw_version_pins.instance_id, target.instance_id),
                eq(kiloclaw_version_pins.id, target.pin_id),
                target.pin_updated_at
                  ? eq(kiloclaw_version_pins.updated_at, target.pin_updated_at)
                  : isNull(kiloclaw_version_pins.updated_at)
              )
            )
            .returning({ id: kiloclaw_version_pins.id });

          // CAS miss: a new pin row was written between the partition
          // SELECT and this delete (the user replaced or updated their
          // pin). Skip rather than override the user's fresh write.
          // Surfacing as `pin_changed_in_flight` keeps DB pin and DO
          // state aligned and lets the admin re-run with the now-current
          // pin information visible in the table.
          if (deleted.length === 0) {
            return { status: 'skipped', reason: 'pin_changed_in_flight' };
          }
          await pushPinToWorker(target.user_id, target.instance_id, null);
        }

        const token = generateApiToken(target.ownerUserRecord, undefined, {
          expiresIn: TOKEN_EXPIRY.fiveMinutes,
        });
        const client = new KiloClawUserClient(token);
        await client.restartMachine(
          { imageTag: input.imageTag },
          {
            userId: target.user_id,
            instanceId: workerInstanceId({
              id: target.instance_id,
              sandbox_id: target.sandbox_id,
            }),
          }
        );
        return { status: 'applied' };
      };

      for (let i = 0; i < applyQueue.length; i += CONCURRENCY) {
        const batch = applyQueue.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(batch.map(applyOne));
        for (let j = 0; j < batch.length; j += 1) {
          const target = batch[j];
          const r = results[j];
          if (r.status === 'fulfilled') {
            if (r.value.status === 'applied') {
              applied.push(target.instance_id);
            } else {
              skipped.push({ instanceId: target.instance_id, reason: r.value.reason });
            }
          } else {
            const err = r.reason;
            const message =
              err instanceof KiloClawApiError
                ? getKiloclawApiErrorPayload(err, 'restart failed').message
                : err instanceof Error
                  ? err.message
                  : 'restart failed';
            failed.push({ instanceId: target.instance_id, error: message });
          }
        }
      }

      // Audit log: bulk version changes can touch up to 500 user instances
      // and override pins. Record the action for accountability. The audit
      // log uses target_user_id = ctx.user.id (the actor) since the
      // schema column is non-null and this is a multi-user action; the
      // applied/skipped/failed instance ids land in metadata. Fire-and-
      // forget pattern matches the rest of this router.
      try {
        await createKiloClawAdminAuditLog({
          action: 'kiloclaw.instances.bulk_change_version',
          actor_id: ctx.user.id,
          actor_email: ctx.user.google_user_email,
          actor_name: ctx.user.google_user_name,
          target_user_id: ctx.user.id,
          message: `Bulk version change: tag=${input.imageTag} overridePins=${input.overridePins} applied=${applied.length} skipped=${skipped.length} failed=${failed.length}`,
          metadata: {
            imageTag: input.imageTag,
            overridePins: input.overridePins,
            requestedInstanceIds: input.instanceIds,
            appliedInstanceIds: applied,
            skipped,
            failed,
          },
        });
      } catch (auditErr) {
        console.error('Failed to write audit log for bulkChangeVersion:', auditErr);
      }

      return { applied, skipped, failed };
    }),

  /**
   * Schedule an admin action against a single instance to fire at a
   * future time.
   *
   * PR 1: only `actionType='scheduled_restart'` is implemented. The
   * input shape is structured as a discriminated union so future action
   * types (`version_change` in PR 3) slot in without breaking callers.
   *
   * Notice config (lead hours, subject, body) is collected here even
   * though PR 1 doesn't dispatch notifications — PR 2 lights up the
   * notification fan-out using these fields.
   */
  scheduleAction: adminProcedure
    .input(
      z.discriminatedUnion('actionType', [
        z.object({
          actionType: z.literal('scheduled_restart'),
          // One parent + one stage + N targets per call. min(1) keeps the
          // shape consistent for single-instance UIs (which pass an array
          // of length 1). Cap mirrors bulkChangeVersion's batch ceiling.
          instanceIds: z.array(z.string().uuid()).min(1).max(500),
          // Must be in the future. Loose lower bound (>= now() + 1 min)
          // is enforced in the procedure body since Zod can't compare to
          // wall-clock time.
          scheduledAt: z.string().datetime(),
          reason: z.string().max(256).optional(),
          // Notice config. notify defaults true — admin must explicitly
          // opt out (uncommon: dev/internal instances with no real user).
          // When notify=false we skip all notification row inserts and
          // the action fires silently.
          notify: z.boolean().default(true),
          // How far ahead of scheduled_at to dispatch the notice. The
          // sweep selects pending notifications where now() >= stage.scheduled_at - lead_hours.
          // Range matches the parent column constraint.
          noticeLeadHours: z.number().int().min(0).max(168).default(24),
          noticeSubject: z.string().max(120).default(''),
          noticeBody: z.string().max(2000).default(''),
          // Channels default to all available. Admin can narrow at
          // schedule time. 'agent' is excluded from the v1 enum here —
          // the dispatcher would 501 anyway and we want admins to know
          // it's not yet supported.
          //
          // min(1) is enforced even when notify=false: callers that
          // want "no notifications" should set notify:false and let
          // the default fill the array, rather than passing []. The
          // backend ignores channels entirely when notify=false (the
          // notification-row insert is gated on notify), so the
          // constraint never affects runtime behavior — it just keeps
          // the validator simple and rejects accidentally-empty
          // arrays from API callers who DID intend notify:true.
          noticeChannels: z
            .array(z.enum(['email', 'webapp', 'mobile_push']))
            .min(1)
            .default(['email', 'webapp', 'mobile_push']),
        }),
        z.object({
          actionType: z.literal('version_change'),
          instanceIds: z.array(z.string().uuid()).min(1).max(500),
          // The image_tag the worker should redeploy on at the scheduled
          // time. Must exist in kiloclaw_image_catalog with status='available'
          // (validated in the procedure body, mirrors bulkChangeVersion).
          imageTag: z
            .string()
            .min(1)
            .max(128)
            .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
          // Whether to delete an existing pin row at apply time. Same
          // semantics as bulkChangeVersion.overridePins. Without this,
          // a pinned instance is recorded as skipped:pinned at apply.
          overridePins: z.boolean().default(false),
          scheduledAt: z.string().datetime(),
          reason: z.string().max(256).optional(),
          notify: z.boolean().default(true),
          noticeLeadHours: z.number().int().min(0).max(168).default(24),
          noticeSubject: z.string().max(120).default(''),
          noticeBody: z.string().max(2000).default(''),
          noticeChannels: z
            .array(z.enum(['email', 'webapp', 'mobile_push']))
            .min(1)
            .default(['email', 'webapp', 'mobile_push']),
        }),
      ])
    )
    .mutation(async ({ input, ctx }) => {
      // Validate scheduledAt > now() + 1 minute so admins can't
      // accidentally schedule something that fires immediately.
      assertScheduledTimeInFuture(input.scheduledAt, 'scheduledAt');

      // For version_change, validate the target image tag matches the
      // catalog rules bulkChangeVersion uses (must exist + status='available').
      // We do this BEFORE inserting any rows so a bad tag fails fast.
      if (input.actionType === 'version_change') {
        await validateAvailableImageTag(input.imageTag);
      }

      // Dedupe instance ids — duplicate target rows would violate
      // UQ_kiloclaw_scheduled_action_targets_parent_instance.
      const uniqueInstanceIds = Array.from(new Set(input.instanceIds));

      // Resolve all instances + owners in one query so we can stamp
      // source_image_tag and user_id per target.
      const instanceRows = await db
        .select({
          instance: kiloclaw_instances,
          owner_id: kilocode_users.id,
        })
        .from(kiloclaw_instances)
        .innerJoin(kilocode_users, eq(kiloclaw_instances.user_id, kilocode_users.id))
        .where(inArray(kiloclaw_instances.id, uniqueInstanceIds));

      const resolvedById = new Map(instanceRows.map(r => [r.instance.id, r]));
      const missing = uniqueInstanceIds.filter(id => !resolvedById.has(id));
      if (missing.length > 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Instance not found: ${missing.join(', ')}`,
        });
      }

      // Silently drop destroyed instances. Mirrors bulkChangeVersion's
      // partition shape (destroyed surfaces as `skipped:destroyed` in
      // its result), but for the schedule path we just filter — there's
      // no apply-time partition until the action fires. The bulk dialog
      // already shows the destroyed count in its summary panel so the
      // admin sees what's being filtered. If every instance is destroyed
      // we have nothing to schedule; reject with a clear message.
      const liveInstanceRows = instanceRows.filter(r => !r.instance.destroyed_at);
      if (liveInstanceRows.length === 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'All target instances are destroyed; nothing to schedule',
        });
      }
      const liveInstanceIds = liveInstanceRows.map(r => r.instance.id);
      const liveResolvedById = new Map(liveInstanceRows.map(r => [r.instance.id, r]));

      // version_change-specific parent/target columns. Null for other action types.
      const parentTargetImageTag = input.actionType === 'version_change' ? input.imageTag : null;
      const parentOverridePins = input.actionType === 'version_change' ? input.overridePins : false;

      // Conflict check + parent/stage/target inserts run in one
      // SERIALIZABLE transaction. Without serialization, two concurrent
      // schedule requests on the same instance can both observe "no
      // pending" outside any transaction and then both insert separate
      // scheduled actions, violating the one-pending-action-per-instance
      // invariant.
      const result = await createScheduledActionRows({
        actionType: input.actionType,
        targetImageTag: parentTargetImageTag,
        overridePins: parentOverridePins,
        noticeLeadHours: input.noticeLeadHours,
        noticeSubject: input.noticeSubject,
        noticeBody: input.noticeBody,
        reason: input.reason ?? null,
        createdBy: ctx.user.id,
        stages: [{ stageIndex: 0, scheduledAt: input.scheduledAt }],
        targets: liveInstanceRows.map(row => ({ ...row, stageIndex: 0 })),
        notify: input.notify,
        noticeChannels: input.noticeChannels,
      });

      // Audit log fire-and-forget. Multi-user actions still use the
      // actor's id as the target_user_id sentinel since the column is
      // notNull; the actual targeted instances are in metadata.
      try {
        const messageDetail =
          input.actionType === 'version_change'
            ? `version_change → ${input.imageTag}${input.overridePins ? ' (override_pins=true)' : ''}`
            : 'scheduled_restart';
        const countLabel =
          liveInstanceIds.length === 1
            ? `instance ${liveInstanceIds[0]}`
            : `${liveInstanceIds.length} instances`;
        // Surface the silent-filter in metadata so an audit reader can
        // see what was dropped.
        const filteredDestroyed = uniqueInstanceIds.filter(id => !liveResolvedById.has(id));
        await createKiloClawAdminAuditLog({
          action: 'kiloclaw.scheduled_action.created',
          actor_id: ctx.user.id,
          actor_email: ctx.user.google_user_email,
          actor_name: ctx.user.google_user_name,
          // target_user_id is notNull. For single-instance use the owner;
          // for bulk fall back to the actor (sentinel — real owners are
          // in metadata.instanceIds).
          target_user_id:
            liveInstanceIds.length === 1
              ? (liveResolvedById.get(liveInstanceIds[0])?.owner_id ?? ctx.user.id)
              : ctx.user.id,
          message: `Scheduled ${messageDetail} for ${countLabel} at ${input.scheduledAt}`,
          metadata: {
            scheduledActionId: result.id,
            actionType: input.actionType,
            instanceIds: liveInstanceIds,
            ...(filteredDestroyed.length > 0
              ? { filteredDestroyedInstanceIds: filteredDestroyed }
              : {}),
            scheduledAt: input.scheduledAt,
            reason: input.reason ?? null,
            // Action-type-specific metadata. For version_change we also
            // capture each instance's tracked tag at schedule time so
            // the audit trail records the from→to per instance, even if
            // the targets table is later mutated or hard-deleted.
            ...(input.actionType === 'version_change'
              ? {
                  imageTag: input.imageTag,
                  overridePins: input.overridePins,
                  instanceSourceTags: Object.fromEntries(
                    liveInstanceRows.map(r => [r.instance.id, r.instance.tracked_image_tag ?? null])
                  ),
                }
              : {}),
          },
        });
      } catch (auditErr) {
        console.error('Failed to write audit log for scheduleAction:', auditErr);
      }

      // Wake the target instances' DOs so each re-arms its alarm with a
      // fresh future timestamp. Without this, the wedge in alarm() never
      // gets a chance to run the new action — the DO's alarm may be
      // stale (in wrangler dev) or future-but-distant (in prod), and we
      // need it pointing at "soon" so the sweep happens promptly.
      // Best-effort + parallel: a failure on one wake doesn't block any
      // other wake or the schedule's existence — the next user-initiated
      // activity on the instance will eventually re-arm.
      const internalClient = new KiloClawInternalClient();
      // Batched concurrency. With the 500-instance cap, a flat
      // Promise.all could open 500 outbound sockets simultaneously
      // against the CF Worker. Keep the burst bounded so we don't
      // exhaust Node's pool or hold 500 futures open under a slow
      // worker. Best-effort + per-batch try/catch — a failure on one
      // wake doesn't block any other.
      const wakeConcurrency = 20;
      for (let i = 0; i < liveInstanceRows.length; i += wakeConcurrency) {
        const batch = liveInstanceRows.slice(i, i + wakeConcurrency);
        await Promise.all(
          batch.map(async r => {
            try {
              await internalClient.wakeScheduledAction(r.owner_id, r.instance.id);
            } catch (wakeErr) {
              console.error(
                `Failed to wake DO after scheduleAction (instance=${r.instance.id}):`,
                wakeErr
              );
            }
          })
        );
      }

      return { id: result.id, stageId: result.stageIds[0] };
    }),

  previewFleetUpgrade: adminProcedure.input(FleetUpgradeFilterSchema).query(async ({ input }) => {
    assertScheduledTimeInFuture(input.startsAt, 'startsAt');
    const plan = await getFleetUpgradePlan(input);

    return {
      counts: plan.counts,
      stages: plan.stages,
      actionableInstanceIds: plan.actionableInstanceIds,
      excluded: plan.excluded,
    };
  }),

  createFleetUpgrade: adminProcedure
    .input(FleetUpgradeFilterSchema)
    .mutation(async ({ input, ctx }) => {
      assertScheduledTimeInFuture(input.startsAt, 'startsAt');
      const plan = await getFleetUpgradePlan(input);

      if (plan.excluded.conflictInstanceIds.length > 0) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `${plan.excluded.conflictInstanceIds.length} instances already have pending or in-flight scheduled actions; cancel those first: ${plan.excluded.conflictInstanceIds.join(', ')}`,
        });
      }

      if (plan.actionableRows.length === 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'No actionable fleet upgrade targets match the selected filters',
        });
      }

      const stageTargets: ScheduledActionTargetRow[] = [];
      let offset = 0;
      for (const stage of plan.stages) {
        const rows = plan.actionableRows.slice(offset, offset + stage.targetCount);
        stageTargets.push(...rows.map(row => ({ ...row, stageIndex: stage.stageIndex })));
        offset += stage.targetCount;
      }

      const result = await createScheduledActionRows({
        actionType: 'version_change',
        targetImageTag: input.targetImageTag,
        overridePins: input.overridePins,
        noticeLeadHours: input.noticeLeadHours,
        noticeSubject: input.noticeSubject,
        noticeBody: input.noticeBody,
        reason: input.reason ?? null,
        createdBy: ctx.user.id,
        stages: plan.stages.map(stage => ({
          stageIndex: stage.stageIndex,
          scheduledAt: stage.scheduledAt,
        })),
        targets: stageTargets,
        notify: input.notify,
        noticeChannels: input.noticeChannels,
      });

      try {
        await createKiloClawAdminAuditLog({
          action: 'kiloclaw.fleet_upgrade.created',
          actor_id: ctx.user.id,
          actor_email: ctx.user.google_user_email,
          actor_name: ctx.user.google_user_name,
          target_user_id: ctx.user.id,
          message: `Created fleet upgrade to ${input.targetImageTag} for ${stageTargets.length} instances in ${plan.stages.length} tranches`,
          metadata: {
            scheduledActionId: result.id,
            versionBelow: input.versionBelow,
            targetImageTag: input.targetImageTag,
            overridePins: input.overridePins,
            startsAt: input.startsAt,
            tranchePercent: input.tranchePercent,
            intervalDays: input.intervalDays,
            targetCount: stageTargets.length,
            counts: plan.counts,
            stageSizes: plan.stages.map(stage => stage.targetCount),
          },
        });
      } catch (auditErr) {
        console.error('Failed to write audit log for createFleetUpgrade:', auditErr);
      }

      const internalClient = new KiloClawInternalClient();
      const wakeConcurrency = 20;
      for (let i = 0; i < plan.actionableRows.length; i += wakeConcurrency) {
        const batch = plan.actionableRows.slice(i, i + wakeConcurrency);
        await Promise.all(
          batch.map(async row => {
            try {
              await internalClient.wakeScheduledAction(row.owner_id, row.instance.id);
            } catch (wakeErr) {
              console.error(
                `Failed to wake DO after createFleetUpgrade (instance=${row.instance.id}):`,
                wakeErr
              );
            }
          })
        );
      }

      return {
        id: result.id,
        stageIds: result.stageIds,
        targetCount: stageTargets.length,
      };
    }),

  /**
   * List scheduled actions, paginated, optionally filtered by status or
   * action_type.
   */
  listScheduledActions: adminProcedure
    .input(
      z.object({
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(25),
        status: z.enum(['scheduled', 'running', 'completed', 'cancelled', 'failed']).optional(),
        actionType: z.enum(['scheduled_restart', 'version_change']).optional(),
      })
    )
    .query(async ({ input }) => {
      const conditions: SQL[] = [];
      if (input.status) {
        conditions.push(eq(kiloclaw_scheduled_actions.status, input.status));
      }
      if (input.actionType) {
        conditions.push(eq(kiloclaw_scheduled_actions.action_type, input.actionType));
      }
      const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

      const rows = await db
        .select()
        .from(kiloclaw_scheduled_actions)
        .where(whereCondition)
        .orderBy(desc(kiloclaw_scheduled_actions.created_at))
        .limit(input.limit)
        .offset(input.offset);

      // For each parent action, we want a compact summary for the list
      // view: the total number of instances + a representative
      // instance_id when there's only one. The full target list lives
      // in `getScheduledAction`. Aggregate via GROUP BY so the response
      // size stays bounded even for bulk schedules touching hundreds
      // of instances.
      const actionIds = rows.map(r => r.id);
      const targetSummaryRows =
        actionIds.length > 0
          ? await db
              .select({
                scheduled_action_id: kiloclaw_scheduled_action_targets.scheduled_action_id,
                count: sql<number>`COUNT(*)::int`,
                // Deterministic single-instance preview: oldest target
                // (lowest id under uuid v4 ordering is fine — we just
                // need *some* stable choice).
                first_instance_id: sql<string>`MIN(${kiloclaw_scheduled_action_targets.instance_id}::text)`,
              })
              .from(kiloclaw_scheduled_action_targets)
              .where(inArray(kiloclaw_scheduled_action_targets.scheduled_action_id, actionIds))
              .groupBy(kiloclaw_scheduled_action_targets.scheduled_action_id)
          : [];
      const targetSummaryByAction = new Map(
        targetSummaryRows.map(t => [
          t.scheduled_action_id,
          { count: t.count, first_instance_id: t.first_instance_id },
        ])
      );

      // Earliest stage's scheduled_at — surfaces the "fire no earlier than"
      // bound in the list view. v1 has one stage per action so this is
      // unambiguous. With multi-stage rollouts (post-PR-4) consider
      // returning min(scheduled_at) and "+ N stages" instead.
      const stageRows =
        actionIds.length > 0
          ? await db
              .select({
                scheduled_action_id: kiloclaw_scheduled_action_stages.scheduled_action_id,
                scheduled_at: sql<string>`MIN(${kiloclaw_scheduled_action_stages.scheduled_at})`,
                stage_count: sql<number>`COUNT(*)::int`,
                latest_scheduled_at: sql<string>`MAX(${kiloclaw_scheduled_action_stages.scheduled_at})`,
              })
              .from(kiloclaw_scheduled_action_stages)
              .where(inArray(kiloclaw_scheduled_action_stages.scheduled_action_id, actionIds))
              .groupBy(kiloclaw_scheduled_action_stages.scheduled_action_id)
          : [];
      const scheduledAtByAction = new Map<string, string>();
      const stageSummaryByAction = new Map<
        string,
        { stage_count: number; latest_scheduled_at: string }
      >();
      for (const s of stageRows) {
        scheduledAtByAction.set(s.scheduled_action_id, s.scheduled_at);
        stageSummaryByAction.set(s.scheduled_action_id, {
          stage_count: s.stage_count,
          latest_scheduled_at: s.latest_scheduled_at,
        });
      }

      const totalCountResult = await db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(kiloclaw_scheduled_actions)
        .where(whereCondition);

      const total = totalCountResult[0]?.count ?? 0;

      return {
        items: rows.map(r => {
          const summary = targetSummaryByAction.get(r.id);
          const stageSummary = stageSummaryByAction.get(r.id);
          return {
            ...r,
            target_count: summary?.count ?? 0,
            // Only meaningful when target_count === 1; UI shows
            // "N instances" otherwise.
            first_instance_id: summary?.first_instance_id ?? null,
            scheduled_at: scheduledAtByAction.get(r.id) ?? null,
            stage_count: stageSummary?.stage_count ?? 0,
            latest_scheduled_at: stageSummary?.latest_scheduled_at ?? null,
          };
        }),
        pagination: {
          offset: input.offset,
          limit: input.limit,
          total,
          totalPages: Math.ceil(total / input.limit),
        },
      };
    }),

  /**
   * Fetch one scheduled action with its stages and targets.
   */
  getScheduledAction: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => {
      const [parent] = await db
        .select()
        .from(kiloclaw_scheduled_actions)
        .where(eq(kiloclaw_scheduled_actions.id, input.id))
        .limit(1);

      if (!parent) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Scheduled action not found' });
      }

      const stages = await db
        .select()
        .from(kiloclaw_scheduled_action_stages)
        .where(eq(kiloclaw_scheduled_action_stages.scheduled_action_id, input.id))
        .orderBy(asc(kiloclaw_scheduled_action_stages.stage_index));

      // Target fetch is intentionally unpaginated: scheduleAction caps
      // instanceIds at 500, so the worst-case response here is 500 rows
      // joined to kilocode_users and kiloclaw_instances. If that cap is
      // ever raised significantly, paginate here.
      const targets = await db
        .select({
          target: kiloclaw_scheduled_action_targets,
          user_email: kilocode_users.google_user_email,
          instance_sandbox_id: kiloclaw_instances.sandbox_id,
          stage_index: kiloclaw_scheduled_action_stages.stage_index,
          stage_scheduled_at: kiloclaw_scheduled_action_stages.scheduled_at,
        })
        .from(kiloclaw_scheduled_action_targets)
        .leftJoin(kilocode_users, eq(kilocode_users.id, kiloclaw_scheduled_action_targets.user_id))
        .leftJoin(
          kiloclaw_instances,
          eq(kiloclaw_instances.id, kiloclaw_scheduled_action_targets.instance_id)
        )
        .leftJoin(
          kiloclaw_scheduled_action_stages,
          eq(kiloclaw_scheduled_action_stages.id, kiloclaw_scheduled_action_targets.stage_id)
        )
        .where(eq(kiloclaw_scheduled_action_targets.scheduled_action_id, input.id));

      return {
        action: parent,
        stages,
        targets: targets.map(t => ({
          ...t.target,
          user_email: t.user_email,
          instance_sandbox_id: t.instance_sandbox_id,
          stage_index: t.stage_index,
          stage_scheduled_at: t.stage_scheduled_at,
        })),
      };
    }),

  /**
   * Pending scheduled actions for a single instance. Powers the
   * "upcoming scheduled action" indicator on the instance detail page.
   * Returns the per-target row joined to its parent action and stage,
   * filtered to pending targets whose parent is still actionable.
   * Ordered by scheduled_at ascending so the soonest is first.
   */
  /**
   * Synchronously runs the scheduled-action notice sweep that the cron
   * normally drives at 1-minute cadence. Powers the admin Scheduler
   * tab "Run notice sweep now" button — useful in `wrangler dev` (where
   * scheduled() does not fire on cadence) and as an on-demand verifier
   * in production after creating a test notification. The sweep is
   * idempotent and bounded; calling it on demand is safe.
   */
  runNoticeSweepNow: adminProcedure.mutation(async () => {
    const internalClient = new KiloClawInternalClient();
    return internalClient.runScheduledActionNoticeSweep();
  }),

  listUpcomingScheduledActionsForInstance: adminProcedure
    .input(z.object({ instanceId: z.string().uuid() }))
    .query(async ({ input }) => {
      // Two aliased joins on kiloclaw_image_catalog so the response
      // can include openclaw_version for both source and target tags
      // — drives the "source (OpenClaw vX) → target (OpenClaw vY)"
      // display. Left joins because the catalog row could be missing
      // (deleted) for an old source tag.
      const sourceCatalog = alias(kiloclaw_image_catalog, 'source_catalog');
      const targetCatalog = alias(kiloclaw_image_catalog, 'target_catalog');

      const rows = await db
        .select({
          target: kiloclaw_scheduled_action_targets,
          action: kiloclaw_scheduled_actions,
          stage: kiloclaw_scheduled_action_stages,
          source_openclaw_version: sourceCatalog.openclaw_version,
          target_openclaw_version: targetCatalog.openclaw_version,
        })
        .from(kiloclaw_scheduled_action_targets)
        .innerJoin(
          kiloclaw_scheduled_actions,
          eq(kiloclaw_scheduled_actions.id, kiloclaw_scheduled_action_targets.scheduled_action_id)
        )
        .leftJoin(
          kiloclaw_scheduled_action_stages,
          eq(kiloclaw_scheduled_action_stages.id, kiloclaw_scheduled_action_targets.stage_id)
        )
        .leftJoin(
          sourceCatalog,
          eq(sourceCatalog.image_tag, kiloclaw_scheduled_action_targets.source_image_tag)
        )
        .leftJoin(
          targetCatalog,
          eq(targetCatalog.image_tag, kiloclaw_scheduled_action_targets.target_image_tag)
        )
        .where(
          and(
            eq(kiloclaw_scheduled_action_targets.instance_id, input.instanceId),
            eq(kiloclaw_scheduled_action_targets.status, 'pending'),
            inArray(kiloclaw_scheduled_actions.status, ['scheduled', 'running'])
          )
        )
        .orderBy(asc(kiloclaw_scheduled_action_stages.scheduled_at));

      // Per-action total target count so the UI can distinguish single
      // vs bulk and offer "cancel only this instance" vs "cancel entire
      // batch". Pulled from the parent's stamped total_count rather than
      // a fresh COUNT(*) — admin-cancel-target paths decrement it as
      // they go (TBD), but for now total_count is the at-schedule-time
      // size, which is what the UX needs.
      return {
        items: rows.map(r => ({
          scheduled_action_id: r.action.id,
          action_type: r.action.action_type,
          target_image_tag: r.target.target_image_tag ?? r.action.target_image_tag,
          target_openclaw_version: r.target_openclaw_version,
          source_image_tag: r.target.source_image_tag,
          source_openclaw_version: r.source_openclaw_version,
          override_pins: r.action.override_pins,
          scheduled_at: r.stage?.scheduled_at ?? null,
          parent_status: r.action.status,
          target_count: r.action.total_count,
        })),
      };
    }),

  /**
   * Cancel a single target row inside a scheduled action. Used by the
   * per-instance "Upcoming scheduled action" indicator when the admin
   * wants to drop just one instance from a bulk schedule (the parent
   * action keeps running for the other targets).
   *
   * Atomic CAS on (scheduled_action_id, instance_id, status='pending').
   * Bumps the parent + stage skipped counters and runs the same
   * promotion sweep as the DO alarm path so that an action whose
   * targets are *all* individually cancelled here doesn't stay in
   * 'scheduled' forever (the alarm-path sweep only fires when due
   * rows are processed).
   */
  cancelScheduledActionTarget: adminProcedure
    .input(
      z.object({
        scheduledActionId: z.string().uuid(),
        instanceId: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const result = await db.transaction(async tx => {
        const [updated] = await tx
          .update(kiloclaw_scheduled_action_targets)
          .set({
            status: 'skipped',
            skip_reason: 'cancelled',
          })
          .where(
            and(
              eq(kiloclaw_scheduled_action_targets.scheduled_action_id, input.scheduledActionId),
              eq(kiloclaw_scheduled_action_targets.instance_id, input.instanceId),
              eq(kiloclaw_scheduled_action_targets.status, 'pending')
            )
          )
          .returning({
            id: kiloclaw_scheduled_action_targets.id,
            stage_id: kiloclaw_scheduled_action_targets.stage_id,
          });

        if (!updated) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'No pending scheduled-action target for this (action, instance)',
          });
        }

        if (updated.stage_id) {
          await tx
            .update(kiloclaw_scheduled_action_stages)
            .set({
              skipped_count: sql`${kiloclaw_scheduled_action_stages.skipped_count} + 1`,
            })
            .where(eq(kiloclaw_scheduled_action_stages.id, updated.stage_id));
        }

        await tx
          .update(kiloclaw_scheduled_actions)
          .set({
            skipped_count: sql`${kiloclaw_scheduled_actions.skipped_count} + 1`,
          })
          .where(eq(kiloclaw_scheduled_actions.id, input.scheduledActionId));

        // Queue cancellation notifications for THIS target only —
        // mirrors the bulk-cancel logic. ON CONFLICT keeps repeat calls
        // safe. We only queue from notices that have already reached
        // 'sent' here. For notices that are still 'sending' at this
        // moment (the sweep is mid-dispatch), the markSent finalization
        // step queues the cancellation in the same UPDATE if it sees
        // parent.action.status = 'cancelled'. That coupling guarantees
        // we never queue an orphan cancellation for a notice that
        // ultimately failed to deliver.
        await tx.execute(sql`
          INSERT INTO kiloclaw_scheduled_action_notifications
            (target_id, channel, kind, status)
          SELECT n.target_id, n.channel, 'cancelled', 'pending'
          FROM kiloclaw_scheduled_action_notifications n
          WHERE n.target_id = ${updated.id}
            AND n.kind = 'notice'
            AND n.status = 'sent'
          ON CONFLICT (target_id, kind, channel) DO NOTHING
        `);

        // Void any pending notice rows for this target so the sweep
        // doesn't deliver a "your bot will restart soon" message after
        // the action has been cancelled. Without this, an admin who
        // cancels before the notice lead-time window opens (e.g.
        // notice_lead_hours=24, cancel at hour 18) still sees the
        // notice fire after hour 24 — selectDueNotifications filters
        // only on notification.status, not on parent action/target
        // status. We deliberately leave 'sending' rows alone: the
        // sweep already committed to dispatching them, and overwriting
        // mid-flight would race with markSent.
        await tx
          .update(kiloclaw_scheduled_action_notifications)
          .set({
            status: 'failed',
            error_message: 'action cancelled before notice was dispatched',
          })
          .where(
            and(
              eq(kiloclaw_scheduled_action_notifications.target_id, updated.id),
              eq(kiloclaw_scheduled_action_notifications.kind, 'notice'),
              eq(kiloclaw_scheduled_action_notifications.status, 'pending')
            )
          );

        // Promote stage + parent if no pending targets remain. Without
        // this, an action whose targets are all individually cancelled
        // via this path stays in 'scheduled' forever — the DO alarm
        // path's findDueScheduledActionTargetsForInstance returns 0
        // rows so its post-pass promotion sweep never runs. Mirrors
        // services/kiloclaw/src/db/index.ts maybePromoteScheduledActionsToCompleted
        // (kept inline rather than imported because that helper takes
        // a WorkerDb, not a tx).
        // NOT EXISTS treats both 'pending' and 'running' as unresolved
        // — see comment on maybePromoteScheduledActionsToCompleted in
        // services/kiloclaw/src/db/index.ts for why.
        await tx.execute(sql`
          UPDATE kiloclaw_scheduled_action_stages s
          SET status = CASE
                WHEN s.applied_count > 0 OR s.skipped_count > 0 THEN 'completed'
                ELSE 'failed'
              END,
              completed_at = COALESCE(s.completed_at, now())
          WHERE s.scheduled_action_id = ${input.scheduledActionId}
            AND s.status IN ('pending', 'running')
            AND NOT EXISTS (
              SELECT 1 FROM kiloclaw_scheduled_action_targets t
              WHERE t.stage_id = s.id AND t.status IN ('pending', 'running')
            )
        `);
        await tx.execute(sql`
          UPDATE kiloclaw_scheduled_actions a
          SET status = CASE
                WHEN a.applied_count > 0 OR a.skipped_count > 0 THEN 'completed'
                ELSE 'failed'
              END,
              completed_at = COALESCE(a.completed_at, now())
          WHERE a.id = ${input.scheduledActionId}
            AND a.status IN ('scheduled', 'running')
            AND NOT EXISTS (
              SELECT 1 FROM kiloclaw_scheduled_action_targets t
              WHERE t.scheduled_action_id = a.id AND t.status IN ('pending', 'running')
            )
        `);

        return { cancelled: true as const };
      });

      // Audit. Reuses the existing 'cancelled' action with metadata
      // indicating per-target scope.
      try {
        await createKiloClawAdminAuditLog({
          action: 'kiloclaw.scheduled_action.cancelled',
          actor_id: ctx.user.id,
          actor_email: ctx.user.google_user_email,
          actor_name: ctx.user.google_user_name,
          target_user_id: ctx.user.id,
          message: `Cancelled scheduled action ${input.scheduledActionId} for instance ${input.instanceId} only`,
          metadata: {
            scope: 'target',
            scheduledActionId: input.scheduledActionId,
            instanceId: input.instanceId,
          },
        });
      } catch (auditErr) {
        console.error('Failed to write audit log for cancelScheduledActionTarget:', auditErr);
      }

      return result;
    }),

  /**
   * Cancel a scheduled action. Pending stages move to 'cancelled';
   * pending targets get marked skipped:cancelled. Already-applied
   * targets stay applied.
   *
   * No notifications are sent in PR 1 (no notification fan-out yet);
   * PR 2 adds cancellation notifications for targets whose original
   * notice was already dispatched.
   */
  cancelScheduledAction: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const result = await db.transaction(async tx => {
        const [updated] = await tx
          .update(kiloclaw_scheduled_actions)
          .set({
            status: 'cancelled',
            cancelled_at: sql`now()`,
          })
          .where(
            and(
              eq(kiloclaw_scheduled_actions.id, input.id),
              inArray(kiloclaw_scheduled_actions.status, ['scheduled', 'running'])
            )
          )
          .returning({ id: kiloclaw_scheduled_actions.id });

        if (!updated) {
          // Either the row doesn't exist or it's already in a terminal
          // state. Distinguish via a follow-up SELECT for a clean error.
          const [existing] = await tx
            .select({ status: kiloclaw_scheduled_actions.status })
            .from(kiloclaw_scheduled_actions)
            .where(eq(kiloclaw_scheduled_actions.id, input.id))
            .limit(1);
          if (!existing) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Scheduled action not found',
            });
          }
          // Already in terminal state — return cancelled:false (no-op)
          return { cancelled: false as const, status: existing.status };
        }

        await tx
          .update(kiloclaw_scheduled_action_stages)
          .set({ status: 'cancelled' })
          .where(
            and(
              eq(kiloclaw_scheduled_action_stages.scheduled_action_id, input.id),
              eq(kiloclaw_scheduled_action_stages.status, 'pending')
            )
          );

        await tx
          .update(kiloclaw_scheduled_action_targets)
          .set({
            status: 'skipped',
            skip_reason: 'cancelled',
          })
          .where(
            and(
              eq(kiloclaw_scheduled_action_targets.scheduled_action_id, input.id),
              eq(kiloclaw_scheduled_action_targets.status, 'pending')
            )
          );

        // Queue cancellation notifications for (target, channel) pairs
        // that already had a 'notice' row in 'sent' status. If the
        // user never received a heads-up we do not surface a
        // cancellation either. ON CONFLICT DO NOTHING keeps repeat
        // cancels idempotent.
        //
        // The race between this cancel and an in-flight 'sending'
        // notice is closed in the sweep's markSent: when markSent
        // moves a row from 'sending' to 'sent' AND the parent action
        // is already in 'cancelled', it inserts a cancellation row in
        // the same step. That makes the cancellation creation
        // contingent on the notice actually reaching the user; a
        // dispatch failure leaves no orphan cancellation pending.
        await tx.execute(sql`
          INSERT INTO kiloclaw_scheduled_action_notifications
            (target_id, channel, kind, status)
          SELECT n.target_id, n.channel, 'cancelled', 'pending'
          FROM kiloclaw_scheduled_action_notifications n
          INNER JOIN kiloclaw_scheduled_action_targets t
            ON t.id = n.target_id
          WHERE t.scheduled_action_id = ${input.id}
            AND n.kind = 'notice'
            AND n.status = 'sent'
          ON CONFLICT (target_id, kind, channel) DO NOTHING
        `);

        // Void any pending notice rows so the sweep doesn't deliver a
        // notice for a now-cancelled action. The sweep's selectDue
        // query filters only on notification.status, not on parent
        // status, so without this an admin who cancels before the
        // notice lead-time window opens still sees the original
        // notice fire on a later tick. Leave 'sending' rows alone —
        // see the per-target version of this for the same reasoning.
        await tx.execute(sql`
          UPDATE kiloclaw_scheduled_action_notifications
          SET status = 'failed',
              error_message = 'action cancelled before notice was dispatched'
          WHERE target_id IN (
            SELECT id FROM kiloclaw_scheduled_action_targets
            WHERE scheduled_action_id = ${input.id}
          )
            AND kind = 'notice'
            AND status = 'pending'
        `);

        return { cancelled: true as const, status: 'cancelled' as const };
      });

      if (result.cancelled) {
        try {
          await createKiloClawAdminAuditLog({
            action: 'kiloclaw.scheduled_action.cancelled',
            actor_id: ctx.user.id,
            actor_email: ctx.user.google_user_email,
            actor_name: ctx.user.google_user_name,
            target_user_id: ctx.user.id, // multi-user action sentinel
            message: `Cancelled scheduled action ${input.id}`,
            metadata: { scheduledActionId: input.id },
          });
        } catch (auditErr) {
          console.error('Failed to write audit log for cancelScheduledAction:', auditErr);
        }
      }

      return result;
    }),

  destroyFlyMachine: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        instanceId: z.string().uuid().optional(),
        appName: z
          .string()
          .min(1)
          .max(63)
          .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'Invalid Fly app name'),
        machineId: z
          .string()
          .min(1)
          .regex(/^[a-z0-9]+$/, 'Invalid Fly machine ID'),
      })
    )
    .mutation(async ({ input, ctx }) => {
      console.log(
        `[admin-kiloclaw] destroyFlyMachine triggered by admin ${ctx.user.id} (${ctx.user.google_user_email}) app=${input.appName} machine=${input.machineId}`
      );
      const instance = await resolveInstance(input.userId, input.instanceId);
      const client = new KiloClawInternalClient();

      // Verify the appName/machineId match the DO's actual state
      let status: Awaited<ReturnType<KiloClawInternalClient['getDebugStatus']>>;
      try {
        status = await client.getDebugStatus(input.userId, workerInstanceId(instance));
      } catch (err) {
        throwKiloclawAdminError(err, 'Failed to verify machine state before destroy');
      }
      if (status.provider !== 'fly') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Direct Fly machine destroy is not supported for provider ${status.provider}`,
        });
      }
      if (status.flyAppName !== input.appName || status.flyMachineId !== input.machineId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Fly resource mismatch: expected app=${status.flyAppName} machine=${status.flyMachineId}, got app=${input.appName} machine=${input.machineId}`,
        });
      }

      const fallbackMessage = 'Failed to destroy Fly machine';
      try {
        const result = await client.destroyFlyMachine(
          input.userId,
          input.appName,
          input.machineId,
          workerInstanceId(instance)
        );

        try {
          await createKiloClawAdminAuditLog({
            action: 'kiloclaw.machine.destroy_fly',
            actor_id: ctx.user.id,
            actor_email: ctx.user.google_user_email,
            actor_name: ctx.user.google_user_name,
            target_user_id: input.userId,
            message: `Fly machine force-destroyed: app=${input.appName} machine=${input.machineId}`,
            metadata: {
              appName: input.appName,
              machineId: input.machineId,
            },
          });
        } catch (auditErr) {
          console.error('Failed to write audit log for destroyFlyMachine:', auditErr);
        }

        return result;
      } catch (err) {
        console.error(
          `Failed to destroy Fly machine app=${input.appName} machine=${input.machineId}:`,
          err
        );
        throwKiloclawAdminError(err, fallbackMessage);
      }
    }),

  extendVolume: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        instanceId: z.string().uuid().optional(),
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
      })
    )
    .mutation(async ({ input, ctx }) => {
      console.log(
        `[admin-kiloclaw] extendVolume triggered by admin ${ctx.user.id} (${ctx.user.google_user_email}) app=${input.appName} volume=${input.volumeId} targetSizeGb=${input.targetSizeGb}`
      );
      const instance = await resolveInstance(input.userId, input.instanceId);
      // Same ownership-check pattern as resizeMachine /
      // setAdminMachineSizeOverride / clearAdminMachineSizeOverride.
      // resolveInstance(userId, instanceId) does NOT filter by user_id when
      // instanceId is supplied — without this assert, an admin passing
      // userId=A + instanceId=B (B owned by user C) would extend C's
      // volume while the audit log records target_user_id=A. Fly volumes
      // can grow but cannot shrink, so the storage change is permanent.
      assertInstanceBelongsToUser(instance, input.userId);
      const client = new KiloClawInternalClient();
      const instanceId = workerInstanceId(instance);

      let status: Awaited<ReturnType<KiloClawInternalClient['getDebugStatus']>>;
      try {
        status = await client.getDebugStatus(input.userId, instanceId);
      } catch (err) {
        throwKiloclawAdminError(err, 'Failed to verify volume state before extend');
      }
      const unsafeExtendStates: ReadonlyArray<string> = ['recovering', 'restoring', 'destroying'];
      if (status.status && unsafeExtendStates.includes(status.status)) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Cannot extend volume while instance is ${status.status}`,
        });
      }
      if (status.flyAppName !== input.appName || status.flyVolumeId !== input.volumeId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Fly resource mismatch: expected app=${status.flyAppName} volume=${status.flyVolumeId}, got app=${input.appName} volume=${input.volumeId}`,
        });
      }
      const currentSizeGb = status.volumeSizeGb ?? 10;
      if (input.targetSizeGb <= currentSizeGb) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Target size must be greater than current size (${currentSizeGb} GB)`,
        });
      }

      const fallbackMessage = 'Failed to extend Fly volume';
      try {
        const result = await client.extendVolume(
          input.userId,
          input.appName,
          input.volumeId,
          input.targetSizeGb,
          instanceId
        );

        try {
          await createKiloClawAdminAuditLog({
            action: 'kiloclaw.volume.extend',
            actor_id: ctx.user.id,
            actor_email: ctx.user.google_user_email,
            actor_name: ctx.user.google_user_name,
            target_user_id: input.userId,
            message: `Fly volume extended to ${input.targetSizeGb}GB: app=${input.appName} volume=${input.volumeId}`,
            metadata: {
              appName: input.appName,
              volumeId: input.volumeId,
              previousSizeGb: currentSizeGb,
              sizeGb: input.targetSizeGb,
            },
          });
        } catch (auditErr) {
          console.error('Failed to write audit log for extendVolume:', auditErr);
        }

        return result;
      } catch (err) {
        console.error(
          `Failed to extend Fly volume app=${input.appName} volume=${input.volumeId}:`,
          err
        );
        throwKiloclawAdminError(err, fallbackMessage);
      }
    }),

  destroy: adminProcedure.input(DestroyInstanceSchema).mutation(async ({ input, ctx }) => {
    const [instance] = await db
      .select({
        id: kiloclaw_instances.id,
        user_id: kiloclaw_instances.user_id,
        sandbox_id: kiloclaw_instances.sandbox_id,
        destroyed_at: kiloclaw_instances.destroyed_at,
      })
      .from(kiloclaw_instances)
      .where(eq(kiloclaw_instances.id, input.id))
      .limit(1);

    if (!instance) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Instance not found' });
    }

    if (instance.destroyed_at !== null) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Instance is already destroyed' });
    }

    console.log(
      `[admin-kiloclaw] Destroy triggered by admin ${ctx.user.id} (${ctx.user.google_user_email}) for instance ${instance.id} (user: ${instance.user_id})`
    );

    const destroyedRow = await markActiveInstanceDestroyed(instance.user_id, instance.id);
    const client = new KiloClawInternalClient();
    try {
      await client.destroy(instance.user_id, workerInstanceId(instance), {
        reason: 'admin_request',
      });
    } catch (error) {
      if (destroyedRow) {
        await restoreDestroyedInstance(destroyedRow.id);
      }
      throw error;
    }

    // Post-destroy cleanup: best-effort DB tidying that must not report
    // failure after a successful destroy.
    try {
      await clearAdminInstanceDestructionDeadlineWithChangeLog({
        actorUserId: ctx.user.id,
        userId: instance.user_id,
        instanceId: instance.id,
        reason: 'admin_destroy_clear_lifecycle_state',
      });

      // Clear lifecycle emails so they can fire again if the user re-provisions.
      const resettableEmailTypes = [
        'claw_suspended_trial',
        'claw_suspended_subscription',
        'claw_suspended_payment',
        'claw_destruction_warning',
        'claw_instance_destroyed',
      ];
      await db
        .delete(kiloclaw_email_log)
        .where(
          and(
            eq(kiloclaw_email_log.user_id, instance.user_id),
            eq(kiloclaw_email_log.instance_id, instance.id),
            inArray(kiloclaw_email_log.email_type, resettableEmailTypes)
          )
        );
      // Clear per-instance ready emails so a future re-provision triggers the notification.
      await db
        .delete(kiloclaw_email_log)
        .where(
          and(
            eq(kiloclaw_email_log.user_id, instance.user_id),
            or(
              and(
                eq(kiloclaw_email_log.instance_id, instance.id),
                eq(kiloclaw_email_log.email_type, 'claw_instance_ready')
              ),
              and(
                isNull(kiloclaw_email_log.instance_id),
                eq(kiloclaw_email_log.email_type, `claw_instance_ready:${instance.sandbox_id}`)
              )
            )
          )
        );
    } catch (cleanupError) {
      console.error('[admin-kiloclaw] Post-destroy cleanup failed:', cleanupError);
    }

    return { success: true };
  }),

  adminAuditLogs: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        action: z.string().optional(),
        limit: z.number().min(1).max(50).default(10),
      })
    )
    .query(async ({ input }) => {
      return listKiloClawAdminAuditLogs({
        target_user_id: input.userId,
        action: input.action as Parameters<typeof listKiloClawAdminAuditLogs>[0]['action'],
        limit: input.limit,
      });
    }),

  candidateVolumes: adminProcedure
    .input(z.object({ userId: z.string().min(1), instanceId: z.string().uuid().optional() }))
    .query(async ({ input }): Promise<CandidateVolumesResponse> => {
      try {
        const instance = await resolveInstance(input.userId, input.instanceId);
        const client = new KiloClawInternalClient();
        return await client.listCandidateVolumes(input.userId, workerInstanceId(instance));
      } catch (err) {
        throwKiloclawAdminError(err, 'Failed to list candidate volumes');
      }
    }),

  devNukeAll: adminProcedure.mutation(async ({ ctx }) => {
    if (process.env.NODE_ENV !== 'development') {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'This endpoint is only available in development mode',
      });
    }

    const activeInstances = await db
      .select({
        id: kiloclaw_instances.id,
        user_id: kiloclaw_instances.user_id,
        sandbox_id: kiloclaw_instances.sandbox_id,
      })
      .from(kiloclaw_instances)
      .where(isNull(kiloclaw_instances.destroyed_at));

    console.log(
      `[admin-kiloclaw] DevNukeAll triggered by admin ${ctx.user.id} (${ctx.user.google_user_email}): ${activeInstances.length} active instances`
    );

    const client = new KiloClawInternalClient();
    let destroyed = 0;
    const errors: Array<{ userId: string; error: string }> = [];

    for (const instance of activeInstances) {
      const destroyedRow = await markActiveInstanceDestroyed(instance.user_id, instance.id);
      try {
        await client.destroy(instance.user_id, workerInstanceId(instance), {
          reason: 'admin_request',
        });
        destroyed++;
      } catch (err) {
        if (destroyedRow) {
          await restoreDestroyedInstance(destroyedRow.id);
        }
        const message = err instanceof Error ? err.message : 'Unknown error';
        errors.push({ userId: instance.user_id, error: message });
        console.error(
          `[admin-kiloclaw] DevNukeAll: failed to destroy instance ${instance.id} (user: ${instance.user_id}):`,
          err
        );
      }
    }

    return { total: activeInstances.length, destroyed, errors };
  }),

  reassociateVolume: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        instanceId: z.string().uuid().optional(),
        newVolumeId: z.string().min(1),
        reason: z.string().min(10).max(500),
      })
    )
    .mutation(async ({ input, ctx }): Promise<ReassociateVolumeResponse> => {
      console.log(
        `[admin-kiloclaw] Volume reassociation triggered by admin ${ctx.user.id} (${ctx.user.google_user_email}) for user ${input.userId}: newVolume=${input.newVolumeId} reason="${input.reason}"`
      );
      try {
        const instance = await resolveInstance(input.userId, input.instanceId);
        const client = new KiloClawInternalClient();
        const result = await client.reassociateVolume(
          input.userId,
          input.newVolumeId,
          input.reason,
          workerInstanceId(instance)
        );

        try {
          await createKiloClawAdminAuditLog({
            action: 'kiloclaw.volume.reassociate',
            actor_id: ctx.user.id,
            actor_email: ctx.user.google_user_email,
            actor_name: ctx.user.google_user_name,
            target_user_id: input.userId,
            message: `Volume reassociated: ${result.previousVolumeId ?? 'none'} → ${result.newVolumeId} (region: ${result.newRegion}). Reason: ${input.reason}`,
            metadata: {
              previousVolumeId: result.previousVolumeId,
              newVolumeId: result.newVolumeId,
              newRegion: result.newRegion,
              reason: input.reason,
            },
          });
        } catch (auditErr) {
          console.error('Failed to write audit log for volume reassociation:', auditErr);
        }

        return result;
      } catch (err) {
        console.error('Failed to reassociate volume for user:', input.userId, err);
        throwKiloclawAdminError(err, 'Failed to reassociate volume');
      }
    }),

  resizeMachine: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        instanceId: z.string().uuid().optional(),
        instanceType: InstanceTierKeySchema,
      })
    )
    .mutation(async ({ input, ctx }): Promise<ResizeMachineResponse> => {
      console.log(
        `[admin-kiloclaw] Machine resize triggered by admin ${ctx.user.id} (${ctx.user.google_user_email}) for user ${input.userId}: ${input.instanceType}`
      );
      try {
        const instance = await resolveInstance(input.userId, input.instanceId);
        assertInstanceBelongsToUser(instance, input.userId);
        const client = new KiloClawInternalClient();
        const result = await client.resizeMachine(
          input.userId,
          input.instanceType,
          { actorId: ctx.user.id, actorEmail: ctx.user.google_user_email },
          workerInstanceId(instance)
        );

        try {
          const clearedOverrideMessage = result.clearedOverride
            ? ` (cleared admin override: ${result.clearedOverride.size.cpus}× ${result.clearedOverride.size.cpu_kind ?? 'shared'}, ${result.clearedOverride.size.memory_mb}MB)`
            : '';
          await createKiloClawAdminAuditLog({
            action: 'kiloclaw.machine.resize',
            actor_id: ctx.user.id,
            actor_email: ctx.user.google_user_email,
            actor_name: ctx.user.google_user_name,
            target_user_id: input.userId,
            message: `Machine resized: ${result.previousTier ?? 'unknown'} → ${result.newTier}${clearedOverrideMessage}`,
            metadata: {
              previousTier: result.previousTier,
              newTier: result.newTier,
              previousVolumeSizeGb: result.previousVolumeSizeGb,
              newVolumeSizeGb: result.newVolumeSizeGb,
              machineSize: result.machineSize,
              clearedOverride: result.clearedOverride,
            },
          });
        } catch (auditErr) {
          console.error('Failed to write audit log for machine resize:', auditErr);
        }

        return result;
      } catch (err) {
        console.error('Failed to resize machine for user:', input.userId, err);
        throwKiloclawAdminError(err, 'Failed to resize machine');
      }
    }),

  setAdminMachineSizeOverride: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        instanceId: z.string().uuid().optional(),
        preset: AdminSizeOverridePresetSchema,
        reason: z.string().min(10).max(500),
      })
    )
    .mutation(async ({ input, ctx }) => {
      console.log(
        `[admin-kiloclaw] Admin size override SET by admin ${ctx.user.id} (${ctx.user.google_user_email}) for user ${input.userId}: preset=${input.preset}`
      );
      try {
        const instance = await resolveInstance(input.userId, input.instanceId);
        assertInstanceBelongsToUser(instance, input.userId);
        const size = presetToMachineSize(input.preset);
        const client = new KiloClawInternalClient();
        const result = await client.setAdminMachineSizeOverride(
          input.userId,
          {
            size,
            reason: input.reason,
            actorId: ctx.user.id,
            actorEmail: ctx.user.google_user_email,
          },
          workerInstanceId(instance)
        );

        try {
          await createKiloClawAdminAuditLog({
            action: 'kiloclaw.admin_size_override.set',
            actor_id: ctx.user.id,
            actor_email: ctx.user.google_user_email,
            actor_name: ctx.user.google_user_name,
            target_user_id: input.userId,
            message: `Admin size override set: preset=${input.preset} (${size.cpus}× ${size.cpu_kind ?? 'shared'}, ${size.memory_mb}MB). Reason: ${input.reason}`,
            metadata: {
              preset: input.preset,
              previousOverride: result.previousOverride,
              newOverride: result.newOverride,
              reason: input.reason,
            },
          });
        } catch (auditErr) {
          console.error('Failed to write audit log for admin size override set:', auditErr);
        }

        return result;
      } catch (err) {
        console.error('Failed to set admin size override for user:', input.userId, err);
        throwKiloclawAdminError(err, 'Failed to set admin size override');
      }
    }),

  clearAdminMachineSizeOverride: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        instanceId: z.string().uuid().optional(),
        reason: z.string().min(10).max(500),
      })
    )
    .mutation(async ({ input, ctx }) => {
      console.log(
        `[admin-kiloclaw] Admin size override CLEAR by admin ${ctx.user.id} (${ctx.user.google_user_email}) for user ${input.userId}`
      );
      try {
        const instance = await resolveInstance(input.userId, input.instanceId);
        assertInstanceBelongsToUser(instance, input.userId);
        const client = new KiloClawInternalClient();
        const result = await client.clearAdminMachineSizeOverride(
          input.userId,
          {
            reason: input.reason,
            actorId: ctx.user.id,
            actorEmail: ctx.user.google_user_email,
          },
          workerInstanceId(instance)
        );

        try {
          const previousMessage = result.previousOverride
            ? `${result.previousOverride.cpus}× ${result.previousOverride.cpu_kind ?? 'shared'}, ${result.previousOverride.memory_mb}MB`
            : 'none';
          await createKiloClawAdminAuditLog({
            action: 'kiloclaw.admin_size_override.clear',
            actor_id: ctx.user.id,
            actor_email: ctx.user.google_user_email,
            actor_name: ctx.user.google_user_name,
            target_user_id: input.userId,
            message: `Admin size override cleared (previous: ${previousMessage}). Reason: ${input.reason}`,
            metadata: {
              previousOverride: result.previousOverride,
              reason: input.reason,
            },
          });
        } catch (auditErr) {
          console.error('Failed to write audit log for admin size override clear:', auditErr);
        }

        return result;
      } catch (err) {
        console.error('Failed to clear admin size override for user:', input.userId, err);
        throwKiloclawAdminError(err, 'Failed to clear admin size override');
      }
    }),

  restoreVolumeSnapshot: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        instanceId: z.string().uuid().optional(),
        snapshotId: z.string().min(1),
        reason: z.string().min(10).max(500),
      })
    )
    .mutation(async ({ input, ctx }): Promise<RestoreVolumeSnapshotResponse> => {
      console.log(
        `[admin-kiloclaw] Snapshot restore triggered by admin ${ctx.user.id} (${ctx.user.google_user_email}) for user ${input.userId}: snapshot=${input.snapshotId} reason="${input.reason}"`
      );
      try {
        const instance = await resolveInstance(input.userId, input.instanceId);
        const client = new KiloClawInternalClient();
        const result = await client.restoreVolumeFromSnapshot(
          input.userId,
          input.snapshotId,
          workerInstanceId(instance)
        );

        try {
          await createKiloClawAdminAuditLog({
            action: 'kiloclaw.snapshot.restore',
            actor_id: ctx.user.id,
            actor_email: ctx.user.google_user_email,
            actor_name: ctx.user.google_user_name,
            target_user_id: input.userId,
            message: `Snapshot restore enqueued: snapshot=${input.snapshotId}, previousVolume=${result.previousVolumeId}. Reason: ${input.reason}`,
            metadata: {
              snapshotId: input.snapshotId,
              previousVolumeId: result.previousVolumeId,
              reason: input.reason,
            },
          });
        } catch (auditErr) {
          console.error('Failed to write audit log for snapshot restore:', auditErr);
        }

        return result;
      } catch (err) {
        console.error('Failed to restore snapshot for user:', input.userId, err);
        throwKiloclawAdminError(err, 'Failed to restore from snapshot');
      }
    }),

  // ── Orphan detection ──────────────────────────────────────────────────

  detectOrphans: adminProcedure.input(DetectOrphansSchema).mutation(async ({ input }) => {
    // 1. Fetch all active (non-destroyed) instances created within the date range.
    //    Cap at 1000 to avoid excessively long fan-outs; the UI shows when capped.
    const MAX_SCAN = 1000;
    const instances = await db
      .select({
        id: kiloclaw_instances.id,
        user_id: kiloclaw_instances.user_id,
        sandbox_id: kiloclaw_instances.sandbox_id,
        organization_id: kiloclaw_instances.organization_id,
        created_at: kiloclaw_instances.created_at,
        user_email: kilocode_users.google_user_email,
        subscription_id: kiloclaw_subscriptions.id,
        subscription_status: kiloclaw_subscriptions.status,
      })
      .from(kiloclaw_instances)
      .leftJoin(kilocode_users, eq(kiloclaw_instances.user_id, kilocode_users.id))
      .leftJoin(
        kiloclaw_subscriptions,
        eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id)
      )
      .where(
        and(
          isNull(kiloclaw_instances.destroyed_at),
          gte(kiloclaw_instances.created_at, input.createdAfter),
          lte(kiloclaw_instances.created_at, input.createdBefore)
        )
      )
      .orderBy(desc(kiloclaw_instances.created_at))
      .limit(MAX_SCAN + 1);

    const capped = instances.length > MAX_SCAN;
    const toScan = capped ? instances.slice(0, MAX_SCAN) : instances;

    if (toScan.length === 0) {
      return { orphans: [], scanned: 0, capped: false };
    }

    // 2. Fan out getDebugStatus calls with concurrency limit.
    const CONCURRENCY = 10;
    const client = new KiloClawInternalClient();

    type OrphanResult = {
      id: string;
      user_id: string;
      sandbox_id: string;
      organization_id: string | null;
      created_at: string;
      user_email: string | null;
      subscription_id: string | null;
      subscription_status: string | null;
      workerStatusError: string | null;
    };

    const orphans: OrphanResult[] = [];

    for (let i = 0; i < toScan.length; i += CONCURRENCY) {
      const batch = toScan.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async instance => {
          const instId = instance.sandbox_id.startsWith('ki_') ? instance.id : undefined;
          const status = await client.getDebugStatus(instance.user_id, instId);
          return { instance, status };
        })
      );

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status === 'fulfilled') {
          const { instance, status } = result.value;
          // A null/undefined status means the DO has never been provisioned.
          if (!status?.status) {
            orphans.push({
              id: instance.id,
              user_id: instance.user_id,
              sandbox_id: instance.sandbox_id,
              organization_id: instance.organization_id,
              created_at: instance.created_at,
              user_email: instance.user_email,
              subscription_id: instance.subscription_id,
              subscription_status: instance.subscription_status,
              workerStatusError: null,
            });
          }
        } else {
          // If the status call itself failed, flag it as a potential orphan
          // with the error — the admin can investigate.
          const instance = batch[j];
          if (instance) {
            orphans.push({
              id: instance.id,
              user_id: instance.user_id,
              sandbox_id: instance.sandbox_id,
              organization_id: instance.organization_id,
              created_at: instance.created_at,
              user_email: instance.user_email,
              subscription_id: instance.subscription_id,
              subscription_status: instance.subscription_status,
              workerStatusError:
                result.reason instanceof Error ? result.reason.message : 'Status check failed',
            });
          }
        }
      }
    }

    return { orphans, scanned: toScan.length, capped };
  }),

  destroyOrphan: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      // Verify the instance exists and is not already destroyed.
      const [instance] = await db
        .select({
          id: kiloclaw_instances.id,
          user_id: kiloclaw_instances.user_id,
          sandbox_id: kiloclaw_instances.sandbox_id,
          destroyed_at: kiloclaw_instances.destroyed_at,
        })
        .from(kiloclaw_instances)
        .where(eq(kiloclaw_instances.id, input.id))
        .limit(1);

      if (!instance) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Instance not found' });
      }
      if (instance.destroyed_at !== null) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Instance is already destroyed' });
      }

      // Verify the instance is actually an orphan — the DO should have no state.
      // If it does, the admin should use the standard destroy flow instead.
      const client = new KiloClawInternalClient();
      const instId = instance.sandbox_id.startsWith('ki_') ? instance.id : undefined;
      const workerStatus = await client.getDebugStatus(instance.user_id, instId);
      if (workerStatus?.status) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Instance has active DO state (status: ${workerStatus.status}) — use the standard destroy flow instead`,
        });
      }

      console.log(
        `[admin-kiloclaw] Orphan cleanup by admin ${ctx.user.id} (${ctx.user.google_user_email}) for instance ${instance.id} (user: ${instance.user_id})`
      );

      // Soft-delete the DB row. No DO destroy needed — the DO was never
      // provisioned (that's what makes it an orphan).
      await markInstanceDestroyedById(instance.id);

      try {
        await createKiloClawAdminAuditLog({
          action: 'kiloclaw.orphan.destroy',
          actor_id: ctx.user.id,
          actor_email: ctx.user.google_user_email,
          actor_name: ctx.user.google_user_name,
          target_user_id: instance.user_id,
          message: `Orphaned instance destroyed: ${instance.sandbox_id}`,
          metadata: {
            reason: 'Orphaned instance — active DB row with no backing Durable Object',
            instance_id: instance.id,
            sandbox_id: instance.sandbox_id,
          },
        });
      } catch (auditErr) {
        console.error('[admin-kiloclaw] Failed to write audit log for orphan destroy:', auditErr);
      }

      return { success: true };
    }),

  setEarlyAccess: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        value: z.boolean(),
      })
    )
    .mutation(async ({ input }) => {
      const client = new KiloClawInternalClient();
      try {
        return await client.setUserKiloclawEarlyAccess(input.userId, input.value);
      } catch (err) {
        if (err instanceof KiloClawApiError && err.statusCode === 404) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
        }
        throw err;
      }
    }),
});
