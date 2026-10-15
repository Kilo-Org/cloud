import 'server-only';

import {
  isVirtualAutoModelId,
  MAX_POOL_ENTRIES,
  poolEntryKey,
  type AutoRoutingSettingsResponse,
  type PoolEntry,
} from '@kilocode/auto-routing-contracts';
import { CUSTOM_LLM_PREFIX } from '@kilocode/web-shared/lib/ai-gateway/model-utils';
import { kiloExclusiveModels } from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import {
  getDirectByokModelsForOrganization,
  getDirectByokModelsForUser,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { getEnhancedOpenRouterModels } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter';
import { getAvailableModelsForOrganization } from '@kilocode/web-shared/lib/organizations/organization-models';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/organizations/organization-types';

export type PoolValidationReason =
  | 'unknown_model'
  | 'virtual_model'
  | 'hidden_model'
  | 'byok_only_model'
  | 'organization_denied_model'
  | 'duplicate_model'
  | 'too_many_entries'
  | 'empty_pool';

export type PoolValidationError = {
  reason: PoolValidationReason;
  message: string;
  index?: number;
  entry?: PoolEntry;
};

export type PoolEntryWithAvailability = PoolEntry & {
  unavailable: boolean;
};

/** Web API response: worker settings plus per-entry availability for the UI. */
export type AutoRoutingSettingsApiResponse = Omit<AutoRoutingSettingsResponse, 'configuredPool'> & {
  configuredPool: PoolEntryWithAvailability[] | null;
  /**
   * False when the worker only supports legacy mode endpoints (deploy-order
   * window or worker rollback). UI must hide pool editing and never send pool mutations.
   */
  poolSupported: boolean;
};

export type EligibleModelInfo = {
  id: string;
};

export type EligibleCatalog = {
  byId: ReadonlyMap<string, EligibleModelInfo>;
  byokOnlyIds: ReadonlySet<string>;
  /** Managed catalog ids before org filtering (for org-denied classification). */
  managedIds: ReadonlySet<string>;
  /** Ids present in the owner-scoped catalog after org filtering. */
  ownerCatalogIds: ReadonlySet<string>;
  organizationId: string | null;
};

const REJECTION_MESSAGES: Record<PoolValidationReason, string> = {
  unknown_model: 'Unknown model. Choose a managed model from your catalog.',
  virtual_model: 'Virtual auto-routing models cannot be added to an Efficient pool.',
  hidden_model: 'This model is not visible in your model picker.',
  byok_only_model: 'Direct BYOK-only models cannot be added to an Efficient pool.',
  organization_denied_model: 'This model is not allowed for the organization.',
  duplicate_model: 'Duplicate model in the pool.',
  too_many_entries: `An Efficient pool can include at most ${MAX_POOL_ENTRIES} models.`,
  empty_pool: 'An Efficient pool must include at least one model.',
};

export function poolValidationMessage(reason: PoolValidationReason): string {
  return REJECTION_MESSAGES[reason];
}

function isHiddenExclusiveModel(modelId: string): boolean {
  const exclusive = kiloExclusiveModels.find(model => model.public_id === modelId);
  return exclusive !== undefined && exclusive.status !== 'public';
}

function isCustomLlmId(modelId: string): boolean {
  return modelId.startsWith(CUSTOM_LLM_PREFIX);
}

/**
 * Build the eligible managed catalog for pool membership.
 * Client-side filtering is never trusted; this is the authorization source.
 */
export async function buildEligibleCatalog(params: {
  userId: string;
  organizationId: string | null;
}): Promise<EligibleCatalog> {
  const { userId, organizationId } = params;

  const [enhanced, byokModels] = await Promise.all([
    getEnhancedOpenRouterModels(),
    organizationId
      ? getDirectByokModelsForOrganization(organizationId)
      : getDirectByokModelsForUser(userId),
  ]);

  const managedModels = Array.isArray(enhanced.data) ? enhanced.data : [];
  const managedIds = new Set(managedModels.map(model => model.id));
  const byokOnlyIds = new Set(byokModels.map(model => model.id));

  let ownerModels: OpenRouterModel[];
  if (organizationId) {
    // Pool membership is organization-level configuration, so it resolves against
    // the organization's own policy rather than the configuring owner's group
    // grants. A member subject would also require direct membership, which a
    // parent-organization owner or platform admin may not have.
    const orgCatalog = await getAvailableModelsForOrganization(organizationId, {
      type: 'defaultAccess',
    });
    ownerModels = orgCatalog?.data ?? [];
  } else {
    ownerModels = managedModels;
  }

  const ownerCatalogIds = new Set(ownerModels.map(model => model.id));
  const byId = new Map<string, EligibleModelInfo>();

  for (const model of ownerModels) {
    const id = model.id;
    if (isVirtualAutoModelId(id)) continue;
    if (byokOnlyIds.has(id)) continue;
    if (isCustomLlmId(id)) continue;
    if (isHiddenExclusiveModel(id)) continue;

    byId.set(id, {
      id,
    });
  }

  return {
    byId,
    byokOnlyIds,
    managedIds,
    ownerCatalogIds,
    organizationId,
  };
}

function classifyIneligibleModel(
  modelId: string,
  catalog: EligibleCatalog
): Exclude<PoolValidationReason, 'duplicate_model' | 'too_many_entries' | 'empty_pool'> {
  if (isVirtualAutoModelId(modelId)) return 'virtual_model';
  if (catalog.byokOnlyIds.has(modelId)) return 'byok_only_model';
  if (isHiddenExclusiveModel(modelId)) return 'hidden_model';
  if (
    catalog.organizationId &&
    catalog.managedIds.has(modelId) &&
    !catalog.ownerCatalogIds.has(modelId)
  ) {
    return 'organization_denied_model';
  }
  // Present in owner catalog but subtracted (custom LLM, etc.) → treat as unknown.
  return 'unknown_model';
}

function validateSingleEntry(
  entry: PoolEntry,
  index: number,
  catalog: EligibleCatalog
): { ok: true; entry: PoolEntry } | { ok: false; error: PoolValidationError } {
  const modelId = entry.model.trim();
  if (!modelId) {
    return {
      ok: false,
      error: {
        reason: 'unknown_model',
        message: poolValidationMessage('unknown_model'),
        index,
        entry,
      },
    };
  }

  const eligible = catalog.byId.get(modelId);
  if (!eligible) {
    // Try case-sensitive exact match only (catalog ids are canonical).
    const reason = classifyIneligibleModel(modelId, catalog);
    return {
      ok: false,
      error: {
        reason,
        message: poolValidationMessage(reason),
        index,
        entry,
      },
    };
  }

  return { ok: true, entry: { model: eligible.id } };
}

/**
 * Revalidate every submitted Pool entry against the owner's effective managed catalog.
 * Returns canonicalized entries on success.
 */
export async function validatePoolEntries(params: {
  user: { id: string };
  organizationId: string | null;
  entries: PoolEntry[];
}): Promise<{ ok: true; entries: PoolEntry[] } | { ok: false; error: PoolValidationError }> {
  const { entries } = params;

  if (entries.length === 0) {
    return {
      ok: false,
      error: {
        reason: 'empty_pool',
        message: poolValidationMessage('empty_pool'),
      },
    };
  }

  if (entries.length > MAX_POOL_ENTRIES) {
    return {
      ok: false,
      error: {
        reason: 'too_many_entries',
        message: poolValidationMessage('too_many_entries'),
      },
    };
  }

  const catalog = await buildEligibleCatalog({
    userId: params.user.id,
    organizationId: params.organizationId,
  });

  const canonical: PoolEntry[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry) continue;
    const result = validateSingleEntry(entry, index, catalog);
    if (!result.ok) return result;

    const key = poolEntryKey(result.entry);
    if (seen.has(key)) {
      return {
        ok: false,
        error: {
          reason: 'duplicate_model',
          message: poolValidationMessage('duplicate_model'),
          index,
          entry: result.entry,
        },
      };
    }
    seen.add(key);
    canonical.push(result.entry);
  }

  return { ok: true, entries: canonical };
}

