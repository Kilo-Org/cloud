import { atom } from 'jotai';
import { atomFamily } from 'jotai-family';
import type { ContextUsage } from '@/src/shared/context-usage';

// Per-conversation in-memory draft text (reset on reload by design).
export const draftAtomFamily = atomFamily((_conversationId: string) => atom(''));

// Per-conversation context usage from the latest gateway turn (in-memory only).
export const contextUsageAtomFamily = atomFamily((_conversationId: string) =>
  atom<ContextUsage | undefined>()
);

// Ids of conversations with an in-flight run / compaction.
export const runningConversationIdsAtom = atom<readonly string[]>([]);
export const compactingConversationIdsAtom = atom<readonly string[]>([]);
