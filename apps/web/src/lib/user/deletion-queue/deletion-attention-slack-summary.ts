import 'server-only';

import { sql } from 'drizzle-orm';
import { user_deletion_requests, user_deletion_steps } from '@kilocode/db/schema';
import { UserDeletionRequestStatus, UserDeletionStepStatus } from '@kilocode/db/schema-types';
import { APP_URL } from '@/lib/constants';
import { db } from '@/lib/drizzle';
import {
  sendAdminSlackNotification,
  type AdminSlackNotification,
} from '@/lib/slack/admin-notifications';
import {
  ACTIVE_REQUEST_STATUSES,
  DUPLICATE_OF_ACTIVE_REQUEST_ATTENTION_CODE,
} from '@/lib/user/deletion-queue/deletion-types';

const DETAIL_LIMIT = 25;
const DETAILS_PER_BLOCK = 5;

type DatabaseCount = string | number | bigint;

type UserDeletionAttentionQueryRow = {
  id: string | null;
  status: UserDeletionRequestStatus | null;
  created_at: string | Date | null;
  snapshot_at: string | Date;
  has_preflight_attention: boolean | null;
  has_step_attention: boolean | null;
  checked: DatabaseCount;
  actionable: DatabaseCount;
  pending: DatabaseCount;
  in_progress: DatabaseCount;
  finalizing: DatabaseCount;
  preflight: DatabaseCount;
  steps: DatabaseCount;
  overlapping: DatabaseCount;
};

export type UserDeletionAttentionDetail = {
  requestId: string;
  status: UserDeletionRequestStatus;
  createdAt: string;
  hasPreflightAttention: boolean;
  hasStepAttention: boolean;
};

export type UserDeletionAttentionSnapshot = {
  snapshotAt: string;
  checked: number;
  actionable: number;
  statusCounts: {
    pending: number;
    inProgress: number;
    finalizing: number;
  };
  attentionSourceCounts: {
    preflight: number;
    steps: number;
    overlapping: number;
  };
  details: UserDeletionAttentionDetail[];
};

export type UserDeletionAttentionSlackSummaryResult = {
  checked: number;
  actionable: number;
  listed: number;
};

function normalizeCount(value: DatabaseCount): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error('User deletion attention count is outside the supported range');
  }
  return normalized;
}

function normalizeTimestamp(value: string | Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('User deletion attention snapshot contains an invalid timestamp');
  }
  return date.toISOString();
}

function emptySnapshot(snapshotAt: string): UserDeletionAttentionSnapshot {
  return {
    snapshotAt,
    checked: 0,
    actionable: 0,
    statusCounts: { pending: 0, inProgress: 0, finalizing: 0 },
    attentionSourceCounts: { preflight: 0, steps: 0, overlapping: 0 },
    details: [],
  };
}

/**
 * Reads a strongly consistent, request-root snapshot. Correlated EXISTS checks
 * prevent multiple blocked steps from inflating request-level totals.
 */
