import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';
import { type StoredChatBackend } from '@/lib/chat/backend-store';
import { decodeBackendTarget, localTargetId } from '@/lib/chat/backend-target';
import { useGgufModels } from '@/lib/chat/gguf-models';
import { type LocalModelStatus } from '@/lib/chat/local-models';

type ModelToolsHintProps = {
  model: string;
  backends: readonly StoredChatBackend[];
  localModels: readonly LocalModelStatus[];
};

/** Says whether a custom or on-device model receives tools. Kilo models need no hint. */
export function ModelToolsHint({ model, backends, localModels }: Readonly<ModelToolsHintProps>) {
  const { t } = useTranslation();
  const ggufModel = useGgufModels().models.find(one => localTargetId('gguf', one.fileId) === model);
  const customTarget = decodeBackendTarget(model);
  const customModel = backends
    .find(backend => backend.id === customTarget?.backendId)
    ?.models.find(one => one.id === customTarget?.modelId);
  const systemModel = localModels.find(local => local.targetId === model);
  if (customModel === undefined && ggufModel === undefined && systemModel === undefined) {
    return null;
  }
  // A system model receives tools when its module says it runs the tool loop.
  const tools =
    customModel?.tools === true ||
    ggufModel?.tools === true ||
    systemModel?.availability?.tools === true;
  return (
    <Text className="px-4 pt-2 text-xs text-muted-foreground">
      {t(tools ? 'modelChat.backends.modelTools' : 'modelChat.backends.textOnly')}
    </Text>
  );
}
