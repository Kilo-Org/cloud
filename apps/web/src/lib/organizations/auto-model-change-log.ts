import { captureException } from '@sentry/nextjs';
import { and, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import type { Organization } from '@kilocode/db/schema';
import {
  modelsByProvider,
  organization_new_models_baselines,
  organization_seats_purchases,
  organizations,
} from '@kilocode/db/schema';
import type { OrganizationSettings } from '@kilocode/db/schema-types';
import type { AuditDetail } from '@kilocode/app-shared/organizations';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { mutateOrganizationSettings } from '@kilocode/web-shared/lib/organizations/organizations';
import {
  bumpOrganizationGroupPolicyRevision,
  lockOrganizationGroupPolicy,
} from '@kilocode/web-shared/lib/organizations/organization-groups';
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
 *   Disabled new models from provider {slug}: {id1}, {id2}
 *   Removed models (no longer available): {id1}, {id2}
 *   Removed models (no longer offered by any allowed provider): {id1}, {id2}
 *
 * `disabledByReasonProvider` lists the additions the `disable_new_models` policy put on the
 * deny list; `changes.addedByReasonProvider` then holds only the additions that stay enabled.
 */
export function buildAutoChangeMessage(
  changes: RelevantChanges,
  disabledByReasonProvider: ReadonlyMap<string, string[]> = new Map()
): string {
  const segments: string[] = [];

  const pushByProvider = (prefix: string, byProvider: ReadonlyMap<string, string[]>) => {
    for (const providerSlug of [...byProvider.keys()].sort((a, b) => a.localeCompare(b))) {
      const models = byProvider.get(providerSlug);
      if (models && models.length > 0) {
        segments.push(`${prefix} from provider ${providerSlug}: ${models.join(', ')}`);
      }
    }
  };
  pushByProvider('Added models', changes.addedByReasonProvider);
  pushByProvider('Disabled new models', disabledByReasonProvider);

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

export type NewModelsPolicyOutcome = {
  /** `changes` with only the additions that stay enabled. */
  changes: RelevantChanges;
  /** providerSlug -> sorted list of normalized model ids put on the deny list. */
  disabledByReasonProvider: Map<string, string[]>;
  /** The new deny list, or null when it is unchanged. */
  modelDenyList: string[] | null;
};

/**
 * Models the organization already chose explicitly. The policy leaves them enabled, so a model
 * that disappears from the catalog and comes back cannot break the default model or
 * Organization Auto.
 */
function explicitlyConfiguredModelIds(settings: OrganizationSettings): Set<string> {
  const ids = [
    settings.default_model,
    settings.org_auto_model?.fallback_model,
    ...Object.values(settings.org_auto_model?.routes ?? {}),
  ];
  return new Set(ids.filter(id => id !== undefined).map(id => normalizeModelId(id)));
}

/** Apply the `disable_new_models` policy to one organization's relevant changes. */
export function applyNewModelsPolicy(
  settings: OrganizationSettings,
  changes: RelevantChanges
): NewModelsPolicyOutcome {
  const configured = explicitlyConfiguredModelIds(settings);
  const addedByReasonProvider = new Map<string, string[]>();
  const disabledByReasonProvider = new Map<string, string[]>();
  for (const [provider, models] of changes.addedByReasonProvider) {
    const enabled = models.filter(model => configured.has(model));
    const disabled = models.filter(model => !configured.has(model));
    if (enabled.length > 0) addedByReasonProvider.set(provider, enabled);
    if (disabled.length > 0) disabledByReasonProvider.set(provider, disabled);
  }

  const currentDenyList = settings.model_deny_list ?? [];
  const deniedModels = new Set(currentDenyList.map(model => normalizeModelId(model)));
  const newlyDenied = [...disabledByReasonProvider.values()]
    .flat()
    .filter(model => !deniedModels.has(model));
  return {
    changes: { ...changes, addedByReasonProvider },
    disabledByReasonProvider,
    modelDenyList: newlyDenied.length > 0 ? [...currentDenyList, ...new Set(newlyDenied)] : null,
  };
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

function auditDetails(
  changes: RelevantChanges,
  disabledByReasonProvider: ReadonlyMap<string, string[]> = new Map()
): AuditDetail {
  const byProvider = (map: ReadonlyMap<string, string[]>) =>
    [...map].map(([provider, models]) => ({ provider, models }));
  return {
    id: 'autoRouting.models',
    added: byProvider(changes.addedByReasonProvider),
    removed: [...changes.removedFromCatalog, ...changes.removedFromAllowedProviders],
    // Omitted when empty, so mobile builds that predate the field still parse the row.
    ...(disabledByReasonProvider.size > 0
      ? { disabled: byProvider(disabledByReasonProvider) }
      : {}),
  };
}

async function upsertBaseline(tx: DrizzleTransaction, organizationId: string, snapshotId: number) {
  await tx
    .insert(organization_new_models_baselines)
    .values({ organization_id: organizationId, snapshot_id: snapshotId })
    .onConflictDoUpdate({
      target: organization_new_models_baselines.organization_id,
      set: { snapshot_id: snapshotId, updated_at: sql`now()` },
    });
}

async function writePolicyAuditLog(
  tx: DrizzleTransaction,
  organizationId: string,
  outcome: NewModelsPolicyOutcome
) {
  if (relevantChangesIsEmpty(outcome.changes) && outcome.disabledByReasonProvider.size === 0) {
    return;
  }
  await createAuditLog({
    action: 'organization.settings.auto_change',
    actor_id: null,
    actor_email: null,
    actor_name: null,
    details: auditDetails(outcome.changes, outcome.disabledByReasonProvider),
    message: buildAutoChangeMessage(outcome.changes, outcome.disabledByReasonProvider),
    organization_id: organizationId,
    tx,
  });
}

/**
 * Reconcile one organization from its baseline to `snapshotId`.
 *
 * The policy itself cannot change meanwhile: `updateNewModelsPolicy` waits for the snapshot lock
 * the caller holds. The deny list can, so the organization's locks are taken only when the deny
 * list changes, and the outcome is then decided again on the locked row.
 */
async function reconcileOrganization(
  tx: DrizzleTransaction,
  organization: Organization,
  diff: SnapshotDiff,
  snapshotId: number
): Promise<void> {
  // Only enterprise organizations have model restrictions. The baseline still advances, so a
  // later upgrade does not disable everything released in between.
  if (organization.plan === 'enterprise') {
    const result = {
      outcome: applyNewModelsPolicy(
        organization.settings,
        computeRelevantChangesForOrg(organization, diff)
      ),
    };
    if (result.outcome.modelDenyList) {
      // Same lock order as `updateAllowLists`: the group policy, then the organization row.
      await lockOrganizationGroupPolicy(tx, organization.id);
      await mutateOrganizationSettings(
        organization.id,
        locked => {
          result.outcome = applyNewModelsPolicy(
            locked.settings,
            computeRelevantChangesForOrg(locked, diff)
          );
          return result.outcome.modelDenyList
            ? { ...locked.settings, model_deny_list: result.outcome.modelDenyList }
            : locked.settings;
        },
        tx
      );
      if (result.outcome.modelDenyList) {
        await bumpOrganizationGroupPolicyRevision(tx, organization.id, null);
      }
    }
    await writePolicyAuditLog(tx, organization.id, result.outcome);
  }
  await upsertBaseline(tx, organization.id, snapshotId);
}

/**
 * Apply the `disable_new_models` policy for a snapshot that is being published. Call it inside
 * the publishing transaction, under the snapshot lock, after inserting the new snapshot.
 *
 * Each organization is reconciled from its own baseline snapshot, in a savepoint, and its
 * baseline then advances to the new snapshot in the same transaction as its deny list. The
 * gateway only admits models listed by an organization's baseline snapshot or an older one
 * (`newModelsBaselineSnapshotId`), so a newly listed model is never usable before it is
 * disabled. When one organization fails, it is reported and its baseline stays where it was:
 * it cannot use the new models until the next sync reconciles it, and the other organizations
 * and the publication go ahead. The caller must keep every snapshot a baseline points at.
 *
 * Returns the organizations it handled, which `logAutoModelChangesForAllOrgs` skips.
 */
export async function applyNewModelsPolicyForPublication(
  tx: DrizzleTransaction,
  {
    previousSnapshot,
    previousSnapshotId,
    newSnapshot,
    newSnapshotId,
  }: {
    previousSnapshot: NormalizedOpenRouterResponse | null;
    previousSnapshotId: number | null;
    newSnapshot: NormalizedOpenRouterResponse;
    newSnapshotId: number;
  }
): Promise<{ handledOrganizationIds: Set<string> }> {
  const policyOrganizations = await tx
    .select({
      organization: organizations,
      baselineSnapshotId: organization_new_models_baselines.snapshot_id,
    })
    .from(organizations)
    .leftJoin(
      organization_new_models_baselines,
      eq(organization_new_models_baselines.organization_id, organizations.id)
    )
    .where(and(isNull(organizations.deleted_at), orgDisablesNewModels));

  await tx.delete(organization_new_models_baselines).where(
    notInArray(
      organization_new_models_baselines.organization_id,
      policyOrganizations.map(({ organization }) => organization.id)
    )
  );

  const olderBaselineIds = [
    ...new Set(
      policyOrganizations.flatMap(({ baselineSnapshotId }) =>
        baselineSnapshotId !== null && baselineSnapshotId !== previousSnapshotId
          ? [baselineSnapshotId]
          : []
      )
    ),
  ];
  const olderBaselines = new Map(
    olderBaselineIds.length === 0
      ? []
      : (
          await tx
            .select({ id: modelsByProvider.id, data: modelsByProvider.data })
            .from(modelsByProvider)
            .where(inArray(modelsByProvider.id, olderBaselineIds))
        ).map(row => [row.id, row.data])
  );
  const baselineSnapshotFor = (organizationId: string, baselineSnapshotId: number | null) => {
    if (baselineSnapshotId !== null && baselineSnapshotId === previousSnapshotId) {
      return previousSnapshot;
    }
    const baseline =
      baselineSnapshotId === null ? undefined : olderBaselines.get(baselineSnapshotId);
    if (baseline) return baseline;
    // Without its baseline, models listed between it and the previous snapshot stay enabled.
    console.warn(
      `[auto-model-change-log] org ${organizationId} has no baseline snapshot; reconciling from the previous snapshot`
    );
    return previousSnapshot;
  };
  const diffs = new Map<NormalizedOpenRouterResponse | null, SnapshotDiff>();
  const diffFrom = (baseline: NormalizedOpenRouterResponse | null) => {
    let diff = diffs.get(baseline);
    if (!diff) {
      diff = computeSnapshotDiff(baseline, newSnapshot);
      diffs.set(baseline, diff);
    }
    return diff;
  };

  const handledOrganizationIds = new Set<string>();
  for (const { organization, baselineSnapshotId } of policyOrganizations) {
    // A failed organization is skipped by the post-commit log too: its additions are not
    // "added", since the next sync disables them.
    handledOrganizationIds.add(organization.id);
    try {
      const diff = diffFrom(baselineSnapshotFor(organization.id, baselineSnapshotId));
      await tx.transaction(sp => reconcileOrganization(sp, organization, diff, newSnapshotId));
    } catch (err) {
      console.error(
        `[auto-model-change-log] failed to apply the new models policy for org ${organization.id}`,
        err
      );
      captureException(err, {
        tags: { component: 'auto-model-change-log' },
        extra: { organization_id: organization.id },
      });
    }
  }

  return { handledOrganizationIds };
}

/**
 * Compute the diff between the previous and current OpenRouter snapshots and
 * write one audit log row per active enterprise organization with explicit
 * model/provider restrictions whose effective model availability changed.
 * Attributed to `System` via null actor fields.
 *
 * Organizations in `skipOrganizationIds` were already handled by
 * `applyNewModelsPolicyForPublication`.
 *
 * Safe to call from inside a background job; individual per-org failures are
 * reported to Sentry and do not break the rest of the loop.
 */
export async function logAutoModelChangesForAllOrgs(
  oldSnapshot: NormalizedOpenRouterResponse | null,
  newSnapshot: NormalizedOpenRouterResponse,
  skipOrganizationIds: ReadonlySet<string> = new Set()
): Promise<LogResult> {
  const diff = computeSnapshotDiff(oldSnapshot, newSnapshot);

  if (diff.addedByProvider.size === 0 && diff.removedByProvider.size === 0) {
    return { orgCount: 0, logCount: 0 };
  }

  const enterpriseOrgs = (
    await db
      .select()
      .from(organizations)
      .where(
        and(
          eq(organizations.plan, 'enterprise'),
          isNull(organizations.deleted_at),
          orgHasModelRestrictions,
          orgHasCurrentEntitlement
        )
      )
  ).filter(organization => !skipOrganizationIds.has(organization.id));

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
        details: auditDetails(changes),
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