export async function getUserDeletionAttentionSnapshot(): Promise<UserDeletionAttentionSnapshot> {
  const activeStatuses = sql.join(
    ACTIVE_REQUEST_STATUSES.map(status => sql`${status}`),
    sql`, `
  );
  const attentionStepStatuses = sql.join(
    [UserDeletionStepStatus.NeedsAttention, UserDeletionStepStatus.ManualActionRequired].map(
      status => sql`${status}`
    ),
    sql`, `
  );

  const { rows } = await db.execute<UserDeletionAttentionQueryRow>(sql`
    WITH request_attention AS (
      SELECT
        ${user_deletion_requests.id} AS id,
        ${user_deletion_requests.status} AS status,
        ${user_deletion_requests.created_at} AS created_at,
        now() AS snapshot_at,
        (
          ${user_deletion_requests.preflight_attention_code} IS NOT NULL
          AND ${user_deletion_requests.preflight_attention_code} <> ${DUPLICATE_OF_ACTIVE_REQUEST_ATTENTION_CODE}
        ) AS has_preflight_attention,
        EXISTS (
          SELECT 1
          FROM ${user_deletion_steps}
          WHERE ${user_deletion_steps.request_id} = ${user_deletion_requests.id}
            AND ${user_deletion_steps.status} IN (${attentionStepStatuses})
        ) AS has_step_attention
      FROM ${user_deletion_requests}
      WHERE ${user_deletion_requests.status} IN (${activeStatuses})
    ),
    totals AS (
      SELECT
        COALESCE(MAX(snapshot_at), now()) AS snapshot_at,
        COUNT(*) AS checked,
        COUNT(*) FILTER (WHERE has_preflight_attention OR has_step_attention) AS actionable,
        COUNT(*) FILTER (
          WHERE (has_preflight_attention OR has_step_attention)
            AND status = ${UserDeletionRequestStatus.Pending}
        ) AS pending,
        COUNT(*) FILTER (
          WHERE (has_preflight_attention OR has_step_attention)
            AND status = ${UserDeletionRequestStatus.InProgress}
        ) AS in_progress,
        COUNT(*) FILTER (
          WHERE (has_preflight_attention OR has_step_attention)
            AND status = ${UserDeletionRequestStatus.Finalizing}
        ) AS finalizing,
        COUNT(*) FILTER (WHERE has_preflight_attention) AS preflight,
        COUNT(*) FILTER (WHERE has_step_attention) AS steps,
        COUNT(*) FILTER (WHERE has_preflight_attention AND has_step_attention) AS overlapping
      FROM request_attention
    ),
    details AS (
      SELECT id, status, created_at, has_preflight_attention, has_step_attention
      FROM request_attention
      WHERE has_preflight_attention OR has_step_attention
      ORDER BY created_at ASC, id ASC
      LIMIT ${DETAIL_LIMIT}
    )
    SELECT
      NULL::uuid AS id,
      NULL::text AS status,
      NULL::timestamptz AS created_at,
      snapshot_at,
      NULL::boolean AS has_preflight_attention,
      NULL::boolean AS has_step_attention,
      checked,
      actionable,
      pending,
      in_progress,
      finalizing,
      preflight,
      steps,
      overlapping
    FROM totals
    UNION ALL
    SELECT
      details.id,
      details.status,
      details.created_at,
      totals.snapshot_at,
      details.has_preflight_attention,
      details.has_step_attention,
      totals.checked,
      totals.actionable,
      totals.pending,
      totals.in_progress,
      totals.finalizing,
      totals.preflight,
      totals.steps,
      totals.overlapping
    FROM details
    CROSS JOIN totals
    ORDER BY created_at ASC NULLS FIRST, id ASC NULLS FIRST
  `);

  const totals = rows[0];
  if (!totals) {
    throw new Error('User deletion attention snapshot did not return totals');
  }

  const snapshot = emptySnapshot(normalizeTimestamp(totals.snapshot_at));
  snapshot.checked = normalizeCount(totals.checked);
  snapshot.actionable = normalizeCount(totals.actionable);
  snapshot.statusCounts = {
    pending: normalizeCount(totals.pending),
    inProgress: normalizeCount(totals.in_progress),
    finalizing: normalizeCount(totals.finalizing),
  };
  snapshot.attentionSourceCounts = {
    preflight: normalizeCount(totals.preflight),
    steps: normalizeCount(totals.steps),
    overlapping: normalizeCount(totals.overlapping),
  };

  snapshot.details = rows.slice(1).flatMap(row => {
    if (!row.id || !row.status || !row.created_at) {
      throw new Error('User deletion attention snapshot contains an invalid detail row');
    }
    return [
      {
        requestId: row.id,
        status: row.status,
        createdAt: normalizeTimestamp(row.created_at),
        hasPreflightAttention: row.has_preflight_attention === true,
        hasStepAttention: row.has_step_attention === true,
      },
    ];
  });

  return snapshot;
}

