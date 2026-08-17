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
  queuedMessageAtomFamily,
  runningConversationIdsAtom,
  sessionCostAtomFamily,
  streamingMessageIdAtomFamily,
} from '@/entrypoints/sidepanel/agent-chat-atoms';

describe('per-conversation atom eviction', () => {
  it('evictConversationAtoms resets draft, usage, session cost, and streaming id for a conversation id', () => {
    const store = getDefaultStore();
    store.set(draftAtomFamily('conversation-1'), 'hello');
    store.set(contextUsageAtomFamily('conversation-1'), { promptTokens: 42 });
    store.set(sessionCostAtomFamily('conversation-1'), 0.0123);
    store.set(streamingMessageIdAtomFamily('conversation-1'), 'msg-streaming');
    store.set(queuedMessageAtomFamily('conversation-1'), 'queued');

    evictConversationAtoms('conversation-1');

    // A fresh atom (post-remove) starts from its initial value.
    expect(store.get(draftAtomFamily('conversation-1'))).toBe('');
    expect(store.get(contextUsageAtomFamily('conversation-1'))).toBeUndefined();
    expect(store.get(sessionCostAtomFamily('conversation-1'))).toBe(0);
    expect(store.get(streamingMessageIdAtomFamily('conversation-1'))).toBeUndefined();
    expect(store.get(queuedMessageAtomFamily('conversation-1'))).toBeUndefined();
  });

  it('clearPerConversationAtoms wipes all drafts, usage, session cost, and streaming ids on sign-out', () => {
    const store = getDefaultStore();
    store.set(draftAtomFamily('conversation-1'), 'prev account draft');
    store.set(contextUsageAtomFamily('conversation-2'), { promptTokens: 999 });
    store.set(sessionCostAtomFamily('conversation-3'), 1.5);
    store.set(streamingMessageIdAtomFamily('conversation-3'), 'msg-only-streaming');
    store.set(queuedMessageAtomFamily('conversation-2'), 'queued');

    clearPerConversationAtoms();

    expect(store.get(draftAtomFamily('conversation-1'))).toBe('');
    expect(store.get(contextUsageAtomFamily('conversation-2'))).toBeUndefined();
    expect(store.get(sessionCostAtomFamily('conversation-3'))).toBe(0);
    expect(store.get(streamingMessageIdAtomFamily('conversation-3'))).toBeUndefined();
    expect(store.get(queuedMessageAtomFamily('conversation-2'))).toBeUndefined();
  });

  it('clearPerConversationAtoms clears run-state on sign-out', () => {
    const store = getDefaultStore();
    store.set(runningConversationIdsAtom, ['conversation-1']);
    store.set(compactingConversationIdsAtom, ['conversation-2']);

    clearPerConversationAtoms();

    expect(store.get(runningConversationIdsAtom)).toStrictEqual([]);
    expect(store.get(compactingConversationIdsAtom)).toStrictEqual([]);
  });

  it('clearPerConversationAtoms wipes a conversation that has only a streaming entry', () => {
    const store = getDefaultStore();
    store.set(streamingMessageIdAtomFamily('conversation-streaming-only'), 'msg-mid-first-run');

    clearPerConversationAtoms();

    expect(store.get(streamingMessageIdAtomFamily('conversation-streaming-only'))).toBeUndefined();
  });
});
