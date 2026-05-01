import { captureException } from '@sentry/nextjs';
import { eq } from 'drizzle-orm';
import type { Organization } from '@kilocode/db/schema';
import { organizations } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { normalizeModelId } from '@/lib/ai-gateway/model-utils';
import { getEffectiveModelRestrictions } from '@/lib/organizations/model-restrictions';
import type { ModelRestrictions } from '@/lib/model-allow.server';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import type { NormalizedOpenRouterResponse } from '@/lib/ai-gateway/providers/openrouter/openrouter-types';
import {
  computeSnapshotDiff,
  type SnapshotDiff,
} from '@/lib/ai-gateway/providers/openrouter/snapshot-diff';

export type RelevantChanges = {
  /** providerSlug -> sorted list of normalized model ids newly accessible via that provider */
  addedByReasonProvider: Map<string, string[]>;
  /** normalized model ids removed from the catalog entirely (no provider offers them anymore) */
  removedFromCatalog: string[];
  /**
   * Normalized model ids still in the catalog but no longer offered by any provider
   * this org allows — effectively lost access even though the model still exists upstream.
   */
  removedFromAllowedProviders: string[];
};

type Availability = { allowed: boolean; reasonProvider: string | null };

type PrecomputedRestrictions = {
  modelDenySet: Set<string>;
  providerAllowSet: Set<string> | undefined;
  providerDenySet: Set<string>;
};

function precompute(restrictions: ModelRestrictions): PrecomputedRestrictions {
  return {
    modelDenySet: new Set(restrictions.modelDenyList.map(normalizeModelId)),
    providerAllowSet: restrictions.providerAllowList
      ? new Set(restrictions.providerAllowList)
      : undefined,
    providerDenySet: new Set(restrictions.providerDenyList),
  };
}

/**
 * Determine whether a model id is accessible to an org given a model→providers
 * index snapshot. Returns `{ allowed: true, reasonProvider }` when accessible,
 * where `reasonProvider` is a deterministically-picked provider slug (first
 * alphabetically among allowed providers) that admits the model — used as the
 * human-readable "because of X" reason.
 */
function checkAvailability(
  providerSlugsForModel: Set<string> | undefined,
  modelId: string,
  precomputed: PrecomputedRestrictions
): Availability {
  if (precomputed.modelDenySet.has(modelId)) {
    return { allowed: false, reasonProvider: null };
  }
  if (!providerSlugsForModel || providerSlugsForModel.size === 0) {
    return { allowed: false, reasonProvider: null };
  }

  const sortedProviders = [...providerSlugsForModel].sort((a, b) => a.localeCompare(b));

  const { providerAllowSet } = precomputed;
  if (providerAllowSet !== undefined) {
    const allowedProvider = sortedProviders.find(slug => providerAllowSet.has(slug));
    return allowedProvider
      ? { allowed: true, reasonProvider: allowedProvider }
      : { allowed: false, reasonProvider: null };
  }

  const nonDeniedProvider = sortedProviders.find(slug => !precomputed.providerDenySet.has(slug));
  return nonDeniedProvider
    ? { allowed: true, reasonProvider: nonDeniedProvider }
    : { allowed: false, reasonProvider: null };
}

/**
 * Walk the diff and, for a single organization's effective restrictions,
 * collect the set of model changes that actually affect what this org can see.
 *
 * - Additions: a model is included when it is now accessible under the org's
 *   current settings AND was NOT accessible before. This naturally handles:
 *     - "new model on existing provider" (e.g. GLM 5.1 under z-ai)
 *     - "existing model newly offered by an allowed provider"
 *     - "brand-new provider" (ignored for allow-list mode orgs; admitted for
 *       legacy deny-list mode orgs whose deny list doesn't cover it)
 * - Removals: a model is included when it was accessible under the org's
 *   current settings using the OLD catalog but is no longer accessible now,
 *   distinguishing:
 *     - `removedFromCatalog`: the model is gone from upstream entirely.
 *     - `removedFromAllowedProviders`: the model still exists upstream but
 *       every provider offering it is now outside the org's allow list.
 */
