import { describe, expect, it, vi } from 'vitest';

import {
  type KiloSessionId,
  type MessageDeliveryState,
  type StoredMessage,
  type ToolPart,
} from '@kilocode/cloud-agent-sdk';
import {
  collectEmptyChildSessionIds,
  countInFlightMessages,
  hydrateEmptyChildSessions,
  resolveRetryPrompt,
  retryMessageAndClear,
} from './session-detail-content-helpers';
import { assistantMessage, userMessage } from './message-bubble-test-utils';

const subagentSessionId = 'ses-child' as KiloSessionId;
const otherSubagentSessionId = 'ses-child-2' as KiloSessionId;

const noChildMessages = (): StoredMessage[] => [];

function makeToolPart(tool: string, state: ToolPart['state']): ToolPart {
  return {
    id: 'p1',
    sessionID: 'ses-1',
    messageID: 'msg-1',
    type: 'tool',
    tool,
    callID: 'call-1',
    state,
  };
}

function makeTaskPart(
  status: 'pending' | 'running' | 'completed' | 'error',
  sessionId: KiloSessionId = subagentSessionId,
  input: Record<string, unknown> = {}
): ToolPart {
  if (status === 'pending') {
    return makeToolPart('task', { status: 'pending', input, raw: '' });
  }
  if (status === 'running') {
    return makeToolPart('task', {
      status: 'running',
      input,
      time: { start: 1 },
      metadata: { sessionId },
    });
  }
  if (status === 'completed') {
    return makeToolPart('task', {
      status: 'completed',
      input,
      output: 'done',
      title: 'Task',
      metadata: { sessionId },
      time: { start: 1, end: 2 },
    });
  }
  return makeToolPart('task', {
    status: 'error',
    input,
    error: 'failed',
    metadata: { sessionId },
    time: { start: 1, end: 2 },
  });
}

