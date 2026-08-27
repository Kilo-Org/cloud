import { describe, expect, it } from 'vitest';
import type {
  AcceptedCommandTurn,
  AcceptedPromptTurn,
  AgentSelection,
  AgentSelectionOverride,
} from '../execution/types.js';
import {
  acceptQueuedMessage,
  assignPreparationAttemptId,
  cancelActiveMessages,
  createSessionMessageRecord,
  failQueuedMessage,
  freezeLegacyQueuedMessages,
  getSessionMessageTurn,
  hasAcceptedMessage,
  hasInterruptibleWork,
  matchesSessionMessageReplay,
  nextQueuedMessageId,
  recordAcceptedMessageActivity,
  resolveSessionMessageIntent,
  streamCloudStatus,
  streamQueuedSnapshots,
  terminalizeAcceptedMessages,
  userTurnTerminalState,
  type ControlSessionMessageInput,
  type ControlSessionMessageIntent,
  type SessionMessageRecord,
} from './session-message-queue.js';

function msg(messageId: string, state: SessionMessageRecord['state']): SessionMessageRecord {
  return { messageId, state };
}

const promptTurn: AcceptedPromptTurn = {
  type: 'prompt',
  messageId: 'a',
  prompt: 'inspect attachment',
  attachments: { path: 'attachment-path', files: ['document.pdf', 'image.png'] },
};
const commandTurn: AcceptedCommandTurn = {
  type: 'command',
  messageId: 'b',
  command: 'review',
  arguments: '--all changes',
};
const defaultAgent: AgentSelection = {
  mode: 'code',
  model: 'kilo/anthropic/claude-sonnet-4',
  variant: 'high',
};

const invalidModels = ['', '   ', 'kilo/', ' kilo/  '];

describe('resolveSessionMessageIntent', () => {
  it('inherits the admitted selection without converting the stored Cloud token', () => {
    expect(resolveSessionMessageIntent({ turn: promptTurn }, defaultAgent)).toEqual({
      turn: promptTurn,
      agent: defaultAgent,
    });
    expect(resolveSessionMessageIntent({ turn: commandTurn }, defaultAgent)).toEqual({
      turn: commandTurn,
      agent: defaultAgent,
    });
  });

  it.each(['anthropic/claude-sonnet-4', ' kilo/anthropic/claude-sonnet-4 '])(
    'retains the same-model variant for the explicit alias %j',
    model => {
      expect(
        resolveSessionMessageIntent({ turn: promptTurn, agent: { model } }, defaultAgent)?.agent
      ).toEqual({ ...defaultAgent, model });
    }
  );

  it('clears the inherited variant when the effective model changes', () => {
    expect(
      resolveSessionMessageIntent(
        { turn: promptTurn, agent: { model: 'kilo/openai/gpt-4.1' } },
        defaultAgent
      )?.agent
    ).toEqual({ mode: 'code', model: 'kilo/openai/gpt-4.1' });
    expect(defaultAgent.variant).toBe('high');
  });

  it.each(['low', ''])('preserves explicit mode and variant %j on a changed model', variant => {
    const agent = { mode: 'architect', model: 'google/gemini-2.5-pro', variant };
    expect(resolveSessionMessageIntent({ turn: promptTurn, agent }, defaultAgent)?.agent).toEqual(
      agent
    );
  });

  it('uses an already resolved creation agent without needing registered defaults', () => {
    expect(resolveSessionMessageIntent({ turn: promptTurn, agent: defaultAgent })).toEqual({
      turn: promptTurn,
      agent: defaultAgent,
    });
  });

  it.each([
    'kilo/kilo/example',
    'kilo/kilo-auto/free',
    'openrouter/free',
    'vendor/team/Model:free~alias',
  ])('keeps the opaque Cloud token %j unchanged', model => {
    expect(resolveSessionMessageIntent({ turn: promptTurn, agent: { model } })?.agent).toEqual({
      mode: 'code',
      model,
    });
  });

  it('does not treat two levels of kilo qualification as the same catalog ID', () => {
    expect(
      resolveSessionMessageIntent(
        { turn: promptTurn, agent: { model: 'kilo/example' } },
        { model: 'kilo/kilo/example', variant: 'high' }
      )?.agent
    ).toEqual({ mode: 'code', model: 'kilo/example' });
  });

  it.each(invalidModels)('rejects explicit invalid model %j rather than inheriting', model => {
    for (const turn of [promptTurn, commandTurn]) {
      expect(resolveSessionMessageIntent({ turn, agent: { model } }, defaultAgent)).toBeUndefined();
    }
  });

  it.each([undefined, ...invalidModels])(
    'rejects a prompt with invalid default model %j',
    model => {
      expect(resolveSessionMessageIntent({ turn: promptTurn }, { model })).toBeUndefined();
    }
  );

  it('allows a command with no model while preserving explicit mode and variant', () => {
    expect(
      resolveSessionMessageIntent({
        turn: commandTurn,
        agent: { mode: 'reviewer', variant: 'low' },
      })
    ).toEqual({ turn: commandTurn, agent: { mode: 'reviewer', variant: 'low' } });
    expect(resolveSessionMessageIntent({ turn: commandTurn })).toEqual({
      turn: commandTurn,
      agent: { mode: 'code' },
    });
  });

  it('snapshots the input before defaults, attachments, or finalization can change', () => {
    const defaults = { ...defaultAgent };
    const turn = structuredClone(promptTurn);
    const finalization = { autoCommit: true, condenseOnComplete: false };
    const intent = resolveSessionMessageIntent({ turn, finalization }, defaults);
    defaults.model = 'kilo/openai/gpt-4.1';
    defaults.mode = 'architect';
    defaults.variant = 'low';
    turn.attachments?.files.push('later.pdf');
    finalization.autoCommit = false;

    expect(intent).toEqual({
      turn: promptTurn,
      agent: defaultAgent,
      finalization: { autoCommit: true, condenseOnComplete: false },
    });
  });
});

