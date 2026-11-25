import { captureException } from '@sentry/nextjs';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { Organization } from '@kilocode/db/schema';
import { organization_seats_purchases, organizations } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { mutateOrganizationSettings } from '@kilocode/web-shared/lib/organizations/organizations';
import { bumpOrganizationGroupPolicyRevision } from '@kilocode/web-shared/lib/organizations/organization-groups';
import { normalizeModelId } from '@kilocode/web-shared/lib/ai-gateway/model-utils';
import {
  normalizeInferenceProviderId,
  normalizeInferenceProviderIds,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { getEffectiveModelRestrictions } from '@/lib/organizations/model-restrictions';
import {
  getEligibleProviderRoutes,
  type ModelRestrictions,
} from '@kilocode/web-shared/lib/model-allow.server';
import { createAuditLog } from '@kilocode/web-shared/lib/organizations/organization-audit-logs';
import type { NormalizedOpenRouterResponse } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/openrouter-types';
import { computeSnapshotDiff, type SnapshotDiff } from '@/lib/providers/openrouter/snapshot-diff';

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
};

function precompute(restrictions: ModelRestrictions): PrecomputedRestrictions {
  return {
    modelDenySet: new Set(restrictions.modelDenyList.map(normalizeModelId)),
    providerAllowSet: restrictions.providerAllowList
      ? new Set(normalizeInferenceProviderIds(restrictions.providerAllowList))
      : undefined,
  };
}

/**
 * Accessibility comes from `getEligibleProviderRoutes`, the same rule
 * `getEffectiveModelDecision` applies. `reasonProvider` is the alphabetically-first
 * provider that both lists the model and has an eligible route, so a router admitted
 * through the `virtual` provider is labelled by the provider the snapshot lists it under.
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

  // The snapshot keeps each provider's own slug, which may differ in case from the
  // catalog form, so both sides of the route rule are compared canonically and the
  // admitted route is reported under the snapshot's slug.
  const canonicalProviders = new Set(
    [...providerSlugsForModel].map(slug => normalizeInferenceProviderId(slug))
  );
  const routes = precomputed.providerAllowSet
    ? getEligibleProviderRoutes(canonicalProviders, precomputed.providerAllowSet)
    : canonicalProviders;

  const admittingProvider = [...providerSlugsForModel]
    .filter(slug => routes.has(normalizeInferenceProviderId(slug)))
    .sort((a, b) => a.localeCompare(b))[0];

  return admittingProvider
    ? { allowed: true, reasonProvider: admittingProvider }
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
 *
 * When `addedModelsDisabled` is set, the additions were also put on the deny list and read
 * `Disabled new models from provider {slug}: {id1}, {id2}` instead.
 */
