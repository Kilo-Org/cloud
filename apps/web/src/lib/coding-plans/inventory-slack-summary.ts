import 'server-only';

import { APP_URL } from '@/lib/constants';
import { getCodingPlanAvailabilityIntentCounts, getKeyInventoryCounts } from '@/lib/coding-plans';
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

export type CodingPlanWaitlistCount = {
  planId: string;
  count: number;
};

type InventoryPlanSummary = {
  providerId: string;
  providerName: string;
  planId: string;
  displayName: string;
  loaded: number;
  waitlist: number;
  statusCounts: Record<string, number>;
};

export type CodingPlanInventoryTotals = {
  loaded: number;
  assigned: number;
  available: number;
  waitlist: number;
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

function escapeSlackLabel(value: string): string {
  return escapeSlackText(value).replaceAll('`', "'").replaceAll('\n', ' ');
}

function formatCount(count: number): string {
  return `\`${count}\``;
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
      waitlist: 0,
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

function addWaitlistCounts(
  summaries: InventoryPlanSummary[],
  counts: CodingPlanWaitlistCount[]
): InventoryPlanSummary[] {
  const catalog = getCodingPlanCatalog();
  const catalogByPlanId = new Map<string, (typeof catalog)[number]>(
    catalog.map(plan => [plan.planId, plan])
  );
  const summariesByPlanId = new Map(summaries.map(summary => [summary.planId, summary]));

  for (const item of counts) {
    const existing = summariesByPlanId.get(item.planId);
    if (existing) {
      existing.waitlist = item.count;
      continue;
    }

    const catalogPlan = catalogByPlanId.get(item.planId);
    const summary: InventoryPlanSummary = {
      providerId: catalogPlan?.providerId ?? 'unknown',
      providerName: catalogPlan?.providerName ?? 'Unknown provider',
      planId: item.planId,
      displayName: catalogPlan?.name ?? item.planId,
      loaded: 0,
      waitlist: item.count,
      statusCounts: {},
    };
    summariesByPlanId.set(item.planId, summary);
    summaries.push(summary);
  }

  return summaries;
}

function inventoryTotals(summaries: InventoryPlanSummary[]): CodingPlanInventoryTotals {
  return summaries.reduce<CodingPlanInventoryTotals>(
    (totals, summary) => ({
      loaded: totals.loaded + summary.loaded,
      assigned: totals.assigned + statusCount(summary, 'assigned'),
      available: totals.available + statusCount(summary, 'available'),
      waitlist: totals.waitlist + summary.waitlist,
      revocationPending: totals.revocationPending + statusCount(summary, 'revocation_pending'),
      revocationFailed: totals.revocationFailed + statusCount(summary, 'revocation_failed'),
      revoked: totals.revoked + statusCount(summary, 'revoked'),
    }),
    {
      loaded: 0,
      assigned: 0,
      available: 0,
      waitlist: 0,
      revocationPending: 0,
      revocationFailed: 0,
      revoked: 0,
    }
  );
}

function formatInventoryTotals(totals: CodingPlanInventoryTotals): string {
  return `*Total* · Available ${formatCount(totals.available)} · Assigned ${formatCount(totals.assigned)} · Loaded ${formatCount(totals.loaded)} · Waitlist ${formatCount(totals.waitlist)}`;
}

function groupSummariesByProvider(
  summaries: InventoryPlanSummary[]
): Map<string, InventoryPlanSummary[]> {
  const providerGroups = new Map<string, InventoryPlanSummary[]>();

  for (const summary of summaries) {
    const providerSummaries = providerGroups.get(summary.providerName) ?? [];
    providerSummaries.push(summary);
    providerGroups.set(summary.providerName, providerSummaries);
  }

  return providerGroups;
}

function formatProviderSummary(providerName: string, summaries: InventoryPlanSummary[]): string {
  const planLines = summaries.map(
    summary =>
      `${escapeSlackLabel(summary.displayName)} · Available ${formatCount(statusCount(summary, 'available'))} · Assigned ${formatCount(statusCount(summary, 'assigned'))} · Loaded ${formatCount(summary.loaded)} · Waitlist ${formatCount(summary.waitlist)}`
  );

  return [`*${escapeSlackLabel(providerName)}*`, ...planLines].join('\n');
}

function formatUnknownStatuses(summaries: InventoryPlanSummary[]): string | null {
  const unknownStatuses = summaries.flatMap(summary =>
    Object.entries(summary.statusCounts)
      .filter(([status]) => !KNOWN_STATUSES.has(status))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([status, count]) => {
        const plan = `${summary.providerName} ${summary.displayName}`;
        return `${escapeSlackLabel(plan)}: ${formatCount(count)} ${escapeSlackText(humanizeStatus(status))}`;
      })
  );

  return unknownStatuses.length > 0 ? `*Other statuses:* ${unknownStatuses.join(' · ')}` : null;
}

function formatRevocationCallout(totals: CodingPlanInventoryTotals): string {
  return [
    totals.revocationFailed > 0
      ? `:rotating_light: *Action required:* ${formatCount(totals.revocationFailed)} credential${totals.revocationFailed === 1 ? '' : 's'} failed revocation.`
      : null,
    totals.revocationPending > 0
      ? `:warning: *${formatCount(totals.revocationPending)} credential${totals.revocationPending === 1 ? ' is' : 's are'} pending revocation.*`
      : null,
  ]
    .filter((value): value is string => value !== null)
    .join('\n');
}

function formatSnapshotTime(timestamp: Date): string {
  return timestamp
    .toISOString()
    .replace('T', ' ')
    .replace(/:\d{2}\.\d{3}Z$/, ' UTC');
}

export function buildCodingPlanInventorySlackNotification(
  counts: CodingPlanInventoryCount[],
  waitlistCounts: CodingPlanWaitlistCount[] = [],
  timestamp = new Date()
): { notification: AdminSlackNotification; totals: CodingPlanInventoryTotals } {
  const summaries = addWaitlistCounts(summarizeInventory(counts), waitlistCounts);
  const totals = inventoryTotals(summaries);
  const needsAttention = totals.revocationFailed + totals.revocationPending;
  const providerNames = Array.from(new Set(summaries.map(summary => summary.providerName)));
  const providerLabel = providerNames.length > 0 ? providerNames.join(', ') : 'All providers';
  const planAvailability = summaries
    .map(
      summary =>
        `${summary.providerName} ${summary.displayName}: ${formatCount(statusCount(summary, 'available'))} available, ${formatCount(statusCount(summary, 'assigned'))} assigned, ${formatCount(summary.loaded)} loaded, ${formatCount(summary.waitlist)} waitlist`
    )
    .join('. ');
  const attentionFallback = [
    totals.revocationFailed > 0
      ? `${formatCount(totals.revocationFailed)} failed revocation`
      : null,
    totals.revocationPending > 0
      ? `${formatCount(totals.revocationPending)} pending revocation`
      : null,
  ]
    .filter((value): value is string => value !== null)
    .join(', ');
  const text = [
    `Coding Plans inventory: ${formatCount(totals.available)} available, ${formatCount(totals.assigned)} assigned, ${formatCount(totals.loaded)} loaded, ${formatCount(totals.waitlist)} waitlisted`,
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
    { type: 'divider' },
  ];

  if (counts.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: 'No Coding Plans inventory is currently recorded.' },
    });
  }

  if (summaries.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: formatInventoryTotals(totals) },
    });

    for (const [providerName, providerSummaries] of groupSummariesByProvider(summaries)) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: formatProviderSummary(providerName, providerSummaries),
        },
      });
    }

    const unknownStatuses = formatUnknownStatuses(summaries);
    if (unknownStatuses) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: unknownStatuses } });
    }
  }

  if (needsAttention > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: formatRevocationCallout(totals) },
    });
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
  getWaitlistCounts?: typeof getCodingPlanAvailabilityIntentCounts;
  sendNotification?: typeof sendAdminSlackNotification;
};

export async function sendCodingPlanInventorySlackSummary({
  getCounts = getKeyInventoryCounts,
  getWaitlistCounts = getCodingPlanAvailabilityIntentCounts,
  sendNotification = sendAdminSlackNotification,
}: InventorySummaryDependencies = {}): Promise<CodingPlanInventoryTotals> {
  const [counts, waitlistCounts] = await Promise.all([getCounts(), getWaitlistCounts()]);
  const { notification, totals } = buildCodingPlanInventorySlackNotification(
    counts,
    waitlistCounts
  );
  await sendNotification(notification);
  return totals;
}
