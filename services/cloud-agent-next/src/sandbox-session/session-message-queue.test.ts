import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { normalizeCliEvent } from '../../../../packages/cloud-agent-sdk/src/normalizer';
import { createServiceState } from '../../../../packages/cloud-agent-sdk/src/service-state';
import { SandboxSession } from './SandboxSession.js';
import {
  parseSessionMetadata,
  serializeSessionMetadata,
  type SessionMetadata,
} from '../persistence/session-metadata.js';
import { createMemoryEventQueries, readStep } from '../session/preparation-test-helpers.js';
import { getPreparationSnapshots, readPreparationAttempt } from '../session/preparation-history.js';
import type { Env } from '../types.js';
import type { UserId } from '../types/ids.js';
import type { sandboxControlRpc } from './control-rpc.js';
import type { SandboxControlOutboundRequest } from '../sandbox-control/socket.js';
import {
  SANDBOX_CONTROL_ATTACH_TIMEOUT_MS,
  SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
  sessionPromptPayloadSchema,
  sessionGitSummaryPayloadSchema,
  type ResponseFrame,
  type SessionAttachPayload,
  type SessionMessageOutcome,
} from '../shared/sandbox-control-protocol.js';
import { DEADLINE_MS } from '../sandbox-control/deadlines.js';
import { createControlPlaneCredential } from '../sandbox-control/managed-credential.js';
import { SESSION_DELIVERY_TIMEOUT_MS } from './control-dispatch.js';
import { RUNTIME_AUTHORIZATION_KEY } from '../session/runtime-authorization-persistence.js';
import type {
  AcceptedCommandTurn,
  AcceptedPromptTurn,
  AgentSelection,
  AgentSelectionOverride,
} from '../execution/types.js';
import {
  acceptQueuedMessage,
  applyMessageOutcome,
  assignPreparationAttemptId,
  createSessionMessageRecord,
  failQueuedMessage,
  freezeLegacyQueuedMessages,
  getSessionMessageTurn,
  hasAcceptedMessage,
  matchesSessionMessageReplay,
  nextQueuedMessageId,
  recordAcceptedMessageActivity,
  resolveSessionMessageIntent,
  streamCloudStatus,
  streamQueuedSnapshots,
  type ControlSessionMessageInput,
  type ControlSessionMessageIntent,
  type SessionMessageRecord,
} from './session-message-queue.js';

const orchestrationMocks = vi.hoisted(() => ({
  eventQueries: vi.fn(),
  signedAttachments: vi.fn(),
  broadcast: vi.fn(),
}));

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      protected ctx: unknown,
      protected env: unknown
    ) {}
  },
}));
vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));
vi.mock('drizzle-orm/durable-sqlite', () => ({ drizzle: vi.fn() }));
vi.mock('drizzle-orm/durable-sqlite/migrator', () => ({ migrate: vi.fn(async () => undefined) }));
vi.mock('../../drizzle/migrations', () => ({ default: {} }));
vi.mock('../session/queries/index.js', () => ({
  createEventQueries: orchestrationMocks.eventQueries,
}));
vi.mock('../model-validation.js', () => ({
  assertKiloModelAvailable: vi.fn(async () => undefined),
}));
vi.mock('../execution/attachment-prompt-parts.js', () => ({
  buildSignedPromptAttachments: orchestrationMocks.signedAttachments,
}));
vi.mock('../websocket/stream.js', () => ({
  createStreamHandler: (
    _state: unknown,
    _queries: unknown,
    _sessionId: string,
    options?: {
      deriveCloudStatus?: () => Promise<unknown>;
      deriveQueuedMessages?: () => Promise<unknown>;
      derivePendingInteractions?: () => Promise<unknown>;
      deriveSessionStatus?: () => Promise<unknown>;
      getPreparationSnapshots?: () => Promise<unknown>;
    }
  ) => ({
    broadcastEvent: orchestrationMocks.broadcast,
    handleStreamRequest: async () =>
      Response.json({
        cloudStatus: await options?.deriveCloudStatus?.(),
        queuedMessages: await options?.deriveQueuedMessages?.(),
        pendingInteractions: await options?.derivePendingInteractions?.(),
        sessionStatus: await options?.deriveSessionStatus?.(),
        preparationSnapshots: await options?.getPreparationSnapshots?.(),
      }),
  }),
}));

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

describe('resolveSessionMessageIntent', () => {
  it.each(['anthropic/claude-sonnet-4', ' kilo/anthropic/claude-sonnet-4 '])(
    'retains the same-model variant for the explicit alias %j',
    model => {
      expect(
        resolveSessionMessageIntent({ turn: promptTurn, agent: { model } }, defaultAgent)?.agent
      ).toEqual({ ...defaultAgent, model });
    }
  );

  it.each(['kilo/openai/gpt-4.1', 'kilo/kilo/anthropic/claude-sonnet-4'])(
    'clears the inherited variant for a different effective model %j',
    model => {
      expect(
        resolveSessionMessageIntent({ turn: promptTurn, agent: { model } }, defaultAgent)?.agent
      ).toEqual({ mode: 'code', model });
      expect(defaultAgent.variant).toBe('high');
    }
  );

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

  it.each(['', 'kilo/'])('rejects explicit invalid model %j rather than inheriting', model => {
    for (const turn of [promptTurn, commandTurn]) {
      expect(resolveSessionMessageIntent({ turn, agent: { model } }, defaultAgent)).toBeUndefined();
    }
  });

  it.each([undefined, 'kilo/'])('rejects a prompt with invalid default model %j', model => {
    expect(resolveSessionMessageIntent({ turn: promptTurn }, { model })).toBeUndefined();
  });

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
  });

  it('keeps a model-less command model-less through acceptance, activity, and completion', () => {
    const record = createSessionMessageRecord({ turn: commandTurn, agent: { mode: 'code' } });
    const accepted = acceptQueuedMessage([record], commandTurn.messageId, 10) ?? [];
    const active = recordAcceptedMessageActivity(accepted, 20) ?? [];
    const completed = applyMessageOutcome(
      active.map(message => ({ ...message, wrapperInstanceId: 'runtime' })),
      { messageId: commandTurn.messageId, status: 'completed' },
      'runtime',
      30
    );

    expect(completed).toEqual([
      {
        ...record,
        intent: { turn: commandTurn, agent: { mode: 'code' } },
        state: 'completed',
        acceptedAt: 10,
        lastActivityAt: 20,
        wrapperInstanceId: 'runtime',
        terminalAt: 30,
      },
    ]);
  });
});