describe('createSessionMessageRecord', () => {
  it('writes only a nested V2 intent and isolates it from later input mutations', () => {
    const intent: ControlSessionMessageIntent = {
      turn: structuredClone(promptTurn),
      agent: { ...defaultAgent },
      finalization: { autoCommit: true },
    };
    const original = structuredClone(intent);
    const record = createSessionMessageRecord(intent);
    intent.agent.model = 'kilo/openai/gpt-4.1';
    intent.turn.attachments?.files.push('later.pdf');

    expect(record).toEqual({
      version: 2,
      messageId: promptTurn.messageId,
      state: 'queued',
      intent: original,
    });
    expect(record).not.toHaveProperty('turn');
    expect(record).not.toHaveProperty('prompt');
  });

  it('keeps a model-less command model-less through acceptance, activity, and completion', () => {
    const record = createSessionMessageRecord({ turn: commandTurn, agent: { mode: 'code' } });
    const accepted = acceptQueuedMessage([record], commandTurn.messageId, 10) ?? [];
    const active = recordAcceptedMessageActivity(accepted, 20) ?? [];
    const completed = terminalizeAcceptedMessages(active, 'completed');

    expect(completed).toEqual([
      {
        ...record,
        state: 'completed',
        acceptedAt: 10,
        lastActivityAt: 20,
      },
    ]);
    expect(completed[0].intent).toBe(record.intent);
    expect(completed[0].intent?.agent).not.toHaveProperty('model');
  });
});

