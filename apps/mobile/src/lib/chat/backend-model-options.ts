import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import { type StoredChatBackend } from './backend-store';
import { backendTargetId, decodeBackendTarget } from './backend-target';

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

/** A new backend or endpoint revision requires consent to transfer the context. */
export function requiresBackendDisclosure(from: string, to: string): boolean {
  const source = decodeBackendTarget(from);
  const destination = decodeBackendTarget(to);
  if (source === null && destination === null) {
    return false;
  }
  return source?.backendId !== destination?.backendId || source?.revision !== destination?.revision;
}
