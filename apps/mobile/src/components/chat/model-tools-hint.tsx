import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';
import { type StoredChatBackend } from '@/lib/chat/backend-store';
import { decodeBackendTarget } from '@/lib/chat/backend-target';
import { type LocalModelStatus } from '@/lib/chat/local-models';

type ModelToolsHintProps = {
  model: string;
  backends: readonly StoredChatBackend[];
  localModels: readonly LocalModelStatus[];
};

/** Says whether a custom or on-device model receives tools. Kilo models need no hint. */
export function ModelToolsHint({ model, backends, localModels }: Readonly<ModelToolsHintProps>) {
  const { t } = useTranslation();
  const customTarget = decodeBackendTarget(model);
  const customModel = backends
    .find(backend => backend.id === customTarget?.backendId)
    ?.models.find(one => one.id === customTarget?.modelId);
  // System on-device models are text-only, like a custom model without tools.
  if (customModel === undefined && !localModels.some(local => local.targetId === model)) {
    return null;
  }
  return (
    <Text className="px-4 pt-2 text-xs text-muted-foreground">
      {t(
        customModel?.tools === true
          ? 'modelChat.backends.modelTools'
          : 'modelChat.backends.textOnly'
      )}
    </Text>
  );
}