describe('matchesSessionMessageReplay', () => {
  const promptRecord = createSessionMessageRecord({
    turn: promptTurn,
    agent: defaultAgent,
    finalization: { autoCommit: true, condenseOnComplete: false },
  });

  it('uses stored selection for omitted overrides on queued and accepted retries', () => {
    expect(matchesSessionMessageReplay(promptRecord, { turn: promptTurn })).toBe(true);
    expect(
      matchesSessionMessageReplay(
        { ...promptRecord, state: 'accepted', acceptedAt: 10 },
        { turn: promptTurn }
      )
    ).toBe(true);
    expect(promptRecord.intent.agent).toEqual(defaultAgent);
  });

  it.each(['anthropic/claude-sonnet-4', ' kilo/anthropic/claude-sonnet-4 '])(
    'accepts an equivalent explicit gateway alias %j',
    model => {
      expect(
        matchesSessionMessageReplay(promptRecord, { turn: promptTurn, agent: { model } })
      ).toBe(true);
      expect(promptRecord.intent.agent.model).toBe(defaultAgent.model);
    }
  );

  it.each([
    ['model', { model: 'openai/gpt-4.1' }],
    ['mode', { mode: 'architect' }],
    ['variant', { variant: 'low' }],
    ['blank variant', { variant: '' }],
    ...invalidModels.map((model): [string, AgentSelectionOverride] => ['invalid model', { model }]),
  ] satisfies [string, AgentSelectionOverride][])(
    'rejects a conflicting explicit %s',
    (_field, agent) => {
      expect(matchesSessionMessageReplay(promptRecord, { turn: promptTurn, agent })).toBe(false);
    }
  );

  it.each([
    ['message ID', { ...promptTurn, messageId: 'other' }],
    ['prompt', { ...promptTurn, prompt: 'different request' }],
    ['removed attachments', { type: 'prompt', messageId: 'a', prompt: promptTurn.prompt }],
    [
      'attachment path',
      { ...promptTurn, attachments: { path: 'other-path', files: ['document.pdf', 'image.png'] } },
    ],
    [
      'attachment files',
      { ...promptTurn, attachments: { path: 'attachment-path', files: ['other.pdf'] } },
    ],
    [
      'attachment order',
      {
        ...promptTurn,
        attachments: { path: 'attachment-path', files: ['image.png', 'document.pdf'] },
      },
    ],
  ] satisfies [string, AcceptedPromptTurn][])(
    'rejects changed immutable turn data: %s',
    (_field, turn) => {
      expect(matchesSessionMessageReplay(promptRecord, { turn })).toBe(false);
    }
  );

  it('compares canonical prompt fields independently of object property order', () => {
    expect(
      matchesSessionMessageReplay(promptRecord, {
        turn: {
          attachments: { files: ['document.pdf', 'image.png'], path: 'attachment-path' },
          prompt: promptTurn.prompt,
          messageId: 'a',
          type: 'prompt',
        },
      })
    ).toBe(true);
  });

  it.each([{ autoCommit: false }, { condenseOnComplete: true }])(
    'rejects conflicting finalization %j',
    finalization => {
      expect(matchesSessionMessageReplay(promptRecord, { turn: promptTurn, finalization })).toBe(
        false
      );
    }
  );

  it('compares command name, arguments, and turn type, not just rendered content', () => {
    const record = createSessionMessageRecord({ turn: commandTurn, agent: defaultAgent });
    expect(
      matchesSessionMessageReplay(record, {
        turn: commandTurn,
        agent: { model: 'anthropic/claude-sonnet-4' },
      })
    ).toBe(true);
    for (const turn of [
      { ...commandTurn, command: 'status' },
      { ...commandTurn, arguments: '--staged' },
      { type: 'prompt', messageId: commandTurn.messageId, prompt: '/review --all changes' },
    ] satisfies ControlSessionMessageInput['turn'][]) {
      expect(matchesSessionMessageReplay(record, { turn })).toBe(false);
    }
  });

  it('does not let a replay select a model for a frozen model-less command', () => {
    const record = createSessionMessageRecord({ turn: commandTurn, agent: { mode: 'code' } });
    expect(matchesSessionMessageReplay(record, { turn: commandTurn })).toBe(true);
    expect(
      matchesSessionMessageReplay(record, {
        turn: commandTurn,
        agent: { model: defaultAgent.model },
      })
    ).toBe(false);
  });

  it('compares catalog identity after removing at most one outer qualifier', () => {
    const record = createSessionMessageRecord({
      turn: promptTurn,
      agent: { mode: 'code', model: 'kilo/kilo/example' },
    });
    expect(
      matchesSessionMessageReplay(record, {
        turn: promptTurn,
        agent: { model: ' kilo/kilo/example ' },
      })
    ).toBe(true);
    expect(
      matchesSessionMessageReplay(record, { turn: promptTurn, agent: { model: 'kilo/example' } })
    ).toBe(false);
  });

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'rejects terminal %s IDs in all formats',
    state => {
      for (const record of [
        { ...promptRecord, state },
        { messageId: promptTurn.messageId, state, turn: promptTurn },
        { messageId: promptTurn.messageId, state, prompt: promptTurn.prompt },
      ]) {
        const original = structuredClone(record);
        expect(matchesSessionMessageReplay(record, { turn: promptTurn })).toBe(false);
        expect(record).toEqual(original);
      }
    }
  );

  it.each([promptTurn, commandTurn])(
    'checks legacy accepted $type content without inventing unknown selection',
    turn => {
      const record: SessionMessageRecord = {
        messageId: turn.messageId,
        state: 'accepted',
        acceptedAt: 10,
        turn,
      };
      expect(
        matchesSessionMessageReplay(record, { turn, agent: { model: 'openai/gpt-4.1' } })
      ).toBe(true);
      expect(record).not.toHaveProperty('intent');
      expect(record.state).toBe('accepted');
    }
  );

  it('checks legacy prompt-only content without reconstructing a command', () => {
    const record: SessionMessageRecord = {
      messageId: 'b',
      state: 'accepted',
      prompt: '/review --all changes',
    };
    expect(
      matchesSessionMessageReplay(record, {
        turn: { type: 'prompt', messageId: 'b', prompt: '/review --all changes' },
      })
    ).toBe(true);
    expect(matchesSessionMessageReplay(record, { turn: commandTurn })).toBe(false);
    expect(record).not.toHaveProperty('intent');
  });
});

