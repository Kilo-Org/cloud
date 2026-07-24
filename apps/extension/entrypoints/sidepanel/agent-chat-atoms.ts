import { atom, getDefaultStore } from 'jotai';
import { atomFamily } from 'jotai-family';
import type { ContextUsage } from '@/src/shared/context-usage';
import type { RemoteMcpStore } from '@/src/shared/remote-mcp';

/*
 * Shared remote MCP servers, hydrated from storage. Settings mutates it and the
 * chat panel reads it at submit time, so newly added/connected servers are
 * usable without a reload.
 */
export const remoteMcpStoreAtom = atom<RemoteMcpStore>({ servers: [] });

// Per-conversation in-memory draft text (reset on reload by design).
// Keys for closed-but-not-deleted conversations are kept so their drafts survive reopen; evicted on delete and on sign-out.
export const draftAtomFamily = atomFamily((_conversationId: string) => atom(''));

// Per-conversation context usage from the latest gateway turn (in-memory only).
// Same lifecycle as drafts: kept across close, evicted on delete and on sign-out.
export const contextUsageAtomFamily = atomFamily((_conversationId: string) =>
  atom<ContextUsage | undefined>()
);

// Event id of the assistant message currently streaming content for a conversation.
// Cleared when that message's stream ends (even if later tool rounds continue).
export const streamingMessageIdAtomFamily = atomFamily((_conversationId: string) =>
  atom<string | undefined>()
);

// Ids of conversations with an in-flight run / compaction.
export const runningConversationIdsAtom = atom<readonly string[]>([]);
export const compactingConversationIdsAtom = atom<readonly string[]>([]);

// Evict a single conversation's in-memory atoms (draft + context usage + streaming id).
export const evictConversationAtoms = (conversationId: string): void => {
  draftAtomFamily.remove(conversationId);
  contextUsageAtomFamily.remove(conversationId);
  streamingMessageIdAtomFamily.remove(conversationId);
};

/*
 * Drop all per-conversation in-memory state. Called on sign-out so a different
 * account on the same profile (no reload) never inherits the prior user's
 * drafts/usage — conversation ids are deterministic (conversation-1, ...), so
 * the atom families would otherwise hand back the old account's values.
 */
export const clearPerConversationAtoms = (): void => {
  const ids = new Set([
    ...draftAtomFamily.getParams(),
    ...contextUsageAtomFamily.getParams(),
    ...streamingMessageIdAtomFamily.getParams(),
  ]);
  for (const id of ids) {
    evictConversationAtoms(id);
  }
  const store = getDefaultStore();
  store.set(runningConversationIdsAtom, []);
  store.set(compactingConversationIdsAtom, []);
};
