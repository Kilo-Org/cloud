import { type MessageDeliveryState, type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { describe, expect, it } from 'vitest';

import { resolveForkCut } from './fork-cut';

function message(
  id: string,
  role: 'user' | 'assistant',
  parts: { type: 'text'; text: string; synthetic?: boolean }[] = []
): StoredMessage {
  return {
    info: { id, role, sessionID: 'ses_source', time: { created: 1 } },
    parts: parts.map((part, index) => ({
      id: `prt_${id}_${index}`,
      messageID: id,
      sessionID: 'ses_source',
      ...part,
    })),
  } as unknown as StoredMessage;
}

const U1 = message('msg_001', 'user', [{ type: 'text', text: 'First question' }]);
const A1 = message('msg_002', 'assistant', [{ type: 'text', text: 'First answer' }]);
const U2 = message('msg_003', 'user', [
  { type: 'text', text: 'Second question' },
  { type: 'text', text: '<file contents>', synthetic: true },
  { type: 'text', text: 'with detail' },
]);
const A2 = message('msg_004', 'assistant', [{ type: 'text', text: 'Second answer' }]);
const TRANSCRIPT = [U1, A1, U2, A2];
const NO_PENDING: ReadonlyMap<string, MessageDeliveryState> = new Map();

function cutFor(
  messageId: string,
  overrides: {
    messages?: StoredMessage[];
    pendingMessages?: ReadonlyMap<string, MessageDeliveryState>;
    isSessionStreaming?: boolean;
  } = {}
) {
  return resolveForkCut({
    messages: overrides.messages ?? TRANSCRIPT,
    messageId,
    pendingMessages: overrides.pendingMessages ?? NO_PENDING,
    isSessionStreaming: overrides.isSessionStreaming ?? false,
  });
}

describe('resolveForkCut', () => {
  it('cuts an assistant message inclusively at itself with no composer text', () => {
    expect(cutFor('msg_002')).toEqual({ cloneUpToMessageId: 'msg_002', forkPrefillText: null });
    expect(cutFor('msg_004')).toEqual({ cloneUpToMessageId: 'msg_004', forkPrefillText: null });
  });

  it('cuts a user message at the message before it and carries its own text', () => {
    expect(cutFor('msg_003')).toEqual({
      cloneUpToMessageId: 'msg_002',
      forkPrefillText: 'Second question\n\nwith detail',
    });
  });

  it('offers no fork on the first user message', () => {
    expect(cutFor('msg_001')).toBeNull();
  });

  it('offers no fork on an unknown message', () => {
    expect(cutFor('msg_999')).toBeNull();
  });

  it('offers no fork on a queued or failed message', () => {
    expect(
      cutFor('msg_003', { pendingMessages: new Map([['msg_003', { status: 'queued' }]]) })
    ).toBeNull();
    expect(
      cutFor('msg_003', {
        pendingMessages: new Map([
          ['msg_003', { status: 'failed', error: 'boom', reason: 'execution' }],
        ]),
      })
    ).toBeNull();
  });

  it('skips an undelivered message when picking the cut before a user message', () => {
    const queued = message('msg_0025', 'user', [{ type: 'text', text: 'Queued' }]);
    expect(
      cutFor('msg_003', {
        messages: [U1, A1, queued, U2, A2],
        pendingMessages: new Map([['msg_0025', { status: 'queued' }]]),
      })
    ).toEqual({ cloneUpToMessageId: 'msg_002', forkPrefillText: 'Second question\n\nwith detail' });
  });

  it('offers no fork on the assistant reply that is still streaming', () => {
    expect(cutFor('msg_004', { isSessionStreaming: true })).toBeNull();
    // An earlier, finished reply still forks while the latest one streams.
    expect(cutFor('msg_002', { isSessionStreaming: true })).toEqual({
      cloneUpToMessageId: 'msg_002',
      forkPrefillText: null,
    });
  });

  it('still forks a user message while the reply after it streams', () => {
    expect(cutFor('msg_003', { isSessionStreaming: true })?.cloneUpToMessageId).toBe('msg_002');
  });

  it('carries no composer text for a user message with no prose', () => {
    const attachmentOnly = message('msg_005', 'user', [
      { type: 'text', text: '<file>', synthetic: true },
    ]);
    expect(cutFor('msg_005', { messages: [...TRANSCRIPT, attachmentOnly] })).toEqual({
      cloneUpToMessageId: 'msg_004',
      forkPrefillText: null,
    });
  });
});