/**
 * Classify saved pool entries against today's catalog so GET can mark
 * departed entries unavailable without rejecting the read.
 */
export function annotatePoolAvailability(params: {
  entries: PoolEntry[] | null;
  catalog: EligibleCatalog;
}): PoolEntryWithAvailability[] | null {
  const { entries, catalog } = params;
  if (entries === null) return null;
  return entries.map(entry => ({
    ...entry,
    unavailable: !catalog.byId.has(entry.model),
  }));
}

export async function annotateConfiguredPool(params: {
  userId: string;
  organizationId: string | null;
  configuredPool: PoolEntry[] | null;
}): Promise<PoolEntryWithAvailability[] | null> {
  if (params.configuredPool === null) return null;
  const catalog = await buildEligibleCatalog({
    userId: params.userId,
    organizationId: params.organizationId,
  });
  return annotatePoolAvailability({ entries: params.configuredPool, catalog });
}

export function toApiSettingsResponse(
  workerBody: AutoRoutingSettingsResponse,
  configuredPool: PoolEntryWithAvailability[] | null
): AutoRoutingSettingsApiResponse {
  return {
    ...workerBody,
    configuredPool,
    poolSupported: true,
  };
}

/**
 * Synthesize a settings API response from the legacy mode-only worker body
 * when `/admin/routing-settings` is not yet deployed (or was rolled back).
 */
export function toLegacyModeApiSettingsResponse(modeBody: {
  ownerType: AutoRoutingSettingsResponse['ownerType'];
  ownerId: string;
  mode: AutoRoutingSettingsResponse['mode'];
  configuredMode: AutoRoutingSettingsResponse['configuredMode'];
  defaultMode: AutoRoutingSettingsResponse['defaultMode'];
}): AutoRoutingSettingsApiResponse {
  return {
    ...modeBody,
    configuredPool: null,
    poolStatuses: [],
    poolSupported: false,
  };
}