function makeAssistantMessage(parts: ToolPart[], id = 'msg-1'): StoredMessage {
  return {
    info: {
      id,
      sessionID: 'ses-1',
      role: 'assistant',
      time: { created: 1 },
      parentID: 'msg-0',
      modelID: 'claude',
      providerID: 'anthropic',
      mode: 'code',
      agent: 'build',
      path: { cwd: '/', root: '/' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts,
  };
}

describe('countInFlightMessages', () => {
  it('excludes a failed pending row from the in-flight count', () => {
    const pending = new Map<string, MessageDeliveryState>([
      ['m1', { status: 'queued' }],
      ['m2', { status: 'failed', error: 'nope', reason: 'exhausted' }],
    ]);
    expect(countInFlightMessages(pending)).toBe(1);
  });

  it('returns zero when every pending row failed', () => {
    const pending = new Map<string, MessageDeliveryState>([
      ['m1', { status: 'failed', error: 'nope', reason: 'interrupted' }],
    ]);
    expect(countInFlightMessages(pending)).toBe(0);
  });

  it('counts every queued row', () => {
    const pending = new Map<string, MessageDeliveryState>([
      ['m1', { status: 'queued' }],
      ['m2', { status: 'queued' }],
    ]);
    expect(countInFlightMessages(pending)).toBe(2);
  });
});

describe('retryMessageAndClear', () => {
  it('clears the failed row when the retry send succeeds', async () => {
    const send = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const clearFailed = vi.fn<() => void>();
    await retryMessageAndClear(send, clearFailed);
    expect(send).toHaveBeenCalledTimes(1);
    expect(clearFailed).toHaveBeenCalledTimes(1);
  });

  it('does not clear the failed row when the retry send fails', async () => {
    const send = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error('Failed to send message'));
    const clearFailed = vi.fn<() => void>();
    await retryMessageAndClear(send, clearFailed);
    expect(send).toHaveBeenCalledTimes(1);
    expect(clearFailed).not.toHaveBeenCalled();
  });
});

describe('resolveRetryPrompt', () => {
  it('returns only the first human text part for a user row with a synthetic notice', () => {
    const message = userMessage('m1');
    message.parts = [
      {
        id: 'm1-prompt',
        sessionID: 'ses_1',
        messageID: 'm1',
        type: 'text',
        text: 'prompt',
      },
      {
        id: 'm1-notice',
        sessionID: 'ses_1',
        messageID: 'm1',
        type: 'text',
        text: 'binary attachment saved: … path=…',
        synthetic: true,
      },
    ] as typeof message.parts;

    expect(resolveRetryPrompt(message, [message])).toBe('prompt');
  });

  it('returns the synthetic queued prompt text for a user row whose only text part is synthetic', () => {
    const message = userMessage('m1b');
    message.parts = [
      {
        id: 'm1b-prompt',
        sessionID: 'ses_1',
        messageID: 'm1b',
        type: 'text',
        text: 'prompt',
        synthetic: true,
      },
    ] as typeof message.parts;

    expect(resolveRetryPrompt(message, [message])).toBe('prompt');
  });

  it('returns null for a file-only user row', () => {
    const message = userMessage('m2');
    message.parts = [
      {
        id: 'm2-file',
        sessionID: 'ses_1',
        messageID: 'm2',
        type: 'file',
        mime: 'text/plain',
        url: 'x',
      },
    ] as typeof message.parts;

    expect(resolveRetryPrompt(message, [message])).toBeNull();
  });

  it('returns the preceding user row human text for an assistant failure', () => {
    const user = userMessage('m3');
    const assistant = assistantMessage('m4');
    const messages: StoredMessage[] = [user, assistant];

    expect(resolveRetryPrompt(assistant, messages)).toBe('hi');
  });

  it('returns null for an assistant row with no preceding user row', () => {
    const assistant = assistantMessage('m5');
    expect(resolveRetryPrompt(assistant, [assistant])).toBeNull();
  });
});

describe('collectEmptyChildSessionIds', () => {
  it('returns [] for no messages', () => {
    expect(collectEmptyChildSessionIds([], noChildMessages)).toEqual([]);
  });

  it('returns [] for a non-task tool part', () => {
    const readPart = makeToolPart('read', {
      status: 'completed',
      input: { filePath: 'x' },
      output: 'y',
      title: 'read',
      metadata: {},
      time: { start: 1, end: 2 },
    });
    const messages = [makeAssistantMessage([readPart])];
    expect(collectEmptyChildSessionIds(messages, noChildMessages)).toEqual([]);
  });

  it('returns [] for a pending task with no metadata sessionId', () => {
    const messages = [makeAssistantMessage([makeTaskPart('pending')])];
    expect(collectEmptyChildSessionIds(messages, noChildMessages)).toEqual([]);
  });

  it('returns the id for a completed task with empty child messages', () => {
    const messages = [makeAssistantMessage([makeTaskPart('completed')])];
    expect(collectEmptyChildSessionIds(messages, noChildMessages)).toEqual([subagentSessionId]);
  });

  it('returns [] for a completed task with existing child messages', () => {
    const messages = [makeAssistantMessage([makeTaskPart('completed')])];
    const getChildMessages = (id: KiloSessionId): StoredMessage[] =>
      id === subagentSessionId ? [makeAssistantMessage([], 'child-msg')] : [];
    expect(collectEmptyChildSessionIds(messages, getChildMessages)).toEqual([]);
  });

  it('includes running and error task states when empty', () => {
    const messages = [
      makeAssistantMessage([makeTaskPart('running', subagentSessionId)], 'msg-run'),
      makeAssistantMessage([makeTaskPart('error', otherSubagentSessionId)], 'msg-err'),
    ];
    expect(collectEmptyChildSessionIds(messages, noChildMessages)).toEqual([
      subagentSessionId,
      otherSubagentSessionId,
    ]);
  });

  it('returns a duplicate task id once', () => {
    const messages = [
      makeAssistantMessage([makeTaskPart('completed', subagentSessionId)], 'msg-1'),
      makeAssistantMessage([makeTaskPart('completed', subagentSessionId)], 'msg-2'),
    ];
    expect(collectEmptyChildSessionIds(messages, noChildMessages)).toEqual([subagentSessionId]);
  });

  it('returns two different empty child ids in first-seen order', () => {
    const messages = [
      makeAssistantMessage([makeTaskPart('completed', subagentSessionId)], 'msg-1'),
      makeAssistantMessage([makeTaskPart('completed', otherSubagentSessionId)], 'msg-2'),
    ];
    expect(collectEmptyChildSessionIds(messages, noChildMessages)).toEqual([
      subagentSessionId,
      otherSubagentSessionId,
    ]);
  });
});

describe('hydrateEmptyChildSessions', () => {
  it('does not retry when ready after the first hydrate', async () => {
    let status = 'loading';
    const hydrate = vi.fn(async () => {
      status = 'ready';
      await Promise.resolve();
    });
    const readHydrationStatus = vi.fn(() => status);
    const retried = new Set<string>();
    await hydrateEmptyChildSessions([subagentSessionId], hydrate, readHydrationStatus, retried);
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(retried.size).toBe(0);
  });

  it('retries once when the first hydrate errors and the second readies', async () => {
    let status = 'loading';
    const hydrate = vi.fn(async () => {
      status = status === 'loading' ? 'error' : 'ready';
      await Promise.resolve();
    });
    const readHydrationStatus = vi.fn(() => status);
    const retried = new Set<string>();
    await hydrateEmptyChildSessions([subagentSessionId], hydrate, readHydrationStatus, retried);
    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(retried.has(subagentSessionId)).toBe(true);
  });

  it('stops at two hydrates when the retry also errors', async () => {
    const hydrate = vi.fn(async () => {
      await Promise.resolve();
    });
    const readHydrationStatus = vi.fn(() => 'error');
    const retried = new Set<string>();
    await hydrateEmptyChildSessions([subagentSessionId], hydrate, readHydrationStatus, retried);
    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(retried.has(subagentSessionId)).toBe(true);
  });

  it('does not retry an id already in retried', async () => {
    const hydrate = vi.fn(async () => {
      await Promise.resolve();
    });
    const readHydrationStatus = vi.fn(() => 'error');
    const retried = new Set<string>([subagentSessionId]);
    await hydrateEmptyChildSessions([subagentSessionId], hydrate, readHydrationStatus, retried);
    expect(hydrate).toHaveBeenCalledTimes(1);
  });
});
