import 'server-only';

import { APP_URL } from '@/lib/constants';
import { getKeyInventoryCounts } from '@/lib/coding-plans';
import { getCodingPlanCatalog } from '@/lib/coding-plans/pricing';
import {
  sendAdminSlackNotification,
  type AdminSlackNotification,
} from '@/lib/slack/admin-notifications';

export type CodingPlanInventoryCount = {
  providerId: string;
  planId: string;
  status: string;
  count: number;
};

type InventoryPlanSummary = {
  providerId: string;
  providerName: string;
  planId: string;
  displayName: string;
  loaded: number;
  statusCounts: Record<string, number>;
};

export type CodingPlanInventoryTotals = {
  loaded: number;
  assigned: number;
  available: number;
  revocationPending: number;
  revocationFailed: number;
  revoked: number;
};

const KNOWN_STATUSES = new Set([
  'assigned',
  'available',
  'revocation_pending',
  'revocation_failed',
  'revoked',
]);

function statusCount(summary: InventoryPlanSummary, status: string): number {
  return summary.statusCounts[status] ?? 0;
}

function escapeSlackText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function humanizeStatus(status: string): string {
  return status.replaceAll('_', ' ');
}

function summarizeInventory(counts: CodingPlanInventoryCount[]): InventoryPlanSummary[] {
  const catalog = getCodingPlanCatalog();
  const catalogByPlanId = new Map<string, (typeof catalog)[number]>(
    catalog.map(plan => [plan.planId, plan])
  );
  const catalogOrder = new Map<string, number>(catalog.map((plan, index) => [plan.planId, index]));
  const summaries = new Map<string, InventoryPlanSummary>();

  for (const item of counts) {
    const key = `${item.providerId}\u0000${item.planId}`;
    const existing = summaries.get(key);
    const catalogPlan = catalogByPlanId.get(item.planId);
    const summary = existing ?? {
      providerId: item.providerId,
      providerName: catalogPlan?.providerName ?? item.providerId,
      planId: item.planId,
      displayName: catalogPlan?.name ?? item.planId,
      loaded: 0,
      statusCounts: {},
    };

    summary.loaded += item.count;
    summary.statusCounts[item.status] = (summary.statusCounts[item.status] ?? 0) + item.count;
    summaries.set(key, summary);
  }

  return Array.from(summaries.values()).sort((left, right) => {
    const leftOrder = catalogOrder.get(left.planId) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = catalogOrder.get(right.planId) ?? Number.MAX_SAFE_INTEGER;
    return (
      leftOrder - rightOrder ||
      left.providerId.localeCompare(right.providerId) ||
      left.planId.localeCompare(right.planId)
    );
  });
}

function inventoryTotals(summaries: InventoryPlanSummary[]): CodingPlanInventoryTotals {
  return summaries.reduce<CodingPlanInventoryTotals>(
    (totals, summary) => ({
      loaded: totals.loaded + summary.loaded,
      assigned: totals.assigned + statusCount(summary, 'assigned'),
      available: totals.available + statusCount(summary, 'available'),
      revocationPending: totals.revocationPending + statusCount(summary, 'revocation_pending'),
      revocationFailed: totals.revocationFailed + statusCount(summary, 'revocation_failed'),
      revoked: totals.revoked + statusCount(summary, 'revoked'),
    }),
    {
      loaded: 0,
      assigned: 0,
      available: 0,
      revocationPending: 0,
      revocationFailed: 0,
      revoked: 0,
    }
  );
}

function formatPlanSummary(summary: InventoryPlanSummary): string {
  const available = statusCount(summary, 'available');
  const assigned = statusCount(summary, 'assigned');
  const pending = statusCount(summary, 'revocation_pending');
  const failed = statusCount(summary, 'revocation_failed');
  const revoked = statusCount(summary, 'revoked');
  const isCatalogPlan = getCodingPlanCatalog().some(plan => plan.planId === summary.planId);
  const displayName = isCatalogPlan
    ? escapeSlackText(summary.displayName)
    : `\`${escapeSlackText(summary.displayName.replaceAll('`', "'"))}\``;
  const lines = [
    `*${displayName}*`,
    `${available} available · ${assigned} assigned · ${summary.loaded} loaded`,
  ];

  const lifecycleParts = [
    failed > 0 ? `${failed} failed revocation` : null,
    pending > 0 ? `${pending} pending revocation` : null,
    revoked > 0 ? `${revoked} revoked` : null,
  ].filter((value): value is string => value !== null);
  if (lifecycleParts.length > 0) {
    lines.push(`${failed > 0 || pending > 0 ? ':warning: ' : ''}${lifecycleParts.join(' · ')}`);
  }

  const unknownStatuses = Object.entries(summary.statusCounts)
    .filter(([status]) => !KNOWN_STATUSES.has(status))
    .sort(([left], [right]) => left.localeCompare(right));
  if (unknownStatuses.length > 0) {
    lines.push(
      unknownStatuses
        .map(([status, count]) => `${count} ${escapeSlackText(humanizeStatus(status))}`)
        .join(' · ')
    );
  }

  return lines.join('\n');
}

