import 'server-only';

import * as z from 'zod';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import pLimit from 'p-limit';

import { decryptApiKey } from '@/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';
import { MINIMAX_USAGE_URL } from '@/lib/coding-plans/minimax-usage';
import { getCodingPlanCatalog } from '@/lib/coding-plans/pricing';
import { db } from '@/lib/drizzle';
import {
  sendAdminSlackNotification,
  type AdminSlackNotification,
} from '@/lib/slack/admin-notifications';
import { sentryLogger } from '@/lib/utils.server';
import { coding_plan_key_inventory, coding_plan_subscriptions } from '@kilocode/db/schema';
import { CodingPlanSubscriptionStatus } from '@kilocode/db/schema-types';
import type { EncryptedData } from '@kilocode/db/schema-types';

const MINIMAX_HEALTH_CHECK_TIMEOUT_MS = 8_000;

const logBadResponse = sentryLogger('minimax-token-health', 'info');

// MiniMax has been observed to apply dynamic rate limiting under load
// (see the 2026-09-15 Token Plan incident), so this sweep bounds its own
// fan-out to avoid generating a burst of load that produces its own denials.
const MINIMAX_TOKEN_HEALTH_CONCURRENCY = 5;

const DETAIL_LIMIT = 40;

// Deliberately narrower than the billing-facing MiniMaxUsageResponseSchema in
// minimax-usage.ts: this probe only needs to classify the response shape, not
// parse quota percentages, so it stays robust to fields that don't matter here.
const MiniMaxTokenPlanRemainsProbeSchema = z.object({
  base_resp: z.object({ status_code: z.number().int() }),
  model_remains: z
    .array(z.object({ model_name: z.string().min(1).max(128) }))
    .max(64)
    .nullish(),
});

export type MiniMaxTokenHealthCategory =
  | 'healthy'
  | 'bad_response'
  | 'denied'
  | 'unreachable'
  | 'configuration';

export type MiniMaxTokenHealthProbeResult = {
  category: MiniMaxTokenHealthCategory;
  reason: string;
  httpStatus?: number;
};

// Only 401/403 indicate the credential itself was rejected; everything else
// must not be escalated as `denied`, since that drives immediate follow-up
// alerts in Slack for what may just be a transient or unrelated failure:
// - 408/429/5xx reflect timeouts, dynamic rate limiting, or upstream outages
//   (see the 2026-09-15 Token Plan incident note above), not access denial.
// - Other unexpected client/protocol statuses (400, 404, 422, etc.) indicate
//   a changed endpoint or malformed request, not a bad API key, so they are
//   bucketed with the response-shape failures as `bad_response`.
function classifyHttpErrorStatus(status: number): MiniMaxTokenHealthCategory {
  if (status === 401 || status === 403) {
    return 'denied';
  }
  if (status === 408 || status === 429 || status >= 500) {
    return 'unreachable';
  }
  return 'bad_response';
}

export async function probeMiniMaxTokenPlanRemains(
  apiKey: string
): Promise<MiniMaxTokenHealthProbeResult> {
  let response: Response;
  try {
    response = await fetch(MINIMAX_USAGE_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(MINIMAX_HEALTH_CHECK_TIMEOUT_MS),
    });
  } catch {
    return { category: 'unreachable', reason: 'network_error' };
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const category = classifyHttpErrorStatus(response.status);
    return { category, reason: `http_${response.status}`, httpStatus: response.status };
  }

  const json: unknown = await response.json().catch(() => null);
  const parsed = MiniMaxTokenPlanRemainsProbeSchema.safeParse(json);
  if (!parsed.success) {
    return { category: 'bad_response', reason: 'invalid_response' };
  }
  if (parsed.data.base_resp.status_code !== 0) {
    return {
      category: 'bad_response',
      reason: `application_status_${parsed.data.base_resp.status_code}`,
    };
  }

  const rows = parsed.data.model_remains;
  if (rows === null || rows === undefined) {
    return { category: 'bad_response', reason: 'invalid_response' };
  }
  if (rows.length === 0) {
    return { category: 'bad_response', reason: 'provider_plan_inactive' };
  }
  // Mirrors normalizeUsage's aggregateRows.length !== 1 check in
  // minimax-usage.ts: a response with zero or multiple `general` rows is
  // ambiguous/malformed and must not be reported as healthy.
  const aggregateRows = rows.filter(row => row.model_name === 'general');
  if (aggregateRows.length !== 1) {
    return { category: 'bad_response', reason: 'missing_aggregate_row' };
  }

  return { category: 'healthy', reason: 'ok' };
}