describe('freezeLegacyQueuedMessages', () => {
  it('freezes both legacy formats against pre-update defaults without changing history', () => {
    const current = createSessionMessageRecord({
      turn: { type: 'prompt', messageId: 'current', prompt: 'new model' },
      agent: { mode: 'architect', model: 'kilo/openai/gpt-4.1' },
    });
    const history: SessionMessageRecord[] = [
      {
        messageId: 'accepted',
        state: 'accepted',
        turn: { ...promptTurn, messageId: 'accepted' },
        acceptedAt: 10,
      },
      { messageId: 'completed', state: 'completed', prompt: 'done' },
      { messageId: 'failed', state: 'failed', prompt: 'failed', failedReason: 'prompt_exhausted' },
      {
        messageId: 'cancelled',
        state: 'cancelled',
        turn: { ...commandTurn, messageId: 'cancelled' },
      },
    ];
    const messages: SessionMessageRecord[] = [
      {
        messageId: promptTurn.messageId,
        state: 'queued',
        turn: promptTurn,
        prompt: 'stale compatibility content',
        attachFailures: 1,
        promptFailures: 2,
        preparationAttemptId: 'attempt-1',
      },
      { messageId: commandTurn.messageId, state: 'queued', turn: commandTurn },
      { messageId: 'old', state: 'queued', prompt: 'old prompt' },
      current,
      ...history,
    ];
    const original = structuredClone(messages);
    const frozen = freezeLegacyQueuedMessages(messages, defaultAgent);

    expect(frozen.slice(0, 3)).toEqual([
      {
        ...createSessionMessageRecord({ turn: promptTurn, agent: defaultAgent }),
        attachFailures: 1,
        promptFailures: 2,
        preparationAttemptId: 'attempt-1',
      },
      createSessionMessageRecord({ turn: commandTurn, agent: defaultAgent }),
      createSessionMessageRecord({
        turn: { type: 'prompt', messageId: 'old', prompt: 'old prompt' },
        agent: defaultAgent,
      }),
    ]);
    expect(frozen[3]).toBe(current);
    for (const [index, record] of history.entries()) {
      expect(frozen[index + 4]).toBe(record);
      expect(record).not.toHaveProperty('intent');
    }
    expect(messages).toEqual(original);
    const restored = structuredClone(frozen);
    expect(
      freezeLegacyQueuedMessages(restored, { mode: 'architect', model: 'kilo/openai/gpt-4.1' })
    ).toEqual(frozen);
  });

  it('freezes a model-less legacy command without inheriting a later model', () => {
    const frozen = freezeLegacyQueuedMessages([
      { messageId: commandTurn.messageId, state: 'queued', turn: commandTurn },
    ]);
    expect(frozen[0].intent).toEqual({ turn: commandTurn, agent: { mode: 'code' } });
    expect(freezeLegacyQueuedMessages(frozen, defaultAgent)[0]).toBe(frozen[0]);
    expect(frozen[0].intent?.agent).not.toHaveProperty('model');
  });

  it.each([undefined, ...invalidModels])(
    'keeps legacy queued prompts fail-able when the pre-update model is %j',
    model => {
      const messages: SessionMessageRecord[] = [
        { messageId: 'a', state: 'queued', turn: promptTurn },
        { messageId: 'old', state: 'queued', prompt: 'old prompt' },
      ];
      const frozen = freezeLegacyQueuedMessages(messages, { model });
      expect(frozen).toEqual(messages.map(message => ({ ...message, legacyIntentInvalid: true })));
      expect(freezeLegacyQueuedMessages(frozen, defaultAgent)).toEqual(frozen);
      expect(frozen.every(message => message.intent === undefined)).toBe(true);
      expect(getSessionMessageTurn(frozen[0])).toEqual(promptTurn);
      expect(matchesSessionMessageReplay(frozen[0], { turn: promptTurn })).toBe(false);
      expect(failQueuedMessage(frozen, 'a')?.[0]).toEqual({ ...frozen[0], state: 'failed' });
    }
  );

  it('does not invent missing turn content or reinterpret old command-like prompt text', () => {
    const frozen = freezeLegacyQueuedMessages(
      [
        { messageId: 'missing', state: 'queued' },
        { messageId: 'old-command', state: 'queued', prompt: '/review --all' },
      ],
      defaultAgent
    );
    expect(frozen[0]).toEqual({
      messageId: 'missing',
      state: 'queued',
      legacyIntentInvalid: true,
    });
    expect(frozen[1].intent?.turn).toEqual({
      type: 'prompt',
      messageId: 'old-command',
      prompt: '/review --all',
    });
  });
});

