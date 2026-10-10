import { useSyncExternalStore } from 'react';

import { listChatBackends, useChatBackends } from './backend-store';
import { resolveChatTarget, type ResolvedChatTarget } from './backend-target';
import { localModelProvider } from './local-models';

/** Tool definitions are absent, not ignored by a text-only backend. */
export function targetSupportsTools(targetId: string): boolean {
  const target = resolveChatTarget(targetId, listChatBackends());
  if (target.kind === 'local') {
    return localModelProvider(target.provider)?.supportsTools(target.modelId) ?? false;
  }
  return target.kind === 'kilo' || target.model.tools;
}

/**
 * The gateway models whose catalog entry lists image input. A model the
 * catalog has not named yet reads as text-only, so an image never reaches a
 * model that would refuse it.
 */
let kiloImageModels: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

/** Takes the gateway's model list as the image capability of each Kilo model. */
export function rememberKiloImageModels(
  models: readonly { readonly id: string; readonly supportsImages?: boolean }[]
): void {
  const next = new Set(
    models.filter(model => model.supportsImages === true).map(model => model.id)
  );
  if (next.size === kiloImageModels.size && [...next].every(id => kiloImageModels.has(id))) {
    return;
  }
  kiloImageModels = next;
  for (const listener of listeners) {
    listener();
  }
}

/** Whether a resolved target receives image parts. */
export function resolvedTargetSupportsImages(target: ResolvedChatTarget): boolean {
  if (target.kind === 'local') {
    return localModelProvider(target.provider)?.supportsImages(target.modelId) ?? false;
  }
  return target.kind === 'kilo' ? kiloImageModels.has(target.modelId) : target.model.images;
}

/** Image parts are sent only to a target that reads them. */
export function targetSupportsImages(targetId: string): boolean {
  return resolvedTargetSupportsImages(resolveChatTarget(targetId, listChatBackends()));
}

function subscribeKiloImageModels(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const currentKiloImageModels = () => kiloImageModels;

/**
 * `targetSupportsImages` for a screen: it renders again when the gateway list
 * or a stored backend changes. A target that no longer resolves reads as
 * text-only; the send path reports why.
 */
export function useTargetSupportsImages(targetId: string): boolean {
  useSyncExternalStore(subscribeKiloImageModels, currentKiloImageModels, currentKiloImageModels);
  useChatBackends();
  try {
    return targetSupportsImages(targetId);
  } catch {
    return false;
  }
}
