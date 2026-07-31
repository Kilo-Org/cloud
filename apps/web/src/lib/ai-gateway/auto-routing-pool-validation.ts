import 'server-only';

import {
  isVirtualAutoModelId,
  MAX_POOL_ENTRIES,
  poolEntryKey,
  type AutoRoutingSettingsResponse,
  type PoolEntry,
} from '@kilocode/auto-routing-contracts';
import { CUSTOM_LLM_PREFIX } from '@/lib/ai-gateway/model-utils';
import { kiloExclusiveModels } from '@/lib/ai-gateway/models';
import { listAvailableExperimentModels } from '@/lib/ai-gateway/experiments/list-available-experiment-models';
import {
  getDirectByokModelsForOrganization,
  getDirectByokModelsForUser,
} from '@/lib/ai-gateway/providers/direct-byok';
import { getEnhancedOpenRouterModels } from '@/lib/ai-gateway/providers/openrouter';
import { getAvailableModelsForOrganization } from '@/lib/organizations/organization-models';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';

export type PoolValidationReason =
  | 'unknown_model'
  | 'virtual_model'
  | 'experiment_model'
  | 'hidden_model'
  | 'byok_only_model'
  | 'organization_denied_model'
  | 'missing_variant'
  | 'unknown_variant'
  | 'unexpected_variant'
  | 'duplicate_pair'
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
  /** Canonical catalog model id. */
  id: string;
  /**
   * Canonical variant keys when the model exposes `opencode.variants`.
   * `null` means the model exposes no variants (variant must be null).
   */
  variantKeys: ReadonlySet<string> | null;
};

export type EligibleCatalog = {
  byId: ReadonlyMap<string, EligibleModelInfo>;
  experimentIds: ReadonlySet<string>;
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
  experiment_model: 'Model experiment IDs cannot be added to an Efficient pool.',
  hidden_model: 'This model is not visible in your model picker.',
  byok_only_model: 'Direct BYOK-only models cannot be added to an Efficient pool.',
  organization_denied_model: 'This model is not allowed for the organization.',
  missing_variant: 'A catalog variant is required for this model.',
  unknown_variant: 'Unknown variant for this model.',
  unexpected_variant: 'This model does not expose variants; variant must be null.',
  duplicate_pair: 'Duplicate model and variant pair in the pool.',
  too_many_entries: `An Efficient pool can include at most ${MAX_POOL_ENTRIES} models.`,
  empty_pool: 'An Efficient pool must include at least one model.',
};

export function poolValidationMessage(reason: PoolValidationReason): string {
  return REJECTION_MESSAGES[reason];
}

function variantKeysForModel(model: OpenRouterModel): ReadonlySet<string> | null {
  const variants = model.opencode?.variants;
  if (!variants) return null;
  const keys = Object.keys(variants).filter(key => key.trim().length > 0);
  return keys.length > 0 ? new Set(keys) : null;
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

  const [enhanced, experimentModels, byokModels] = await Promise.all([
    getEnhancedOpenRouterModels(),
    listAvailableExperimentModels(),
    organizationId
      ? getDirectByokModelsForOrganization(organizationId)
      : getDirectByokModelsForUser(userId),
  ]);

  const managedModels = Array.isArray(enhanced.data) ? enhanced.data : [];
  const managedIds = new Set(managedModels.map(model => model.id));
  const experimentIds = new Set(experimentModels.map(model => model.id));
  const byokOnlyIds = new Set(byokModels.map(model => model.id));

  let ownerModels: OpenRouterModel[];
  if (organizationId) {
    const orgCatalog = await getAvailableModelsForOrganization(organizationId);
    ownerModels = orgCatalog?.data ?? [];
  } else {
    ownerModels = managedModels;
  }

  const ownerCatalogIds = new Set(ownerModels.map(model => model.id));
  const byId = new Map<string, EligibleModelInfo>();

  for (const model of ownerModels) {
    const id = model.id;
    if (isVirtualAutoModelId(id)) continue;
    if (experimentIds.has(id)) continue;
    if (byokOnlyIds.has(id)) continue;
    if (isCustomLlmId(id)) continue;
    if (isHiddenExclusiveModel(id)) continue;

    byId.set(id, {
      id,
      variantKeys: variantKeysForModel(model),
    });
  }

  return {
    byId,
    experimentIds,
    byokOnlyIds,
    managedIds,
    ownerCatalogIds,
    organizationId,
  };
}

function classifyIneligibleModel(
  modelId: string,
  catalog: EligibleCatalog
): Exclude<
  PoolValidationReason,
  | 'missing_variant'
  | 'unknown_variant'
  | 'unexpected_variant'
  | 'duplicate_pair'
  | 'too_many_entries'
  | 'empty_pool'
> {
  if (isVirtualAutoModelId(modelId)) return 'virtual_model';
  if (catalog.experimentIds.has(modelId)) return 'experiment_model';
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

  const rawVariant = entry.variant;
  const variant =
    rawVariant === null || rawVariant === undefined ? null : rawVariant.trim() || null;

  if (eligible.variantKeys === null) {
    if (variant !== null) {
      return {
        ok: false,
        error: {
          reason: 'unexpected_variant',
          message: poolValidationMessage('unexpected_variant'),
          index,
          entry,
        },
      };
    }
    return { ok: true, entry: { model: eligible.id, variant: null } };
  }

  if (variant === null) {
    return {
      ok: false,
      error: {
        reason: 'missing_variant',
        message: poolValidationMessage('missing_variant'),
        index,
        entry,
      },
    };
  }

  // Match exact catalog key (trim already applied); keys are as cataloged.
  if (!eligible.variantKeys.has(variant)) {
    // Also accept if a catalog key equals after the same trim (keys are already trimmed filters).
    const canonical = [...eligible.variantKeys].find(key => key === variant);
    if (!canonical) {
      return {
        ok: false,
        error: {
          reason: 'unknown_variant',
          message: poolValidationMessage('unknown_variant'),
          index,
          entry,
        },
      };
    }
    return { ok: true, entry: { model: eligible.id, variant: canonical } };
  }

  return { ok: true, entry: { model: eligible.id, variant } };
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
          reason: 'duplicate_pair',
          message: poolValidationMessage('duplicate_pair'),
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

function isEntryAvailable(entry: PoolEntry, catalog: EligibleCatalog): boolean {
  const eligible = catalog.byId.get(entry.model);
  if (!eligible) return false;

  if (eligible.variantKeys === null) {
    return entry.variant === null;
  }
  if (entry.variant === null) return false;
  return eligible.variantKeys.has(entry.variant);
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
    unavailable: !isEntryAvailable(entry, catalog),
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
