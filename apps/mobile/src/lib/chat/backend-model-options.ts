import { type TFunction } from 'i18next';

import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import { type StoredChatBackend } from './backend-store';
import { backendTargetId, decodeBackendTarget, decodeLocalTarget } from './backend-target';
import { type LocalModelStatus } from './local-models';

export function backendModelOptions(backends: readonly StoredChatBackend[]): SessionModelOption[] {
  return backends.flatMap(backend =>
    backend.models.map(model => ({
      id: backendTargetId(backend, model.id),
      name: `${backend.name} · ${model.name}`,
      displayId: model.id,
      variants: [],
      isPreferred: false,
      showGatewayMetadata: false,
      provider: { id: backend.id, name: backend.name },
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    }))
  );
}

/** An on-device model is offered only while its provider says it is available. */
export function localModelOptions(
  statuses: readonly LocalModelStatus[],
  t: TFunction
): SessionModelOption[] {
  return statuses.flatMap(({ targetId, nameKey, availability }) =>
    availability?.status === 'available'
      ? [
          {
            id: targetId,
            name: t(nameKey),
            displayId: availability.modelId,
            variants: [],
            isPreferred: false,
            showGatewayMetadata: false,
            ...(availability.contextWindow > 0
              ? { contextWindow: availability.contextWindow }
              : {}),
          },
        ]
      : []
  );
}

/** Kilo, one backend revision, or one on-device provider model. */
function backendIdentity(targetId: string): string {
  const local = decodeLocalTarget(targetId);
  if (local !== null) {
    return `local:${local.provider}:${local.modelId}`;
  }
  const backend = decodeBackendTarget(targetId);
  return backend === null ? 'kilo' : `backend:${backend.backendId}:${backend.revision}`;
}

/** A different backend identity requires consent to transfer the context. */
export function requiresBackendDisclosure(from: string, to: string): boolean {
  return backendIdentity(from) !== backendIdentity(to);
}