describe('nextQueuedMessageId', () => {
  it('returns the oldest queued message when none are accepted', () => {
    expect(
      nextQueuedMessageId([msg('a', 'completed'), msg('b', 'queued'), msg('c', 'queued')])
    ).toBe('b');
  });

  it('returns undefined while a message is accepted', () => {
    expect(nextQueuedMessageId([msg('a', 'accepted'), msg('b', 'queued')])).toBeUndefined();
  });

  it('returns undefined when the queue is empty', () => {
    expect(nextQueuedMessageId([msg('a', 'completed')])).toBeUndefined();
  });
});

describe('assignPreparationAttemptId', () => {
  it('returns undefined when the message is missing', () => {
    expect(assignPreparationAttemptId([msg('a', 'queued')], 'missing', () => 'attempt-1')).toBe(
      undefined
    );
  });

  it('reuses an existing id and preserves the array identity', () => {
    const messages = [{ ...msg('a', 'queued'), preparationAttemptId: 'attempt-1' }];

    const assigned = assignPreparationAttemptId(messages, 'a', () => 'attempt-2');

    expect(assigned?.attemptId).toBe('attempt-1');
    expect(assigned?.messages).toBe(messages);
  });

  it('mints an id and stores it only on the matching message', () => {
    const messages = [msg('a', 'queued'), msg('b', 'queued')];

    const assigned = assignPreparationAttemptId(messages, 'b', () => 'attempt-1');

    expect(assigned?.attemptId).toBe('attempt-1');
    expect(assigned?.messages).not.toBe(messages);
    expect(assigned?.messages).toEqual([
      msg('a', 'queued'),
      { ...msg('b', 'queued'), preparationAttemptId: 'attempt-1' },
    ]);
  });
});