export function buildAutoChangeMessage(
  changes: RelevantChanges,
  { addedModelsDisabled = false }: { addedModelsDisabled?: boolean } = {}
): string {
  const segments: string[] = [];

  const sortedProviders = [...changes.addedByReasonProvider.keys()].sort((a, b) =>
    a.localeCompare(b)
  );
  const addedPrefix = addedModelsDisabled ? 'Disabled new models' : 'Added models';
  for (const providerSlug of sortedProviders) {
    const models = changes.addedByReasonProvider.get(providerSlug);
    if (models && models.length > 0) {
      segments.push(`${addedPrefix} from provider ${providerSlug}: ${models.join(', ')}`);
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

const orgHasModelRestrictions = sql<boolean>`(
  jsonb_typeof(${organizations.settings}->'provider_allow_list') = 'array'
  OR (
    jsonb_typeof(${organizations.settings}->'model_deny_list') = 'array'
    AND jsonb_array_length(${organizations.settings}->'model_deny_list') > 0
  )
)`;

const orgHasCurrentEntitlement = sql<boolean>`(
  ${organizations.require_seats} = false
  OR ${organizations.settings}->>'suppress_trial_messaging' = 'true'
  OR ${organizations.settings}->>'oss_sponsorship_tier' IS NOT NULL
  OR coalesce(${organizations.free_trial_end_at}, ${organizations.created_at} + interval '14 days') >= now() - interval '3 days'
  OR coalesce((
    SELECT ${organization_seats_purchases.subscription_status} <> 'ended'
    FROM ${organization_seats_purchases}
    WHERE ${organization_seats_purchases.organization_id} = ${organizations.id}
    ORDER BY ${organization_seats_purchases.created_at} DESC
    LIMIT 1
  ), false)
)`;

const orgDisablesNewModels = sql<boolean>`(${organizations.settings}->>'disable_new_models' = 'true')`;

function auditDetails(changes: RelevantChanges, addedModelsDisabled: boolean) {
  return {
    id: 'autoRouting.models' as const,
    // The mobile detail line reads these as enabled additions, so disabled ones are
    // left to the message.
    added: addedModelsDisabled
      ? []
      : [...changes.addedByReasonProvider].map(([provider, models]) => ({ provider, models })),
    removed: [...changes.removedFromCatalog, ...changes.removedFromAllowedProviders],
  };
}

/**
 * Add the models `changes` newly admits to the organization's deny list and record the
 * change, in one transaction. The policy is read again under the row lock, so an
 * organization that turned it off since the sync read it only gets the audit row.
 */
async function disableAddedModelsAndLog(organizationId: string, changes: RelevantChanges) {
  const addedModels = [...changes.addedByReasonProvider.values()].flat();
  await db.transaction(async tx => {
    // Same lock order as `updateAllowLists`: the group policy revision, then the organization row.
    await bumpOrganizationGroupPolicyRevision(tx, organizationId, null);
    let addedModelsDisabled = false;
    await mutateOrganizationSettings(
      organizationId,
      organization => {
        if (organization.plan !== 'enterprise' || !organization.settings.disable_new_models) {
          return organization.settings;
        }
        addedModelsDisabled = true;
        const modelDenyList = [
          ...new Set([...(organization.settings.model_deny_list ?? []), ...addedModels]),
        ];
        const defaultModel = organization.settings.default_model;
        const defaultModelDisabled =
          defaultModel !== undefined && addedModels.includes(normalizeModelId(defaultModel));
        return {
          ...organization.settings,
          model_deny_list: modelDenyList,
          ...(defaultModelDisabled ? { default_model: undefined } : {}),
        };
      },
      tx
    );
    await createAuditLog({
      action: 'organization.settings.auto_change',
      actor_id: null,
      actor_email: null,
      actor_name: null,
      details: auditDetails(changes, addedModelsDisabled),
      message: buildAutoChangeMessage(changes, { addedModelsDisabled }),
      organization_id: organizationId,
      tx,
    });
  });
}

/**
 * Compute the diff between the previous and current OpenRouter snapshots and
 * write one audit log row per active enterprise organization with explicit
 * model/provider restrictions whose effective model availability changed.
 * Attributed to `System` via null actor fields.
 *
 * An enterprise organization with the `disable_new_models` advanced policy is
 * always included, whatever its restrictions or entitlement, and the models that
 * become available to it are also added to its deny list.
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
    .where(
      and(
        eq(organizations.plan, 'enterprise'),
        isNull(organizations.deleted_at),
        or(and(orgHasModelRestrictions, orgHasCurrentEntitlement), orgDisablesNewModels)
      )
    );

  let logCount = 0;
  for (const organization of enterpriseOrgs) {
    const changes = computeRelevantChangesForOrg(organization, diff);
    if (relevantChangesIsEmpty(changes)) continue;

    const message = buildAutoChangeMessage(changes);
    try {
      if (organization.settings.disable_new_models && changes.addedByReasonProvider.size > 0) {
        await disableAddedModelsAndLog(organization.id, changes);
      } else {
        await createAuditLog({
          action: 'organization.settings.auto_change',
          actor_id: null,
          actor_email: null,
          actor_name: null,
          details: auditDetails(changes, false),
          message,
          organization_id: organization.id,
        });
      }
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