export type MiniMaxTokenHealthTarget = {
  inventoryId: string;
  planId: string;
  upstreamPlanId: string;
  encryptedApiKey: EncryptedData | null;
  subscriptionId: string | null;
  userId: string | null;
  subscriptionStatus: CodingPlanSubscriptionStatus | null;
};

// Nothing in the schema enforces at most one live (active/past_due)
// subscription per key_inventory_id (only per user+plan and per
// user+provider), so the leftJoin below can legitimately fan out to more
// than one row for the same key. dedupeByMostRecentLiveSubscription collapses
// that fan-out back to one row per key, keeping the most recently created
// live subscription, so a duplicate can't cause the same key to be probed
// (and counted) more than once.
function dedupeByMostRecentLiveSubscription<
  T extends { inventoryId: string; subscriptionCreatedAt: string | null },
>(rows: T[]): T[] {
  const byInventoryId = new Map<string, T>();
  for (const row of rows) {
    const existing = byInventoryId.get(row.inventoryId);
    if (!existing || (row.subscriptionCreatedAt ?? '') > (existing.subscriptionCreatedAt ?? '')) {
      byInventoryId.set(row.inventoryId, row);
    }
  }
  return Array.from(byInventoryId.values());
}

// Every assigned MiniMax key should have a live (active/past_due) subscription
// per coding_plan_subscriptions_live_access_check, but the join is left so a
// key whose subscription already canceled (and hasn't been revoked yet) still
// gets checked instead of silently dropped.
export async function getMiniMaxTokenHealthTargets(): Promise<MiniMaxTokenHealthTarget[]> {
  const rows = await db
    .select({
      inventoryId: coding_plan_key_inventory.id,
      planId: coding_plan_key_inventory.plan_id,
      upstreamPlanId: coding_plan_key_inventory.upstream_plan_id,
      encryptedApiKey: coding_plan_key_inventory.encrypted_api_key,
      subscriptionId: coding_plan_subscriptions.id,
      userId: coding_plan_subscriptions.user_id,
      subscriptionStatus: coding_plan_subscriptions.status,
      subscriptionCreatedAt: coding_plan_subscriptions.created_at,
    })
    .from(coding_plan_key_inventory)
    .leftJoin(
      coding_plan_subscriptions,
      and(
        eq(coding_plan_subscriptions.key_inventory_id, coding_plan_key_inventory.id),
        inArray(coding_plan_subscriptions.status, [
          CodingPlanSubscriptionStatus.Active,
          CodingPlanSubscriptionStatus.PastDue,
        ])
      )
    )
    .where(
      and(
        eq(coding_plan_key_inventory.provider_id, 'minimax'),
        eq(coding_plan_key_inventory.status, 'assigned'),
        isNotNull(coding_plan_key_inventory.encrypted_api_key)
      )
    )
    .orderBy(coding_plan_key_inventory.plan_id, coding_plan_key_inventory.created_at);

  return dedupeByMostRecentLiveSubscription(rows).map(
    ({ subscriptionCreatedAt: _subscriptionCreatedAt, ...target }) => target
  );
}

export type MiniMaxTokenHealthEntry = Omit<MiniMaxTokenHealthTarget, 'encryptedApiKey'> &
  MiniMaxTokenHealthProbeResult;

function isLiveSubscription(entry: MiniMaxTokenHealthEntry): boolean {
  return (
    entry.subscriptionStatus === CodingPlanSubscriptionStatus.Active ||
    entry.subscriptionStatus === CodingPlanSubscriptionStatus.PastDue
  );
}