function formatAge(snapshotAt: string, createdAt: string): string {
  const ageMinutes = Math.max(
    0,
    Math.floor((new Date(snapshotAt).getTime() - new Date(createdAt).getTime()) / 60_000)
  );
  const days = Math.floor(ageMinutes / (24 * 60));
  const hours = Math.floor((ageMinutes % (24 * 60)) / 60);
  const minutes = ageMinutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return 'under 1m';
}

function requestLink(requestId: string): string {
  return `${APP_URL}/admin/deletion-queue/${encodeURIComponent(requestId)}`;
}

function detailLine(detail: UserDeletionAttentionDetail, snapshotAt: string): string {
  return `<${requestLink(detail.requestId)}|${detail.requestId}> · ${detail.status} · ${formatAge(snapshotAt, detail.createdAt)}`;
}

export function buildUserDeletionAttentionSlackNotification(
  snapshot: UserDeletionAttentionSnapshot
): AdminSlackNotification {
  const listedDetails = snapshot.details.slice(0, DETAIL_LIMIT);
  const listedLines = listedDetails.map(detail => detailLine(detail, snapshot.snapshotAt));
  const omitted = snapshot.actionable - listedDetails.length;
  const text = [
    `GDPR deletion attention: ${snapshot.actionable} actionable request${snapshot.actionable === 1 ? '' : 's'}.`,
    `Status: pending ${snapshot.statusCounts.pending}, in progress ${snapshot.statusCounts.inProgress}, finalizing ${snapshot.statusCounts.finalizing}.`,
    `Sources: preflight ${snapshot.attentionSourceCounts.preflight}, blocked steps ${snapshot.attentionSourceCounts.steps}, both ${snapshot.attentionSourceCounts.overlapping}.`,
    ...listedLines,
    omitted > 0 ? `${omitted} additional request${omitted === 1 ? '' : 's'} omitted.` : null,
    `Queue: ${APP_URL}/admin/deletion-queue`,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  const blocks: NonNullable<AdminSlackNotification['blocks']> = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'GDPR deletion attention', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${snapshot.actionable} actionable request${snapshot.actionable === 1 ? '' : 's'}* · Pending ${snapshot.statusCounts.pending} · In progress ${snapshot.statusCounts.inProgress} · Finalizing ${snapshot.statusCounts.finalizing}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Attention sources* · Preflight ${snapshot.attentionSourceCounts.preflight} · Blocked steps ${snapshot.attentionSourceCounts.steps} · Both ${snapshot.attentionSourceCounts.overlapping}`,
      },
    },
  ];

  for (let index = 0; index < listedLines.length; index += DETAILS_PER_BLOCK) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: listedLines.slice(index, index + DETAILS_PER_BLOCK).join('\n'),
      },
    });
  }

  if (omitted > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `_${omitted} additional actionable request${omitted === 1 ? '' : 's'} not shown._`,
      },
    });
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Snapshot: ${snapshot.snapshotAt} · <${APP_URL}/admin/deletion-queue|Open deletion queue>`,
      },
    ],
  });

  return { text, blocks, unfurl_links: false, unfurl_media: false };
}

type UserDeletionAttentionSlackSummaryDependencies = {
  getSnapshot?: typeof getUserDeletionAttentionSnapshot;
  sendNotification?: typeof sendAdminSlackNotification;
};

export async function sendUserDeletionAttentionSlackSummary({
  getSnapshot = getUserDeletionAttentionSnapshot,
  sendNotification = sendAdminSlackNotification,
}: UserDeletionAttentionSlackSummaryDependencies = {}): Promise<UserDeletionAttentionSlackSummaryResult> {
  const snapshot = await getSnapshot();
  const result = {
    checked: snapshot.checked,
    actionable: snapshot.actionable,
    listed: snapshot.details.length,
  };
  if (snapshot.actionable === 0) return result;

  await sendNotification(buildUserDeletionAttentionSlackNotification(snapshot));
  return result;
}