describe('matchesSessionMessageReplay', () => {
  const promptRecord = createSessionMessageRecord({
    turn: promptTurn,
    agent: defaultAgent,
    finalization: { autoCommit: true, condenseOnComplete: false },
  });

  it.each(['queued', 'accepted'] as const)(
    'matches reordered prompt fields and omitted overrides while %s',
    state => {
      expect(
        matchesSessionMessageReplay(
          { ...promptRecord, state },
          {
            turn: {
              attachments: { files: ['document.pdf', 'image.png'], path: 'attachment-path' },
              prompt: promptTurn.prompt,
              messageId: 'a',
              type: 'prompt',
            },
          }
        )
      ).toBe(true);
    }
  );

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
    ['invalid model', { model: 'kilo/' }],
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

  it.each([{ autoCommit: false }, { condenseOnComplete: true }])(
    'rejects conflicting finalization %j',
    finalization => {
      expect(matchesSessionMessageReplay(promptRecord, { turn: promptTurn, finalization })).toBe(
        false
      );
    }
  );

  it('compares command identity and preserves a frozen model-less selection', () => {
    const record = createSessionMessageRecord({ turn: commandTurn, agent: { mode: 'code' } });
    expect(matchesSessionMessageReplay(record, { turn: commandTurn })).toBe(true);
    for (const turn of [
      { ...commandTurn, command: 'status' },
      { ...commandTurn, arguments: '--staged' },
      { type: 'prompt', messageId: commandTurn.messageId, prompt: '/review --all changes' },
    ] satisfies ControlSessionMessageInput['turn'][]) {
      expect(matchesSessionMessageReplay(record, { turn })).toBe(false);
    }
    expect(
      matchesSessionMessageReplay(record, {
        turn: commandTurn,
        agent: { model: defaultAgent.model },
      })
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
      { messageId: 'failed', state: 'failed', prompt: 'failed', failedReason: 'prompt_exhausted' },
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
      { messageId: 'old', state: 'queued', prompt: '/review --all' },
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
        turn: { type: 'prompt', messageId: 'old', prompt: '/review --all' },
        agent: defaultAgent,
      }),
    ]);
    expect(frozen.slice(3)).toEqual([current, ...history]);
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
    expect(freezeLegacyQueuedMessages(structuredClone(frozen), defaultAgent)).toEqual(frozen);
  });

  it.each([undefined, 'kilo/'])(
    'keeps legacy queued prompts fail-able when the pre-update model is %j',
    model => {
      const messages: SessionMessageRecord[] = [
        { messageId: 'a', state: 'queued', turn: promptTurn },
        { messageId: 'old', state: 'queued', prompt: 'old prompt' },
      ];
      const frozen = freezeLegacyQueuedMessages(messages, { model });
      expect(frozen).toEqual(messages.map(message => ({ ...message, legacyIntentInvalid: true })));
      expect(freezeLegacyQueuedMessages(structuredClone(frozen), defaultAgent)).toEqual(frozen);
      expect(getSessionMessageTurn(frozen[0])).toEqual(promptTurn);
      expect(matchesSessionMessageReplay(frozen[0], { turn: promptTurn })).toBe(false);
      expect(failQueuedMessage(frozen, 'a')?.[0]).toEqual({ ...frozen[0], state: 'failed' });
    }
  );

  it('does not invent missing turn content', () => {
    const frozen = freezeLegacyQueuedMessages([msg('missing', 'queued')], defaultAgent);
    expect(frozen).toEqual([{ messageId: 'missing', state: 'queued', legacyIntentInvalid: true }]);
  });

  it('preserves unversioned intents and freezes legacy finalization before defaults change', () => {
    const existing: SessionMessageRecord = {
      messageId: commandTurn.messageId,
      state: 'queued',
      intent: {
        turn: commandTurn,
        agent: { mode: 'reviewer' },
        finalization: { autoCommit: false },
      },
    };
    const frozen = freezeLegacyQueuedMessages(
      [
        existing,
        {
          messageId: promptTurn.messageId,
          state: 'queued',
          turn: promptTurn,
          finalization: { condenseOnComplete: false },
        },
      ],
      defaultAgent,
      { autoCommit: false, condenseOnComplete: true }
    );
    expect(frozen).toEqual([
      existing,
      createSessionMessageRecord({
        turn: promptTurn,
        agent: defaultAgent,
        finalization: { autoCommit: false, condenseOnComplete: false },
      }),
    ]);
    expect(
      freezeLegacyQueuedMessages(frozen, { model: 'other-model' }, { autoCommit: true })
    ).toEqual(frozen);
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

describe('applyMessageOutcome', () => {
  it('settles only the message identified by the matching runtime', () => {
    const before = [{ ...msg('a', 'accepted'), wrapperInstanceId: 'runtime' }, msg('b', 'queued')];
    const next = applyMessageOutcome(
      before,
      { messageId: 'a', status: 'completed' },
      'runtime',
      30
    );
    expect(next?.map(message => [message.messageId, message.state])).toEqual([
      ['a', 'completed'],
      ['b', 'queued'],
    ]);
    expect(hasAcceptedMessage(next ?? [])).toBe(false);
    expect(
      applyMessageOutcome(before, { messageId: 'a', status: 'completed' }, 'old-runtime', 30)
    ).toBeUndefined();
    expect(
      applyMessageOutcome(next ?? [], { messageId: 'a', status: 'failed' }, 'runtime', 40)
    ).toBeUndefined();
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

  it('preserves upstream turns and durable intents with attachments, commands, and finalization', () => {
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
    const messages: SessionMessageRecord[] = [
      { messageId: prompt.messageId, state: 'queued', turn: prompt },
      { messageId: command.messageId, state: 'queued', turn: command },
      {
        messageId: prompt.messageId,
        state: 'queued',
        intent: {
          turn: prompt,
          agent: { mode: 'debug', model: 'attachment-model', variant: 'focused' },
          finalization: { autoCommit: false, condenseOnComplete: true },
        },
      },
      {
        messageId: command.messageId,
        state: 'queued',
        intent: {
          turn: command,
          agent: { mode: 'plan', model: 'command-model' },
          finalization: { autoCommit: true, condenseOnComplete: false },
        },
      },
    ];

    for (const message of messages) {
      expect(acceptQueuedMessage([message], message.messageId, 10)?.[0]).toEqual({
        ...message,
        state: 'accepted',
        acceptedAt: 10,
        lastActivityAt: 10,
      });
    }
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

describe('recordAcceptedMessageActivity', () => {
  it('updates only the accepted message activity timestamp', () => {
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
  });

  it('does not update messages when no turn is accepted', () => {
    expect(
      recordAcceptedMessageActivity([msg('a', 'queued'), msg('b', 'completed')], 30)
    ).toBeUndefined();
  });
});

describe('streamQueuedSnapshots', () => {
  it('prefers nested intent over stale turn and prompt compatibility fields', () => {
    const prompt: SessionMessageRecord = {
      ...createSessionMessageRecord({ turn: promptTurn, agent: defaultAgent }),
      state: 'accepted',
      acceptedAt: 20,
    };
    const command = Object.assign(
      createSessionMessageRecord({ turn: commandTurn, agent: { mode: 'code' } }),
      {
        turn: { type: 'prompt', messageId: commandTurn.messageId, prompt: 'stale turn' },
        prompt: 'stale prompt',
      }
    );
    expect(streamQueuedSnapshots([prompt, command], 99)).toEqual([
      {
        messageId: promptTurn.messageId,
        content: promptTurn.prompt,
        timestamp: 20,
        delivery: 'sent',
      },
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

  it('marks accepted legacy prompts as sent without changing genuinely queued snapshots', () => {
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
      { messageId: 'b', content: 'world', timestamp: 20, delivery: 'sent' },
    ]);
  });

  it('renders upstream structured turns and durable command or attachment intents on reconnect', () => {
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
          {
            messageId: 'command',
            state: 'queued',
            intent: {
              turn: {
                type: 'command',
                messageId: 'command',
                command: 'compact',
                arguments: '--aggressive',
              },
              agent: { mode: 'plan', model: 'override-model' },
            },
          },
          {
            messageId: 'attachment',
            state: 'queued',
            intent: {
              turn: {
                type: 'prompt',
                messageId: 'attachment',
                prompt: 'inspect attachment',
                attachments: { path: 'attachment-path', files: ['document.pdf'] },
              },
              agent: { mode: 'debug', model: 'attachment-model' },
              finalization: { autoCommit: false },
            },
          },
        ],
        99
      )
    ).toEqual([
      { messageId: 'a', content: 'hello', timestamp: 20, delivery: 'sent' },
      { messageId: 'b', content: '/review --all', timestamp: 99 },
      { messageId: 'c', content: '/status', timestamp: 99 },
      { messageId: 'command', content: '/compact --aggressive', timestamp: 99 },
      { messageId: 'attachment', content: 'inspect attachment', timestamp: 99 },
    ]);
  });

  it('prefers the canonical durable turn over stale upstream turns and compatibility prompts', () => {
    expect(
      streamQueuedSnapshots(
        [
          {
            messageId: 'prompt',
            state: 'accepted',
            prompt: 'stale compatibility text',
            turn: { type: 'prompt', messageId: 'prompt', prompt: 'stale upstream text' },
            intent: {
              turn: { type: 'prompt', messageId: 'prompt', prompt: 'canonical text' },
              agent: { mode: 'code', model: 'selected-model' },
            },
          },
        ],
        50
      )
    ).toEqual([
      { messageId: 'prompt', content: 'canonical text', timestamp: 50, delivery: 'sent' },
    ]);
  });

  it('keeps failed snapshots on their existing queued-then-terminal delivery path', () => {
    expect(
      streamQueuedSnapshots(
        [
          {
            messageId: 'queued_failure',
            state: 'failed',
            prompt: 'never sent',
            failedReason: 'preparation_failed',
          },
          {
            messageId: 'accepted_failure',
            state: 'failed',
            prompt: 'already sent',
            acceptedAt: 20,
            failedReason: 'wrapper_failed',
          },
        ],
        99
      )
    ).toEqual([
      {
        messageId: 'queued_failure',
        content: 'never sent',
        timestamp: 99,
        terminalFailure: {
          messageId: 'queued_failure',
          status: 'failed',
          delivery: 'queued',
          accepted: false,
          reason: 'preparation_failed',
          timestamp: 99,
        },
      },
      {
        messageId: 'accepted_failure',
        content: 'already sent',
        timestamp: 20,
        terminalFailure: {
          messageId: 'accepted_failure',
          status: 'failed',
          delivery: 'sent',
          accepted: true,
          reason: 'wrapper_failed',
          timestamp: 20,
        },
      },
    ]);
  });
});

const SESSION_ID = 'workspace_11111111-1111-4111-8111-111111111111';
const SANDBOX_ID = 'ses-11111111111141118111111111111111';
const RUNTIME_ID = '22222222-2222-4222-8222-222222222222';
const NEXT_RUNTIME_ID = '33333333-3333-4333-8333-333333333333';
const DIRECTORY = '/workspace/session';
const KILO_CREDENTIAL = createControlPlaneCredential(SANDBOX_ID, 'kilo');
const ATTACHMENT = {
  directory: DIRECTORY,
  env: { KILOCODE_TOKEN: KILO_CREDENTIAL },
  kilo: {
    scopeId: SESSION_ID,
    token: KILO_CREDENTIAL,
    targets: {
      backendBaseUrl: 'https://backend.example.test',
      providerBaseUrl: 'https://provider.example.test',
      sessionIngestBaseUrl: 'https://ingest.example.test',
    },
  },
} satisfies SessionAttachPayload;

type Control = ReturnType<typeof sandboxControlRpc>;
type ControlStatus = Awaited<ReturnType<Control['ensureReady']>>;

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function controlResponse(result: unknown): ResponseFrame {
  return { type: 'response', requestId: 'request', ok: true, result };
}

function controlFailure(retryable: boolean, code = 'not_ready'): ResponseFrame {
  return {
    type: 'response',
    requestId: 'request',
    ok: false,
    error: { code, message: 'Control request failed', retryable },
  };
}

function sessionFixture(overrides: Partial<SessionMetadata> = {}, sharedControl?: Control) {
  const values = new Map<string, unknown>();
  let alarmAt: number | null = null;
  const errors: unknown[] = [];
  const kv: SyncKvStorage = {
    get: <T>(key: string): T | undefined => structuredClone(values.get(key)) as T | undefined,
    put: <T>(key: string, value: T) => {
      values.set(key, structuredClone(value));
    },
    delete: (key: string) => values.delete(key),
    list: <T>(options?: SyncKvListOptions) =>
      [...values.entries()]
        .filter(([key]) => !options?.prefix || key.startsWith(options.prefix))
        .map(([key, value]) => [key, structuredClone(value) as T] as [string, T]),
  };
  const metadata = parseSessionMetadata({
    metadataSchemaVersion: 2,
    identity: { sessionId: SESSION_ID, userId: 'user_1', billingOrigin: 'cloud-agent-web' },
    auth: { kiloSessionId: 'kilo_root', kilocodeToken: 'test-token' },
    agent: defaultAgent,
    workspace: { sandboxId: SANDBOX_ID, workspacePath: DIRECTORY },
    lifecycle: { version: 1, timestamp: Date.now() },
    ...overrides,
  });
  kv.put('session_metadata', serializeSessionMetadata(metadata));
  const eventQueries = createMemoryEventQueries();
  let eventSequence = 0;
  eventQueries.insert = params =>
    eventQueries.upsert({ ...params, entityId: `test-event/${++eventSequence}` });
  eventQueries.insertUnique = params =>
    eventQueries.findByEntityId(params.entityId) ? null : eventQueries.upsert(params);
  eventQueries.getLatestEventId = () =>
    Math.max(0, ...eventQueries.findByEntityPrefix('').map(row => row.id));
  eventQueries.deleteOlderThan = vi.fn();
  orchestrationMocks.eventQueries.mockReturnValue(eventQueries);
  orchestrationMocks.signedAttachments.mockResolvedValue([]);
  const storage = {
    kv,
    get: async <T>(key: string) => kv.get<T>(key),
    put: async <T>(key: string, value: T) => kv.put(key, value),
    sql: {},
    transactionSync: <T>(callback: () => T) => callback(),
    getAlarm: vi.fn(async () => alarmAt),
    setAlarm: vi.fn(async (at: number | Date) => {
      alarmAt = Number(at);
    }),
    deleteAlarm: vi.fn(async () => {
      alarmAt = null;
    }),
  } as unknown as DurableObjectStorage;
  const ctx = {
    id: { name: `user_1:${metadata.identity.sessionId}` },
    storage,
    blockConcurrencyWhile: async (callback: () => Promise<void>) => callback(),
    getWebSockets: () => [],
    waitUntil: (promise: Promise<unknown>) => {
      void promise.catch(error => {
        errors.push(error);
      });
    },
  } as unknown as DurableObjectState;
  let status: ControlStatus = {
    physical: 'running',
    connection: 'ready',
    wrapperInstanceId: RUNTIME_ID,
  };
  const request = vi.fn(async (input: SandboxControlOutboundRequest): Promise<ResponseFrame> => {
    if (input.operation === 'session.attach') return controlResponse({ attached: true });
    if (input.operation === 'session.prompt') {
      const prompt = sessionPromptPayloadSchema.parse(input.payload);
      return controlResponse({ messageId: prompt.messageId, status: 'accepted' });
    }
    if (input.operation === 'session.sync')
      return controlResponse({ status: { type: 'busy' }, questions: [], permissions: [] });
    if (input.operation === 'session.abort') return controlResponse({ status: 'aborted' });
    return controlResponse({ success: true });
  });
  const control = {
    getStatus: vi.fn(async (): Promise<ControlStatus> => ({ ...status })),
    getRuntimeCredentialProxyFence: vi.fn(async () => ({
      plane: 'control' as const,
      allocationId: 'allocation_1',
      providerInstanceId: 'provider_1',
      connectionId: 'connection_1',
      wrapperInstanceId: RUNTIME_ID,
    })),
    ensureReady: vi.fn(
      async (_input: Parameters<Control['ensureReady']>[0]): Promise<ControlStatus> => ({
        ...status,
        attachment: { ...ATTACHMENT, setupCommands: metadata.profile?.setupCommands },
      })
    ),
    attachSession: vi.fn(async () => ({})),
    bindRuntimeCredentialProxyHandle: vi.fn(async () => ({ bound: true as const })),
    detachSession: vi.fn(async () => ({ existed: true })),
    quarantineRuntime: vi.fn(async (_input: Parameters<Control['quarantineRuntime']>[0]) => ({
      quarantined: true,
    })),
    validateTerminalAccess: vi.fn(async () => ({ allowed: true })),
    recordTerminalActivity: vi.fn(async () => ({ allowed: true })),
    prepareSessionCredentials: vi.fn(async () => ({})),
    updateNetworkPolicy: vi.fn(async () => undefined),
    request,
  } satisfies Control;
  const env = {
    SANDBOX_CONTROL: { getByName: () => sharedControl ?? control },
    WORKER_URL: 'https://worker.example.test',
    NEXTAUTH_SECRET: 'test-secret',
    CLOUD_AGENT_CONTAINER_BILLING_ENABLED: 'true',
    CLOUD_AGENT_CONTAINER_BILLING_ORG_IDS: 'org_1',
    CLOUD_AGENT_CONTAINER_BILLING_USER_IDS: 'user_1',
  } as unknown as Env;
  let session = new SandboxSession(ctx, env);
  return {
    get session() {
      return session;
    },
    control,
    env,
    metadata,
    storage,
    values,
    eventQueries,
    setStatus: (next: ControlStatus) => {
      status = next;
    },
    alarmAt: () => alarmAt,
    reload: () => {
      const now = Date.now();
      vi.clearAllTimers();
      vi.setSystemTime(now);
      orchestrationMocks.eventQueries.mockReturnValue(eventQueries);
      session = new SandboxSession(ctx, env);
    },
    fireAlarm: () => {
      alarmAt = null;
      return session.alarm();
    },
    record: (messageId: string) =>
      kv
        .get<SessionMessageRecord[]>('session_messages')
        ?.find(message => message.messageId === messageId),
    acquisition: (messageId: string) => {
      const record = kv
        .get<SessionMessageRecord[]>('session_messages')
        ?.find(message => message.messageId === messageId);
      if (!record?.preparationAttemptId || record.deliveryDeadlineAt === undefined) {
        throw new Error('Missing durable acquisition request');
      }
      return { id: record.preparationAttemptId, deadlineAt: record.deliveryDeadlineAt };
    },
    terminalEvents: () => eventQueries.findByEntityPrefix('terminal-message/'),
    flush: async () => {
      await vi.advanceTimersByTimeAsync(0);
      expect(errors).toEqual([]);
    },
    admit: (
      messageId: string,
      input: {
        prompt?: string;
        attachments?: AcceptedPromptTurn['attachments'];
        finalization?: ControlSessionMessageInput['finalization'];
      } = {}
    ) =>
      session.admitSubmittedMessage({
        userId: 'user_1' as UserId,
        turn: {
          type: 'prompt',
          id: messageId,
          prompt: input.prompt ?? `prompt ${messageId}`,
          attachments: input.attachments,
        },
        finalization: input.finalization,
      }),
    outcome: (
      messageId: string,
      outcome: SessionMessageOutcome['status'],
      wrapperInstanceId = RUNTIME_ID
    ) =>
      session.receiveSandboxControlEvent({
        identity: {
          directory: metadata.workspace?.workspacePath ?? DIRECTORY,
          kiloSessionId: metadata.auth.kiloSessionId,
          rootKiloSessionId: metadata.auth.kiloSessionId,
        },
        wrapperInstanceId,
        payload: { type: 'session.message.outcome', properties: { messageId, status: outcome } },
      }),
    rawEvent: (type: string, properties: Record<string, unknown>, kiloSessionId = 'kilo_root') =>
      session.receiveSandboxControlEvent({
        identity: { directory: DIRECTORY, kiloSessionId, rootKiloSessionId: 'kilo_root' },
        wrapperInstanceId: RUNTIME_ID,
        payload: { type, properties },
      }),
    snapshot: async () => (await session.fetch(new Request('http://unit.test/stream'))).json(),
  };
}

function installModernRuntimeAuthorization(fixture: ReturnType<typeof sessionFixture>) {
  const authorizationId = '44444444-4444-4444-8444-444444444444';
  const token = jwt.sign(
    {
      runtimeAuthorization: { id: authorizationId },
      exp: Math.floor(Date.now() / 1000) + 60 * 60,
    },
    'test-secret'
  );
  fixture.storage.kv.put(
    'session_metadata',
    serializeSessionMetadata({
      ...fixture.metadata,
      auth: { ...fixture.metadata.auth, kilocodeToken: token },
    })
  );
  fixture.storage.kv.put(RUNTIME_AUTHORIZATION_KEY, {
    version: 1,
    id: authorizationId,
    resourceKind: 'cloud-agent-next',
    resourceId: SESSION_ID,
    userId: 'user_1',
    authorizationUserId: 'user_1',
    issuedAt: '2026-01-01T00:00:00.000Z',
    delegationExpiresAt: '2026-01-02T00:00:00.000Z',
    state: 'active',
    bindings: { userPepperDigest: 'a'.repeat(64), authorizationPepperDigest: 'b'.repeat(64) },
    source: { admissionSource: 'user' },
  });
  return token;
}

function delegateRequest(
  fixture: ReturnType<typeof sessionFixture>,
  operation: SandboxControlOutboundRequest['operation'],
  replacement: (input: SandboxControlOutboundRequest) => Promise<ResponseFrame>
) {
  const original = fixture.control.request.getMockImplementation();
  if (!original) throw new Error('Missing control fixture');
  fixture.control.request.mockImplementation(input =>
    input.operation === operation ? replacement(input) : original(input)
  );
}

describe('SandboxSession orchestration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    orchestrationMocks.broadcast.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('persists the alarm and head budget before the first RPC and wakes the head on a fresh ID after reset', async () => {
    const fixture = sessionFixture();
    const firstReady = deferred<ControlStatus>();
    fixture.control.ensureReady.mockImplementationOnce(() => {
      expect(fixture.alarmAt()).not.toBeNull();
      expect(fixture.record('a')?.deliveryDeadlineAt).toBe(
        Date.now() + SESSION_DELIVERY_TIMEOUT_MS
      );
      expect(fixture.control.getStatus).not.toHaveBeenCalled();
      return firstReady.promise;
    });
    await fixture.admit('a');
    await fixture.flush();
    const deadlineAt = fixture.record('a')?.deliveryDeadlineAt;
    expect(fixture.record('a')?.state).toBe('queued');
    fixture.reload();
    await fixture.admit('b');
    await fixture.flush();

    expect(fixture.record('a')?.failedReason).toBeUndefined();
    expect(fixture.record('a')).toMatchObject({
      state: 'accepted',
      deliveryDeadlineAt: deadlineAt,
    });
    expect(fixture.record('b')).toMatchObject({ state: 'queued' });
    expect(fixture.record('b')?.deliveryDeadlineAt).toBeUndefined();
    expect(fixture.control.ensureReady).toHaveBeenCalledWith(
      expect.objectContaining({ acquisition: fixture.acquisition('a') })
    );
    await fixture.outcome('a', 'completed');
    await fixture.flush();
    expect(fixture.record('b')?.state).toBe('accepted');
    expect(fixture.record('b')?.deliveryDeadlineAt).toBe(Date.now() + SESSION_DELIVERY_TIMEOUT_MS);
  });

  it.each(['cloudflare', 'vercel'] as const)(
    'sends the expected runtime fence for cold and warm handoffs on %s',
    async provider => {
      const fixture = sessionFixture({
        workspace: {
          sandboxId: SANDBOX_ID,
          workspacePath: DIRECTORY,
          sandboxProvider: provider,
        },
      });
      await fixture.admit('a');
      await fixture.flush();
      await fixture.admit('b');
      await fixture.outcome('a', 'completed');
      await fixture.flush();
      expect(fixture.record('b')?.state).toBe('accepted');
      const handoffs = fixture.control.request.mock.calls
        .map(([input]) => input)
        .filter(
          input => input.operation === 'session.attach' || input.operation === 'session.prompt'
        );
      expect(handoffs.map(input => input.operation)).toEqual([
        'session.attach',
        'session.prompt',
        'session.prompt',
      ]);
      expect(handoffs.map(input => input.expectedWrapperInstanceId)).toEqual([
        RUNTIME_ID,
        RUNTIME_ID,
        RUNTIME_ID,
      ]);
    }
  );

  it('continues the durable acquisition after reset before its first control RPC', async () => {
    const fixture = sessionFixture();
    const signing = deferred<[]>();
    orchestrationMocks.signedAttachments.mockImplementationOnce(() => signing.promise);
    await fixture.admit('a');
    await fixture.flush();
    const acquisition = fixture.acquisition('a');
    const intent = fixture.record('a')?.intent;
    expect(fixture.control.ensureReady).not.toHaveBeenCalled();
    expect(fixture.alarmAt()).not.toBeNull();
    fixture.reload();
    await fixture.fireAlarm();
    expect(fixture.control.ensureReady).toHaveBeenCalledWith(
      expect.objectContaining({ acquisition })
    );
    expect(fixture.record('a')).toMatchObject({
      state: 'accepted',
      intent,
      preparationAttemptId: acquisition.id,
      deliveryDeadlineAt: acquisition.deadlineAt,
    });
    signing.resolve([]);
    await fixture.flush();
    expect(fixture.control.ensureReady).toHaveBeenCalledOnce();
    expect(fixture.record('a')?.state).toBe('accepted');
  });

  it.each(['unmarked', 'permanent', 'overloaded', 'hangs'] as const)(
    'fails the waiting queue immediately for an ensureReady failure that is %s',
    async failure => {
      const fixture = sessionFixture();
      const ready = deferred<ControlStatus>();
      fixture.control.ensureReady.mockImplementation(() => ready.promise);
      await fixture.admit('a');
      await fixture.admit('b');
      await fixture.flush();
      if (failure === 'hangs') {
        await vi.advanceTimersByTimeAsync(DEADLINE_MS.startup);
      } else {
        ready.reject(
          Object.assign(
            new Error('Provider configuration or admission failed'),
            failure === 'overloaded'
              ? { retryable: true, overloaded: true }
              : failure === 'permanent'
                ? { retryable: false }
                : {}
          )
        );
      }
      await fixture.flush();
      expect(fixture.record('a')).toMatchObject({
        state: 'failed',
        failedReason: 'environment_failed',
      });
      expect(fixture.record('b')?.state).toBe('failed');
      expect(fixture.terminalEvents()).toHaveLength(2);
      await fixture.fireAlarm();
      expect(fixture.control.ensureReady).toHaveBeenCalledOnce();
      expect(fixture.control.getStatus).not.toHaveBeenCalled();
      expect(fixture.control.request).not.toHaveBeenCalled();
      expect(fixture.control.quarantineRuntime).not.toHaveBeenCalled();
      fixture.control.ensureReady.mockResolvedValue({
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: NEXT_RUNTIME_ID,
        attachment: ATTACHMENT,
      });
      fixture.setStatus({
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: NEXT_RUNTIME_ID,
      });
      await fixture.admit('c');
      await fixture.flush();
      expect(fixture.record('c')?.state).toBe('accepted');
    }
  );

  it('bounds explicitly transient preparation retries by the original head deadline across reset', async () => {
    const fixture = sessionFixture();
    fixture.control.ensureReady.mockRejectedValue(
      Object.assign(new Error('Transient admission failure'), {
        retryable: true,
        overloaded: false,
      })
    );
    await fixture.admit('a');
    await fixture.admit('b');
    await fixture.flush();
    const deadlineAt = fixture.record('a')?.deliveryDeadlineAt;
    if (deadlineAt === undefined) throw new Error('Missing head delivery deadline');
    expect(deadlineAt).toBe(Date.now() + SESSION_DELIVERY_TIMEOUT_MS);
    const acquisition = fixture.acquisition('a');
    const initialCalls = fixture.control.ensureReady.mock.calls.length;
    fixture.reload();
    const retryAt = fixture.alarmAt();
    if (retryAt === null) throw new Error('Missing queue retry alarm');
    vi.setSystemTime(retryAt);
    await fixture.fireAlarm();
    expect(fixture.record('a')).toMatchObject({ state: 'queued', deliveryDeadlineAt: deadlineAt });
    expect(fixture.record('b')?.deliveryDeadlineAt).toBeUndefined();
    vi.setSystemTime(deadlineAt - 1);
    await fixture.fireAlarm();
    expect(fixture.record('a')?.state).toBe('queued');
    expect(fixture.alarmAt()).toBe(deadlineAt);
    const callsBeforeDeadline = fixture.control.ensureReady.mock.calls.length;
    vi.setSystemTime(deadlineAt);
    await fixture.fireAlarm();
    expect(fixture.record('a')).toMatchObject({
      state: 'failed',
      failedReason: 'preparation_timeout',
      terminalAt: deadlineAt,
    });
    expect(fixture.record('b')?.state).toBe('failed');
    expect(fixture.terminalEvents()).toHaveLength(2);
    expect(fixture.control.ensureReady).toHaveBeenCalledTimes(callsBeforeDeadline);
    for (const [input] of fixture.control.ensureReady.mock.calls.slice(initialCalls)) {
      expect(input.acquisition).toEqual(acquisition);
      expect(input.allowCreate).toBeUndefined();
    }
    expect(fixture.control.getStatus).not.toHaveBeenCalled();
    expect(fixture.control.request).not.toHaveBeenCalled();
    expect(fixture.control.quarantineRuntime).not.toHaveBeenCalled();
  });

  it.each(['ensureReady', 'attachSession'] as const)(
    'quarantines the recorded runtime when pre-attach %s never returns',
    async operation => {
      const fixture = sessionFixture();
      if (operation === 'ensureReady') {
        fixture.control.request.mockResolvedValueOnce({
          type: 'response',
          requestId: 'attach',
          ok: false,
          error: { code: 'not_ready', message: 'Retry attachment', retryable: true },
        });
        await fixture.admit('a');
        await fixture.flush();
        fixture.control.ensureReady.mockImplementation(
          () => new Promise<ControlStatus>(() => undefined)
        );
      } else {
        fixture.control.attachSession.mockImplementation(
          () => new Promise<Record<string, never>>(() => undefined)
        );
        await fixture.admit('a');
      }
      await fixture.admit('b');
      await fixture.flush();
      expect(fixture.record('a')).toMatchObject({ state: 'queued', wrapperInstanceId: RUNTIME_ID });
      await vi.advanceTimersByTimeAsync(
        operation === 'ensureReady' ? DEADLINE_MS.startup : SANDBOX_CONTROL_REQUEST_TIMEOUT_MS
      );
      expect(fixture.record('a')?.state).toBe('failed');
      expect(fixture.record('b')?.state).toBe('failed');
      expect(fixture.control.quarantineRuntime).toHaveBeenCalledWith(
        expect.objectContaining({ wrapperInstanceId: RUNTIME_ID })
      );
      expect(
        fixture.control.request.mock.calls.some(([input]) => input.operation === 'session.prompt')
      ).toBe(false);
    }
  );

  it('continues the same acquisition across background stop observations', async () => {
    const fixture = sessionFixture();
    fixture.control.ensureReady.mockRejectedValueOnce(
      Object.assign(new Error('Transient admission failure'), { retryable: true })
    );
    await fixture.admit('a');
    await fixture.flush();
    const acquisition = fixture.acquisition('a');
    fixture.setStatus({ physical: 'stopping', connection: 'disconnected' });
    await fixture.fireAlarm();
    expect(fixture.record('a')?.state).toBe('queued');
    expect(fixture.alarmAt()).toBeGreaterThan(Date.now());
    expect(fixture.control.ensureReady).toHaveBeenLastCalledWith(
      expect.objectContaining({ acquisition })
    );
    fixture.control.ensureReady.mockImplementationOnce(async () => {
      const ready = {
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: NEXT_RUNTIME_ID,
      } satisfies ControlStatus;
      fixture.setStatus(ready);
      return { ...ready, attachment: ATTACHMENT };
    });
    await fixture.fireAlarm();
    expect(fixture.record('a')).toMatchObject({
      state: 'accepted',
      wrapperInstanceId: NEXT_RUNTIME_ID,
    });
    expect(fixture.control.ensureReady).toHaveBeenLastCalledWith(
      expect.objectContaining({ acquisition })
    );
  });

  it('keeps Vercel alarm recovery observation-only', async () => {
    const fixture = sessionFixture({
      workspace: { sandboxId: SANDBOX_ID, workspacePath: DIRECTORY, sandboxProvider: 'vercel' },
    });
    fixture.control.ensureReady.mockRejectedValueOnce(
      Object.assign(new Error('Transient admission failure'), { retryable: true })
    );
    await fixture.admit('a');
    await fixture.flush();
    expect(fixture.control.ensureReady).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: 'vercel', allowCreate: true })
    );
    fixture.setStatus({ physical: 'stopping', connection: 'disconnected' });
    await fixture.fireAlarm();
    expect(fixture.record('a')?.state).toBe('queued');
    expect(fixture.control.ensureReady).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: 'vercel', allowCreate: false })
    );
    expect(
      fixture.control.ensureReady.mock.calls.every(([input]) => input.acquisition === undefined)
    ).toBe(true);
    fixture.setStatus({ physical: 'stopped', connection: 'disconnected' });
    await fixture.fireAlarm();
    expect(fixture.record('a')?.state).toBe('failed');
    expect(fixture.control.request).not.toHaveBeenCalled();
  });

  describe.each([
    {
      operation: 'session.attach',
      limit: 2,
      reason: 'attach_exhausted',
      timeoutMs: SANDBOX_CONTROL_ATTACH_TIMEOUT_MS,
    },
    {
      operation: 'session.prompt',
      limit: 5,
      reason: 'prompt_exhausted',
      timeoutMs: SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
    },
  ] as const)('$operation delivery failure policy', ({ operation, limit, reason, timeoutMs }) => {
    it.each([
      ['response', 'accepted'],
      ['exception', 'accepted'],
      ['response', 'failed'],
      ['exception', 'failed'],
    ] as const)(
      'applies the persisted retry budget to a transient %s ending %s',
      async (source, outcome) => {
        const fixture = sessionFixture();
        const first = deferred<ResponseFrame>();
        const requests: SandboxControlOutboundRequest[] = [];
        const transient = Object.assign(new Error('Transient control failure'), {
          retryable: true,
          overloaded: false,
        });
        const original = fixture.control.request.getMockImplementation();
        if (!original) throw new Error('Missing control fixture');
        delegateRequest(fixture, operation, async input => {
          requests.push(structuredClone(input));
          if (requests.length === 1) return first.promise;
          if (outcome === 'accepted' && requests.length >= limit) return original(input);
          if (source === 'exception') throw transient;
          return controlFailure(true);
        });
        await fixture.admit('a');
        await fixture.admit('b');
        await fixture.flush();
        const intent = fixture.record('a')?.intent;
        const deadlineAt = fixture.record('a')?.deliveryDeadlineAt;
        if (source === 'exception') first.reject(transient);
        else first.resolve(controlFailure(true));
        await fixture.flush();
        for (let attempt = 2; attempt <= limit; attempt++) {
          expect(fixture.record('a')).toMatchObject({
            state: 'queued',
            intent,
            deliveryDeadlineAt: deadlineAt,
          });
          expect(fixture.record('b')?.state).toBe('queued');
          expect(fixture.terminalEvents()).toHaveLength(0);
          expect(fixture.control.quarantineRuntime).not.toHaveBeenCalled();
          fixture.reload();
          const retryAt = fixture.alarmAt();
          if (retryAt === null) throw new Error('Missing queue retry alarm');
          vi.setSystemTime(retryAt);
          await fixture.fireAlarm();
        }
        expect(requests).toEqual(Array.from({ length: limit }, () => requests[0]));
        expect(fixture.record('a')).toMatchObject({
          state: outcome,
          intent,
          deliveryDeadlineAt: deadlineAt,
        });
        if (outcome === 'accepted') {
          expect(fixture.record('b')?.state).toBe('queued');
          await fixture.outcome('a', 'completed');
          await fixture.flush();
          expect(fixture.record('b')?.state).toBe('accepted');
          expect(fixture.control.quarantineRuntime).not.toHaveBeenCalled();
        } else if (source === 'response') {
          expect(fixture.record('a')?.failedReason).toBe(reason);
          expect(fixture.record('b')?.state).toBe('queued');
          expect(fixture.terminalEvents()).toHaveLength(1);
          expect(fixture.control.quarantineRuntime).not.toHaveBeenCalled();
          fixture.control.request.mockImplementation(original);
          await fixture.fireAlarm();
          expect(fixture.record('b')?.state).toBe('accepted');
        } else {
          expect(fixture.record('a')?.failedReason).toBe(reason);
          expect(fixture.record('b')?.state).toBe('failed');
          expect(fixture.terminalEvents()).toHaveLength(2);
          expect(fixture.control.quarantineRuntime).toHaveBeenCalledWith(
            expect.objectContaining({ wrapperInstanceId: RUNTIME_ID, reason })
          );
        }
      }
    );

    it.each([
      'permanent response',
      'unhealthy response',
      'malformed response',
      'unmarked exception',
      'overloaded exception',
    ] as const)('fails visibly without retrying a %s', async failure => {
      const fixture = sessionFixture();
      const response = deferred<ResponseFrame>();
      delegateRequest(fixture, operation, () => response.promise);
      await fixture.admit('a');
      await fixture.admit('b');
      await fixture.flush();
      if (failure === 'permanent response') response.resolve(controlFailure(false));
      else if (failure === 'unhealthy response')
        response.resolve(controlFailure(false, 'runtime_unhealthy'));
      else if (failure === 'malformed response') {
        response.resolve({ type: 'response', requestId: 'request', ok: false });
      } else {
        response.reject(
          Object.assign(
            new Error('Control request failed'),
            failure === 'overloaded exception' ? { retryable: true, overloaded: true } : {}
          )
        );
      }
      await fixture.flush();
      expect(fixture.record('a')).toMatchObject({ state: 'failed', failedReason: reason });
      if (failure === 'permanent response') {
        expect(fixture.record('b')?.state).toBe('queued');
        expect(fixture.terminalEvents()).toHaveLength(1);
        expect(fixture.control.quarantineRuntime).not.toHaveBeenCalled();
        return;
      }
      expect(fixture.record('b')?.state).toBe('failed');
      expect(fixture.terminalEvents()).toHaveLength(2);
      expect(fixture.control.quarantineRuntime).toHaveBeenCalledWith(
        expect.objectContaining({ wrapperInstanceId: RUNTIME_ID, reason })
      );
      await fixture.fireAlarm();
      expect(
        fixture.control.request.mock.calls.filter(([input]) => input.operation === operation)
      ).toHaveLength(1);
    });

    it.each(['response', 'exception'] as const)(
      'distinguishes a peer %s from a transport timeout at the operation cutoff',
      async source => {
        const fixture = sessionFixture();
        delegateRequest(
          fixture,
          operation,
          () =>
            new Promise<ResponseFrame>((resolve, reject) => {
              setTimeout(() => {
                if (source === 'response') resolve(controlFailure(true));
                else
                  reject(Object.assign(new Error('Peer request timed out'), { retryable: true }));
              }, timeoutMs);
            })
        );
        await fixture.admit('a');
        await fixture.admit('b');
        await fixture.flush();
        await vi.advanceTimersByTimeAsync(timeoutMs - 1);
        expect(fixture.record('a')?.state).toBe('queued');
        expect(fixture.control.quarantineRuntime).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await fixture.flush();
        if (source === 'response') {
          expect(fixture.record('a')).toMatchObject({
            state: 'queued',
            deliveryRetryScope: 'message',
          });
          expect(fixture.record('b')?.state).toBe('queued');
          expect(fixture.control.quarantineRuntime).not.toHaveBeenCalled();
          expect(fixture.terminalEvents()).toHaveLength(0);
          return;
        }
        expect(fixture.record('a')).toMatchObject({ state: 'failed', failedReason: reason });
        expect(fixture.record('b')?.state).toBe('failed');
        expect(fixture.terminalEvents()).toHaveLength(2);
        expect(fixture.control.quarantineRuntime).toHaveBeenCalledOnce();
        await fixture.fireAlarm();
        expect(
          fixture.control.request.mock.calls.filter(([input]) => input.operation === operation)
        ).toHaveLength(1);
      }
    );
  });

  describe.each(['session.attach', 'session.prompt'] as const)(
    '%s failure isolation',
    operation => {
      function sharedSessions() {
        const writer = sessionFixture();
        const sibling = sessionFixture(
          {
            identity: {
              ...writer.metadata.identity,
              sessionId: 'workspace_44444444-4444-4444-8444-444444444444',
            },
            auth: { ...writer.metadata.auth, kiloSessionId: 'kilo_sibling' },
          },
          writer.control
        );
        writer.control.quarantineRuntime.mockImplementation(async input => {
          writer.setStatus({ physical: 'stopped', connection: 'disconnected' });
          await writer.session.failWaitingMessages(input.reason, input.wrapperInstanceId);
          return { quarantined: true };
        });
        return { writer, sibling };
      }

      it.each(['accepted', 'expired'] as const)(
        'keeps an accepted sibling alive while contention retries become %s across resets',
        async outcome => {
          const { writer, sibling } = sharedSessions();
          await writer.admit('writer');
          await writer.flush();
          expect(writer.record('writer')?.state).toBe('accepted');
          let busy = true;
          const requests: SandboxControlOutboundRequest[] = [];
          const original = writer.control.request.getMockImplementation();
          if (!original) throw new Error('Missing control fixture');
          delegateRequest(writer, operation, async input => {
            if (input.session?.sessionId !== sibling.metadata.identity.sessionId)
              return original(input);
            requests.push(structuredClone(input));
            return busy ? controlFailure(true, 'session_busy') : original(input);
          });
          await sibling.admit('waiting');
          await sibling.flush();
          const acquisition = sibling.acquisition('waiting');
          for (let attempt = 0; attempt < 6; attempt++) {
            sibling.reload();
            const retryAt = sibling.alarmAt();
            if (retryAt === null) throw new Error('Missing contention retry alarm');
            vi.setSystemTime(retryAt);
            await sibling.fireAlarm();
            expect(sibling.record('waiting')).toMatchObject({
              state: 'queued',
              deliveryRetryScope: 'message',
              deliveryDeadlineAt: acquisition.deadlineAt,
              preparationAttemptId: acquisition.id,
            });
            expect(sibling.record('waiting')?.attachFailures).toBeUndefined();
            expect(sibling.record('waiting')?.promptFailures).toBeUndefined();
            expect(writer.record('writer')?.state).toBe('accepted');
            expect(writer.control.quarantineRuntime).not.toHaveBeenCalled();
          }
          expect(requests).toEqual(Array.from({ length: 7 }, () => requests[0]));
          if (outcome === 'expired') {
            sibling.reload();
            vi.setSystemTime(acquisition.deadlineAt);
            await sibling.fireAlarm();
            expect(sibling.record('waiting')).toMatchObject({
              state: 'failed',
              failedReason: 'preparation_timeout',
              terminalAt: acquisition.deadlineAt,
            });
            expect(sibling.terminalEvents()).toHaveLength(1);
            expect(await sibling.session.getCurrentMessageWork()).toBeNull();
            expect(await sibling.session.isSandboxCleanupScheduled()).toBe(false);
            expect(await sibling.snapshot()).toMatchObject({
              sessionStatus: { type: 'idle' },
              cloudStatus: { type: 'ready' },
              pendingInteractions: { questions: [], permissions: [] },
              queuedMessages: [
                {
                  messageId: 'waiting',
                  terminalFailure: { accepted: false, reason: 'preparation_timeout' },
                },
              ],
            });
            expect(await writer.session.getCurrentMessageWork()).toMatchObject({
              messageId: 'writer',
              status: 'running',
            });
            await sibling.fireAlarm();
            expect(requests).toHaveLength(7);
            expect(sibling.alarmAt()).toBeNull();
            busy = false;
            await sibling.admit('follow-up');
            await sibling.flush();
            expect(sibling.record('follow-up')?.state).toBe('accepted');
          } else {
            busy = false;
            await sibling.fireAlarm();
            expect(sibling.record('waiting')).toMatchObject({
              state: 'accepted',
              deliveryDeadlineAt: acquisition.deadlineAt,
              wrapperInstanceId: RUNTIME_ID,
            });
            await sibling.outcome('waiting', 'completed');
          }
          await writer.fireAlarm();
          expect(writer.record('writer')?.state).toBe('accepted');
          expect(writer.control.quarantineRuntime).not.toHaveBeenCalled();
          expect(writer.terminalEvents()).toHaveLength(0);
          await writer.outcome('writer', 'completed');
          expect(writer.record('writer')?.state).toBe('completed');
        }
      );

      it('expires only the contending head and preserves its queued follow-up', async () => {
        const { writer, sibling } = sharedSessions();
        await writer.admit('writer');
        await writer.flush();
        const original = writer.control.request.getMockImplementation();
        if (!original) throw new Error('Missing control fixture');
        delegateRequest(writer, operation, async () => controlFailure(true, 'session_busy'));
        await sibling.admit('waiting');
        await sibling.admit('next');
        await sibling.flush();
        const deadlineAt = sibling.acquisition('waiting').deadlineAt;
        sibling.reload();
        vi.setSystemTime(deadlineAt);
        await sibling.fireAlarm();
        expect(sibling.record('waiting')).toMatchObject({
          state: 'failed',
          failedReason: 'preparation_timeout',
        });
        expect(sibling.record('next')?.state).toBe('queued');
        expect(sibling.record('next')?.deliveryDeadlineAt).toBeUndefined();
        expect(await sibling.session.getCurrentMessageWork()).toMatchObject({
          messageId: 'next',
          status: 'pending',
        });
        expect(writer.record('writer')?.state).toBe('accepted');
        writer.control.request.mockImplementation(original);
        await sibling.fireAlarm();
        expect(sibling.record('next')).toMatchObject({
          state: 'accepted',
          deliveryDeadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS,
          wrapperInstanceId: RUNTIME_ID,
        });
        expect(sibling.terminalEvents()).toHaveLength(1);
        expect(writer.control.quarantineRuntime).not.toHaveBeenCalled();
      });

      it.each([false, true])(
        'isolates application rejection with retryable=%s from a running sibling',
        async retryable => {
          const { writer, sibling } = sharedSessions();
          await writer.admit('writer');
          await writer.flush();
          delegateRequest(writer, operation, async () => controlFailure(retryable));
          await sibling.admit('rejected');
          await sibling.flush();
          for (let attempt = 1; attempt < (operation === 'session.attach' ? 2 : 5); attempt++) {
            sibling.reload();
            await sibling.fireAlarm();
          }
          expect(sibling.record('rejected')).toMatchObject({
            state: 'failed',
            failedReason: operation === 'session.attach' ? 'attach_exhausted' : 'prompt_exhausted',
          });
          expect(sibling.terminalEvents()).toHaveLength(1);
          expect(await sibling.session.isSandboxCleanupScheduled()).toBe(false);
          expect(writer.control.quarantineRuntime).not.toHaveBeenCalled();
          await writer.outcome('writer', 'completed');
          expect(writer.record('writer')?.state).toBe('completed');
        }
      );

      it('cancels a busy retry without quarantining the accepted sibling', async () => {
        const { writer, sibling } = sharedSessions();
        await writer.admit('writer');
        await writer.flush();
        delegateRequest(writer, operation, async () => controlFailure(true, 'session_busy'));
        await sibling.admit('waiting');
        await sibling.flush();
        sibling.reload();
        await expect(sibling.session.interruptExecution()).resolves.toEqual({ success: true });
        await sibling.fireAlarm();
        expect(sibling.record('waiting')?.state).toBe('cancelled');
        expect(sibling.terminalEvents()).toHaveLength(1);
        expect(writer.control.quarantineRuntime).not.toHaveBeenCalled();
        await writer.outcome('writer', 'completed');
        expect(writer.record('writer')?.state).toBe('completed');
      });

      it.each(['ensureReady', 'attachSession'] as const)(
        'preserves the accepted sibling when a busy retry is cancelled during %s',
        async stage => {
          const { writer, sibling } = sharedSessions();
          await writer.admit('writer');
          await writer.flush();
          const ready = {
            physical: 'running',
            connection: 'ready',
            wrapperInstanceId: RUNTIME_ID,
            attachment: {
              ...ATTACHMENT,
              kilo: { ...ATTACHMENT.kilo, containmentEnabled: false },
            },
          } satisfies ControlStatus;
          writer.control.ensureReady.mockResolvedValue(ready);
          delegateRequest(writer, operation, async () => controlFailure(true, 'session_busy'));
          await sibling.admit('waiting');
          await sibling.flush();
          expect(sibling.record('waiting')).toMatchObject({
            state: 'queued',
            deliveryRetryScope: 'message',
            wrapperInstanceId: RUNTIME_ID,
          });
          expect(sibling.record('waiting')?.unresolvedDispatch).toBeUndefined();
          sibling.reload();
          writer.control.ensureReady.mockClear();
          writer.control.attachSession.mockClear();
          writer.control.request.mockClear();
          const pending = deferred<void>();
          if (stage === 'ensureReady') {
            writer.control.ensureReady.mockImplementationOnce(async () => {
              await pending.promise;
              return ready;
            });
          } else {
            writer.control.attachSession.mockImplementationOnce(async () => {
              await pending.promise;
              return {};
            });
          }
          const retry = sibling.fireAlarm();
          await sibling.flush();
          try {
            expect(writer.control.ensureReady).toHaveBeenCalledOnce();
            expect(writer.control.attachSession).toHaveBeenCalledTimes(
              stage === 'attachSession' ? 1 : 0
            );
            expect(writer.control.request).not.toHaveBeenCalled();
            expect(sibling.record('waiting')?.unresolvedDispatch).toBeUndefined();
            await expect(sibling.session.interruptExecution()).resolves.toEqual({ success: true });
            expect(writer.control.quarantineRuntime).not.toHaveBeenCalled();
            expect(writer.record('writer')?.state).toBe('accepted');
            expect(writer.terminalEvents()).toHaveLength(0);
            expect(sibling.record('waiting')?.state).toBe('cancelled');
            expect(sibling.terminalEvents()).toHaveLength(1);
            expect(await sibling.session.isSandboxCleanupScheduled()).toBe(false);
          } finally {
            pending.resolve(undefined);
            await retry;
            await sibling.flush();
          }
          await sibling.fireAlarm();
          expect(writer.control.request).not.toHaveBeenCalled();
          expect(writer.control.quarantineRuntime).not.toHaveBeenCalled();
          expect(sibling.record('waiting')?.state).toBe('cancelled');
          expect(sibling.terminalEvents()).toHaveLength(1);
          expect(writer.record('writer')?.state).toBe('accepted');
          await writer.outcome('writer', 'completed');
          expect(writer.record('writer')?.state).toBe('completed');
        }
      );

      it('quarantines a busy retry interrupted during wrapper dispatch', async () => {
        const { writer, sibling } = sharedSessions();
        await writer.admit('writer');
        await writer.flush();
        delegateRequest(writer, operation, async () => controlFailure(true, 'session_busy'));
        await sibling.admit('waiting');
        await sibling.flush();
        expect(sibling.record('waiting')?.deliveryRetryScope).toBe('message');
        const pending = deferred<ResponseFrame>();
        delegateRequest(writer, operation, () => pending.promise);
        writer.control.request.mockClear();
        sibling.reload();
        const retry = sibling.fireAlarm();
        await sibling.flush();
        try {
          expect(writer.control.request).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ operation, expectedWrapperInstanceId: RUNTIME_ID })
          );
          expect(sibling.record('waiting')).toMatchObject({
            state: 'queued',
            unresolvedDispatch: true,
            wrapperInstanceId: RUNTIME_ID,
          });
          expect(sibling.record('waiting')?.deliveryRetryScope).toBeUndefined();
          await expect(sibling.session.interruptExecution()).resolves.toEqual({ success: true });
          expect(writer.control.quarantineRuntime).toHaveBeenCalledExactlyOnceWith({
            ownerId: writer.metadata.identity.userId,
            sessionId: sibling.metadata.identity.sessionId,
            wrapperInstanceId: RUNTIME_ID,
            reason: 'preparation_interrupted',
          });
          expect(sibling.record('waiting')?.state).toBe('cancelled');
          expect(writer.record('writer')?.state).toBe('failed');
        } finally {
          pending.resolve(
            controlResponse(
              operation === 'session.attach'
                ? { attached: true }
                : { messageId: 'waiting', status: 'accepted' }
            )
          );
          await retry;
          await sibling.flush();
        }
        await sibling.fireAlarm();
        expect(writer.control.request).toHaveBeenCalledOnce();
        expect(sibling.record('waiting')?.state).toBe('cancelled');
        expect(sibling.terminalEvents()).toHaveLength(1);
      });

      it.each(['stop', 'expiry'] as const)(
        'retains unresolved dispatch ownership through a lost acknowledgement, busy replay, and %s',
        async action => {
          const fixture = sessionFixture();
          const lostAcknowledgement = deferred<ResponseFrame>();
          let requests = 0;
          let remoteWorkRunning = false;
          delegateRequest(fixture, operation, async () => {
            requests++;
            if (requests === 1) {
              remoteWorkRunning = true;
              return lostAcknowledgement.promise;
            }
            return controlFailure(true, 'session_busy');
          });
          fixture.control.quarantineRuntime.mockImplementation(async () => {
            remoteWorkRunning = false;
            return { quarantined: true };
          });
          await fixture.admit('waiting');
          await fixture.flush();
          const acquisition = fixture.acquisition('waiting');
          expect(fixture.record('waiting')?.unresolvedDispatch).toBe(true);
          for (let attempt = 0; attempt < 3; attempt++) {
            fixture.reload();
            await fixture.fireAlarm();
            expect(fixture.record('waiting')).toMatchObject({
              state: 'queued',
              unresolvedDispatch: true,
              deliveryRetryScope: 'runtime',
              wrapperInstanceId: RUNTIME_ID,
            });
          }
          expect(remoteWorkRunning).toBe(true);
          expect(fixture.control.quarantineRuntime).not.toHaveBeenCalled();
          fixture.reload();
          if (action === 'stop') {
            await expect(fixture.session.interruptExecution()).resolves.toEqual({ success: true });
          } else {
            vi.setSystemTime(acquisition.deadlineAt);
            await fixture.fireAlarm();
          }
          expect(remoteWorkRunning).toBe(false);
          expect(fixture.control.quarantineRuntime).toHaveBeenCalledWith({
            ownerId: 'user_1',
            sessionId: SESSION_ID,
            wrapperInstanceId: RUNTIME_ID,
            reason: action === 'stop' ? 'preparation_interrupted' : 'preparation_timeout',
          });
          expect(fixture.record('waiting')?.state).toBe(action === 'stop' ? 'cancelled' : 'failed');
          lostAcknowledgement.resolve(
            controlResponse(
              operation === 'session.attach'
                ? { attached: true }
                : { messageId: 'waiting', status: 'accepted' }
            )
          );
          await fixture.flush();
          expect(fixture.record('waiting')?.state).toBe(action === 'stop' ? 'cancelled' : 'failed');
          expect(fixture.terminalEvents()).toHaveLength(1);
          expect(await fixture.session.getCurrentMessageWork()).toBeNull();
        }
      );

      it('quarantines a transport failure after a busy retry rather than retaining the previous isolation scope', async () => {
        const { writer, sibling } = sharedSessions();
        await writer.admit('writer');
        await writer.flush();
        let busy = true;
        delegateRequest(writer, operation, async () => {
          if (busy) return controlFailure(true, 'session_busy');
          throw new Error('Control transport disconnected');
        });
        await sibling.admit('waiting');
        await sibling.flush();
        expect(writer.control.quarantineRuntime).not.toHaveBeenCalled();
        busy = false;
        sibling.reload();
        await sibling.fireAlarm();
        expect(sibling.record('waiting')?.state).toBe('failed');
        expect(writer.record('writer')?.state).toBe('failed');
        expect(writer.control.quarantineRuntime).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: sibling.metadata.identity.sessionId,
            wrapperInstanceId: RUNTIME_ID,
          })
        );
      });
    }
  );

  it('retains acknowledged prompt ownership until acceptance is persisted atomically', async () => {
    const fixture = sessionFixture();
    let acknowledged = false;
    delegateRequest(fixture, 'session.prompt', async () => {
      acknowledged = true;
      return controlResponse({ messageId: 'waiting', status: 'accepted' });
    });
    const writes: SessionMessageRecord[] = [];
    const put = fixture.storage.kv.put.bind(fixture.storage.kv);
    vi.spyOn(fixture.storage.kv, 'put').mockImplementation((key, value) => {
      if (key === 'session_messages' && acknowledged) {
        writes.push(...structuredClone(value as SessionMessageRecord[]));
      }
      put(key, value);
    });
    await fixture.admit('waiting');
    await fixture.flush();
    expect(writes.some(message => message.state === 'accepted')).toBe(true);
    expect(
      writes
        .filter(message => message.state === 'queued')
        .every(message => message.unresolvedDispatch)
    ).toBe(true);
    expect(fixture.record('waiting')?.unresolvedDispatch).toBeUndefined();
  });

  it('clears acknowledged attachment ownership before a fresh prompt contention rejection', async () => {
    const fixture = sessionFixture();
    const lostAcknowledgement = deferred<ResponseFrame>();
    let attachments = 0;
    delegateRequest(fixture, 'session.attach', async () => {
      attachments++;
      if (attachments === 1) return lostAcknowledgement.promise;
      return attachments === 2
        ? controlFailure(true, 'session_busy')
        : controlResponse({ attached: true });
    });
    delegateRequest(fixture, 'session.prompt', async () => controlFailure(true, 'session_busy'));
    await fixture.admit('waiting');
    await fixture.flush();
    fixture.reload();
    await fixture.fireAlarm();
    expect(fixture.record('waiting')?.unresolvedDispatch).toBe(true);
    await fixture.fireAlarm();
    expect(fixture.record('waiting')).toMatchObject({
      state: 'queued',
      deliveryRetryScope: 'message',
    });
    expect(fixture.record('waiting')?.unresolvedDispatch).toBeUndefined();
    fixture.reload();
    await expect(fixture.session.interruptExecution()).resolves.toEqual({ success: true });
    expect(fixture.control.quarantineRuntime).not.toHaveBeenCalled();
    expect(fixture.record('waiting')?.state).toBe('cancelled');
    lostAcknowledgement.resolve(controlResponse({ attached: true }));
    await fixture.flush();
    expect(fixture.record('waiting')?.state).toBe('cancelled');
  });

  it.each(['acknowledged', 'rejected'] as const)(
    'compensates a route RPC %s after deletion without retrying or resurrecting its message',
    async result => {
      const fixture = sessionFixture();
      const route = deferred<Record<string, never>>();
      fixture.control.attachSession.mockImplementation(() => route.promise);
      await fixture.admit('a');
      await fixture.flush();
      await fixture.session.deleteSession();
      const detachCount = fixture.control.detachSession.mock.calls.length;
      if (result === 'acknowledged') route.resolve({});
      else route.reject(Object.assign(new Error('Late route failure'), { retryable: true }));
      await fixture.flush();
      expect(fixture.control.detachSession.mock.calls.length).toBeGreaterThan(detachCount);
      expect(await fixture.session.getMetadata()).toBeNull();
      expect(fixture.record('a')).toBeUndefined();
      expect(fixture.eventQueries.findByEntityId('accepted-message/a')).toBeNull();
      expect(
        fixture.control.request.mock.calls.some(([input]) => input.operation === 'session.prompt')
      ).toBe(false);
      await expect(fixture.admit('b')).resolves.toMatchObject({
        success: false,
        code: 'NOT_FOUND',
      });
    }
  );

  it.each(['revoked', 'deleted'] as const)(
    'immediately denies runtime proxy issue and resolution after terminal lifecycle is %s despite pending or failed detach',
    async lifecycle => {
      const fixture = sessionFixture({
        identity: {
          sessionId: SESSION_ID,
          userId: 'user_1',
          orgId: 'org_1',
          billingOrigin: 'cloud-agent-web',
        },
      });
      installModernRuntimeAuthorization(fixture);
      const handle = await fixture.session.issueRuntimeCredentialProxyGrant({
        wrapperRunId: 'ignored',
        wrapperGeneration: 0,
        wrapperConnectionId: 'ignored',
      });
      expect(handle).toEqual(expect.any(String));

      const detach = deferred<{ existed: boolean }>();
      fixture.control.detachSession.mockImplementationOnce(() => detach.promise);
      const blocked =
        lifecycle === 'revoked'
          ? fixture.session.closeOrgStreams('org_1')
          : fixture.session.deleteSession();

      await expect(
        fixture.session.issueRuntimeCredentialProxyGrant({
          wrapperRunId: 'ignored',
          wrapperGeneration: 0,
          wrapperConnectionId: 'ignored',
        })
      ).resolves.toBeNull();
      await expect(fixture.session.resolveRuntimeCredentialProxyGrant(handle!)).resolves.toBeNull();

      detach.reject(new Error('detach failed'));
      await expect(blocked).rejects.toThrow('detach failed');
      await expect(fixture.session.resolveRuntimeCredentialProxyGrant(handle!)).resolves.toBeNull();
    }
  );

  it('sends modern attach credentials only through the Worker proxy handle and exact proxy targets', async () => {
    const fixture = sessionFixture();
    const backingToken = installModernRuntimeAuthorization(fixture);

    await fixture.admit('modern-proxy');
    await fixture.flush();

    const attach = fixture.control.request.mock.calls.find(
      ([input]) => input.operation === 'session.attach'
    )?.[0];
    expect(attach).toMatchObject({
      expectedConnection: {
        providerInstanceId: 'provider_1',
        connectionId: 'connection_1',
        wrapperInstanceId: RUNTIME_ID,
      },
      payload: {
        kilo: {
          scopeId: SESSION_ID,
          token: expect.stringMatching(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
          targets: {
            backendBaseUrl: 'https://worker.example.test',
            providerBaseUrl: 'https://worker.example.test',
            sessionIngestBaseUrl: 'https://worker.example.test',
          },
        },
      },
    });
    const serialized = JSON.stringify(attach?.payload);
    expect(serialized).not.toContain(KILO_CREDENTIAL);
    expect(serialized).not.toContain(backingToken);
    expect(serialized).not.toContain('test-secret');
  });

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'settles an early %s outcome once without resurrecting work on acknowledgement',
    async status => {
      const fixture = sessionFixture();
      const prompt = deferred<ResponseFrame>();
      const original = fixture.control.request.getMockImplementation();
      if (!original) throw new Error('Missing control fixture');
      delegateRequest(fixture, 'session.prompt', input => {
        const parsed = sessionPromptPayloadSchema.parse(input.payload);
        if (parsed.messageId !== 'a') return original(input);
        expect(fixture.record('a')).toMatchObject({
          state: 'queued',
          wrapperInstanceId: RUNTIME_ID,
        });
        return prompt.promise;
      });
      await fixture.admit('a');
      await fixture.admit('b');
      await fixture.flush();
      expect(fixture.record('a')?.state).toBe('queued');
      await expect(fixture.outcome('a', status)).resolves.toEqual({ applied: true });
      await fixture.flush();
      expect(fixture.record('b')?.state).toBe('accepted');
      const terminal = fixture.eventQueries.findByEntityId('terminal-message/a');
      expect(terminal).not.toBeNull();
      prompt.resolve(controlResponse({ messageId: 'a', status: 'accepted' }));
      await fixture.flush();
      await expect(fixture.outcome('a', status)).resolves.toEqual({ applied: true });
      await fixture.outcome('a', status === 'failed' ? 'completed' : 'failed');
      expect(fixture.record('a')?.state).toBe(status);
      expect(fixture.record('b')?.state).toBe('accepted');
      expect(fixture.eventQueries.findByEntityId('terminal-message/a')).toEqual(terminal);
      expect(fixture.terminalEvents()).toHaveLength(1);
      expect(fixture.eventQueries.findByEntityId('accepted-message/a')).toBeNull();
      expect(fixture.eventQueries.findByEntityId('accepted-message/b')?.stream_event_type).toBe(
        'cloud.message.sent'
      );
      expect(fixture.control.quarantineRuntime).not.toHaveBeenCalled();
      const payload = JSON.parse(terminal?.payload ?? '{}');
      expect(payload).toMatchObject({ messageId: 'a', accepted: true, delivery: 'sent' });
      expect(payload.status).toBe(status === 'cancelled' ? 'interrupted' : status);
    }
  );

  it('acknowledges an old outcome and late preparing progress without changing the next accepted turn', async () => {
    const fixture = sessionFixture();
    await fixture.admit('a');
    await fixture.admit('b');
    await fixture.flush();
    await fixture.outcome('a', 'completed');
    await fixture.flush();
    const messages = fixture.storage.kv.get('session_messages');
    const events = fixture.eventQueries.findByEntityPrefix('');
    const alarmAt = fixture.alarmAt();
    const attemptId = fixture.record('a')?.preparationAttemptId;
    if (!attemptId) throw new Error('Missing preparation attempt');
    await expect(fixture.outcome('a', 'completed')).resolves.toEqual({ applied: true });
    await expect(fixture.outcome('a', 'completed')).resolves.toEqual({ applied: true });
    await expect(
      fixture.session.receiveSandboxControlPreparing({
        identity: {
          directory: DIRECTORY,
          kiloSessionId: 'kilo_root',
          rootKiloSessionId: 'kilo_root',
        },
        wrapperInstanceId: RUNTIME_ID,
        payload: {
          version: 2,
          attemptId,
          triggerMessageId: 'a',
          revision: 999,
          timestamp: Date.now(),
          step: 'cloning',
          message: 'Late progress',
          action: 'step_progress',
          stepId: 'phase:cloning',
          detail: 'Late progress',
        },
      })
    ).resolves.toEqual({ applied: true });
    expect(fixture.storage.kv.get('session_messages')).toEqual(messages);
    expect(fixture.eventQueries.findByEntityPrefix('')).toEqual(events);
    expect(fixture.alarmAt()).toBe(alarmAt);
    await expect(fixture.session.getCurrentMessageWork()).resolves.toEqual({
      messageId: 'b',
      status: 'running',
      health: 'healthy',
    });
    expect(fixture.control.quarantineRuntime).not.toHaveBeenCalled();
  });

  it('ignores a late rejected prompt RPC after its outcome and the next message handoff', async () => {
    const fixture = sessionFixture();
    const prompt = deferred<ResponseFrame>();
    fixture.control.request.mockImplementationOnce(async () => controlResponse({ attached: true }));
    fixture.control.request.mockImplementationOnce(() => prompt.promise);
    await fixture.admit('a');
    await fixture.admit('b');
    await fixture.flush();
    await fixture.outcome('a', 'completed');
    await fixture.flush();
    expect(fixture.record('b')?.state).toBe('accepted');
    prompt.reject(new Error('Lost acknowledgement'));
    await fixture.flush();
    expect(fixture.record('a')?.state).toBe('completed');
    expect(fixture.record('b')?.state).toBe('accepted');
    expect(fixture.control.quarantineRuntime).not.toHaveBeenCalled();
  });

  it('does not infer message settlement from raw parent-session closes, errors, or untrusted outcomes', async () => {
    const fixture = sessionFixture();
    await fixture.admit('a');
    await fixture.admit('b');
    await fixture.flush();
    await fixture.rawEvent('session.turn.close', {
      sessionID: 'kilo_root',
      parentID: 'parent_session',
      reason: 'completed',
    });
    await fixture.rawEvent('session.error', {
      sessionID: 'kilo_root',
      error: { name: 'ContextOverflowError' },
    });
    await fixture.rawEvent(
      'session.turn.close',
      { sessionID: 'kilo_child', parentID: 'kilo_root', reason: 'completed' },
      'kilo_child'
    );
    await fixture.outcome('a', 'completed', NEXT_RUNTIME_ID);
    await fixture.outcome('b', 'completed');
    await fixture.session.receiveSandboxControlEvent({
      identity: { directory: DIRECTORY, rootKiloSessionId: 'kilo_root' },
      payload: {
        type: 'session.message.outcome',
        properties: { messageId: 'a', status: 'completed' },
      },
    });
    await fixture.rawEvent('session.message.outcome', { messageId: 'a', status: 'idle' });
    expect(fixture.record('a')?.state).toBe('accepted');
    expect(fixture.record('b')?.state).toBe('queued');
    expect(fixture.terminalEvents()).toHaveLength(0);
  });

  it.each([
    { messageId: 'other', status: 'accepted' },
    { messageId: 'a', status: 'completed' },
    {},
  ])('rejects an invalid prompt result %j instead of accepting it', async result => {
    const fixture = sessionFixture();
    delegateRequest(fixture, 'session.prompt', async () => controlResponse(result));
    await fixture.admit('a');
    await fixture.admit('b');
    await fixture.flush();
    expect(fixture.record('a')?.state).toBe('failed');
    expect(fixture.record('b')?.state).toBe('failed');
    expect(fixture.control.quarantineRuntime).toHaveBeenCalledWith({
      ownerId: 'user_1',
      sessionId: SESSION_ID,
      wrapperInstanceId: RUNTIME_ID,
      reason: 'prompt_exhausted',
    });
  });

  it('gives a hanging attachment eight minutes then retains cleanup until quarantine is acknowledged', async () => {
    const fixture = sessionFixture();
    const attach = deferred<ResponseFrame>();
    delegateRequest(fixture, 'session.attach', () => attach.promise);
    fixture.control.quarantineRuntime.mockRejectedValue(
      new Error('Control temporarily unavailable')
    );
    await fixture.admit('a');
    await fixture.flush();
    await vi.advanceTimersByTimeAsync(SANDBOX_CONTROL_ATTACH_TIMEOUT_MS - 1);
    expect(fixture.record('a')?.state).toBe('queued');
    await vi.advanceTimersByTimeAsync(1);
    await fixture.flush();
    expect(fixture.record('a')?.state).toBe('failed');
    expect(await fixture.session.isSandboxCleanupScheduled()).toBe(true);
    const calls = fixture.control.ensureReady.mock.calls.length;
    await fixture.admit('b');
    await fixture.flush();
    expect(fixture.record('b')?.state).toBe('queued');
    expect(fixture.control.ensureReady).toHaveBeenCalledTimes(calls);
    expect(
      fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.prompt')
    ).toHaveLength(0);
    attach.resolve(controlResponse({ attached: true }));
    await fixture.flush();
    expect(fixture.record('a')?.state).toBe('failed');
    expect(fixture.record('b')?.state).toBe('queued');
  });

  it.each([undefined, 'Session aborted'])(
    'projects a cancelled outcome with reason %j as an SDK interruption',
    async reason => {
      const fixture = sessionFixture();
      await fixture.admit('a');
      await fixture.flush();
      const state = createServiceState({ rootSessionId: 'kilo_root' });
      state.process({
        type: 'connected',
        sessionStatus: { type: 'busy' },
        cloudStatus: { type: 'ready' },
      });
      state.process({ type: 'cloud.message.sent', messageId: 'a' });

      await fixture.rawEvent('session.message.outcome', {
        messageId: 'a',
        status: 'cancelled',
        ...(reason ? { reason } : {}),
      });

      const [terminal] = fixture.terminalEvents();
      if (!terminal) throw new Error('Missing cancellation event');
      const payload: unknown = JSON.parse(terminal.payload);
      expect(payload).toMatchObject({ accepted: true });
      const event = normalizeCliEvent(terminal.stream_event_type, payload);
      expect(event).toMatchObject({
        type: 'cloud.message.failed',
        messageId: 'a',
        reason: 'interrupted',
        error: 'The message was interrupted',
      });
      if (!event || event.type !== 'cloud.message.failed') throw new Error('Invalid cancellation');
      state.process(event);
      expect(state.getActivity()).toEqual({ type: 'idle' });
      expect(state.getStatus()).toEqual({ type: 'interrupted' });
      expect(state.getPendingMessages().get('a')).toMatchObject({ reason: 'interrupted' });
      expect(fixture.record('a')?.failedReason).toBe(reason);
    }
  );

  it.each(['accepted', 'preparing'] as const)(
    'preserves %s ownership through the public mark-then-interrupt sequence and a reset',
    async phase => {
      const fixture = sessionFixture();
      const attach = deferred<ResponseFrame>();
      const abort = deferred<ResponseFrame>();
      const quarantine = deferred<{ quarantined: boolean }>();
      if (phase === 'preparing') delegateRequest(fixture, 'session.attach', () => attach.promise);
      delegateRequest(fixture, 'session.abort', () => abort.promise);
      fixture.control.quarantineRuntime.mockImplementation(() => quarantine.promise);
      await fixture.admit('a');
      await fixture.flush();
      const owned = fixture.record('a');
      await fixture.session.markAsInterrupted();
      expect(fixture.record('a')).toEqual(owned);
      fixture.reload();
      const interruption = fixture.session.interruptExecution();
      await fixture.flush();
      if (phase === 'accepted') {
        expect(fixture.record('a')?.state).toBe('accepted');
        expect(fixture.control.request).toHaveBeenCalledWith(
          expect.objectContaining({
            operation: 'session.abort',
            session: { sessionId: SESSION_ID, kiloSessionId: 'kilo_root', directory: DIRECTORY },
            payload: { messageId: 'a' },
          })
        );
        abort.resolve(controlResponse({ status: 'aborted' }));
      } else {
        expect(await fixture.session.isSandboxCleanupScheduled()).toBe(true);
        expect(fixture.control.quarantineRuntime).toHaveBeenCalledWith({
          ownerId: 'user_1',
          sessionId: SESSION_ID,
          wrapperInstanceId: RUNTIME_ID,
          reason: 'preparation_interrupted',
        });
        attach.resolve(controlResponse({ attached: true }));
        quarantine.resolve({ quarantined: true });
      }
      await expect(interruption).resolves.toEqual({ success: true });
      await fixture.flush();
      expect(fixture.record('a')?.state).toBe('cancelled');
      expect(fixture.terminalEvents()).toHaveLength(1);
      if (phase === 'preparing') {
        expect(
          fixture.control.request.mock.calls.some(([input]) => input.operation === 'session.prompt')
        ).toBe(false);
      }
    }
  );

  it('quarantines a cancelled preparation instead of letting its late attach submit a prompt', async () => {
    const fixture = sessionFixture();
    const attach = deferred<ResponseFrame>();
    delegateRequest(fixture, 'session.attach', () => attach.promise);
    const cleanup = deferred<{ quarantined: boolean }>();
    fixture.control.quarantineRuntime.mockImplementation(() => cleanup.promise);
    await fixture.admit('a');
    await fixture.flush();
    const interrupt = fixture.session.interruptExecution();
    await fixture.flush();
    await fixture.admit('b');
    await fixture.flush();
    expect(fixture.record('a')?.state).toBe('cancelled');
    expect(fixture.record('b')?.state).toBe('queued');
    expect(await fixture.session.isSandboxCleanupScheduled()).toBe(true);
    attach.resolve(controlResponse({ attached: true }));
    cleanup.resolve({ quarantined: true });
    await interrupt;
    await fixture.flush();
    expect(
      fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.prompt')
    ).toHaveLength(0);
  });

  it('settles cancelled preparation history across reset, late events, and reconnect', async () => {
    const fixture = sessionFixture();
    const attach = deferred<ResponseFrame>();
    delegateRequest(fixture, 'session.attach', () => attach.promise);
    await fixture.admit('a');
    await fixture.flush();
    const attemptId = fixture.record('a')?.preparationAttemptId;
    if (!attemptId) throw new Error('Missing preparation attempt');
    expect(readPreparationAttempt(fixture.eventQueries, attemptId)?.status).toBe('running');
    expect(readStep(fixture.eventQueries, attemptId, 'phase:workspace_setup').status).toBe(
      'running'
    );

    await expect(fixture.session.interruptExecution()).resolves.toEqual({ success: true });
    expect(fixture.record('a')?.state).toBe('cancelled');
    expect(readPreparationAttempt(fixture.eventQueries, attemptId)).toMatchObject({
      status: 'failed',
      safeError: 'The message was interrupted',
      completedAt: fixture.record('a')?.terminalAt,
    });
    expect(readStep(fixture.eventQueries, attemptId, 'phase:workspace_setup')).toMatchObject({
      status: 'failed',
      safeError: 'The message was interrupted',
    });
    const snapshots = structuredClone(getPreparationSnapshots(fixture.eventQueries));
    fixture.reload();
    attach.resolve(controlResponse({ attached: true }));
    await fixture.flush();
    for (const action of [
      { action: 'step_progress', step: 'workspace_setup', stepId: 'phase:workspace_setup' },
      { action: 'attempt_failed', step: 'failed', safeError: 'Late wrapper failure' },
    ]) {
      await expect(
        fixture.session.receiveSandboxControlPreparing({
          identity: {
            directory: DIRECTORY,
            kiloSessionId: 'kilo_root',
            rootKiloSessionId: 'kilo_root',
          },
          wrapperInstanceId: RUNTIME_ID,
          payload: {
            version: 2,
            attemptId,
            triggerMessageId: 'a',
            revision: 1_000,
            timestamp: Date.now(),
            message: 'Late wrapper preparation',
            ...action,
          },
        })
      ).resolves.toEqual({ applied: true });
    }
    await fixture.session.failWaitingMessages('environment_stopped', RUNTIME_ID);
    await fixture.fireAlarm();
    vi.setSystemTime(Date.now() + 16 * 60_000);
    fixture.reload();
    expect(await fixture.snapshot()).toMatchObject({ preparationSnapshots: snapshots });
    expect(fixture.record('a')?.state).toBe('cancelled');
    expect(fixture.terminalEvents()).toHaveLength(1);
    expect(
      fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.prompt')
    ).toHaveLength(0);
  });

  it('delivers a follow-up after awaited cancel, failed quarantine transfer, reset, and old-runtime cleanup', async () => {
    const fixture = sessionFixture();
    const attach = deferred<ResponseFrame>();
    let firstAttach = true;
    delegateRequest(fixture, 'session.attach', async () => {
      if (firstAttach) {
        firstAttach = false;
        return attach.promise;
      }
      return controlResponse({ attached: true });
    });
    fixture.control.quarantineRuntime.mockRejectedValue(new Error('Quarantine unavailable'));
    await fixture.admit('a');
    await fixture.flush();
    const oldAcquisition = fixture.acquisition('a');
    await expect(fixture.session.interruptExecution()).resolves.toEqual({ success: true });
    expect(fixture.record('a')?.state).toBe('cancelled');
    expect(await fixture.session.isSandboxCleanupScheduled()).toBe(true);
    await fixture.admit('b');
    await fixture.flush();
    const acquisition = fixture.acquisition('b');
    const intent = fixture.record('b')?.intent;
    expect(acquisition.id).not.toBe(oldAcquisition.id);
    expect(fixture.control.ensureReady).toHaveBeenCalledOnce();
    fixture.reload();
    fixture.control.quarantineRuntime.mockImplementation(async () => {
      fixture.setStatus({ physical: 'stopping', connection: 'disconnected' });
      return { quarantined: true };
    });
    await fixture.fireAlarm();
    expect(await fixture.session.isSandboxCleanupScheduled()).toBe(false);
    expect(fixture.record('b')?.state).toBe('queued');
    expect(fixture.control.ensureReady).toHaveBeenLastCalledWith(
      expect.objectContaining({ acquisition })
    );
    fixture.setStatus({ physical: 'stopped', connection: 'disconnected' });
    fixture.control.ensureReady.mockImplementationOnce(async input => {
      expect(input.acquisition).toEqual(acquisition);
      const ready = {
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: NEXT_RUNTIME_ID,
      } satisfies ControlStatus;
      fixture.setStatus(ready);
      return { ...ready, attachment: ATTACHMENT };
    });
    await fixture.fireAlarm();
    expect(fixture.record('b')).toMatchObject({
      state: 'accepted',
      intent,
      wrapperInstanceId: NEXT_RUNTIME_ID,
      preparationAttemptId: acquisition.id,
      deliveryDeadlineAt: acquisition.deadlineAt,
    });
    await fixture.admit('c');
    attach.resolve(controlResponse({ attached: true }));
    await fixture.flush();
    await expect(fixture.outcome('a', 'completed')).resolves.toEqual({ applied: false });
    await fixture.session.failWaitingMessages('late_old_failure', RUNTIME_ID);
    expect(fixture.record('a')?.state).toBe('cancelled');
    expect(fixture.record('b')?.state).toBe('accepted');
    expect(fixture.record('c')?.state).toBe('queued');
    expect(fixture.control.ensureReady).toHaveBeenCalledTimes(3);
    expect(
      fixture.control.request.mock.calls
        .filter(([input]) => input.operation === 'session.prompt')
        .map(([input]) => sessionPromptPayloadSchema.parse(input.payload).messageId)
    ).toEqual(['b']);
  });

  it('retains the original head deadline after awaited cancel cannot transfer quarantine', async () => {
    const fixture = sessionFixture();
    const attach = deferred<ResponseFrame>();
    delegateRequest(fixture, 'session.attach', () => attach.promise);
    fixture.control.quarantineRuntime.mockRejectedValue(new Error('Quarantine unavailable'));
    await fixture.admit('a');
    await fixture.flush();
    await expect(fixture.session.interruptExecution()).resolves.toEqual({ success: true });
    await fixture.admit('b');
    await fixture.flush();
    const pending = fixture.record('b');
    if (!pending?.deliveryDeadlineAt) throw new Error('Missing pending head deadline');
    const deadlineAt = pending.deliveryDeadlineAt;
    attach.resolve(controlResponse({ attached: true }));
    await fixture.flush();
    fixture.reload();
    vi.setSystemTime(deadlineAt);
    await fixture.fireAlarm();
    expect(fixture.record('a')?.state).toBe('cancelled');
    expect(fixture.record('b')).toMatchObject({
      state: 'failed',
      failedReason: 'preparation_timeout',
      deliveryDeadlineAt: deadlineAt,
      intent: pending.intent,
    });
    expect(await fixture.session.isSandboxCleanupScheduled()).toBe(true);
    expect(fixture.control.ensureReady).toHaveBeenCalledOnce();
    expect(
      fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.prompt')
    ).toHaveLength(0);
  });

  it.each([
    { name: 'silent tool work', status: { type: 'busy' }, questions: [], permissions: [] },
    {
      name: 'question input',
      status: { type: 'idle' },
      questions: [{ id: 'question_1', sessionID: 'kilo_root' }],
      permissions: [],
    },
    {
      name: 'permission input',
      status: { type: 'idle' },
      questions: [],
      permissions: [{ id: 'permission_1', sessionID: 'kilo_root' }],
    },
  ])('supervises healthy $name without treating content silence as terminal', async snapshot => {
    const fixture = sessionFixture();
    const result = {
      status: snapshot.status,
      questions: snapshot.questions,
      permissions: snapshot.permissions,
    };
    delegateRequest(fixture, 'session.sync', async input => {
      expect(input.session).toEqual({
        sessionId: SESSION_ID,
        kiloSessionId: 'kilo_root',
        directory: DIRECTORY,
      });
      expect(fixture.alarmAt()).not.toBeNull();
      return controlResponse(result);
    });
    await fixture.admit('a');
    await fixture.admit('b');
    await fixture.flush();
    for (let check = 0; check < 4; check++) {
      vi.setSystemTime(Date.now() + DEADLINE_MS.acceptedOverdue);
      await fixture.fireAlarm();
      expect(fixture.record('a')?.state).toBe('accepted');
      expect(fixture.record('b')?.state).toBe('queued');
      expect(fixture.alarmAt()).not.toBeNull();
    }
    expect(fixture.terminalEvents()).toHaveLength(0);
    expect(fixture.control.quarantineRuntime).not.toHaveBeenCalled();
  });

  it.each(['idle', 'error', 'hang'] as const)(
    'fails lost accepted execution on %s health and fences cleanup across reset',
    async health => {
      const fixture = sessionFixture();
      await fixture.admit('a');
      await fixture.admit('b');
      await fixture.flush();
      delegateRequest(fixture, 'session.sync', async () => {
        if (health === 'error') throw new Error('Kilo status failed');
        if (health === 'hang') return new Promise<ResponseFrame>(() => undefined);
        return controlResponse({ status: { type: 'idle' }, questions: [], permissions: [] });
      });
      const cleanup = deferred<{ quarantined: boolean }>();
      fixture.control.quarantineRuntime.mockImplementation(() => cleanup.promise);
      vi.setSystemTime(Date.now() + DEADLINE_MS.acceptedOverdue);
      const alarm = fixture.fireAlarm();
      await vi.advanceTimersByTimeAsync(health === 'hang' ? SANDBOX_CONTROL_REQUEST_TIMEOUT_MS : 0);
      expect(fixture.record('a')?.state).toBe('failed');
      expect(fixture.record('b')?.state).toBe('failed');
      expect(fixture.terminalEvents()).toHaveLength(2);
      expect(await fixture.session.isSandboxCleanupScheduled()).toBe(true);
      await fixture.admit('c');
      await fixture.flush();
      expect(fixture.record('c')?.state).toBe('queued');
      const acquisition = fixture.acquisition('c');
      const ensureCount = fixture.control.ensureReady.mock.calls.length;
      await vi.advanceTimersByTimeAsync(SANDBOX_CONTROL_REQUEST_TIMEOUT_MS);
      await alarm;
      fixture.reload();
      fixture.control.quarantineRuntime.mockResolvedValue({ quarantined: false });
      fixture.setStatus({ physical: 'stopped', connection: 'disconnected' });
      fixture.control.ensureReady.mockImplementationOnce(async () => {
        const ready = {
          physical: 'running',
          connection: 'ready',
          wrapperInstanceId: NEXT_RUNTIME_ID,
        } satisfies ControlStatus;
        fixture.setStatus(ready);
        return { ...ready, attachment: ATTACHMENT };
      });
      await fixture.fireAlarm();
      expect(await fixture.session.isSandboxCleanupScheduled()).toBe(false);
      expect(fixture.record('c')).toMatchObject({
        state: 'accepted',
        wrapperInstanceId: NEXT_RUNTIME_ID,
      });
      expect(fixture.control.ensureReady).toHaveBeenCalledTimes(ensureCount + 1);
      expect(fixture.control.ensureReady).toHaveBeenLastCalledWith(
        expect.objectContaining({ acquisition })
      );
      await fixture.outcome('c', 'completed', NEXT_RUNTIME_ID);
      await fixture.flush();
      await fixture.admit('d');
      await fixture.admit('e');
      await fixture.flush();
      await fixture.session.failWaitingMessages('delayed_old_failure', RUNTIME_ID);
      expect(fixture.record('d')?.state).toBe('accepted');
      expect(fixture.record('e')?.state).toBe('queued');
      cleanup.resolve({ quarantined: true });
      await fixture.flush();
      expect(fixture.record('d')?.state).toBe('accepted');
    }
  );

  it('ignores delayed old-runtime failures during a new runtime handoff and for its followers', async () => {
    const fixture = sessionFixture();
    await fixture.admit('a');
    await fixture.flush();
    await fixture.session.failWaitingMessages('old_runtime_failed', RUNTIME_ID);
    fixture.setStatus({
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: NEXT_RUNTIME_ID,
    });
    const prompt = deferred<ResponseFrame>();
    delegateRequest(fixture, 'session.prompt', () => prompt.promise);
    await fixture.admit('b');
    await fixture.admit('c');
    await fixture.flush();
    expect(fixture.record('b')).toMatchObject({
      state: 'queued',
      wrapperInstanceId: NEXT_RUNTIME_ID,
    });
    await fixture.session.failWaitingMessages('late_old_runtime_failure', RUNTIME_ID);
    expect(fixture.record('b')?.state).toBe('queued');
    expect(fixture.record('c')?.state).toBe('queued');
    prompt.resolve(controlResponse({ messageId: 'b', status: 'accepted' }));
    await fixture.flush();
    expect(fixture.record('b')?.state).toBe('accepted');
    expect(fixture.terminalEvents()).toHaveLength(1);
  });

  it('does not hand off a prompt when the runtime changes during attachment', async () => {
    const fixture = sessionFixture();
    fixture.control.quarantineRuntime.mockResolvedValue({ quarantined: false });
    delegateRequest(fixture, 'session.attach', async () => {
      fixture.setStatus({
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: NEXT_RUNTIME_ID,
      });
      return controlResponse({ attached: true });
    });
    await fixture.admit('a');
    await fixture.flush();
    expect(fixture.record('a')?.state).toBe('failed');
    expect(
      fixture.control.request.mock.calls.some(([input]) => input.operation === 'session.prompt')
    ).toBe(false);
    expect(fixture.control.quarantineRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ wrapperInstanceId: RUNTIME_ID })
    );
    await fixture.admit('b');
    await fixture.flush();
    expect(fixture.record('b')).toMatchObject({
      state: 'accepted',
      wrapperInstanceId: NEXT_RUNTIME_ID,
    });
  });

  it('bounds an accepted runtime status RPC that never responds', async () => {
    const fixture = sessionFixture();
    await fixture.admit('a');
    await fixture.flush();
    fixture.control.getStatus.mockImplementation(() => new Promise<ControlStatus>(() => undefined));
    vi.setSystemTime(Date.now() + DEADLINE_MS.acceptedOverdue);
    const alarm = fixture.fireAlarm();
    await vi.advanceTimersByTimeAsync(SANDBOX_CONTROL_REQUEST_TIMEOUT_MS);
    await alarm;
    expect(fixture.record('a')?.state).toBe('failed');
    expect(fixture.control.quarantineRuntime).toHaveBeenCalledOnce();
  });

  it('does not apply a late unhealthy health result to the next accepted message', async () => {
    const fixture = sessionFixture();
    const sync = deferred<ResponseFrame>();
    delegateRequest(fixture, 'session.sync', () => sync.promise);
    await fixture.admit('a');
    await fixture.admit('b');
    await fixture.flush();
    vi.setSystemTime(Date.now() + DEADLINE_MS.acceptedOverdue);
    const alarm = fixture.fireAlarm();
    await fixture.flush();
    await fixture.outcome('a', 'completed');
    await fixture.flush();
    sync.reject(new Error('Late health failure'));
    await alarm;
    expect(fixture.record('a')?.state).toBe('completed');
    expect(fixture.record('b')?.state).toBe('accepted');
    expect(fixture.control.quarantineRuntime).not.toHaveBeenCalled();
  });

  it('keeps a new head bounded even while a prior quarantine cannot be transferred', async () => {
    const fixture = sessionFixture();
    await fixture.admit('a');
    await fixture.flush();
    delegateRequest(fixture, 'session.sync', async () => {
      throw new Error('Unhealthy runtime');
    });
    fixture.control.quarantineRuntime.mockRejectedValue(new Error('Quarantine unavailable'));
    vi.setSystemTime(Date.now() + DEADLINE_MS.acceptedOverdue);
    await fixture.fireAlarm();
    await fixture.admit('b');
    await fixture.flush();
    const deadlineAt = fixture.record('b')?.deliveryDeadlineAt;
    if (!deadlineAt) throw new Error('Missing pending head deadline');
    vi.setSystemTime(deadlineAt);
    await fixture.fireAlarm();
    expect(fixture.record('b')?.state).toBe('failed');
    expect(await fixture.session.isSandboxCleanupScheduled()).toBe(true);
    expect(fixture.control.ensureReady).toHaveBeenCalledOnce();
  });

  it('restores pending interactions from KV after reset and projects accepted work as ready and busy', async () => {
    const fixture = sessionFixture();
    await fixture.admit('a');
    await fixture.flush();
    const question = {
      id: 'question_1',
      sessionID: 'kilo_root',
      questions: [{ question: 'Proceed?' }],
    };
    const permission = { id: 'permission_1', sessionID: 'kilo_root', permission: 'skill_shell' };
    await fixture.rawEvent('question.asked', question);
    await fixture.rawEvent('permission.asked', permission);
    fixture.reload();
    delegateRequest(fixture, 'session.sync', async () => {
      throw new Error('Snapshot temporarily unavailable');
    });
    const snapshot = await fixture.snapshot();
    expect(snapshot).toMatchObject({
      cloudStatus: { type: 'ready' },
      sessionStatus: { type: 'busy' },
      pendingInteractions: { questions: [question], permissions: [permission] },
      queuedMessages: [expect.objectContaining({ messageId: 'a', delivery: 'sent' })],
      preparationSnapshots: expect.any(Array),
    });
    await fixture.session.answerQuestion({ questionId: 'question_1', answers: [['Yes']] });
    expect(await fixture.snapshot()).toMatchObject({
      pendingInteractions: { questions: [], permissions: [permission] },
    });
    await fixture.outcome('a', 'completed');
    expect(await fixture.snapshot()).toMatchObject({
      pendingInteractions: { questions: [], permissions: [] },
    });
  });

  it('persists root-routed descendant interactions and reconciles their original session identities', async () => {
    const fixture = sessionFixture();
    await fixture.admit('a');
    await fixture.flush();
    const childQuestion = {
      id: 'child_q',
      sessionID: 'kilo_child',
      questions: [{ question: 'Continue child task?' }],
    };
    const childPermission = {
      id: 'child_p',
      sessionID: 'kilo_grandchild',
      permission: 'skill_shell',
    };
    await fixture.rawEvent('question.asked', childQuestion, 'kilo_child');
    await fixture.rawEvent('permission.asked', childPermission, 'kilo_grandchild');
    delegateRequest(fixture, 'session.sync', async () => {
      throw new Error('Snapshot unavailable');
    });
    fixture.reload();
    expect(await fixture.snapshot()).toMatchObject({
      pendingInteractions: { questions: [childQuestion], permissions: [childPermission] },
    });
    const rootQuestion = { id: 'root_q', sessionID: 'kilo_root' };
    delegateRequest(fixture, 'session.sync', async input => {
      expect(input.session).toEqual({
        sessionId: SESSION_ID,
        kiloSessionId: 'kilo_root',
        directory: DIRECTORY,
      });
      return controlResponse({
        status: { type: 'busy' },
        questions: [rootQuestion, childQuestion],
        permissions: [childPermission],
      });
    });
    expect(await fixture.snapshot()).toMatchObject({
      pendingInteractions: {
        questions: [rootQuestion, childQuestion],
        permissions: [childPermission],
      },
    });
    await fixture.rawEvent(
      'question.replied',
      { requestID: childQuestion.id, sessionID: 'kilo_child' },
      'kilo_child'
    );
    await fixture.rawEvent(
      'permission.replied',
      { requestID: childPermission.id, sessionID: 'kilo_grandchild' },
      'kilo_grandchild'
    );
    expect(fixture.storage.kv.get('session_pending_interactions')).toMatchObject({
      questions: [rootQuestion],
      permissions: [],
    });
    await fixture.outcome('a', 'completed');
    expect(fixture.storage.kv.get('session_pending_interactions')).toMatchObject({
      questions: [],
      permissions: [],
    });
  });

  it.each([
    { rootKiloSessionId: 'other_root', wrapperInstanceId: RUNTIME_ID },
    { rootKiloSessionId: undefined, wrapperInstanceId: RUNTIME_ID },
    { rootKiloSessionId: 'kilo_root', wrapperInstanceId: NEXT_RUNTIME_ID },
  ])(
    'rejects descendant interaction identity outside the owning root/runtime: %j',
    async identity => {
      const fixture = sessionFixture();
      await fixture.admit('a');
      await fixture.flush();
      const before = fixture.eventQueries.findByEntityPrefix('');
      await expect(
        fixture.session.receiveSandboxControlEvent({
          identity: {
            directory: DIRECTORY,
            kiloSessionId: 'kilo_child',
            rootKiloSessionId: identity.rootKiloSessionId,
          },
          wrapperInstanceId: identity.wrapperInstanceId,
          payload: { type: 'question.asked', properties: { id: 'q', sessionID: 'kilo_child' } },
        })
      ).resolves.toEqual({ applied: false });
      expect(fixture.storage.kv.get('session_pending_interactions')).toBeUndefined();
      expect(fixture.eventQueries.findByEntityPrefix('')).toEqual(before);
      expect(fixture.record('a')?.state).toBe('accepted');
    }
  );

  it('keeps unknown pending state unknown when session.sync fails, then reconciles a successful directory-scoped snapshot', async () => {
    const fixture = sessionFixture();
    await fixture.admit('a');
    await fixture.flush();
    delegateRequest(fixture, 'session.sync', async () => ({
      type: 'response',
      requestId: 'sync',
      ok: false,
      error: { code: 'read_failed', message: 'Not available', retryable: true },
    }));
    expect(await fixture.snapshot()).not.toHaveProperty('pendingInteractions');
    delegateRequest(fixture, 'session.sync', async input => {
      expect(input.session?.directory).toBe(DIRECTORY);
      return controlResponse({
        status: { type: 'busy' },
        questions: [{ id: 'q' }],
        permissions: [{ id: 'p' }],
      });
    });
    expect(await fixture.snapshot()).toMatchObject({
      pendingInteractions: { questions: [{ id: 'q' }], permissions: [{ id: 'p' }] },
    });
    delegateRequest(fixture, 'session.sync', async () =>
      controlResponse({ status: { type: 'busy' }, questions: [], permissions: [] })
    );
    expect(await fixture.snapshot()).toMatchObject({
      pendingInteractions: { questions: [], permissions: [] },
    });
  });

  it('does not restore a resolved question from an older in-flight sync response', async () => {
    const fixture = sessionFixture();
    await fixture.admit('a');
    await fixture.flush();
    const question = { id: 'question_1', sessionID: 'kilo_root' };
    await fixture.rawEvent('question.asked', question);
    const sync = deferred<ResponseFrame>();
    delegateRequest(fixture, 'session.sync', () => sync.promise);
    const snapshot = fixture.snapshot();
    await fixture.flush();
    await fixture.rawEvent('question.replied', { requestID: 'question_1', sessionID: 'kilo_root' });
    sync.resolve(
      controlResponse({ status: { type: 'busy' }, questions: [question], permissions: [] })
    );
    expect(await snapshot).toMatchObject({
      pendingInteractions: { questions: [], permissions: [] },
    });
  });

  it('keeps failed question replies pending and validates success payloads', async () => {
    const fixture = sessionFixture();
    await fixture.admit('a');
    await fixture.flush();
    await fixture.rawEvent('question.asked', { id: 'q', sessionID: 'kilo_root' });
    delegateRequest(fixture, 'session.question.resolve', async () =>
      controlResponse({ success: false })
    );
    await expect(fixture.session.rejectQuestion({ questionId: 'q' })).rejects.toThrow();
    expect(fixture.storage.kv.get('session_pending_interactions')).toMatchObject({
      questions: [{ id: 'q' }],
    });
    delegateRequest(fixture, 'session.question.resolve', async () =>
      controlResponse({ success: true })
    );
    await fixture.session.rejectQuestion({ questionId: 'q' });
    expect(fixture.storage.kv.get('session_pending_interactions')).toMatchObject({ questions: [] });
  });

  it('reuses a persisted healthy attachment without warm preparation or a new preparation snapshot', async () => {
    const fixture = sessionFixture();
    await fixture.admit('cold');
    await fixture.flush();
    const coldPreparation = fixture.eventQueries.findByEntityPrefix('preparation/attempt/');
    expect(coldPreparation.length).toBeGreaterThan(0);
    await fixture.outcome('cold', 'completed');
    await fixture.flush();
    fixture.reload();
    orchestrationMocks.broadcast.mockClear();
    const ready = deferred<ControlStatus>();
    fixture.control.ensureReady.mockImplementationOnce(() => ready.promise);
    await fixture.admit('warm');
    await fixture.flush();
    expect(fixture.record('warm')?.state).toBe('queued');
    expect(fixture.eventQueries.findByEntityPrefix('preparation/attempt/')).toEqual(
      coldPreparation
    );
    expect(orchestrationMocks.broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ stream_event_type: 'preparing' })
    );
    ready.resolve({ physical: 'running', connection: 'ready', wrapperInstanceId: RUNTIME_ID });
    await fixture.flush();
    expect(fixture.record('warm')?.state).toBe('accepted');
    expect(fixture.control.ensureReady).toHaveBeenCalledTimes(2);
    expect(fixture.control.attachSession).toHaveBeenCalledOnce();
    expect(
      fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.attach')
    ).toHaveLength(1);
    expect(fixture.eventQueries.findByEntityPrefix('preparation/attempt/')).toEqual(
      coldPreparation
    );
    expect(orchestrationMocks.broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ stream_event_type: 'preparing' })
    );
    expect(await fixture.snapshot()).toMatchObject({ preparationSnapshots: coldPreparation });
  });

  it('keeps a persisted modern attachment isolated after the rollout flag is disabled', async () => {
    const fixture = sessionFixture({
      auth: {
        kiloSessionId: 'kilo_root',
        kilocodeToken: 'eyJhbGciOiJub25lIn0.eyJydW50aW1lQXV0aG9yaXphdGlvbiI6e319.',
      },
    });
    fixture.env.RUNTIME_ISOLATION_ENABLED = 'false';

    await fixture.admit('modern');
    await fixture.flush();

    expect(fixture.control.request).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'session.attach',
        payload: expect.objectContaining({ runtimeIsolation: 'per-session' }),
      })
    );
  });

  it.each(['cloudflare', 'vercel'] as const)(
    'refreshes direct credentials without warm preparation across eviction on %s',
    async sandboxProvider => {
      const fixture = sessionFixture({
        workspace: { sandboxId: SANDBOX_ID, workspacePath: DIRECTORY, sandboxProvider },
      });
      const initial = {
        ...ATTACHMENT,
        kilo: { ...ATTACHMENT.kilo, containmentEnabled: false },
      };
      const ready: ControlStatus = {
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: RUNTIME_ID,
        attachment: initial,
      };
      fixture.control.ensureReady.mockResolvedValue(ready);
      await fixture.admit('cold');
      await fixture.flush();
      const coldPreparation = fixture.eventQueries.findByEntityPrefix('preparation/attempt/');
      expect(coldPreparation.length).toBeGreaterThan(0);
      expect(fixture.control.request).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'session.attach',
          payload: {
            ...initial,
            preparation: {
              attemptId: fixture.record('cold')?.preparationAttemptId,
              triggerMessageId: 'cold',
            },
          },
        })
      );
      await fixture.outcome('cold', 'completed');
      await fixture.flush();
      fixture.reload();
      const refreshed = {
        ...initial,
        kilo: { ...initial.kilo, token: 'fresh-direct-kilo-token' },
        env: { KILOCODE_TOKEN: 'fresh-direct-kilo-token', GH_TOKEN: 'fresh-direct-git-token' },
        git: { url: 'https://github.com/acme/repo.git', token: 'fresh-direct-git-token' },
      };
      fixture.control.ensureReady.mockResolvedValue({ ...ready, attachment: refreshed });
      fixture.control.request.mockClear();
      orchestrationMocks.broadcast.mockClear();
      const attached = deferred<ResponseFrame>();
      delegateRequest(fixture, 'session.attach', () => attached.promise);
      await fixture.admit('warm');
      await fixture.flush();
      expect(orchestrationMocks.broadcast).not.toHaveBeenCalledWith(
        expect.objectContaining({ stream_event_type: 'preparing' })
      );
      expect(fixture.eventQueries.findByEntityPrefix('preparation/attempt/')).toEqual(
        coldPreparation
      );
      expect(fixture.control.request).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          operation: 'session.attach',
          expectedWrapperInstanceId: RUNTIME_ID,
          payload: refreshed,
        })
      );
      expect(fixture.record('warm')).toMatchObject({ state: 'queued', unresolvedDispatch: true });
      attached.resolve(controlResponse({ attached: true }));
      await fixture.flush();
      expect(fixture.control.request.mock.calls.map(([input]) => input.operation)).toEqual([
        'session.attach',
        'session.prompt',
      ]);
      expect(fixture.record('warm')).toMatchObject({
        state: 'accepted',
        wrapperInstanceId: RUNTIME_ID,
      });
      expect(fixture.record('warm')?.unresolvedDispatch).toBeUndefined();
      expect(fixture.control.quarantineRuntime).not.toHaveBeenCalled();
      expect(orchestrationMocks.broadcast).not.toHaveBeenCalledWith(
        expect.objectContaining({ stream_event_type: 'preparing' })
      );
      expect(fixture.eventQueries.findByEntityPrefix('preparation/attempt/')).toEqual(
        coldPreparation
      );
      expect(await fixture.snapshot()).toMatchObject({ preparationSnapshots: coldPreparation });
    }
  );

  it('reports a failed warm credential refresh without preparation or prompt delivery', async () => {
    const fixture = sessionFixture();
    fixture.control.ensureReady.mockResolvedValue({
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      attachment: {
        ...ATTACHMENT,
        kilo: { ...ATTACHMENT.kilo, containmentEnabled: false },
      },
    });
    await fixture.admit('cold');
    await fixture.flush();
    await fixture.outcome('cold', 'completed');
    await fixture.flush();
    const coldPreparation = fixture.eventQueries.findByEntityPrefix('preparation/attempt/');
    fixture.reload();
    fixture.control.request.mockClear();
    orchestrationMocks.broadcast.mockClear();
    delegateRequest(fixture, 'session.attach', async () => controlFailure(false));
    await fixture.admit('warm');
    await fixture.flush();
    expect(fixture.record('warm')).toMatchObject({
      state: 'failed',
      failedReason: 'attach_exhausted',
    });
    expect(fixture.control.request.mock.calls.map(([input]) => input.operation)).toEqual([
      'session.attach',
    ]);
    expect(orchestrationMocks.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ stream_event_type: 'cloud.message.failed' })
    );
    expect(orchestrationMocks.broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ stream_event_type: 'preparing' })
    );
    expect(fixture.eventQueries.findByEntityPrefix('preparation/attempt/')).toEqual(
      coldPreparation
    );
    expect(fixture.control.quarantineRuntime).not.toHaveBeenCalled();
    expect(await fixture.snapshot()).toMatchObject({ preparationSnapshots: coldPreparation });
  });

  it.each(['cloudflare', 'vercel'] as const)(
    'fences captures across warm direct reattachment without clearing ambiguous dispatch on %s',
    async sandboxProvider => {
      const fixture = sessionFixture({
        repository: { type: 'github', repo: 'acme/repo', upstreamBranch: 'main' },
        workspace: { sandboxId: SANDBOX_ID, workspacePath: DIRECTORY, sandboxProvider },
      });
      fixture.control.ensureReady.mockResolvedValue({
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: RUNTIME_ID,
        attachment: {
          ...ATTACHMENT,
          kilo: { ...ATTACHMENT.kilo, containmentEnabled: false },
        },
      });
      const captureResponse = (input: SandboxControlOutboundRequest) =>
        controlResponse({
          revision: sessionGitSummaryPayloadSchema.parse(input.payload).revision,
          comparison: {
            baseRef: 'refs/remotes/origin/main',
            mergeBase: 'a'.repeat(40),
            head: 'b'.repeat(40),
          },
          files: [],
          truncated: false,
        });
      let heldCapture: ReturnType<typeof deferred<ResponseFrame>> | undefined;
      let heldRequest: SandboxControlOutboundRequest | undefined;
      delegateRequest(fixture, 'session.git.summary', async input => {
        if (!heldCapture) return captureResponse(input);
        heldRequest = input;
        return heldCapture.promise;
      });
      await fixture.admit('cold');
      await fixture.flush();
      await fixture.outcome('cold', 'completed');
      await fixture.flush();
      const saved = await fixture.session.getWorktreeChanges();
      expect(saved.snapshot).not.toBeNull();
      fixture.reload();
      heldCapture = deferred<ResponseFrame>();
      const staleRefresh = fixture.session.refreshWorktreeChanges();
      await fixture.flush();
      const attached = deferred<ResponseFrame>();
      delegateRequest(fixture, 'session.attach', () => attached.promise);
      const lostPrompt = deferred<ResponseFrame>();
      let prompts = 0;
      delegateRequest(fixture, 'session.prompt', async () =>
        ++prompts === 1 ? lostPrompt.promise : controlFailure(true, 'session_busy')
      );
      await fixture.admit('warm');
      await fixture.flush();
      if (!heldRequest) throw new Error('Expected in-flight capture');
      heldCapture.resolve(captureResponse(heldRequest));
      heldCapture = undefined;
      await expect(staleRefresh).resolves.toEqual({ status: 'failed', snapshot: saved.snapshot });
      await expect(fixture.session.refreshWorktreeChanges()).resolves.toEqual({
        status: 'offline',
        snapshot: saved.snapshot,
      });
      expect(prompts).toBe(0);
      attached.resolve(controlResponse({ attached: true }));
      await fixture.flush();
      expect(prompts).toBe(1);
      expect(fixture.record('warm')).toMatchObject({ state: 'queued', unresolvedDispatch: true });
      const captured = await fixture.session.getWorktreeChanges();
      expect(captured.snapshot?.revision).toBeGreaterThan(saved.snapshot?.revision ?? 0);
      fixture.reload();
      await fixture.fireAlarm();
      await fixture.flush();
      expect(fixture.record('warm')).toMatchObject({
        state: 'queued',
        unresolvedDispatch: true,
        deliveryRetryScope: 'runtime',
      });
      await expect(fixture.session.refreshWorktreeChanges()).resolves.toMatchObject({
        status: 'refreshed',
      });
      expect(fixture.record('warm')?.unresolvedDispatch).toBe(true);
      await fixture.session.interruptExecution();
      expect(fixture.control.quarantineRuntime).toHaveBeenCalledWith(
        expect.objectContaining({ wrapperInstanceId: RUNTIME_ID })
      );
      lostPrompt.resolve(controlResponse({ messageId: 'warm', status: 'accepted' }));
      await fixture.flush();
      expect(fixture.record('warm')?.state).toBe('cancelled');
    }
  );

  it.each(['stop', 'expiry'] as const)(
    'retains ambiguous warm prompt ownership through direct reattachment and %s',
    async action => {
      const fixture = sessionFixture();
      fixture.control.ensureReady.mockResolvedValue({
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: RUNTIME_ID,
        attachment: {
          ...ATTACHMENT,
          kilo: { ...ATTACHMENT.kilo, containmentEnabled: false },
        },
      });
      await fixture.admit('cold');
      await fixture.flush();
      await fixture.outcome('cold', 'completed');
      await fixture.flush();
      const lostPrompt = deferred<ResponseFrame>();
      let prompts = 0;
      delegateRequest(fixture, 'session.prompt', async () => {
        prompts++;
        return prompts === 1 ? lostPrompt.promise : controlFailure(true, 'session_busy');
      });
      await fixture.admit('warm');
      await fixture.flush();
      const acquisition = fixture.acquisition('warm');
      expect(fixture.record('warm')?.unresolvedDispatch).toBe(true);
      fixture.reload();
      await fixture.fireAlarm();
      expect(fixture.record('warm')).toMatchObject({
        state: 'queued',
        unresolvedDispatch: true,
        deliveryRetryScope: 'runtime',
        wrapperInstanceId: RUNTIME_ID,
      });
      expect(fixture.control.attachSession).toHaveBeenCalledTimes(3);
      if (action === 'stop') {
        await fixture.session.interruptExecution();
      } else {
        vi.setSystemTime(acquisition.deadlineAt);
        await fixture.fireAlarm();
      }
      expect(fixture.control.quarantineRuntime).toHaveBeenCalledWith(
        expect.objectContaining({ wrapperInstanceId: RUNTIME_ID })
      );
      expect(fixture.record('warm')?.state).toBe(action === 'stop' ? 'cancelled' : 'failed');
      lostPrompt.resolve(controlResponse({ messageId: 'warm', status: 'accepted' }));
      await fixture.flush();
      expect(fixture.record('warm')?.state).toBe(action === 'stop' ? 'cancelled' : 'failed');
      expect(fixture.terminalEvents()).toHaveLength(2);
    }
  );

  it.each(['replacement runtime', 'missing legacy attachment'] as const)(
    'performs real preparation for a %s instead of assuming warmth from prior messages',
    async reason => {
      const fixture = sessionFixture();
      await fixture.admit('cold');
      await fixture.flush();
      await fixture.outcome('cold', 'completed');
      await fixture.flush();
      fixture.reload();
      const wrapperInstanceId = reason === 'replacement runtime' ? NEXT_RUNTIME_ID : RUNTIME_ID;
      fixture.setStatus({ physical: 'running', connection: 'ready', wrapperInstanceId });
      if (reason === 'missing legacy attachment')
        fixture.values.delete('terminal_attached_session');
      orchestrationMocks.broadcast.mockClear();
      await fixture.admit('rebuild');
      await fixture.flush();
      expect(fixture.record('rebuild')).toMatchObject({ state: 'accepted', wrapperInstanceId });
      expect(fixture.control.ensureReady).toHaveBeenCalledTimes(2);
      expect(fixture.control.attachSession).toHaveBeenCalledTimes(2);
      expect(
        fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.attach')
      ).toHaveLength(2);
      expect(orchestrationMocks.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ stream_event_type: 'preparing' })
      );
      const attemptId = fixture.record('rebuild')?.preparationAttemptId;
      const snapshot = fixture.eventQueries.findByEntityId(`preparation/attempt/${attemptId}`);
      expect(JSON.parse(snapshot?.payload ?? '{}')).toMatchObject({
        triggerMessageId: 'rebuild',
        attempt: { status: 'completed' },
      });
    }
  );

  it('keeps invalid custom options visibly rejected even when an attachment is warm', async () => {
    const fixture = sessionFixture();
    await fixture.admit('cold');
    await fixture.flush();
    await fixture.outcome('cold', 'completed');
    fixture.storage.kv.put(
      'session_metadata',
      serializeSessionMetadata({
        ...fixture.metadata,
        profile: { envVars: { SANDBOX_CONTROL_CREDENTIAL: 'raw-secret-must-not-leak' } },
      })
    );
    const admission = await fixture.admit('warm');
    expect(admission).toMatchObject({
      success: false,
      code: 'BAD_REQUEST',
      error: expect.stringContaining('Reserved control runtime environment variable'),
    });
    expect(JSON.stringify(admission)).not.toContain('raw-secret-must-not-leak');
    expect(fixture.record('warm')).toBeUndefined();
    expect(fixture.control.ensureReady).toHaveBeenCalledOnce();
  });

  it('runs trusted admission for every warm handoff and cannot bypass denial through ready status', async () => {
    const fixture = sessionFixture();
    let allowed = true;
    fixture.control.ensureReady.mockImplementation(async input => {
      expect(input.billing).toMatchObject({
        sandboxId: SANDBOX_ID,
        enforcementRequested: true,
        subject: { type: 'user', id: 'user_1' },
        actor: { type: 'user', id: 'user_1' },
        sessionId: SESSION_ID,
      });
      if (fixture.control.ensureReady.mock.calls.length === 1) {
        expect(fixture.control.getStatus).not.toHaveBeenCalled();
      }
      if (!allowed) throw new Error('Compute admission denied');
      return {
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: RUNTIME_ID,
        attachment: ATTACHMENT,
      };
    });
    await fixture.admit('a');
    await fixture.admit('b');
    await fixture.flush();
    expect(fixture.record('a')?.state).toBe('accepted');
    expect(fixture.control.ensureReady).toHaveBeenCalledOnce();
    allowed = false;
    await fixture.outcome('a', 'completed');
    await fixture.flush();
    expect(fixture.record('b')).toMatchObject({
      state: 'failed',
      failedReason: 'environment_failed',
    });
    expect(fixture.control.ensureReady).toHaveBeenCalledTimes(2);
    expect(fixture.control.ensureReady).toHaveBeenLastCalledWith(
      expect.objectContaining({ acquisition: fixture.acquisition('b') })
    );
    expect(fixture.control.getStatus).toHaveBeenCalledOnce();
    await fixture.fireAlarm();
    expect(fixture.control.ensureReady).toHaveBeenCalledTimes(2);
    expect(
      fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.prompt')
    ).toHaveLength(1);
    allowed = true;
    await fixture.admit('c');
    await fixture.flush();
    expect(fixture.record('c')?.state).toBe('accepted');
    expect(fixture.control.ensureReady).toHaveBeenCalledTimes(3);
    expect(fixture.control.ensureReady).toHaveBeenLastCalledWith(
      expect.objectContaining({ acquisition: fixture.acquisition('c') })
    );
  });

  it('passes signed prompt attachments and trusted billing attribution at the handoff boundary', async () => {
    const fixture = sessionFixture({
      identity: {
        sessionId: SESSION_ID,
        userId: 'user_1',
        orgId: 'org_1',
        botId: 'bot_1',
        billingOrigin: 'cloud-agent-web',
      },
    });
    const attachments = { path: 'uploads', files: ['document.pdf'] };
    const signed = [
      {
        filename: 'document.pdf',
        mime: 'application/pdf',
        localPath: '/workspace/attachments/document.pdf',
        signedUrl: 'https://attachments.example.test/document.pdf',
      },
    ];
    orchestrationMocks.signedAttachments.mockResolvedValue(signed);
    await fixture.admit('a', { prompt: '', attachments });
    attachments.files.push('later.txt');
    await fixture.flush();
    expect(orchestrationMocks.signedAttachments).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user_1',
        sessionId: SESSION_ID,
        attachments: { path: 'uploads', files: ['document.pdf'] },
      })
    );
    const prompt = fixture.control.request.mock.calls.find(
      ([input]) => input.operation === 'session.prompt'
    )?.[0];
    expect(prompt?.payload).toMatchObject({
      messageId: 'a',
      turn: { type: 'prompt', prompt: '' },
      attachments: signed,
    });
    expect(fixture.control.ensureReady).toHaveBeenCalledWith(
      expect.objectContaining({
        billing: {
          sandboxId: SANDBOX_ID,
          enforcementRequested: true,
          subject: { type: 'org', id: 'org_1' },
          actor: { type: 'bot', id: 'bot_1' },
          onBehalfOf: { type: 'org', id: 'org_1' },
          sessionId: SESSION_ID,
          metadata: { origin: 'cloud-agent-web' },
        },
      })
    );
  });

  it.each([{ autoCommit: true }, { condenseOnComplete: true }])(
    'preserves supported follow-up finalization %j through prompt handoff',
    async finalization => {
      const fixture = sessionFixture();
      await expect(fixture.admit('a', { finalization })).resolves.toMatchObject({ success: true });
      await fixture.flush();
      expect(fixture.record('a')).toMatchObject({ state: 'accepted', intent: { finalization } });
      expect(fixture.control.request).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'session.prompt',
          payload: expect.objectContaining({ finalization }),
        })
      );
    }
  );

  it('admits an initial web turn with enabled finalizers and passes them unchanged to the wrapper', async () => {
    const fixture = sessionFixture();
    fixture.values.delete('session_metadata');
    const finalization = { autoCommit: true, condenseOnComplete: true };
    const messageId = 'msg_123456789abcABCDEFGHIJKLMN';
    await expect(
      fixture.session.createSessionWithInitialAdmission({
        identity: fixture.metadata.identity,
        auth: fixture.metadata.auth,
        agent: fixture.metadata.agent,
        workspace: fixture.metadata.workspace,
        finalization,
        message: { initialTurn: { type: 'prompt', messageId, prompt: 'Initial web prompt' } },
      })
    ).resolves.toMatchObject({ success: true });
    await fixture.flush();
    expect(fixture.record(messageId)).toMatchObject({
      state: 'accepted',
      intent: { finalization },
    });
    expect((await fixture.session.getMetadata())?.finalization).toEqual(finalization);
    expect(fixture.control.request).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'session.prompt',
        payload: expect.objectContaining({ finalization }),
      })
    );
  });

  it.each([
    { envVars: { SANDBOX_CONTROL_URL: 'not-logged' } },
    {
      encryptedSecrets: {
        SANDBOX_CONTROL_CREDENTIAL: {
          encryptedData: 'not-logged',
          encryptedDEK: 'not-logged',
          algorithm: 'rsa-aes-256-gcm' as const,
          version: 1 as const,
        },
      },
    },
  ])('rejects reserved profile environment without rejecting contained auth', async profile => {
    const fixture = sessionFixture({ profile });
    await expect(fixture.admit('a')).resolves.toMatchObject({
      success: false,
      code: 'BAD_REQUEST',
      error: expect.stringContaining('Reserved control runtime environment variable'),
    });
    expect(fixture.control.ensureReady).not.toHaveBeenCalled();
    const supported = sessionFixture({ profile: { envVars: {}, setupCommands: ['pnpm install'] } });
    await expect(
      supported.admit('b', { finalization: { autoCommit: false, condenseOnComplete: false } })
    ).resolves.toMatchObject({ success: true });
    await supported.flush();
    expect(supported.record('b')?.state).toBe('accepted');
    const attach = supported.control.request.mock.calls.find(
      ([input]) => input.operation === 'session.attach'
    )?.[0];
    expect(attach?.payload).toMatchObject({
      env: { KILOCODE_TOKEN: KILO_CREDENTIAL },
      kilo: ATTACHMENT.kilo,
      setupCommands: ['pnpm install'],
    });
    expect(JSON.stringify(attach?.payload)).not.toContain('test-token');
  });

  it.each(['rejected', 'malformed', 'error', 'timeout'] as const)(
    'quarantines an accepted runtime on %s abort and fails a follow-up admitted during cancellation',
    async failure => {
      const fixture = sessionFixture();
      const abort = deferred<ResponseFrame>();
      const cleanup = deferred<{ quarantined: boolean }>();
      delegateRequest(fixture, 'session.abort', () => abort.promise);
      fixture.control.quarantineRuntime.mockImplementation(() => cleanup.promise);
      await fixture.admit('a');
      await fixture.flush();
      const interruption = fixture.session.interruptExecution();
      await fixture.flush();
      await fixture.admit('b');
      await fixture.flush();
      expect(fixture.record('a')?.state).toBe('accepted');
      expect(fixture.record('b')?.state).toBe('queued');
      if (failure === 'timeout') {
        await vi.advanceTimersByTimeAsync(SANDBOX_CONTROL_REQUEST_TIMEOUT_MS);
      } else {
        if (failure === 'error') abort.reject(new Error('Abort transport failed'));
        else
          abort.resolve(
            failure === 'rejected' ? controlFailure(true) : controlResponse({ status: 'pending' })
          );
        await fixture.flush();
      }
      expect(fixture.record('a')).toMatchObject({
        state: 'failed',
        failedReason: 'runtime_unhealthy',
      });
      expect(fixture.record('b')).toMatchObject({
        state: 'failed',
        failedReason: 'runtime_unhealthy',
      });
      expect(await fixture.session.isSandboxCleanupScheduled()).toBe(true);
      expect(fixture.control.quarantineRuntime).toHaveBeenCalledWith(
        expect.objectContaining({ wrapperInstanceId: RUNTIME_ID, reason: 'runtime_unhealthy' })
      );
      expect(fixture.terminalEvents()).toHaveLength(2);
      cleanup.resolve({ quarantined: true });
      await expect(interruption).resolves.toEqual({
        success: false,
        message: 'The session runtime could not be interrupted',
      });
      fixture.setStatus({
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: NEXT_RUNTIME_ID,
      });
      await fixture.admit('c');
      await fixture.flush();
      abort.resolve(controlResponse({ status: 'aborted' }));
      await fixture.flush();
      expect(fixture.record('a')?.state).toBe('failed');
      expect(fixture.record('c')).toMatchObject({
        state: 'accepted',
        wrapperInstanceId: NEXT_RUNTIME_ID,
      });
    }
  );

  it.each(['error', 'timeout'] as const)(
    'ignores a late abort %s after an outcome releases the next accepted message',
    async failure => {
      const fixture = sessionFixture();
      const abort = deferred<ResponseFrame>();
      delegateRequest(fixture, 'session.abort', () => abort.promise);
      await fixture.admit('a');
      await fixture.flush();
      const interruption = fixture.session.interruptExecution();
      await fixture.flush();
      await fixture.admit('b');
      await fixture.flush();
      await fixture.outcome('a', 'cancelled');
      await fixture.flush();
      expect(fixture.record('b')?.state).toBe('accepted');
      if (failure === 'timeout') {
        await vi.advanceTimersByTimeAsync(SANDBOX_CONTROL_REQUEST_TIMEOUT_MS);
      } else {
        abort.reject(new Error('Late abort transport failure'));
      }
      await expect(interruption).resolves.toEqual({ success: true });
      expect(fixture.record('a')?.state).toBe('cancelled');
      expect(fixture.record('b')?.state).toBe('accepted');
      expect(fixture.control.quarantineRuntime).not.toHaveBeenCalled();
      expect(fixture.terminalEvents()).toHaveLength(1);
    }
  );

  it('does not cancel a new submission while aborting the previously accepted message', async () => {
    const fixture = sessionFixture();
    const abort = deferred<ResponseFrame>();
    delegateRequest(fixture, 'session.abort', () => abort.promise);
    await fixture.admit('a');
    await fixture.flush();
    const interruption = fixture.session.interruptExecution();
    await fixture.flush();
    await fixture.admit('b');
    await fixture.flush();
    expect(fixture.record('a')?.state).toBe('accepted');
    expect(fixture.record('b')?.state).toBe('queued');
    abort.resolve(controlResponse({ status: 'aborted' }));
    await interruption;
    await fixture.fireAlarm();
    expect(fixture.record('a')?.state).toBe('cancelled');
    expect(fixture.record('b')?.state).toBe('accepted');
  });
});

describe('streamCloudStatus', () => {
  it('is ready for accepted work even with queued followers', () => {
    expect(streamCloudStatus([msg('a', 'queued')])).toEqual({ type: 'preparing' });
    expect(streamCloudStatus([msg('a', 'completed'), msg('b', 'queued')])).toEqual({
      type: 'preparing',
    });
    expect(streamCloudStatus([msg('a', 'accepted'), msg('b', 'queued')])).toEqual({
      type: 'ready',
    });
  });

  it('is ready after a turn and null before any messages', () => {
    expect(streamCloudStatus([msg('a', 'completed')])).toEqual({ type: 'ready' });
    expect(streamCloudStatus([])).toBeNull();
  });
});