export function needsImmediateFollowUp(entry: MiniMaxTokenHealthEntry): boolean {
  return isLiveSubscription(entry) && entry.category !== 'healthy';
}

type CheckAllDependencies = {
  getTargets?: typeof getMiniMaxTokenHealthTargets;
  probe?: typeof probeMiniMaxTokenPlanRemains;
};

export async function checkAllMiniMaxTokenHealth({
  getTargets = getMiniMaxTokenHealthTargets,
  probe = probeMiniMaxTokenPlanRemains,
}: CheckAllDependencies = {}): Promise<MiniMaxTokenHealthEntry[]> {
  const targets = await getTargets();
  const limit = pLimit(MINIMAX_TOKEN_HEALTH_CONCURRENCY);

  return Promise.all(
    targets.map(({ encryptedApiKey, ...target }) =>
      limit(async (): Promise<MiniMaxTokenHealthEntry> => {
        if (!encryptedApiKey) {
          return { ...target, category: 'configuration', reason: 'missing_api_key' };
        }

        let apiKey: string;
        try {
          apiKey = decryptApiKey(encryptedApiKey, BYOK_ENCRYPTION_KEY);
        } catch {
          return { ...target, category: 'configuration', reason: 'decryption_failed' };
        }

        const result = await probe(apiKey);
        return { ...target, ...result };
      })
    )
  );
}

export type MiniMaxTokenHealthTotals = {
  checked: number;
  healthy: number;
  badResponse: number;
  denied: number;
  unreachable: number;
  configuration: number;
  needsFollowUp: number;
};

function summarizeTotals(entries: MiniMaxTokenHealthEntry[]): MiniMaxTokenHealthTotals {
  return entries.reduce<MiniMaxTokenHealthTotals>(
    (totals, entry) => ({
      checked: totals.checked + 1,
      healthy: totals.healthy + (entry.category === 'healthy' ? 1 : 0),
      badResponse: totals.badResponse + (entry.category === 'bad_response' ? 1 : 0),
      denied: totals.denied + (entry.category === 'denied' ? 1 : 0),
      unreachable: totals.unreachable + (entry.category === 'unreachable' ? 1 : 0),
      configuration: totals.configuration + (entry.category === 'configuration' ? 1 : 0),
      needsFollowUp: totals.needsFollowUp + (needsImmediateFollowUp(entry) ? 1 : 0),
    }),
    {
      checked: 0,
      healthy: 0,
      badResponse: 0,
      denied: 0,
      unreachable: 0,
      configuration: 0,
      needsFollowUp: 0,
    }
  );
}

function formatCount(count: number): string {
  return `\`${count}\``;
}

// Mirrors escapeSlackText/escapeSlackLabel in inventory-slack-summary.ts:
// planId, upstreamPlanId, and subscriptionId are DB-derived and must not be
// interpolated into Slack mrkdwn unescaped.
function escapeSlackText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeSlackLabel(value: string): string {
  return escapeSlackText(value).replaceAll('`', "'").replaceAll('\n', ' ');
}

function planDisplayName(planId: string): string {
  const plan = getCodingPlanCatalog().find(entry => entry.planId === planId);
  return escapeSlackLabel(plan ? `${plan.providerName} ${plan.name}` : planId);
}

function formatTotalsLine(totals: MiniMaxTokenHealthTotals): string {
  return `*Checked* ${formatCount(totals.checked)} · Healthy ${formatCount(totals.healthy)} · Denied ${formatCount(totals.denied)} · Bad response ${formatCount(totals.badResponse)} · Unreachable ${formatCount(totals.unreachable)} · Config ${formatCount(totals.configuration)}`;
}

