import { useEffect, useState } from 'react';
import type { ModelOption } from '@/components/shared/ModelCombobox';
import { KILOCLAW_KILO_PROVIDER_PREFIX } from '@/lib/ai-gateway/model-utils';

export function getDefaultSelectedModel(
  kilocodeDefaultModel: string | null | undefined,
  modelOptions: ModelOption[]
) {
  if (modelOptions.length === 0) return '';
  if (!kilocodeDefaultModel?.startsWith(KILOCLAW_KILO_PROVIDER_PREFIX)) return '';

  const defaultModel = kilocodeDefaultModel.slice(KILOCLAW_KILO_PROVIDER_PREFIX.length);
  if (modelOptions.some(model => model.id === defaultModel)) return defaultModel;
  return '';
}

export function useDefaultModelSelection(
  kilocodeDefaultModel: string | null | undefined,
  modelOptions: ModelOption[]
) {
  const [selectedModel, setSelectedModel] = useState('');
  const [hasAppliedDefaults, setHasAppliedDefaults] = useState(false);

  useEffect(() => {
    if (hasAppliedDefaults) return;
    if (modelOptions.length === 0) return;
    // `undefined` means config is still loading; wait so we do not clear an existing saved default.
    if (kilocodeDefaultModel === undefined) return;
    const defaultModel = getDefaultSelectedModel(kilocodeDefaultModel, modelOptions);
    if (defaultModel) setSelectedModel(defaultModel);

    setHasAppliedDefaults(true);
  }, [kilocodeDefaultModel, modelOptions, hasAppliedDefaults]);

  return {
    selectedModel,
    setSelectedModel,
  };
}
