import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import { backendModelOptions, localModelOptions } from './backend-model-options';
import { type StoredChatBackend } from './backend-store';
import { ggufModelOptions, useGgufModels } from './gguf-models';
import { type LocalModelStatus } from './local-models';

/** What a chat can pick: the gateway's models, custom backends, then on-device models. */
export function useChatModelOptions(
  gateway: readonly SessionModelOption[],
  backends: readonly StoredChatBackend[],
  localModels: readonly LocalModelStatus[]
): SessionModelOption[] {
  const { t } = useTranslation();
  const ggufModels = useGgufModels().models;
  return useMemo(
    () => [
      ...gateway,
      ...backendModelOptions(backends),
      ...localModelOptions(localModels, t),
      ...ggufModelOptions(ggufModels),
    ],
    [backends, gateway, ggufModels, localModels, t]
  );
}
