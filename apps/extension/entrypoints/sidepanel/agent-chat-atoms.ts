import { atom } from 'jotai';
import { atomFamily } from 'jotai-family';
import type { ContextUsage } from '@/src/shared/context-usage';

// Per-conversation in-memory draft text (reset on reload by design).
// Keys for closed-but-not-deleted conversations are kept for the session so their drafts survive reopen; the set is small and resets on reload.
export const draftAtomFamily = atomFamily((_conversationId: string) => atom(''));

// Per-conversation context usage from the latest gateway turn (in-memory only).
// Keys for closed-but-not-deleted conversations are kept for the session; only deleted conversations have their keys evicted via .remove().
export const contextUsageAtomFamily = atomFamily((_conversationId: string) =>
  atom<ContextUsage | undefined>()
);

// Ids of conversations with an in-flight run / compaction.
export const runningConversationIdsAtom = atom<readonly string[]>([]);
export const compactingConversationIdsAtom = atom<readonly string[]>([]);
