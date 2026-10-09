import { listChatBackends } from './backend-store';
import { resolveChatTarget } from './backend-target';

/** Tool definitions are absent, not ignored by a text-only backend. */
export function targetSupportsTools(targetId: string): boolean {
  const target = resolveChatTarget(targetId, listChatBackends());
  return target.kind === 'kilo' || target.model.tools;
}