describe('userTurnTerminalState', () => {
  it('maps session.turn.close and session.error only', () => {
    expect(userTurnTerminalState('session.turn.close')).toBe('completed');
    expect(userTurnTerminalState('session.error')).toBe('failed');
    expect(userTurnTerminalState('session.idle')).toBeUndefined();
    expect(userTurnTerminalState('message.updated')).toBeUndefined();
  });

  it.each([
    ['session.turn.close', 'completed'],
    ['session.error', 'failed'],
  ])('settles %s only for the root session', (type, state) => {
    expect(userTurnTerminalState(type, 'root', 'root')).toBe(state);
    expect(userTurnTerminalState(type, 'child', 'root')).toBeUndefined();
    expect(userTurnTerminalState(type, undefined, 'root')).toBe(state);
  });
});

describe('terminalizeAcceptedMessages', () => {
  it('completes only accepted messages and leaves queued intact', () => {
    const next = terminalizeAcceptedMessages(
      [msg('a', 'accepted'), msg('b', 'queued'), msg('c', 'completed')],
      'completed'
    );
    expect(next.map(message => [message.messageId, message.state])).toEqual([
      ['a', 'completed'],
      ['b', 'queued'],
      ['c', 'completed'],
    ]);
    expect(hasAcceptedMessage(next)).toBe(false);
  });
});

describe('cancelActiveMessages', () => {
  it('cancels queued and accepted messages and leaves terminals intact', () => {
    const { messages, cancelledIds } = cancelActiveMessages([
      msg('a', 'accepted'),
      msg('b', 'queued'),
      msg('c', 'completed'),
      msg('d', 'failed'),
    ]);
    expect(messages.map(message => [message.messageId, message.state])).toEqual([
      ['a', 'cancelled'],
      ['b', 'cancelled'],
      ['c', 'completed'],
      ['d', 'failed'],
    ]);
    expect(cancelledIds).toEqual(['a', 'b']);
  });
});

describe('failQueuedMessage', () => {
  it('fails only the matching queued message', () => {
    const next = failQueuedMessage([msg('a', 'queued'), msg('b', 'queued')], 'a');
    expect(next?.map(message => [message.messageId, message.state])).toEqual([
      ['a', 'failed'],
      ['b', 'queued'],
    ]);
  });

  it('does not change an already terminal message', () => {
    expect(failQueuedMessage([msg('a', 'completed')], 'a')).toBeUndefined();
    expect(failQueuedMessage([msg('a', 'accepted')], 'a')).toBeUndefined();
  });
});

describe('acceptQueuedMessage', () => {
  it('accepts only the next queued message', () => {
    const accepted = acceptQueuedMessage([msg('a', 'queued'), msg('b', 'queued')], 'a', 10);
    expect(accepted?.map(message => [message.messageId, message.state])).toEqual([
      ['a', 'accepted'],
      ['b', 'queued'],
    ]);
    expect(accepted?.find(message => message.messageId === 'a')).toEqual({
      messageId: 'a',
      state: 'accepted',
      acceptedAt: 10,
      lastActivityAt: 10,
    });
  });

  it('preserves structured prompt attachments and command arguments', () => {
    const prompt = {
      type: 'prompt' as const,
      messageId: 'a',
      prompt: 'inspect attachment',
      attachments: { path: 'attachment-path', files: ['document.pdf'] },
    };
    const command = {
      type: 'command' as const,
      messageId: 'b',
      command: 'review',
      arguments: '--all changes',
    };

    expect(
      acceptQueuedMessage([{ messageId: 'a', state: 'queued', turn: prompt }], 'a', 10)?.[0]
    ).toMatchObject({ state: 'accepted', turn: prompt });
    expect(
      acceptQueuedMessage([{ messageId: 'b', state: 'queued', turn: command }], 'b', 20)?.[0]
    ).toMatchObject({ state: 'accepted', turn: command });
  });

  it('does not resurrect a cancelled message after interrupt', () => {
    expect(
      acceptQueuedMessage([msg('a', 'cancelled'), msg('b', 'queued')], 'a', 10)
    ).toBeUndefined();
  });

  it('does not accept while another message is accepted', () => {
    expect(
      acceptQueuedMessage([msg('a', 'accepted'), msg('b', 'queued')], 'b', 10)
    ).toBeUndefined();
  });
});

