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

/**
 * The model a new chat starts on: the one the latest chat is on, then Kilo's
 * preferred model, then any Kilo model, then an on-device model, then anything
 * offered. Kilo models are offered only once the catalog has loaded, so while
 * it loads the answer waits for it rather than starting on whatever is there.
 * A catalog that cannot load — offline, or the API down — is not waited for:
 * an on-device model answers with no connection.
 */
export function defaultChatModel(input: {
  readonly options: readonly SessionModelOption[];
  readonly latestChatModel: string | undefined;
  readonly catalogLoading: boolean;
}): string | undefined {
  const { options, latestChatModel, catalogLoading } = input;
  if (options.some(option => option.id === latestChatModel)) {
    return latestChatModel;
  }
  if (catalogLoading) {
    return undefined;
  }
  const kilo = options.filter(
    option => decodeLocalTarget(option.id) === null && decodeBackendTarget(option.id) === null
  );
  return (
    kilo.find(option => option.isPreferred)?.id ??
    kilo[0]?.id ??
    options.find(option => decodeLocalTarget(option.id) !== null)?.id ??
    options[0]?.id
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
