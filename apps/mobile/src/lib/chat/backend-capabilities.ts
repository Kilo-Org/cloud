import { listChatBackends } from './backend-store';
import { resolveChatTarget } from './backend-target';
import { localModelProvider } from './local-models';

/** Tool definitions are absent, not ignored by a text-only backend. */
export function targetSupportsTools(targetId: string): boolean {
  const target = resolveChatTarget(targetId, listChatBackends());
  if (target.kind === 'local') {
    return localModelProvider(target.provider)?.supportsTools(target.modelId) ?? false;
  }
  return target.kind === 'kilo' || target.model.tools;
}