const nonterminalSessionEventTypes = ['session.event', 'message.part.delta', 'session.idle'];

describe('recordAcceptedMessageActivity', () => {
  it.each(nonterminalSessionEventTypes)(
    'keeps the accepted turn active when a %s event arrives',
    eventType => {
      expect(userTurnTerminalState(eventType)).toBeUndefined();

      const messages: SessionMessageRecord[] = [
        { messageId: 'a', state: 'accepted', acceptedAt: 10, lastActivityAt: 20 },
        { messageId: 'b', state: 'queued' },
        { messageId: 'c', state: 'completed' },
      ];

      expect(recordAcceptedMessageActivity(messages, 30)).toEqual([
        { messageId: 'a', state: 'accepted', acceptedAt: 10, lastActivityAt: 30 },
        { messageId: 'b', state: 'queued' },
        { messageId: 'c', state: 'completed' },
      ]);
    }
  );

  it.each(['session.turn.close', 'session.error'])(
    'keeps the parent active and the next turn queued for a child %s',
    eventType => {
      const messages: SessionMessageRecord[] = [
        { messageId: 'parent', state: 'accepted', acceptedAt: 10, lastActivityAt: 20 },
        { messageId: 'next', state: 'queued' },
      ];

      expect(userTurnTerminalState(eventType, 'child', 'root')).toBeUndefined();
      const activeMessages = recordAcceptedMessageActivity(messages, 30);

      expect(activeMessages).toEqual([
        { messageId: 'parent', state: 'accepted', acceptedAt: 10, lastActivityAt: 30 },
        { messageId: 'next', state: 'queued' },
      ]);
      expect(nextQueuedMessageId(activeMessages ?? [])).toBeUndefined();
    }
  );

  it('does not update messages when no turn is accepted', () => {
    expect(
      recordAcceptedMessageActivity([msg('a', 'queued'), msg('b', 'completed')], 30)
    ).toBeUndefined();
  });
});

describe('hasInterruptibleWork', () => {
  it('is true for queued, accepted, or already-cancelled messages', () => {
    expect(hasInterruptibleWork([msg('a', 'completed')])).toBe(false);
    expect(hasInterruptibleWork([msg('a', 'queued')])).toBe(true);
    expect(hasInterruptibleWork([msg('a', 'cancelled')])).toBe(true);
  });
});

