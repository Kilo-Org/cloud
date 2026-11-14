import type { QueryClient } from '@tanstack/react-query';
import { removeAccountScopedAgentsQueries } from '@/src/shared/side-panel-query-options';
import { clearPerConversationAtoms } from './agent-chat-atoms';
import { clearStoredDrafts } from './agent-draft-storage';

/*
 * Every store that belongs to the signed-in account: per-conversation drafts
 * and usage, the persisted draft mirror, and the cached agents data. Sign-out
 * and session expiry both call this, so a list that grows with a new
 * account-scoped store is only ever edited here.
 */
export const clearAccountScopedState = async (queryClient: QueryClient): Promise<void> => {
  clearPerConversationAtoms();
  await clearStoredDrafts();
  removeAccountScopedAgentsQueries(queryClient);
};
