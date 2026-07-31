import 'server-only';

import { db } from '@/lib/drizzle';
import { isNewSession } from '@/lib/cloud-agent/session-type';
import {
  containerCapacityForService,
  type ContainerCapacity,
} from '@/lib/cloudflare/container-capacity';
import {
  queryContainerMetricsAnalytics,
  type ContainerMetricsResult,
} from '@/lib/cloudflare/container-metrics-analytics';
import {
  cliSessions,
  cli_sessions_v2,
  cloud_agent_session_runs,
  cloud_agent_sessions,
  cloud_billing_sku,
  container_usage_interval,
} from '@kilocode/db/schema';
import { and, asc, eq, gt, like, lt, or } from 'drizzle-orm';
import * as z from 'zod';

const SESSION_METRICS_PADDING_MS = 10 * 60 * 1_000;

const capacityMetadataSchema = z
  .object({
    durable_object_id: z.string().min(1),
    container_class: z.string().optional(),
    vcpu: z.string().optional(),
    memory_mib: z.string().optional(),
    disk_mb: z.string().optional(),
  })
  .passthrough();

type SessionReference = {
  cloudAgentSessionId: string;
  subjectType: 'user' | 'org';
  subjectId: string;
  createdAt: string;
  updatedAt: string;
};

export type SessionContainerInterval = {
  id: string;
  service: string;
  sandboxId: string;
  cloudflareInstanceId: string | null;
  containerClass: string | null;
  startedAt: string;
  lastSeenAt: string;
  stoppedAt: string | null;
  status: 'open' | 'closed';
  closeReason: string | null;
  exitCode: number | null;
  sku: {
    id: string;
    name: string;
    description: string | null;
  };
  capacity: ContainerCapacity | null;
  capacitySource: 'recorded' | 'configured' | null;
};

export type SessionContainerInfo = {
  cloudAgentSessionId: string;
  sandboxId: string | null;
  scope: 'isolated' | 'shared' | 'unknown';
  windowStartAt: string;
  windowEndAt: string;
  intervals: SessionContainerInterval[];
  runs: Array<{
    messageId: string;
    status: string;
    queuedAt: string | null;
    dispatchAcceptedAt: string | null;
    agentActivityObservedAt: string | null;
    terminalAt: string | null;
  }>;
};

