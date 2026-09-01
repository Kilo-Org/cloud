import type {
  PreparationAttempt,
  SessionCommit,
  SessionStatusIndicator,
} from '@kilocode/cloud-agent-sdk';
import type { AssistantMessage } from '@/types/opencode.gen';
import type { Part, ReasoningPart, StoredMessage, TextPart, ToolPart } from './types';
import {
  getVisibleAssistantParts,
  groupConversationMessages,
  commitsByMessageAnchor,
  isCommitSummaryRepresented,
  shouldRenderToolPart,
} from './message-presentation';

function assistantMessage(id: string, overrides: Partial<AssistantMessage> = {}): StoredMessage {
  return {
    info: {
      id,
      sessionID: 'ses-1',
      role: 'assistant',
      time: { created: 1, completed: 2 },
      parentID: 'user-1',
      modelID: 'test-model',
      providerID: 'test-provider',
      mode: 'code',
      agent: 'test-agent',
      path: { cwd: '/', root: '/' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...overrides,
    },
    parts: [],
  };
}

function textPart(id: string, text = 'The answer'): TextPart {
  return { id, sessionID: 'ses-1', messageID: 'assistant-1', type: 'text', text };
}

function reasoningPart(id: string, text = 'Considering the implementation'): ReasoningPart {
  return {
    id,
    sessionID: 'ses-1',
    messageID: 'assistant-1',
    type: 'reasoning',
    text,
    time: { start: 1, end: 2 },
  };
}

function toolPart(
  id: string,
  tool = 'read',
  state: ToolPart['state'] = {
    status: 'completed',
    input: {},
    output: 'Tool output',
    title: tool,
    metadata: {},
    time: { start: 1, end: 2 },
  }
): ToolPart {
  return {
    id,
    sessionID: 'ses-1',
    messageID: 'assistant-1',
    type: 'tool',
    callID: id,
    tool,
    state,
  };
}

const noPreparations = new Map<string, readonly PreparationAttempt[]>();

describe('groupConversationMessages', () => {
  it('returns no groups for an empty transcript', () => {
    expect(groupConversationMessages([], noPreparations)).toEqual([]);
  });

  it('groups consecutive assistant messages from the same turn in their original order', () => {
    const first = assistantMessage('assistant-1');
    const second = assistantMessage('assistant-2');
    const streaming = assistantMessage('assistant-3', { time: { created: 3 } });

    expect(groupConversationMessages([first, second, streaming], noPreparations)).toEqual([
      [first, second, streaming],
    ]);
  });

  it('keeps user messages separate and never groups across them', () => {
    const first = assistantMessage('assistant-1');
    const user: StoredMessage = {
      info: {
        id: 'user-2',
        sessionID: 'ses-1',
        role: 'user',
        time: { created: 3 },
        agent: 'code',
        model: { providerID: 'test-provider', modelID: 'test-model' },
      },
      parts: [textPart('prompt', 'Follow up')],
    };
    const nextUser: StoredMessage = { ...user, info: { ...user.info, id: 'user-3' } };
    const second = assistantMessage('assistant-2');

    expect(groupConversationMessages([first, user, nextUser, second], noPreparations)).toEqual([
      [first],
      [user],
      [nextUser],
      [second],
    ]);
  });

  it.each(['sessionID', 'parentID'] as const)('does not group across a different %s', key => {
    const first = assistantMessage('assistant-1');
    const boundary = assistantMessage('assistant-2', { [key]: 'other' });
    const third = assistantMessage('assistant-3');

    expect(groupConversationMessages([first, boundary, third], noPreparations)).toEqual([
      [first],
      [boundary],
      [third],
    ]);
  });

  it.each([
    ['failure', { name: 'UnknownError', data: { message: 'Request failed' } }],
    ['interruption', { name: 'MessageAbortedError', data: { message: 'aborted' } }],
    ['sanitized string error', 'Request was rate limited'],
  ])('isolates an assistant %s from both neighboring groups', (_label, error) => {
    const first = assistantMessage('assistant-1');
    const failed = assistantMessage('assistant-2');
    Object.defineProperty(failed.info, 'error', { value: error, enumerable: true });
    const third = assistantMessage('assistant-3');
    const fourth = assistantMessage('assistant-4');

    expect(groupConversationMessages([first, failed, third, fourth], noPreparations)).toEqual([
      [first],
      [failed],
      [third, fourth],
    ]);
  });

  it('allows a null error and empty preparation list without creating a boundary', () => {
    const first = assistantMessage('assistant-1');
    const second = assistantMessage('assistant-2');
    Object.defineProperty(first.info, 'error', { value: null, enumerable: true });
    const preparations = new Map<string, readonly PreparationAttempt[]>([['assistant-2', []]]);

    expect(groupConversationMessages([first, second], preparations)).toEqual([[first, second]]);
  });

  it.each(['running', 'completed', 'failed'] as const)(
    'preserves both sides of a %s preparation boundary',
    status => {
      const first = assistantMessage('assistant-1');
      const prepared = assistantMessage('assistant-2');
      const third = assistantMessage('assistant-3');
      const fourth = assistantMessage('assistant-4');
      const attempt: PreparationAttempt = {
        id: 'attempt-1',
        triggerMessageId: prepared.info.id,
        status,
        startedAt: 1,
        revision: 1,
        steps: [],
      };
      const attempts = Object.freeze([attempt]);
      const preparations = new Map([[prepared.info.id, attempts]]);

      expect(groupConversationMessages([first, prepared, third, fourth], preparations)).toEqual([
        [first],
        [prepared],
        [third, fourth],
      ]);
      expect([...preparations]).toEqual([[prepared.info.id, [attempt]]]);
      expect(preparations.get(prepared.info.id)).toBe(attempts);
    }
  );

  it('preserves the original message objects and does not mutate frozen inputs', () => {
    const first = assistantMessage('assistant-1');
    first.parts = [reasoningPart('reasoning-1'), toolPart('read-1')];
    const second = assistantMessage('assistant-2');
    second.parts = [{ ...textPart('answer'), messageID: second.info.id }];
    const messages = [first, second];
    const original = structuredClone(messages);
    for (const message of messages) {
      Object.freeze(message.info);
      Object.freeze(message.parts);
      Object.freeze(message);
    }
    Object.freeze(messages);

    const groups = groupConversationMessages(messages, noPreparations);

    expect(messages).toEqual(original);
    expect(groups).toEqual([[first, second]]);
    expect(groups[0]).not.toBe(messages);
    expect(groups[0]?.[0]).toBe(first);
    expect(groups[0]?.[1]).toBe(second);
  });
});

describe('commitsByMessageAnchor', () => {
  const user: StoredMessage = {
    info: {
      id: 'user-1',
      sessionID: 'ses-1',
      role: 'user',
      time: { created: 1 },
      agent: 'code',
      model: { providerID: 'test', modelID: 'test' },
    },
    parts: [],
  };
  const commit = {
    commitHash: 'a'.repeat(40),
    commitMessage: 'Actual commit',
    messageId: 'assistant-2',
    userMessageId: user.info.id,
    committedAt: '2026-09-01T10:00:00Z',
    pushStatus: 'unknown',
  } satisfies SessionCommit;

  it('waits for a known assistant anchor instead of moving the commit to an older answer', () => {
    const first = assistantMessage('assistant-1');
    expect([...commitsByMessageAnchor([user, first], [commit])]).toEqual([]);
    const anchor = assistantMessage(commit.messageId);
    expect([...commitsByMessageAnchor([user, first, anchor], [commit])]).toEqual([
      [anchor.info.id, [commit]],
    ]);
  });

  it('places the commit only once across completed and dynamic transcript chunks', () => {
    const completed = [user, assistantMessage('assistant-1')];
    const dynamic = [assistantMessage(commit.messageId)];
    expect([...commitsByMessageAnchor(completed, [commit])]).toEqual([]);
    expect([...commitsByMessageAnchor(dynamic, [commit])]).toEqual([[commit.messageId, [commit]]]);
    expect([...commitsByMessageAnchor([...completed, ...dynamic], [commit])]).toEqual([
      [commit.messageId, [commit]],
    ]);
  });

  it('uses user-turn fallback only for an explicit user anchor and after its turn completes', () => {
    const userAnchored = { ...commit, messageId: user.info.id };
    const first = assistantMessage('assistant-1');
    const running = assistantMessage('assistant-2', { time: { created: 3 } });
    expect([...commitsByMessageAnchor([user, first, running], [userAnchored])]).toEqual([]);
    expect([...commitsByMessageAnchor([user, first], [userAnchored])]).toEqual([
      [first.info.id, [userAnchored]],
    ]);
  });

  it('deduplicates replay and prevents grouping across the exact commit boundary', () => {
    const first = assistantMessage(commit.messageId);
    const second = assistantMessage('assistant-3');
    const commits = Object.freeze([commit, { ...commit }]);
    const anchors = commitsByMessageAnchor([first, second], commits);
    expect([...anchors]).toEqual([[first.info.id, [commit]]]);
    expect(groupConversationMessages([first, second], noPreparations, anchors)).toEqual([
      [first],
      [second],
    ]);
  });
});

describe('commit summary suppression', () => {
  const commit: SessionCommit = {
    commitHash: 'a'.repeat(40),
    messageId: 'assistant',
    userMessageId: 'user',
    committedAt: '2026-09-01T10:00:00.000Z',
    commitMessage: 'Actual message',
    pushStatus: 'pushed',
  };
  const represented = new Map([['assistant', [commit]]]);
  const indicator: SessionStatusIndicator = {
    type: 'info',
    message: 'Committed',
    timestamp: 1,
    commitHash: commit.commitHash,
  };

  it('suppresses only an informational summary represented by the same full-SHA line', () => {
    expect(isCommitSummaryRepresented(indicator, represented)).toBe(true);
    expect(isCommitSummaryRepresented(indicator, new Map())).toBe(false);
    expect(
      isCommitSummaryRepresented({ ...indicator, commitHash: `${'a'.repeat(39)}b` }, represented)
    ).toBe(false);
    expect(isCommitSummaryRepresented({ ...indicator, commitHash: undefined }, represented)).toBe(
      false
    );
    for (const type of ['progress', 'error', 'warning'] as const) {
      expect(isCommitSummaryRepresented({ ...indicator, type }, represented)).toBe(false);
    }
  });
});

describe.each([
  { status: 'pending', input: {}, raw: '' },
  { status: 'running', input: {}, time: { start: 1 } },
  {
    status: 'completed',
    input: {},
    output: '',
    title: '',
    metadata: {},
    time: { start: 1, end: 2 },
  },
  { status: 'error', input: {}, error: 'Tool failed', time: { start: 1, end: 2 } },
] satisfies ToolPart['state'][])('shouldRenderToolPart ($status)', state => {
  it.each(['todoread', 'plan_enter', 'plan_exit'])('hides %s', tool => {
    expect(shouldRenderToolPart(toolPart(tool, tool, state))).toBe(false);
  });

  it('shows todowrite only after completion', () => {
    expect(shouldRenderToolPart(toolPart('todos', 'todowrite', state))).toBe(
      state.status === 'completed'
    );
  });

  it.each(['question', 'suggest', 'chart', 'permission', 'task', 'custom-tool'])(
    'preserves the %s flow',
    tool => {
      expect(shouldRenderToolPart(toolPart(tool, tool, state))).toBe(true);
    }
  );
});

describe('getVisibleAssistantParts', () => {
  it('keeps reasoning, tools, and prose in transcript order', () => {
    const parts = [
      reasoningPart('reasoning-1'),
      toolPart('read-1'),
      textPart('answer-1'),
      textPart('answer-2', 'Next steps'),
      toolPart('edit-1', 'edit'),
      reasoningPart('reasoning-2'),
    ];

    expect(getVisibleAssistantParts(parts)).toEqual(parts);
  });

  it('keeps all tool states, interactive tools, files, subtasks, and unknown parts visible', () => {
    const unknown = textPart('unknown', '');
    Object.defineProperty(unknown, 'type', { value: 'future-part', enumerable: true });
    const parts: Part[] = [
      toolPart('pending', 'read', { status: 'pending', input: {}, raw: '' }),
      toolPart('running', 'bash', { status: 'running', input: {}, time: { start: 1 } }),
      toolPart('completed', 'edit'),
      toolPart('failed', 'bash', {
        status: 'error',
        input: {},
        error: 'Command failed',
        time: { start: 1, end: 2 },
      }),
      toolPart('question-1', 'question'),
      toolPart('suggest-1', 'suggest'),
      toolPart('chart-1', 'chart'),
      toolPart('permission-1', 'permission'),
      toolPart('todos-1', 'todowrite'),
      toolPart('background-1', 'background_process'),
      toolPart('apply-patch-1', 'apply_patch'),
      toolPart('fetch-1', 'webfetch'),
      toolPart('code-search-1', 'codesearch'),
      toolPart('task-1', 'task'),
      toolPart('custom-1', 'custom-tool'),
      {
        id: 'file-1',
        sessionID: 'ses-1',
        messageID: 'assistant-1',
        type: 'file',
        mime: 'text/plain',
        filename: 'report.txt',
        url: '',
      },
      {
        id: 'subtask-1',
        sessionID: 'ses-1',
        messageID: 'assistant-1',
        type: 'subtask',
        agent: 'explore',
        description: 'Inspect the parser',
        prompt: 'Find the parsing code',
      },
      unknown,
    ];

    expect(getVisibleAssistantParts(parts)).toEqual(parts);
  });

  it('filters hidden parts without changing the order of visible neighbors', () => {
    const base = { sessionID: 'ses-1', messageID: 'assistant-1' };
    const hidden: Part[] = [
      { ...base, id: 'start', type: 'step-start' },
      {
        ...base,
        id: 'finish',
        type: 'step-finish',
        reason: 'tool-calls',
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      { ...base, id: 'patch', type: 'patch', hash: 'hash-1', files: ['report.txt'] },
      textPart('empty-text', ''),
      textPart('blank-text', ' \n\t '),
      reasoningPart('empty-reasoning', ''),
      reasoningPart('blank-reasoning', ' \n\t '),
      reasoningPart('redacted-reasoning', '[REDACTED]'),
      reasoningPart('repeated-redactions', ' [REDACTED]\n[REDACTED][REDACTED]\t '),
      reasoningPart('comment-placeholder', '<!-- reasoning unavailable -->'),
      reasoningPart('comment-and-redaction', '[REDACTED]<!-- placeholder -->'),
      { ...reasoningPart('unfinished-comment', '<!--'), time: { start: 1 } },
      { ...reasoningPart('unfinished-empty-reasoning', ''), time: { start: 1 } },
      { ...reasoningPart('unfinished-blank-reasoning', ' \n\t '), time: { start: 1 } },
      {
        ...reasoningPart('openai-encrypted', ''),
        metadata: { openai: { reasoningEncryptedContent: 'encrypted-reasoning' } },
      },
      {
        ...reasoningPart('copilot-encrypted', ''),
        metadata: { copilot: { reasoningEncryptedContent: 'encrypted-reasoning' } },
      },
      {
        ...reasoningPart('openrouter-encrypted', ' \n\t '),
        metadata: {
          openrouter: {
            reasoning_details: [{ type: 'reasoning.encrypted', data: 'encrypted-reasoning' }],
          },
        },
      },
      {
        ...reasoningPart('anthropic-redacted', ''),
        metadata: { anthropic: { redactedData: 'redacted-reasoning' } },
      },
      toolPart('enter', 'plan_enter'),
      toolPart('exit', 'plan_exit'),
      toolPart('read-todos', 'todoread'),
      toolPart('pending-todos', 'todowrite', { status: 'pending', input: {}, raw: '' }),
      toolPart('running-todos', 'todowrite', {
        status: 'running',
        input: {},
        time: { start: 1 },
      }),
      toolPart('failed-todos', 'todowrite', {
        status: 'error',
        input: {},
        error: 'Hidden todo error',
        time: { start: 1, end: 2 },
      }),
    ];
    const reasoning = reasoningPart('reasoning-1');
    const tool = toolPart('read-1');

    expect(getVisibleAssistantParts([])).toEqual([]);
    expect(getVisibleAssistantParts(hidden)).toEqual([]);
    expect(getVisibleAssistantParts([reasoning, ...hidden, tool])).toEqual([reasoning, tool]);
  });

  it('preserves readable reasoning alongside redactions and encrypted-only metadata', () => {
    const redacted = reasoningPart(
      'redacted',
      '<!-- placeholder -->Check [REDACTED] before continuing.'
    );
    const encrypted = {
      ...reasoningPart('encrypted', 'The answer depends on the input.'),
      metadata: {
        openrouter: {
          reasoning_details: [{ type: 'reasoning.encrypted', data: 'encrypted-reasoning' }],
        },
      },
    };
    const answer = textPart('answer');

    expect(getVisibleAssistantParts([redacted, encrypted, answer])).toEqual([
      redacted,
      encrypted,
      answer,
    ]);
  });

  it('preserves visible part identity without changing frozen parts or their input array', () => {
    const visible = [reasoningPart('reasoning-1'), toolPart('read-1'), textPart('answer')];
    const parts = [reasoningPart('hidden', '[REDACTED]'), ...visible];
    const original = structuredClone(parts);
    parts.forEach(Object.freeze);
    Object.freeze(parts);

    const displayed = getVisibleAssistantParts(parts);

    expect(parts).toEqual(original);
    expect(displayed).toEqual(visible);
    displayed.forEach((part, index) => expect(part).toBe(visible[index]));
  });
});