describe('streamQueuedSnapshots', () => {
  it.each(['intent', 'turn', 'prompt'] as const)(
    'reconnects prompt and command content from the %s format',
    format => {
      const fixtures = [
        { turn: promptTurn, content: 'inspect attachment' },
        { turn: commandTurn, content: '/review --all changes' },
        {
          turn: { type: 'command', messageId: 'c', command: 'status', arguments: '' },
          content: '/status',
        },
      ] satisfies { turn: ControlSessionMessageInput['turn']; content: string }[];
      const records = fixtures.map(({ turn, content }): SessionMessageRecord => {
        const lifecycle =
          turn.type === 'prompt'
            ? { state: 'accepted' as const, acceptedAt: 20 }
            : { state: 'queued' as const };
        if (format === 'intent') {
          return {
            ...createSessionMessageRecord(
              turn.type === 'prompt'
                ? { turn, agent: defaultAgent }
                : { turn, agent: { mode: 'code' } }
            ),
            ...lifecycle,
          };
        }
        return {
          messageId: turn.messageId,
          ...lifecycle,
          ...(format === 'turn' ? { turn } : { prompt: content }),
        };
      });

      expect(streamQueuedSnapshots(records, 99)).toEqual([
        { messageId: 'a', content: 'inspect attachment', timestamp: 20 },
        { messageId: 'b', content: '/review --all changes', timestamp: 99 },
        { messageId: 'c', content: '/status', timestamp: 99 },
      ]);
    }
  );

  it('prefers nested intent over stale turn and prompt compatibility fields', () => {
    const record = Object.assign(
      createSessionMessageRecord({ turn: commandTurn, agent: defaultAgent }),
      {
        turn: { type: 'prompt', messageId: commandTurn.messageId, prompt: 'stale turn' },
        prompt: 'stale prompt',
      }
    );
    expect(getSessionMessageTurn(record)).toEqual(commandTurn);
    expect(streamQueuedSnapshots([record], 99)).toEqual([
      { messageId: commandTurn.messageId, content: '/review --all changes', timestamp: 99 },
    ]);
  });

  it('preserves terminal failure delivery semantics for nested intent and excludes settled history', () => {
    const record = createSessionMessageRecord({ turn: promptTurn, agent: defaultAgent });
    expect(
      streamQueuedSnapshots(
        [
          { ...record, state: 'failed', acceptedAt: 20, failedReason: 'prompt_exhausted' },
          { ...record, state: 'completed' },
          { ...record, state: 'cancelled' },
        ],
        99
      )
    ).toEqual([
      {
        messageId: promptTurn.messageId,
        content: promptTurn.prompt,
        timestamp: 20,
        terminalFailure: {
          messageId: promptTurn.messageId,
          status: 'failed',
          delivery: 'sent',
          accepted: true,
          reason: 'prompt_exhausted',
          timestamp: 20,
        },
      },
    ]);
  });

  it('surfaces queued and accepted legacy prompts for /stream catch-up', () => {
    expect(
      streamQueuedSnapshots(
        [
          { messageId: 'a', state: 'queued', prompt: 'hello' },
          { messageId: 'b', state: 'accepted', prompt: 'world', acceptedAt: 20 },
          { messageId: 'c', state: 'completed', prompt: 'done' },
        ],
        99
      )
    ).toEqual([
      { messageId: 'a', content: 'hello', timestamp: 99 },
      { messageId: 'b', content: 'world', timestamp: 20 },
    ]);
  });

  it('renders structured prompts and commands for queued-message reconnect', () => {
    expect(
      streamQueuedSnapshots(
        [
          {
            messageId: 'a',
            state: 'accepted',
            acceptedAt: 20,
            turn: { type: 'prompt', messageId: 'a', prompt: 'hello' },
          },
          {
            messageId: 'b',
            state: 'queued',
            turn: { type: 'command', messageId: 'b', command: 'review', arguments: '--all' },
          },
          {
            messageId: 'c',
            state: 'queued',
            turn: { type: 'command', messageId: 'c', command: 'status', arguments: '' },
          },
        ],
        99
      )
    ).toEqual([
      { messageId: 'a', content: 'hello', timestamp: 20 },
      { messageId: 'b', content: '/review --all', timestamp: 99 },
      { messageId: 'c', content: '/status', timestamp: 99 },
    ]);
  });
});

describe('streamCloudStatus', () => {
  it('is preparing while work is queued or accepted', () => {
    expect(streamCloudStatus([msg('a', 'queued')])).toEqual({ type: 'preparing' });
    expect(streamCloudStatus([msg('a', 'accepted')])).toEqual({ type: 'preparing' });
  });

  it('is ready after a turn and null before any messages', () => {
    expect(streamCloudStatus([msg('a', 'completed')])).toEqual({ type: 'ready' });
    expect(streamCloudStatus([])).toBeNull();
  });
});