function iso(value: string | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

async function resolveSessionReference(sessionId: string): Promise<SessionReference | null> {
  if (isNewSession(sessionId)) {
    const [session] = await db
      .select({
        cloudAgentSessionId: cli_sessions_v2.cloud_agent_session_id,
        cloudAgentSessionScopeId: cli_sessions_v2.cloud_agent_session_scope_id,
        kiloUserId: cli_sessions_v2.kilo_user_id,
        organizationId: cli_sessions_v2.organization_id,
        createdAt: cli_sessions_v2.created_at,
        updatedAt: cli_sessions_v2.updated_at,
      })
      .from(cli_sessions_v2)
      .where(eq(cli_sessions_v2.session_id, sessionId))
      .limit(1);
    const cloudAgentSessionId = session?.cloudAgentSessionId ?? session?.cloudAgentSessionScopeId;
    if (!session || !cloudAgentSessionId) return null;
    return {
      cloudAgentSessionId,
      subjectType: session.organizationId ? 'org' : 'user',
      subjectId: session.organizationId ?? session.kiloUserId,
      createdAt: new Date(session.createdAt).toISOString(),
      updatedAt: new Date(session.updatedAt).toISOString(),
    };
  }

  const [session] = await db
    .select({
      cloudAgentSessionId: cliSessions.cloud_agent_session_id,
      kiloUserId: cliSessions.kilo_user_id,
      organizationId: cliSessions.organization_id,
      createdAt: cliSessions.created_at,
      updatedAt: cliSessions.updated_at,
    })
    .from(cliSessions)
    .where(eq(cliSessions.session_id, sessionId))
    .limit(1);
  if (!session?.cloudAgentSessionId) return null;
  return {
    cloudAgentSessionId: session.cloudAgentSessionId,
    subjectType: session.organizationId ? 'org' : 'user',
    subjectId: session.organizationId ?? session.kiloUserId,
    createdAt: new Date(session.createdAt).toISOString(),
    updatedAt: new Date(session.updatedAt).toISOString(),
  };
}

function recordedCapacity(
  metadata: z.infer<typeof capacityMetadataSchema>
): ContainerCapacity | null {
  const vcpu = Number(metadata.vcpu);
  const memoryMiB = Number(metadata.memory_mib);
  const diskMB = Number(metadata.disk_mb);
  if (
    !Number.isInteger(vcpu) ||
    vcpu <= 0 ||
    !Number.isInteger(memoryMiB) ||
    memoryMiB <= 0 ||
    !Number.isInteger(diskMB) ||
    diskMB <= 0
  ) {
    return null;
  }
  return {
    vcpu,
    memoryBytes: memoryMiB * 1024 ** 2,
    diskBytes: diskMB * 1_000_000,
  };
}

export async function getSessionContainerInfo(
  sessionId: string
): Promise<SessionContainerInfo | null> {
  const reference = await resolveSessionReference(sessionId);
  if (!reference) return null;

  const [report] = await db
    .select({ sandboxId: cloud_agent_sessions.sandbox_id })
    .from(cloud_agent_sessions)
    .where(eq(cloud_agent_sessions.cloud_agent_session_id, reference.cloudAgentSessionId))
    .limit(1);
  const sandboxId = report?.sandboxId ?? null;
  const runRows = await db
    .select({
      messageId: cloud_agent_session_runs.message_id,
      status: cloud_agent_session_runs.status,
      queuedAt: cloud_agent_session_runs.queued_at,
      dispatchAcceptedAt: cloud_agent_session_runs.dispatch_accepted_at,
      agentActivityObservedAt: cloud_agent_session_runs.agent_activity_observed_at,
      terminalAt: cloud_agent_session_runs.terminal_at,
    })
    .from(cloud_agent_session_runs)
    .where(eq(cloud_agent_session_runs.cloud_agent_session_id, reference.cloudAgentSessionId))
    .orderBy(asc(cloud_agent_session_runs.queued_at), asc(cloud_agent_session_runs.message_id));
  const observedTimes = runRows.flatMap(run =>
    [run.queuedAt, run.dispatchAcceptedAt, run.agentActivityObservedAt, run.terminalAt].flatMap(
      value => (value ? [Date.parse(value)] : [])
    )
  );
  const windowStartMs =
    Math.min(Date.parse(reference.createdAt), ...observedTimes) - SESSION_METRICS_PADDING_MS;
  const windowEndMs =
    Math.max(Date.parse(reference.updatedAt), ...observedTimes) + SESSION_METRICS_PADDING_MS;
  const windowStartAt = new Date(windowStartMs).toISOString();
  const windowEndAt = new Date(windowEndMs).toISOString();
  const overlapsSessionWindow = and(
    lt(container_usage_interval.started_at, windowEndAt),
    gt(container_usage_interval.last_seen_at, windowStartAt)
  );
  const intervalIdentityCondition = sandboxId
    ? or(
        eq(container_usage_interval.session_id, reference.cloudAgentSessionId),
        eq(container_usage_interval.instance_id, sandboxId)
      )
    : eq(container_usage_interval.session_id, reference.cloudAgentSessionId);

  const intervalRows = await db
    .select({
      id: container_usage_interval.id,
      service: container_usage_interval.service,
      sandboxId: container_usage_interval.instance_id,
      metadata: container_usage_interval.metadata,
      startedAt: container_usage_interval.started_at,
      lastSeenAt: container_usage_interval.last_seen_at,
      stoppedAt: container_usage_interval.stopped_at,
      status: container_usage_interval.status,
      closeReason: container_usage_interval.close_reason,
      exitCode: container_usage_interval.exit_code,
      skuId: cloud_billing_sku.id,
      skuName: cloud_billing_sku.name,
      skuDescription: cloud_billing_sku.description,
    })
    .from(container_usage_interval)
    .innerJoin(
      cloud_billing_sku,
      eq(container_usage_interval.cloud_billing_sku_id, cloud_billing_sku.id)
    )
    .where(
      and(
        eq(container_usage_interval.subject_type, reference.subjectType),
        eq(container_usage_interval.subject_id, reference.subjectId),
        like(container_usage_interval.service, 'cloud-agent-next%'),
        overlapsSessionWindow,
        intervalIdentityCondition
      )
    )
    .orderBy(asc(container_usage_interval.started_at), asc(container_usage_interval.id));

  const intervals = intervalRows.map(row => {
    const parsedMetadata = capacityMetadataSchema.safeParse(row.metadata);
    const metadata = parsedMetadata.success ? parsedMetadata.data : null;
    const recorded = metadata ? recordedCapacity(metadata) : null;
    const configured = containerCapacityForService(row.service);
    return {
      id: row.id,
      service: row.service,
      sandboxId: row.sandboxId,
      cloudflareInstanceId: metadata?.durable_object_id ?? null,
      containerClass: metadata?.container_class ?? null,
      startedAt: new Date(row.startedAt).toISOString(),
      lastSeenAt: new Date(row.lastSeenAt).toISOString(),
      stoppedAt: iso(row.stoppedAt),
      status: row.status,
      closeReason: row.closeReason,
      exitCode: row.exitCode,
      sku: { id: row.skuId, name: row.skuName, description: row.skuDescription },
      capacity: recorded ?? configured,
      capacitySource: recorded
        ? ('recorded' as const)
        : configured
          ? ('configured' as const)
          : null,
    } satisfies SessionContainerInterval;
  });

  return {
    cloudAgentSessionId: reference.cloudAgentSessionId,
    sandboxId,
    scope: !sandboxId
      ? 'unknown'
      : sandboxId.startsWith('ses-') ||
          sandboxId.startsWith('crv-') ||
          sandboxId.startsWith('dind-')
        ? 'isolated'
        : 'shared',
    windowStartAt,
    windowEndAt,
    intervals,
    runs: runRows.map(run => ({
      messageId: run.messageId,
      status: run.status,
      queuedAt: iso(run.queuedAt),
      dispatchAcceptedAt: iso(run.dispatchAcceptedAt),
      agentActivityObservedAt: iso(run.agentActivityObservedAt),
      terminalAt: iso(run.terminalAt),
    })),
  };
}

export type SessionContainerMetrics =
  | {
      available: false;
      reason:
        | 'not_cloud_agent_session'
        | 'no_container_intervals'
        | 'no_provider_identity'
        | 'no_overlapping_intervals'
        | 'ambiguous_application';
    }
  | ({ available: true } & ContainerMetricsResult);

export async function getSessionContainerMetricsForInfo(
  info: SessionContainerInfo,
  queryMetrics: typeof queryContainerMetricsAnalytics = queryContainerMetricsAnalytics
): Promise<SessionContainerMetrics> {
  if (info.intervals.length === 0) return { available: false, reason: 'no_container_intervals' };
  const intervalsWithProviderIdentity = info.intervals.filter(
    (
      interval
    ): interval is SessionContainerInterval & {
      cloudflareInstanceId: string;
    } => interval.cloudflareInstanceId !== null
  );
  if (intervalsWithProviderIdentity.length === 0) {
    return { available: false, reason: 'no_provider_identity' };
  }
  const windows = intervalsWithProviderIdentity.flatMap(interval => {
    const start = new Date(
      Math.max(Date.parse(interval.startedAt), Date.parse(info.windowStartAt))
    ).toISOString();
    const end = new Date(
      Math.min(Date.parse(interval.stoppedAt ?? interval.lastSeenAt), Date.parse(info.windowEndAt))
    ).toISOString();
    if (Date.parse(end) <= Date.parse(start)) return [];
    return [
      {
        key: interval.id,
        instanceId: interval.cloudflareInstanceId,
        start,
        end,
      },
    ];
  });
  if (windows.length === 0) return { available: false, reason: 'no_overlapping_intervals' };
  const metrics = await queryMetrics({ windows });
  const applicationIds = new Set(metrics.rows.map(row => row.applicationId));
  if (applicationIds.size > 1) {
    return { available: false, reason: 'ambiguous_application' };
  }
  return { available: true, ...metrics };
}

export async function getSessionContainerMetrics(
  sessionId: string,
  queryMetrics: typeof queryContainerMetricsAnalytics = queryContainerMetricsAnalytics
): Promise<SessionContainerMetrics> {
  const info = await getSessionContainerInfo(sessionId);
  return info
    ? getSessionContainerMetricsForInfo(info, queryMetrics)
    : { available: false, reason: 'not_cloud_agent_session' };
}