function formatSnapshotTime(timestamp: Date): string {
  return timestamp
    .toISOString()
    .replace('T', ' ')
    .replace(/:\d{2}\.\d{3}Z$/, ' UTC');
}

export function buildCodingPlanInventorySlackNotification(
  counts: CodingPlanInventoryCount[],
  timestamp = new Date()
): { notification: AdminSlackNotification; totals: CodingPlanInventoryTotals } {
  const summaries = summarizeInventory(counts);
  const totals = inventoryTotals(summaries);
  const needsAttention = totals.revocationFailed + totals.revocationPending;
  const providerNames = Array.from(new Set(summaries.map(summary => summary.providerName)));
  const providerLabel = providerNames.length > 0 ? providerNames.join(', ') : 'All providers';
  const planAvailability = summaries
    .map(summary => `${summary.displayName}: ${statusCount(summary, 'available')} available`)
    .join('. ');
  const attentionFallback = [
    totals.revocationFailed > 0 ? `${totals.revocationFailed} failed revocation` : null,
    totals.revocationPending > 0 ? `${totals.revocationPending} pending revocation` : null,
  ]
    .filter((value): value is string => value !== null)
    .join(', ');
  const text = [
    `Coding Plans inventory: ${totals.available} available, ${totals.assigned} assigned, ${totals.loaded} loaded`,
    attentionFallback || null,
    planAvailability || 'No inventory recorded',
  ]
    .filter((value): value is string => value !== null)
    .join('. ')
    .concat('.');

  const blocks: NonNullable<AdminSlackNotification['blocks']> = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Coding Plans inventory', emoji: true },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `${escapeSlackText(providerLabel)} · Current snapshot` }],
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*${totals.available}*\nAvailable` },
        { type: 'mrkdwn', text: `*${totals.assigned}*\nAssigned` },
        { type: 'mrkdwn', text: `*${totals.loaded}*\nLoaded` },
        { type: 'mrkdwn', text: `*${needsAttention}*\nNeeds attention` },
      ],
    },
    { type: 'divider' },
  ];

  if (summaries.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: 'No Coding Plans inventory is currently recorded.' },
    });
  } else {
    for (const summary of summaries) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: formatPlanSummary(summary) },
      });
    }
  }

  if (needsAttention > 0) {
    const attentionLines = [
      totals.revocationFailed > 0
        ? `:rotating_light: *Action required:* ${totals.revocationFailed} credential${totals.revocationFailed === 1 ? '' : 's'} failed revocation.`
        : null,
      totals.revocationPending > 0
        ? `:warning: *${totals.revocationPending} credential${totals.revocationPending === 1 ? ' is' : 's are'} pending revocation.*`
        : null,
    ].filter((value): value is string => value !== null);
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: attentionLines.join('\n') } });
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Snapshot: ${formatSnapshotTime(timestamp)} · <${APP_URL}/admin/coding-plans|Open Coding Plans>`,
      },
    ],
  });

  return {
    totals,
    notification: { text, blocks, unfurl_links: false, unfurl_media: false },
  };
}

type InventorySummaryDependencies = {
  getCounts?: typeof getKeyInventoryCounts;
  sendNotification?: typeof sendAdminSlackNotification;
};

export async function sendCodingPlanInventorySlackSummary({
  getCounts = getKeyInventoryCounts,
  sendNotification = sendAdminSlackNotification,
}: InventorySummaryDependencies = {}): Promise<CodingPlanInventoryTotals> {
  const counts = await getCounts();
  const { notification, totals } = buildCodingPlanInventorySlackNotification(counts);
  await sendNotification(notification);
  return totals;
}