function followUpLine(entry: MiniMaxTokenHealthEntry): string {
  const statusLabel = entry.subscriptionStatus ?? 'unknown';
  const httpStatus = entry.httpStatus ? ` (HTTP ${entry.httpStatus})` : '';
  const upstreamPlanId = escapeSlackLabel(entry.upstreamPlanId);
  const subscriptionId = escapeSlackLabel(entry.subscriptionId ?? 'n/a');
  const userId = escapeSlackLabel(entry.userId ?? 'n/a');
  return `${planDisplayName(entry.planId)} · upstream \`${upstreamPlanId}\` · sub \`${subscriptionId}\` (${statusLabel}) · user \`${userId}\` · *${entry.category}*: ${entry.reason}${httpStatus}`;
}

export function buildMiniMaxTokenHealthSlackNotification(
  entries: MiniMaxTokenHealthEntry[],
  timestamp = new Date()
): { notification: AdminSlackNotification; totals: MiniMaxTokenHealthTotals } {
  const totals = summarizeTotals(entries);
  const followUps = entries
    .filter(needsImmediateFollowUp)
    .sort((left, right) => left.planId.localeCompare(right.planId));
  const listed = followUps.slice(0, DETAIL_LIMIT);
  const omitted = followUps.length - listed.length;

  const text = [
    `MiniMax token health: ${formatCount(totals.checked)} checked, ${formatCount(totals.healthy)} healthy, ${formatCount(totals.needsFollowUp)} active subscription${totals.needsFollowUp === 1 ? '' : 's'} need follow-up.`,
    `Denied ${totals.denied} · Bad response ${totals.badResponse} · Unreachable ${totals.unreachable} · Config ${totals.configuration}.`,
  ].join(' ');

  const blocks: NonNullable<AdminSlackNotification['blocks']> = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'MiniMax token health', emoji: true },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'GET /v1/token_plan/remains · Current sweep' }],
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: formatTotalsLine(totals) },
    },
  ];

  if (totals.needsFollowUp === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: ':white_check_mark: No active subscriptions need follow-up.' },
    });
  } else {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:rotating_light: *${formatCount(totals.needsFollowUp)} active subscription${totals.needsFollowUp === 1 ? '' : 's'} need immediate follow-up:*`,
      },
    });
    for (const entry of listed) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: followUpLine(entry) },
      });
    }
    if (omitted > 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `_${omitted} additional entr${omitted === 1 ? 'y' : 'ies'} not shown._`,
        },
      });
    }
  }

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Snapshot: ${timestamp.toISOString()}` }],
  });

  return {
    totals,
    notification: { text, blocks, unfurl_links: false, unfurl_media: false },
  };
}

// Slack truncates the follow-up list to DETAIL_LIMIT and only lists entries
// with a live subscription, so this logs every `bad_response` entry (the
// category that can't be told apart from a denied/unreachable credential by
// HTTP status alone) with its raw reason so the underlying cause is visible
// in cron logs even when Slack omits or aggregates it.
function logBadResponseEntries(entries: MiniMaxTokenHealthEntry[]): void {
  for (const entry of entries) {
    if (entry.category !== 'bad_response') continue;
    logBadResponse('MiniMax token health bad_response', {
      inventoryId: entry.inventoryId,
      planId: entry.planId,
      upstreamPlanId: entry.upstreamPlanId,
      subscriptionId: entry.subscriptionId,
      userId: entry.userId,
      subscriptionStatus: entry.subscriptionStatus,
      reason: entry.reason,
      httpStatus: entry.httpStatus,
    });
  }
}

type SendSummaryDependencies = {
  checkAll?: typeof checkAllMiniMaxTokenHealth;
  sendNotification?: typeof sendAdminSlackNotification;
};

export async function sendMiniMaxTokenHealthSlackSummary({
  checkAll = checkAllMiniMaxTokenHealth,
  sendNotification = sendAdminSlackNotification,
}: SendSummaryDependencies = {}): Promise<MiniMaxTokenHealthTotals> {
  const entries = await checkAll();
  logBadResponseEntries(entries);
  const { notification, totals } = buildMiniMaxTokenHealthSlackNotification(entries);
  await sendNotification(notification);
  return totals;
}