export function computeRelevantChangesForOrg(
  organization: Organization,
  diff: SnapshotDiff
): RelevantChanges {
  const precomputed = precompute(getEffectiveModelRestrictions(organization));

  const addedByReasonProvider = new Map<string, string[]>();
  const removedFromCatalog: string[] = [];
  const removedFromAllowedProviders: string[] = [];

  const affectedModelIds = new Set<string>();
  for (const list of diff.addedByProvider.values()) {
    for (const modelId of list) affectedModelIds.add(modelId);
  }
  for (const list of diff.removedByProvider.values()) {
    for (const modelId of list) affectedModelIds.add(modelId);
  }

  for (const modelId of affectedModelIds) {
    const oldProviders = diff.oldModelProvidersIndex.get(modelId);
    const newProviders = diff.newModelProvidersIndex.get(modelId);

    const before = checkAvailability(oldProviders, modelId, precomputed);
    const after = checkAvailability(newProviders, modelId, precomputed);

    if (!before.allowed && after.allowed && after.reasonProvider) {
      const list = addedByReasonProvider.get(after.reasonProvider);
      if (list) {
        list.push(modelId);
      } else {
        addedByReasonProvider.set(after.reasonProvider, [modelId]);
      }
    } else if (before.allowed && !after.allowed) {
      if (!newProviders || newProviders.size === 0) {
        removedFromCatalog.push(modelId);
      } else {
        removedFromAllowedProviders.push(modelId);
      }
    }
  }

  for (const list of addedByReasonProvider.values()) {
    list.sort((a, b) => a.localeCompare(b));
  }
  removedFromCatalog.sort((a, b) => a.localeCompare(b));
  removedFromAllowedProviders.sort((a, b) => a.localeCompare(b));

  return { addedByReasonProvider, removedFromCatalog, removedFromAllowedProviders };
}

export function relevantChangesIsEmpty(changes: RelevantChanges): boolean {
  return (
    changes.addedByReasonProvider.size === 0 &&
    changes.removedFromCatalog.length === 0 &&
    changes.removedFromAllowedProviders.length === 0
  );
}

/**
 * Build a human-readable, deterministic audit log message describing all
 * relevant model additions and removals for one organization in one sync.
 *
 * Segments (each conditionally present, joined by `'; '`):
 *   Added models from provider {slug}: {id1}, {id2}
 *   Removed models (no longer available): {id1}, {id2}
 *   Removed models (no longer offered by any allowed provider): {id1}, {id2}
 */
export function buildAutoChangeMessage(changes: RelevantChanges): string {
  const segments: string[] = [];

  const sortedProviders = [...changes.addedByReasonProvider.keys()].sort((a, b) =>
    a.localeCompare(b)
  );
  for (const providerSlug of sortedProviders) {
    const models = changes.addedByReasonProvider.get(providerSlug);
    if (models && models.length > 0) {
      segments.push(`Added models from provider ${providerSlug}: ${models.join(', ')}`);
    }
  }

  if (changes.removedFromCatalog.length > 0) {
    segments.push(`Removed models (no longer available): ${changes.removedFromCatalog.join(', ')}`);
  }

  if (changes.removedFromAllowedProviders.length > 0) {
    segments.push(
      `Removed models (no longer offered by any allowed provider): ${changes.removedFromAllowedProviders.join(', ')}`
    );
  }

  return segments.join('; ');
}

export type LogResult = {
  orgCount: number;
  logCount: number;
};

/**
 * Compute the diff between the previous and current OpenRouter snapshots and
 * write one audit log row per enterprise organization whose effective model
 * availability changed. Attributed to `System` via null actor fields.
 *
 * Safe to call from inside a background job; individual per-org failures are
 * reported to Sentry and do not break the rest of the loop.
 */
export async function logAutoModelChangesForAllOrgs(
  oldSnapshot: NormalizedOpenRouterResponse | null,
  newSnapshot: NormalizedOpenRouterResponse
): Promise<LogResult> {
  const diff = computeSnapshotDiff(oldSnapshot, newSnapshot);

  if (diff.addedByProvider.size === 0 && diff.removedByProvider.size === 0) {
    return { orgCount: 0, logCount: 0 };
  }

  const enterpriseOrgs = await db
    .select()
    .from(organizations)
    .where(eq(organizations.plan, 'enterprise'));

  let logCount = 0;
  for (const organization of enterpriseOrgs) {
    const changes = computeRelevantChangesForOrg(organization, diff);
    if (relevantChangesIsEmpty(changes)) continue;

    const message = buildAutoChangeMessage(changes);
    try {
      await createAuditLog({
        action: 'organization.settings.auto_change',
        actor_id: null,
        actor_email: null,
        actor_name: null,
        message,
        organization_id: organization.id,
      });
      logCount++;
    } catch (err) {
      console.error(
        `[auto-model-change-log] failed to write audit log for org ${organization.id}`,
        err
      );
      captureException(err, {
        tags: { component: 'auto-model-change-log' },
        extra: { organization_id: organization.id, message },
      });
    }
  }

  return { orgCount: enterpriseOrgs.length, logCount };
}
