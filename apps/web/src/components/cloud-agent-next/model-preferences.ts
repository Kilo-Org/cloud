import { safeLocalStorage } from '@/lib/localStorage';
import type { ModelOption } from '@/components/shared/ModelCombobox';

const MODEL_STORAGE_KEY_PREFIX = 'cloud-agent:last-used-model';
const VARIANTS_STORAGE_KEY_PREFIX = 'cloud-agent:last-used-variants';

export function getLastUsedModelStorageKey(organizationId?: string) {
  return organizationId
    ? `${MODEL_STORAGE_KEY_PREFIX}:organization:${organizationId}`
    : `${MODEL_STORAGE_KEY_PREFIX}:personal`;
}

export function getLastUsedModel(organizationId?: string) {
  return safeLocalStorage.getItem(getLastUsedModelStorageKey(organizationId));
}

export function setLastUsedModel(model: string, organizationId?: string) {
  safeLocalStorage.setItem(getLastUsedModelStorageKey(organizationId), model);
}

export function getPreferredInitialModel({
  modelOptions,
  lastUsedModel,
  defaultModel,
}: {
  modelOptions: ModelOption[];
  lastUsedModel: string | null;
  defaultModel?: string;
}) {
  if (lastUsedModel && modelOptions.some(model => model.id === lastUsedModel)) {
    return lastUsedModel;
  }

  if (defaultModel && modelOptions.some(model => model.id === defaultModel)) {
    return defaultModel;
  }

  return modelOptions[0]?.id;
}

export function getLastUsedVariantsStorageKey(organizationId?: string) {
  return organizationId
    ? `${VARIANTS_STORAGE_KEY_PREFIX}:organization:${organizationId}`
    : `${VARIANTS_STORAGE_KEY_PREFIX}:personal`;
}

function readLastUsedVariants(organizationId?: string): Record<string, string> {
  const raw = safeLocalStorage.getItem(getLastUsedVariantsStorageKey(organizationId));
  if (!raw) return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

export function getLastUsedVariant(modelId: string, organizationId?: string): string | null {
  return readLastUsedVariants(organizationId)[modelId] ?? null;
}

export function setLastUsedVariant(
  modelId: string,
  variant: string,
  organizationId?: string
): void {
  const map = readLastUsedVariants(organizationId);
  map[modelId] = variant;
  safeLocalStorage.setItem(getLastUsedVariantsStorageKey(organizationId), JSON.stringify(map));
}

export function getPreferredInitialVariant({
  availableVariants,
  lastUsedVariant,
  currentVariant,
}: {
  availableVariants: string[];
  lastUsedVariant: string | null;
  currentVariant?: string;
}): string | undefined {
  if (availableVariants.length === 0) return undefined;

  if (lastUsedVariant && availableVariants.includes(lastUsedVariant)) {
    return lastUsedVariant;
  }

  if (currentVariant && availableVariants.includes(currentVariant)) {
    return currentVariant;
  }

  return availableVariants[0];
}
