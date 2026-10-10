import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';
import { useTargetSupportsImages } from '@/lib/chat/backend-capabilities';
import { type StoredChatBackend } from '@/lib/chat/backend-store';
import { decodeBackendTarget, localTargetId } from '@/lib/chat/backend-target';
import { useGgufModels } from '@/lib/chat/gguf-models';
import { type LocalModelStatus } from '@/lib/chat/local-models';

type ModelToolsHintProps = {
  model: string;
  backends: readonly StoredChatBackend[];
  localModels: readonly LocalModelStatus[];
};

const HINT_KEYS = {
  toolsImages: 'modelChat.backends.modelToolsImages',
  tools: 'modelChat.backends.modelTools',
  images: 'modelChat.backends.imagesNoTools',
  none: 'modelChat.backends.textOnly',
} as const;

/**
 * Says whether a custom or on-device model receives tools and images. Kilo
 * models need no hint: they all receive tools, and the attach control shows
 * which ones read images.
 */
export function ModelToolsHint({ model, backends, localModels }: Readonly<ModelToolsHintProps>) {
  const { t } = useTranslation();
  const images = useTargetSupportsImages(model);
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
  let key: (typeof HINT_KEYS)[keyof typeof HINT_KEYS] = HINT_KEYS.none;
  if (tools) {
    key = images ? HINT_KEYS.toolsImages : HINT_KEYS.tools;
  } else if (images) {
    key = HINT_KEYS.images;
  }
  return <Text className="px-4 pt-2 text-xs text-muted-foreground">{t(key)}</Text>;
}
