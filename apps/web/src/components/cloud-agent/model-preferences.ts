import { safeLocalStorage } from '@/lib/localStorage';
import type { ModelOption } from '@/components/shared/ModelCombobox';

const STORAGE_KEY_PREFIX = 'cloud-agent:last-used-model';

export function getLastUsedModelStorageKey(organizationId?: string) {
  return organizationId
    ? `${STORAGE_KEY_PREFIX}:organization:${organizationId}`
    : `${STORAGE_KEY_PREFIX}:personal`;
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
