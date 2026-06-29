import { getDefaultStore } from 'jotai';
import { describe, expect, it } from 'vitest';
// Atoms module lives under entrypoints/ but has no #imports dependency.
// Imported here, under src/, because that is where the vitest glob runs.
import {
  clearPerConversationAtoms,
  compactingConversationIdsAtom,
  contextUsageAtomFamily,
  draftAtomFamily,
  evictConversationAtoms,
  runningConversationIdsAtom,
} from '@/entrypoints/sidepanel/agent-chat-atoms';

describe('per-conversation atom eviction', () => {
  it('evictConversationAtoms resets draft and usage for a conversation id', () => {
    const store = getDefaultStore();
    store.set(draftAtomFamily('conversation-1'), 'hello');
    store.set(contextUsageAtomFamily('conversation-1'), { promptTokens: 42 });

    evictConversationAtoms('conversation-1');

    // A fresh atom (post-remove) starts from its initial value.
    expect(store.get(draftAtomFamily('conversation-1'))).toBe('');
    expect(store.get(contextUsageAtomFamily('conversation-1'))).toBeUndefined();
  });

  it('clearPerConversationAtoms wipes all drafts, usage, and run-state on sign-out', () => {
    const store = getDefaultStore();
    store.set(draftAtomFamily('conversation-1'), 'prev account draft');
    store.set(contextUsageAtomFamily('conversation-2'), { promptTokens: 999 });
    store.set(runningConversationIdsAtom, ['conversation-1']);
    store.set(compactingConversationIdsAtom, ['conversation-2']);

    clearPerConversationAtoms();

    expect(store.get(draftAtomFamily('conversation-1'))).toBe('');
    expect(store.get(contextUsageAtomFamily('conversation-2'))).toBeUndefined();
    expect(store.get(runningConversationIdsAtom)).toStrictEqual([]);
    expect(store.get(compactingConversationIdsAtom)).toStrictEqual([]);
  });
});
