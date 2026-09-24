import { signModernKiloToken } from '@kilocode/worker-utils/kilo-token-policy';
import {
  verifyRuntimeProxyAttestation,
  RUNTIME_PROXY_ATTESTATION_HEADER,
} from '@kilocode/worker-utils/runtime-proxy-attestation';
import { assertKiloModelAvailable } from '../model-validation.js';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeCliEvent } from '../../../../packages/cloud-agent-sdk/src/normalizer';
import { createServiceState } from '../../../../packages/cloud-agent-sdk/src/service-state';
import { serializeSessionMetadata, type SessionMetadata } from '../persistence/session-metadata.js';
import { readStep } from '../session/preparation-test-helpers.js';
import type { Env } from '../types.js';
import { getPreparationSnapshots, readPreparationAttempt } from '../session/preparation-history.js';
import type { CallbackJob } from '../callbacks/types.js';
import type { SandboxControlOutboundRequest } from '../sandbox-control/socket.js';
import {
  SANDBOX_CONTROL_OUTCOME_TIMEOUT_MS,
  SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
  SandboxAcquisitionLostError,
  SandboxAcquisitionSupersededError,
  sessionOperationExpiresAt,
  sessionOperationResultHash,
  sessionPromptPayloadSchema,
  type ResponseFrame,
  type SessionOperationAuthorization,
  type SessionOperationDelivery,
} from '../shared/sandbox-control-protocol.js';
import { DEADLINE_MS } from '../sandbox-control/deadlines.js';
import { logger } from '../logger.js';
import { SESSION_DELIVERY_TIMEOUT_MS } from './control-dispatch.js';
import { RUNTIME_AUTHORIZATION_KEY } from '../session/runtime-authorization-persistence.js';
import {
  RUNTIME_PROXY_GRANT_KEY,
  runtimeProxyGrantSchema,
  type RuntimeProxyFence,
} from '../runtime-credential-proxy.js';
import { PENDING_SESSION_MESSAGE_LIMIT } from '../session/pending-messages.js';
import type { CloudAgentQueueReport } from '@kilocode/worker-utils/cloud-agent-queue-report';
import type {
  AcceptedCommandTurn,
  AcceptedPromptTurn,
  AgentSelectionOverride,
} from '../execution/types.js';
import {
  ATTACH_FAILURE_LIMIT,
  PROMPT_FAILURE_LIMIT,
  acceptQueuedMessage,
  acceptedAtOf as acceptedAtOfMessage,
  activeWrapperInstanceId as activeWrapperInstanceIdMessage,
  applyMessageOutcome,
  applySessionOperationResult,
  assignPreparationAttemptId,
  cancelPendingMessage,
  completeSessionOperationAttachment,
  createSessionMessageRecord,
  failAcceptedMessage,
  failedMessageSnapshot,
  failQueuedMessage,
  failedReasonOf as failedReasonOfMessage,
  freezeLegacyQueuedMessages,
  getSessionMessageTurn,
  hasAcceptedMessage,
  matchesSessionMessageReplay,
  nextQueuedMessageId,
  markSessionOperationRejection,
  noOutputRecoveryAllowed,
  recordAcceptedMessageActivity,
  recordSessionOperationDispatch,
  redispatchAcceptedMessage,
  releaseCompletedRetryableAttach,
  releaseUnadmittedWaitingMessages,
  releaseUnconfirmedAttach,
  rotateLostPreparationAttempt,
  resolveSessionMessageIntent,
  streamCloudStatus,
  streamQueuedSnapshots,
  terminalAtOf as terminalAtOfMessage,
  terminalSourceOf as terminalSourceOfMessage,
  type ControlSessionMessageInput,
  type ControlSessionMessageIntent,
  type SessionAggregate,
  type SessionMessage,
  type SessionMessageState,
  type SessionOperationProof,
} from './session-message-queue.js';
import { acceptedState, queuedState, terminalState } from './session-state.test-helpers.js';
import type {
  AcceptedMessageState,
  CancelledMessageState,
  FailedMessageState,
  QueuedMessageState,
  SessionMessageTerminalSource,
} from '../sandbox-state/model/session.js';
import {
  ATTACHMENT,
  DIRECTORY,
  KILO_CREDENTIAL,
  NEXT_RUNTIME_ID,
  RUNTIME_ID,
  SANDBOX_ID,
  SESSION_ID,
  controlFailure,
  controlResponse,
  createSessionFixture,
  deferred,
  defaultAgent,
  delegateRequest,
  receiptedEvent,
  receiptedPreparing,
  unreceiptedPreparing,
  type Control,
  type ControlStatus,
  type SessionFixtureDeps,
} from './session-fixture.test-helpers.js';

import {
  readSessionValueSync,
  writeSessionValueSync,
  writeSessionMessages,
  seedSessionValue,
  isSessionMessagesKey,
} from '../sandbox-state/persist/access.js';
import { terminalizeOnStop } from '../sandbox-state/session/reduce.js';
import { decodeSessionValue, readRawSessionMessages } from '../sandbox-state/persist/load.js';
import { POLICY } from '../sandbox-state/schedule.js';
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
      readPendingInteractions?: () => unknown;
      deriveSessionStatus?: () => Promise<unknown>;
      getPreparationSnapshots?: () => Promise<unknown>;
    }
  ) => ({
    broadcastEvent: orchestrationMocks.broadcast,
    handleStreamRequest: async () =>
      Response.json({
        cloudStatus: await options?.deriveCloudStatus?.(),
        queuedMessages: await options?.deriveQueuedMessages?.(),
        pendingInteractions: options?.readPendingInteractions?.(),
        sessionStatus: await options?.deriveSessionStatus?.(),
        preparationSnapshots: await options?.getPreparationSnapshots?.(),
      }),
  }),
}));

function msg(messageId: string, kind: SessionMessageState): SessionMessage {
  return {
    messageId,
    state:
      kind === 'queued'
        ? queuedState()
        : kind === 'accepted'
          ? acceptedState()
          : terminalState(kind),
  };
}

/** The canonical queue-head delivery deadline; absent (undefined) for a non-head queue. */
function deadlineAtOf(record: SessionMessage | undefined): number | undefined {
  return record?.state.kind === 'queued' ? (record.state.deadlineAt ?? undefined) : undefined;
}

function acceptedAtOf(record: SessionMessage | undefined): number | undefined {
  return record ? acceptedAtOfMessage(record) : undefined;
}

function terminalAtOf(record: SessionMessage | undefined): number | undefined {
  return record ? terminalAtOfMessage(record) : undefined;
}

function activeWrapperInstanceId(record: SessionMessage | undefined): string | undefined {
  return record ? activeWrapperInstanceIdMessage(record) : undefined;
}

function failedReasonOf(record: SessionMessage | undefined): string | undefined {
  return record ? failedReasonOfMessage(record) : undefined;
}

function terminalSourceOf(
  record: SessionMessage | undefined
): SessionMessageTerminalSource | undefined {
  return record ? terminalSourceOfMessage(record) : undefined;
}

function lastActivityAtOf(record: SessionMessage | undefined): number | undefined {
  return record?.state.kind === 'accepted' ? record.state.lastActivityAt : undefined;
}

function preparationAttemptIdOf(record: SessionMessage | undefined): string | undefined {
  return record?.state.kind === 'queued' ? record.state.preparationAttemptId : undefined;
}

function attachFailuresOf(record: SessionMessage | undefined): number | undefined {
  return record?.state.kind === 'queued' ? record.state.attachFailures : undefined;
}

function promptFailuresOf(record: SessionMessage | undefined): number | undefined {
  return record?.state.kind === 'queued' ? record.state.promptFailures : undefined;
}

function recoveryAttemptsOf(record: SessionMessage | undefined): number | undefined {
  return record?.state.kind === 'accepted' ? record.state.recoveryAttempts : undefined;
}

function unresolvedDispatchOf(record: SessionMessage | undefined): true | undefined {
  return record?.state.kind === 'queued' ? record.state.unresolvedDispatch : undefined;
}

function retryNotBeforeOf(record: SessionMessage | undefined): number | undefined {
  return record?.state.kind === 'queued' ? record.state.retryNotBefore : undefined;
}

/** A bound aggregate for the helpers whose canonical precondition is a bound session. */
function boundAggregate(
  messages: readonly SessionMessage[],
  wrapper = 'runtime'
): SessionAggregate {
  return {
    binding: { kind: 'bound', handle: { incarnation: 'incarnation', wrapper, epoch: 0 } },
    messages: [...messages],
  };
}

function queuedWith(messageId: string, state: Partial<QueuedMessageState> = {}): SessionMessage {
  return { messageId, state: queuedState(state) };
}

function acceptedWith(
  messageId: string,
  state: Partial<AcceptedMessageState> = {}
): SessionMessage {
  return { messageId, state: acceptedState(state) };
}

/** Seeds the canonical session envelope through the same writer the DO uses. */
function writeMessages(
  storage: { put(key: string, value: unknown): void },
  messages: readonly SessionMessage[]
): void {
  writeSessionMessages(storage, boundAggregate(messages).binding, messages);
}

/** Seeds a raw `Map` fixture with the canonical session envelope. */
function seedMessages(records: Map<string, unknown>, messages: readonly SessionMessage[]): void {
  seedSessionValue(records, {
    v: 2,
    binding: boundAggregate(messages).binding,
    messages: [...messages],
  });
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
  it('writes only a nested intent and isolates it from later input mutations', () => {
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
      messageId: promptTurn.messageId,
      state: {
        kind: 'queued',
        intent: original,
        deliveryStep: 'waiting',
        deadlineAt: null,
        attachFailures: 0,
        promptFailures: 0,
      },
    });
  });

  it('keeps a model-less command model-less through acceptance, activity, and completion', () => {
    const record = createSessionMessageRecord({ turn: commandTurn, agent: { mode: 'code' } });
    const accepted = acceptQueuedMessage(boundAggregate([record]), commandTurn.messageId, 10);
    if (!accepted) throw new Error('Expected the command to be accepted');
    const active = recordAcceptedMessageActivity(accepted.messages, 20);
    if (!active) throw new Error('Expected accepted activity to update');
    const completed = applyMessageOutcome(
      { ...accepted, messages: active },
      { messageId: commandTurn.messageId, status: 'completed' },
      'runtime',
      30
    );

    // `lastActivityAt` is accepted-only; the terminal state retains the intent,
    // the acceptance time and the message's delivery identity (Amendment A).
    expect(completed?.messages).toEqual([
      {
        messageId: commandTurn.messageId,
        state: {
          kind: 'completed',
          intent: { turn: commandTurn, agent: { mode: 'code' } },
          acceptedAt: 10,
          at: 30,
          source: 'wrapper_outcome',
          wrapperInstanceId: 'runtime',
        },
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
    kind => {
      const message: SessionMessage =
        kind === 'queued'
          ? {
              ...promptRecord,
              state: queuedState({
                intent: promptRecord.state.intent,
                legacyInvalidIntent: undefined,
              }),
            }
          : {
              ...promptRecord,
              state: acceptedState({
                intent: promptRecord.state.intent,
                legacyInvalidIntent: undefined,
                acceptedAt: 20,
              }),
            };
      expect(
        matchesSessionMessageReplay(message, {
          turn: {
            attachments: { files: ['document.pdf', 'image.png'], path: 'attachment-path' },
            prompt: promptTurn.prompt,
            messageId: 'a',
            type: 'prompt',
          },
        })
      ).toBe(true);
    }
  );

  it.each(['anthropic/claude-sonnet-4', ' kilo/anthropic/claude-sonnet-4 '])(
    'accepts an equivalent explicit gateway alias %j',
    model => {
      expect(
        matchesSessionMessageReplay(promptRecord, { turn: promptTurn, agent: { model } })
      ).toBe(true);
      expect(promptRecord.state.intent?.agent.model).toBe(defaultAgent.model);
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
    kind => {
      for (const record of [
        { ...promptRecord, state: terminalState(kind) },
        {
          messageId: promptTurn.messageId,
          state: terminalState(kind, { legacy: { turn: promptTurn } }),
        },
        {
          messageId: promptTurn.messageId,
          state: terminalState(kind, { legacy: { prompt: promptTurn.prompt } }),
        },
      ] satisfies SessionMessage[]) {
        const original = structuredClone(record);
        expect(matchesSessionMessageReplay(record, { turn: promptTurn })).toBe(false);
        expect(record).toEqual(original);
      }
    }
  );

  it.each([promptTurn, commandTurn])(
    'checks legacy accepted $type content without inventing unknown selection',
    turn => {
      const record: SessionMessage = {
        messageId: turn.messageId,
        state: acceptedState({ legacy: { turn }, legacyInvalidIntent: undefined }),
      };
      expect(
        matchesSessionMessageReplay(record, { turn, agent: { model: 'openai/gpt-4.1' } })
      ).toBe(true);
      expect(record.state.intent).toBeNull();
      expect(record.state.kind).toBe('accepted');
    }
  );

  it('checks legacy prompt-only content without reconstructing a command', () => {
    const record: SessionMessage = {
      messageId: 'b',
      state: acceptedState({
        legacy: { prompt: '/review --all changes' },
        legacyInvalidIntent: undefined,
      }),
    };
    expect(
      matchesSessionMessageReplay(record, {
        turn: { type: 'prompt', messageId: 'b', prompt: '/review --all changes' },
      })
    ).toBe(true);
    expect(matchesSessionMessageReplay(record, { turn: commandTurn })).toBe(false);
    expect(record.state.intent).toBeNull();
  });
});

describe('freezeLegacyQueuedMessages', () => {
  // Tests seed RAW pre-cutover rows and drive the real legacy decoder, so the
  // unresolved (payload) / resolved (intent) / permanently invalid (marker)
  // tri-state is exercised end to end rather than hand-built canonical fixtures.
  function decodeLegacy(rows: readonly unknown[]): SessionMessage[] {
    const decoded = decodeSessionValue(rows);
    if (!decoded.ok) throw new Error(decoded.reason);
    return decoded.value.messages;
  }

  it('freezes decoded legacy queued rows against pre-update defaults without changing history', () => {
    const current = createSessionMessageRecord({
      turn: { type: 'prompt', messageId: 'current', prompt: 'new model' },
      agent: { mode: 'architect', model: 'kilo/openai/gpt-4.1' },
    });
    const history: SessionMessage[] = [
      {
        messageId: 'accepted',
        state: acceptedState({
          acceptedAt: 10,
          legacyInvalidIntent: undefined,
          legacy: { turn: { ...promptTurn, messageId: 'accepted' } },
        }),
      },
      {
        messageId: 'failed',
        state: terminalState('failed', {
          reason: 'prompt_exhausted',
          legacy: { prompt: 'failed' },
        }),
      },
    ];
    const decoded = decodeLegacy([
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
    ]);
    // The decoder yields unresolved rows: payload present, no invalid marker.
    expect(decoded[0]?.state).toMatchObject({
      kind: 'queued',
      intent: null,
      legacy: { turn: promptTurn, prompt: 'stale compatibility content' },
    });
    expect(decoded[0]?.state.legacyInvalidIntent).toBeUndefined();

    const messages: SessionMessage[] = [...decoded, current, ...history];
    const original = structuredClone(messages);
    const frozen = freezeLegacyQueuedMessages(messages, defaultAgent);

    expect(frozen.slice(0, 3)).toEqual([
      {
        messageId: promptTurn.messageId,
        state: queuedState({
          intent: { turn: promptTurn, agent: defaultAgent },
          legacyInvalidIntent: undefined,
          deliveryStep: 'preparing',
          attachFailures: 1,
          promptFailures: 2,
          preparationAttemptId: 'attempt-1',
        }),
      },
      createSessionMessageRecord({
        turn: commandTurn,
        agent: defaultAgent,
      }),
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
    const decoded = decodeLegacy([
      { messageId: commandTurn.messageId, state: 'queued', turn: commandTurn },
    ]);
    const frozen = freezeLegacyQueuedMessages(decoded);
    expect(frozen[0]?.state.intent).toEqual({ turn: commandTurn, agent: { mode: 'code' } });
    expect(freezeLegacyQueuedMessages(structuredClone(frozen), defaultAgent)).toEqual(frozen);
  });

  it.each([undefined, 'kilo/'])(
    'keeps legacy queued prompts fail-able and permanently invalid after a failed freeze (model %j)',
    model => {
      const decoded = decodeLegacy([
        { messageId: 'a', state: 'queued', turn: promptTurn },
        { messageId: 'old', state: 'queued', prompt: 'old prompt' },
      ]);
      const frozen = freezeLegacyQueuedMessages(decoded, { model });
      // A failed resolution marks the row permanently invalid and keeps the
      // legacy payload, so a later freeze with a valid model cannot promote it.
      expect(frozen[0]?.state).toMatchObject({
        intent: null,
        legacyInvalidIntent: true,
        legacy: { turn: promptTurn },
      });
      expect(getSessionMessageTurn(frozen[0]!)).toEqual(promptTurn);
      expect(matchesSessionMessageReplay(frozen[0]!, { turn: promptTurn })).toBe(false);
      // A later valid model still cannot resolve the marked row…
      expect(
        freezeLegacyQueuedMessages(structuredClone(frozen), defaultAgent)[0]?.state.intent
      ).toBeNull();
      // …but failing it is still possible.
      const failed = failQueuedMessage({ binding: { kind: 'unbound' }, messages: frozen }, 'a');
      expect(failed?.messages[0]).toMatchObject({
        messageId: 'a',
        state: {
          kind: 'failed',
          source: 'coordinator',
          intent: null,
          legacyInvalidIntent: true,
          legacy: { turn: promptTurn },
        },
      });
    }
  );

  it('keeps a pre-marked invalid row invalid even though it retains its payload', () => {
    const decoded = decodeLegacy([
      { messageId: 'poison', state: 'queued', prompt: 'do not run', legacyIntentInvalid: true },
    ]);
    // The marker wins over the payload: HEAD's failed freeze persisted exactly
    // this pair, so decoding must not drop the marker and let a later freeze
    // promote the row.
    expect(decoded[0]?.state).toMatchObject({
      intent: null,
      legacyInvalidIntent: true,
      legacy: { prompt: 'do not run' },
    });
    const frozen = freezeLegacyQueuedMessages(decoded, defaultAgent);
    expect(frozen[0]?.state.intent).toBeNull();
    expect(frozen[0]?.state.legacyInvalidIntent).toBe(true);
    expect(
      matchesSessionMessageReplay(frozen[0]!, {
        turn: { type: 'prompt', messageId: 'poison', prompt: 'do not run' },
      })
    ).toBe(false);
  });

  it('resolves a fresh unresolved row but never promotes a marked one', () => {
    const [row] = decodeLegacy([{ messageId: 'a', state: 'queued', turn: promptTurn }]);
    const resolved = freezeLegacyQueuedMessages([row!], defaultAgent);
    expect(resolved[0]?.state.intent).toEqual({ turn: promptTurn, agent: defaultAgent });
    const invalid = freezeLegacyQueuedMessages([row!], { model: undefined });
    expect(invalid[0]?.state).toMatchObject({ intent: null, legacyInvalidIntent: true });
  });

  it('does not invent missing turn content', () => {
    const frozen = freezeLegacyQueuedMessages([msg('missing', 'queued')], defaultAgent);
    expect(frozen).toEqual([msg('missing', 'queued')]);
  });

  it('preserves unversioned intents and freezes legacy finalization before defaults change', () => {
    const existing: SessionMessage = {
      messageId: commandTurn.messageId,
      state: queuedState({
        intent: {
          turn: commandTurn,
          agent: { mode: 'reviewer' },
          finalization: { autoCommit: false },
        },
        legacyInvalidIntent: undefined,
      }),
    };
    const decoded = decodeLegacy([
      {
        messageId: promptTurn.messageId,
        state: 'queued',
        turn: promptTurn,
        finalization: { condenseOnComplete: false },
      },
    ]);
    const frozen = freezeLegacyQueuedMessages([existing, ...decoded], defaultAgent, {
      autoCommit: false,
      condenseOnComplete: true,
    });
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

  it('returns the queued follow-up even while another message is accepted', () => {
    expect(nextQueuedMessageId([msg('a', 'accepted'), msg('b', 'queued')])).toBe('b');
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
    const messages = [queuedWith('a', { preparationAttemptId: 'attempt-1' })];

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
      queuedWith('b', { preparationAttemptId: 'attempt-1' }),
    ]);
  });
});

describe('releaseCompletedRetryableAttach', () => {
  const authorization: SessionOperationAuthorization = {
    operation: 'session.attach',
    operationId: 'attach-a',
    messageId: 'a',
    session: { sessionId: SESSION_ID, kiloSessionId: 'kilo_root', directory: DIRECTORY },
    wrapperInstanceId: RUNTIME_ID,
    dispatchDeadlineAt: 100,
  };
  const failedResult = {
    ok: false as const,
    error: { code: 'not_ready', message: 'Wrapper is not ready', retryable: true },
  };

  it('retires the failed attach proof before retrying', () => {
    const attach = { authorization, dispatched: true, result: failedResult };
    const messages: SessionMessage[] = [
      {
        messageId: 'a',
        state: queuedState({
          intent: { turn: promptTurn, agent: defaultAgent },
          legacyInvalidIntent: undefined,
          unresolvedDispatch: true,
          preparationAttemptId: authorization.operationId,
        }),
        proofs: { attach },
      },
    ];

    const released = releaseCompletedRetryableAttach(messages, 'a', 200);

    expect(released[0]).toMatchObject({
      state: { kind: 'queued', retryNotBefore: 200 },
      proofs: { retiredAttach: attach },
    });
    expect(released[0]?.state).not.toHaveProperty('unresolvedDispatch');
    expect(released[0]?.state).not.toHaveProperty('preparationAttemptId');
    expect(released[0]?.proofs?.attach).toBeUndefined();
  });

  it('applies a duplicate result to a retired attach proof without restoring it', () => {
    const completedAt = 200;
    const delivery: SessionOperationDelivery = {
      version: 2,
      authorization,
      completedAt,
      result: failedResult,
      events: [],
      preparing: [],
    };
    const messages: SessionMessage[] = [
      {
        messageId: 'a',
        state: queuedState({
          intent: { turn: promptTurn, agent: defaultAgent },
          legacyInvalidIntent: undefined,
          wrapperInstanceId: RUNTIME_ID,
        }),
        proofs: {
          retiredAttach: {
            authorization,
            dispatched: true,
            result: failedResult,
            resultHash: 'result-hash',
            completedAt,
            decision: { state: 'queued', at: completedAt },
          },
        },
      },
    ];

    const applied = applySessionOperationResult(
      { binding: { kind: 'unbound' }, messages },
      delivery,
      'result-hash',
      completedAt + 1
    );

    expect(applied).toMatchObject({ disposition: 'identical' });
    expect(applied?.messages[0]?.proofs?.attach).toBeUndefined();
    expect(applied?.messages[0]?.proofs?.retiredAttach).toMatchObject({ authorization });
  });
});

describe('markSessionOperationRejection', () => {
  const authorization: SessionOperationAuthorization = {
    operation: 'session.attach',
    operationId: 'attach-a',
    messageId: 'a',
    session: { sessionId: SESSION_ID, kiloSessionId: 'kilo_root', directory: DIRECTORY },
    wrapperInstanceId: RUNTIME_ID,
    dispatchDeadlineAt: 100,
  };
  const message = (proof: SessionOperationProof): SessionMessage => ({
    messageId: 'a',
    state: queuedState({ wrapperInstanceId: RUNTIME_ID }),
    proofs: { attach: proof },
  });

  it('records the git subtype from a confirmed attach rejection', () => {
    const marked = markSessionOperationRejection(
      [message({ authorization, dispatched: true })],
      authorization,
      'git_rate_limited'
    );

    expect(marked?.[0]?.proofs?.attach).toMatchObject({
      rejectionReceived: true,
      rejectionSubtype: 'git_rate_limited',
    });
  });

  it('records a later subtype even when the rejection was already counted', () => {
    const marked = markSessionOperationRejection(
      [message({ authorization, dispatched: true, rejectionReceived: true })],
      authorization,
      'git_clone_timeout'
    );

    expect(marked?.[0]?.proofs?.attach).toMatchObject({
      rejectionReceived: true,
      rejectionSubtype: 'git_clone_timeout',
    });
  });

  it('leaves an already-counted rejection without a subtype unchanged', () => {
    const before = [message({ authorization, dispatched: true, rejectionReceived: true })];
    expect(markSessionOperationRejection(before, authorization)).toEqual(before);
  });
});

describe('releaseUnconfirmedAttach', () => {
  const authorization: SessionOperationAuthorization = {
    operation: 'session.attach',
    operationId: 'attempt-missing',
    messageId: 'a',
    session: { sessionId: SESSION_ID, kiloSessionId: 'kilo_root', directory: DIRECTORY },
    wrapperInstanceId: RUNTIME_ID,
    dispatchDeadlineAt: 100,
  };

  function queuedMessage(
    attach: SessionOperationProof | undefined,
    state: Partial<QueuedMessageState> = {}
  ): SessionMessage {
    return {
      messageId: 'a',
      state: queuedState({
        intent: { turn: promptTurn, agent: defaultAgent },
        legacyInvalidIntent: undefined,
        unresolvedDispatch: true,
        wrapperInstanceId: RUNTIME_ID,
        ...state,
      }),
      ...(attach ? { proofs: { attach } } : {}),
    };
  }

  it('retires a dispatched attach the runtime has no record of', () => {
    const attach = { authorization, dispatched: true };
    const released = releaseUnconfirmedAttach(
      [queuedMessage(attach, { preparationAttemptId: 'attempt-missing', deadlineAt: 500 })],
      authorization
    );

    expect(released?.[0]).toMatchObject({
      state: {
        kind: 'queued',
        wrapperInstanceId: RUNTIME_ID,
        preparationAttemptId: 'attempt-missing',
        deadlineAt: 500,
      },
      proofs: { retiredAttach: attach },
    });
    expect(released?.[0]?.state).not.toHaveProperty('unresolvedDispatch');
    expect(released?.[0]?.proofs?.attach).toBeUndefined();
  });

  it('keeps the retired attach epoch when the replacement proof has none', () => {
    const message = queuedMessage({ authorization, dispatched: true });
    if (!message.proofs) throw new Error('Missing attach proof');
    const released = releaseUnconfirmedAttach(
      [
        {
          ...message,
          proofs: {
            ...message.proofs,
            retiredAttach: {
              authorization,
              dispatched: true,
              completedAt: 400,
              attachmentEpoch: 3,
            },
          },
        },
      ],
      authorization
    );

    // The dispatched attach carries no epoch until its result arrives, so the
    // overwritten slot would drop the watermark the fence holds.
    expect(released?.[0]?.proofs?.retiredAttach).toMatchObject({ attachmentEpoch: 3 });
  });

  it('refuses a message id that is not in the messages array', () => {
    expect(releaseUnconfirmedAttach([], authorization)).toBeUndefined();
  });

  it('refuses a present message with no attach proof', () => {
    expect(releaseUnconfirmedAttach([queuedMessage(undefined)], authorization)).toBeUndefined();
  });

  it.each([
    {
      name: 'a completed attach result',
      attach: {
        authorization,
        dispatched: true,
        result: { ok: false as const, error: { code: 'not_ready', message: 'x', retryable: true } },
      },
    },
    {
      name: 'an undispatched attach proof',
      attach: { authorization, dispatched: false },
    },
    {
      name: 'an attach proof for another wrapper',
      attach: {
        authorization: {
          ...authorization,
          wrapperInstanceId: '44444444-4444-4444-8444-444444444444',
        },
        dispatched: true,
      },
    },
  ])('refuses to release $name', ({ attach }) => {
    expect(releaseUnconfirmedAttach([queuedMessage(attach)], authorization)).toBeUndefined();
  });
});

describe('rotateLostPreparationAttempt', () => {
  const attachAuthorization: SessionOperationAuthorization = {
    operation: 'session.attach',
    operationId: 'attempt-old',
    messageId: 'a',
    session: { sessionId: SESSION_ID, kiloSessionId: 'kilo_root', directory: DIRECTORY },
    wrapperInstanceId: RUNTIME_ID,
    dispatchDeadlineAt: 100,
  };
  const promptAuthorization: SessionOperationAuthorization = {
    ...attachAuthorization,
    operation: 'session.prompt',
    operationId: 'a',
  };

  function queuedMessage(): SessionMessage {
    return {
      messageId: 'a',
      state: queuedState({
        intent: { turn: promptTurn, agent: defaultAgent },
        legacyInvalidIntent: undefined,
        deadlineAt: 500,
        deliveryRetryScope: 'runtime',
        preparationAttemptId: 'attempt-old',
        attachFailures: 1,
        promptFailures: 2,
      }),
      proofs: {
        attach: { authorization: attachAuthorization, dispatched: false },
        prompt: { authorization: promptAuthorization, dispatched: false },
        retiredAttach: { authorization: attachAuthorization, dispatched: true },
      },
    };
  }

  it('clears stale preparation state and definitively unadmitted operation proofs', () => {
    const message = queuedMessage();

    const rotated = rotateLostPreparationAttempt([message], 'a', 200);

    expect(rotated?.[0]).toMatchObject({
      state: {
        kind: 'queued',
        retryNotBefore: 200,
        deadlineAt: 500,
        attachFailures: 1,
        promptFailures: 2,
      },
      proofs: { retiredAttach: message.proofs?.retiredAttach },
    });
    expect(rotated?.[0]?.state).not.toHaveProperty('preparationAttemptId');
    expect(rotated?.[0]?.state).not.toHaveProperty('deliveryRetryScope');
    expect(rotated?.[0]?.proofs?.attach).toBeUndefined();
    expect(rotated?.[0]?.proofs?.prompt).toBeUndefined();
  });

  it.each([
    {
      name: 'a dispatched attach proof',
      update: (message: SessionMessage) => ({
        ...message,
        proofs: {
          ...message.proofs,
          attach: { authorization: attachAuthorization, dispatched: true },
        },
      }),
    },
    {
      name: 'a dispatched prompt proof',
      update: (message: SessionMessage) => ({
        ...message,
        proofs: {
          ...message.proofs,
          prompt: { authorization: promptAuthorization, dispatched: true },
        },
      }),
    },
    {
      name: 'an unresolved dispatch',
      update: (message: SessionMessage) => ({
        ...message,
        state: { ...message.state, unresolvedDispatch: true as const },
      }),
    },
    {
      name: 'a non-queued message',
      update: (message: SessionMessage) => ({
        ...message,
        state: acceptedState({
          intent: { turn: promptTurn, agent: defaultAgent },
          legacyInvalidIntent: undefined,
          acceptedAt: 0,
        }),
      }),
    },
  ])('refuses rotation when there is $name', ({ update }) => {
    expect(rotateLostPreparationAttempt([update(queuedMessage())], 'a', 200)).toBeUndefined();
  });
});

describe('noOutputRecoveryAllowed', () => {
  it('allows exactly one no-output recovery per accepted turn', () => {
    expect(noOutputRecoveryAllowed(0)).toBe(true);
    expect(noOutputRecoveryAllowed(1)).toBe(false);
    expect(noOutputRecoveryAllowed(2)).toBe(false);
  });
});

describe('redispatchAcceptedMessage', () => {
  const promptAuthorization: SessionOperationAuthorization = {
    operation: 'session.prompt',
    operationId: 'prompt-a',
    messageId: promptTurn.messageId,
    session: { sessionId: SESSION_ID, kiloSessionId: 'kilo_root', directory: DIRECTORY },
    wrapperInstanceId: RUNTIME_ID,
    dispatchDeadlineAt: 100,
  };

  function acceptedMessage(): SessionMessage {
    return {
      messageId: promptTurn.messageId,
      state: acceptedState({
        intent: { turn: promptTurn, agent: { ...defaultAgent } },
        legacyInvalidIntent: undefined,
        acceptedAt: 10,
        lastActivityAt: 20,
        wrapperInstanceId: RUNTIME_ID,
        preparationAttemptId: 'attempt-1',
        executionDeadlineAt: 900,
      }),
      proofs: {
        attach: {
          authorization: { ...promptAuthorization, operation: 'session.attach' },
          dispatched: true,
        },
        prompt: { authorization: promptAuthorization, dispatched: true },
      },
    };
  }

  it('re-queues only the accepted turn, spends one recovery, and clears its dispatch state', () => {
    const accepted = acceptedMessage();
    const queued = msg('b', 'queued');
    const messages = [accepted, queued];

    const next = redispatchAcceptedMessage(messages, promptTurn.messageId);

    expect(next?.[0]).toStrictEqual({
      messageId: promptTurn.messageId,
      state: {
        kind: 'queued',
        intent: { turn: promptTurn, agent: { ...defaultAgent } },
        deliveryStep: 'waiting',
        deadlineAt: null,
        attachFailures: 0,
        promptFailures: 0,
        recoveryAttempts: 1,
      },
    });
    // The typed turn survives the recovery under its durable identity, and the
    // array is rebuilt instead of mutating the caller's records.
    expect(next?.[0]?.state.intent).toStrictEqual(accepted.state.intent);
    expect(next?.[1]).toBe(queued);
    expect(messages[0]).toBe(accepted);
  });

  it('accumulates the recovery count for the next accepted state', () => {
    const first = redispatchAcceptedMessage([acceptedMessage()], promptTurn.messageId) ?? [];
    expect(first[0]?.state.recoveryAttempts).toBe(1);
    // A queued record is not accepted any more, so a replayed detection cannot
    // spend a second recovery on it.
    expect(redispatchAcceptedMessage(first, promptTurn.messageId)).toBeUndefined();
    const acceptedAgain: SessionMessage = {
      messageId: promptTurn.messageId,
      state: acceptedState({
        intent: { turn: promptTurn, agent: { ...defaultAgent } },
        legacyInvalidIntent: undefined,
        acceptedAt: 50,
        lastActivityAt: 60,
        wrapperInstanceId: RUNTIME_ID,
        executionDeadlineAt: 900,
        recoveryAttempts: 1,
      }),
    };
    expect(
      redispatchAcceptedMessage([acceptedAgain], promptTurn.messageId)?.[0]?.state.recoveryAttempts
    ).toBe(2);
  });

  it('returns undefined for a missing or non-accepted record', () => {
    expect(redispatchAcceptedMessage([acceptedMessage()], 'missing')).toBeUndefined();
    expect(redispatchAcceptedMessage([msg('a', 'queued')], 'a')).toBeUndefined();
    expect(redispatchAcceptedMessage([msg('a', 'failed')], 'a')).toBeUndefined();
  });
});

describe('failedMessageSnapshot', () => {
  it('records the attempt count once a no-output recovery was spent', () => {
    const record: SessionMessage = {
      messageId: promptTurn.messageId,
      state: terminalState('failed', {
        intent: { turn: promptTurn, agent: { ...defaultAgent } },
        legacyInvalidIntent: undefined,
        acceptedAt: 10,
        recoveryAttempts: 1,
        reason: 'accepted_overdue',
        detail: 'Turn did not complete',
      }),
    };

    expect(failedMessageSnapshot(record, 99)).toMatchObject({
      attempts: 2,
      reason: 'accepted_overdue',
      status: 'failed',
    });
  });

  it('omits the attempt count when the turn never spent a recovery', () => {
    const record: SessionMessage = {
      messageId: promptTurn.messageId,
      state: terminalState('failed', {
        intent: { turn: promptTurn, agent: { ...defaultAgent } },
        legacyInvalidIntent: undefined,
        reason: 'preparation_failed',
      }),
    };

    expect(failedMessageSnapshot(record, 99)).not.toHaveProperty('attempts');
  });
});

describe('applyMessageOutcome', () => {
  it('settles only the message identified by the matching runtime', () => {
    const before: SessionMessage[] = [
      acceptedWith('a', { acceptedAt: 0, wrapperInstanceId: 'runtime' }),
      msg('b', 'queued'),
    ];
    const next = applyMessageOutcome(
      boundAggregate(before),
      { messageId: 'a', status: 'completed' },
      'runtime',
      30
    );
    expect(next?.messages.map(message => [message.messageId, message.state.kind])).toEqual([
      ['a', 'completed'],
      ['b', 'queued'],
    ]);
    expect(hasAcceptedMessage(next?.messages ?? [])).toBe(false);
    expect(
      applyMessageOutcome(
        boundAggregate(before),
        { messageId: 'a', status: 'completed' },
        'old-runtime',
        30
      )
    ).toBeUndefined();
    expect(
      applyMessageOutcome(
        next ?? boundAggregate([]),
        { messageId: 'a', status: 'failed' },
        'runtime',
        40
      )
    ).toBeUndefined();
  });

  it('persists a gate result on the terminal record when the outcome carries one', () => {
    const before = [acceptedWith('a', { acceptedAt: 0, wrapperInstanceId: 'runtime' })];
    const next = applyMessageOutcome(
      boundAggregate(before),
      { messageId: 'a', status: 'completed', gateResult: 'fail' },
      'runtime',
      30
    );
    expect(next?.messages.find(message => message.messageId === 'a')).toMatchObject({
      state: { kind: 'completed', gateResult: 'fail' },
    });
  });

  it('leaves the gate result key absent when the outcome carries none', () => {
    const before = [acceptedWith('a', { acceptedAt: 0, wrapperInstanceId: 'runtime' })];
    const next = applyMessageOutcome(
      boundAggregate(before),
      { messageId: 'a', status: 'completed' },
      'runtime',
      30
    );
    const message = next?.messages.find(item => item.messageId === 'a');
    expect(message).toBeDefined();
    expect(message?.state).not.toHaveProperty('gateResult');
  });

  it('persists bounded assistant facts on the failed state when the outcome carries them', () => {
    const before = [acceptedWith('a', { acceptedAt: 0, wrapperInstanceId: 'runtime' })];
    const next = applyMessageOutcome(
      boundAggregate(before),
      {
        messageId: 'a',
        status: 'failed',
        assistantReason: 'rate_limited',
        providerOwnership: 'unknown',
      },
      'runtime',
      30
    );
    expect(next?.messages.find(message => message.messageId === 'a')).toMatchObject({
      state: { kind: 'failed', assistantReason: 'rate_limited', providerOwnership: 'unknown' },
    });
  });

  it('leaves the assistant fact keys absent when the failed outcome carries none', () => {
    const before = [acceptedWith('a', { acceptedAt: 0, wrapperInstanceId: 'runtime' })];
    const next = applyMessageOutcome(
      boundAggregate(before),
      { messageId: 'a', status: 'failed' },
      'runtime',
      30
    );
    const message = next?.messages.find(item => item.messageId === 'a');
    expect(message).toBeDefined();
    expect(message?.state).not.toHaveProperty('assistantReason');
    expect(message?.state).not.toHaveProperty('providerOwnership');
  });

  it.each(['completed', 'cancelled'] as const)(
    'stores no assistant facts on a %s outcome that carries them',
    status => {
      const before = [acceptedWith('a', { acceptedAt: 0, wrapperInstanceId: 'runtime' })];
      const next = applyMessageOutcome(
        boundAggregate(before),
        {
          messageId: 'a',
          status,
          assistantReason: 'rate_limited',
          providerOwnership: 'unknown',
        },
        'runtime',
        30
      );
      const message = next?.messages.find(item => item.messageId === 'a');
      expect(message?.state.kind).toBe(status);
      expect(message?.state).not.toHaveProperty('assistantReason');
      expect(message?.state).not.toHaveProperty('providerOwnership');
    }
  );
});

describe('failQueuedMessage', () => {
  it('fails only the matching queued message', () => {
    const next = failQueuedMessage(
      { binding: { kind: 'unbound' }, messages: [msg('a', 'queued'), msg('b', 'queued')] },
      'a'
    );
    expect(next?.messages.map(message => [message.messageId, message.state.kind])).toEqual([
      ['a', 'failed'],
      ['b', 'queued'],
    ]);
  });

  it('does not change an already terminal message', () => {
    expect(
      failQueuedMessage({ binding: { kind: 'unbound' }, messages: [msg('a', 'completed')] }, 'a')
    ).toBeUndefined();
    expect(
      failQueuedMessage({ binding: { kind: 'unbound' }, messages: [msg('a', 'accepted')] }, 'a')
    ).toBeUndefined();
  });

  it('refuses a non-head queued message', () => {
    // Only the queue head may be failed; a follower is still deliverable later.
    expect(
      failQueuedMessage(
        { binding: { kind: 'unbound' }, messages: [msg('a', 'queued'), msg('b', 'queued')] },
        'b'
      )
    ).toBeUndefined();
  });

  it('retains a bounded terminal detail for public projections', () => {
    const failed = failQueuedMessage(
      { binding: { kind: 'unbound' }, messages: [msg('a', 'queued')] },
      'a',
      'attach_exhausted',
      'Repository checkout failed: output: requested review ref was not found'
    );
    expect(failed?.messages[0]).toMatchObject({
      state: {
        kind: 'failed',
        reason: 'attach_exhausted',
        detail: 'Repository checkout failed: output: requested review ref was not found',
      },
    });
    expect(streamQueuedSnapshots(failed?.messages ?? [], 20)).toMatchObject([
      {
        terminalFailure: {
          error: 'Repository checkout failed: output: requested review ref was not found',
        },
      },
    ]);
  });
});

describe('failAcceptedMessage', () => {
  it('fails only the matching accepted message', () => {
    const next = failAcceptedMessage(
      {
        binding: { kind: 'unbound' },
        messages: [msg('a', 'accepted'), msg('b', 'queued')],
      },
      'a',
      'accepted_overdue',
      'Turn did not complete'
    );
    expect(next?.messages[0]).toMatchObject({
      state: { kind: 'failed', reason: 'accepted_overdue', detail: 'Turn did not complete' },
    });
    expect(next?.messages[1]).toEqual(msg('b', 'queued'));
  });

  it('does not change a queued or already terminal message', () => {
    expect(
      failAcceptedMessage({ binding: { kind: 'unbound' }, messages: [msg('a', 'queued')] }, 'a')
    ).toBeUndefined();
    expect(
      failAcceptedMessage({ binding: { kind: 'unbound' }, messages: [msg('a', 'completed')] }, 'a')
    ).toBeUndefined();
    expect(
      failAcceptedMessage({ binding: { kind: 'unbound' }, messages: [msg('a', 'cancelled')] }, 'a')
    ).toBeUndefined();
  });
});

describe('acceptQueuedMessage', () => {
  it('refuses ACCEPT on an unbound aggregate instead of inventing a binding', () => {
    // Acceptance requires a bound aggregate; the adapter must refuse rather than
    // fabricate a binding to make the head accepted.
    expect(
      acceptQueuedMessage({ binding: { kind: 'unbound' }, messages: [msg('a', 'queued')] }, 'a', 10)
    ).toBeUndefined();
  });

  it('accepts only the next queued message', () => {
    const accepted = acceptQueuedMessage(
      boundAggregate([msg('a', 'queued'), msg('b', 'queued')]),
      'a',
      10
    );
    expect(accepted?.messages.map(message => [message.messageId, message.state.kind])).toEqual([
      ['a', 'accepted'],
      ['b', 'queued'],
    ]);
    expect(accepted?.messages.find(message => message.messageId === 'a')).toEqual({
      messageId: 'a',
      state: {
        kind: 'accepted',
        intent: null,
        legacyInvalidIntent: true,
        acceptedAt: 10,
        lastActivityAt: 10,
        wrapperInstanceId: 'runtime',
        executionDeadlineAt: 10 + POLICY.acceptedExecutionBoundMs,
        capAt: 10 + POLICY.acceptedRecheckMs,
      },
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
    const messages: SessionMessage[] = [
      { messageId: prompt.messageId, state: queuedState({ legacy: { turn: prompt } }) },
      { messageId: command.messageId, state: queuedState({ legacy: { turn: command } }) },
      {
        messageId: prompt.messageId,
        state: queuedState({
          intent: {
            turn: prompt,
            agent: { mode: 'debug', model: 'attachment-model', variant: 'focused' },
            finalization: { autoCommit: false, condenseOnComplete: true },
          },
          legacyInvalidIntent: undefined,
        }),
      },
      {
        messageId: command.messageId,
        state: queuedState({
          intent: {
            turn: command,
            agent: { mode: 'plan', model: 'command-model' },
            finalization: { autoCommit: true, condenseOnComplete: false },
          },
          legacyInvalidIntent: undefined,
        }),
      },
    ];

    for (const message of messages) {
      expect(
        acceptQueuedMessage(boundAggregate([message]), message.messageId, 10)?.messages[0]
      ).toEqual({
        ...message,
        state: {
          kind: 'accepted',
          ...(message.state.intent !== null
            ? { intent: message.state.intent }
            : { intent: null, legacyInvalidIntent: true, legacy: message.state.legacy }),
          acceptedAt: 10,
          lastActivityAt: 10,
          wrapperInstanceId: 'runtime',
          executionDeadlineAt: 10 + POLICY.acceptedExecutionBoundMs,
          capAt: 10 + POLICY.acceptedRecheckMs,
        },
      });
    }
  });

  it('does not resurrect a cancelled message after interrupt', () => {
    expect(
      acceptQueuedMessage(boundAggregate([msg('a', 'cancelled'), msg('b', 'queued')]), 'a', 10)
    ).toBeUndefined();
  });

  it('accepts a queued follow-up while another message is accepted', () => {
    const accepted = acceptQueuedMessage(
      boundAggregate([msg('a', 'accepted'), msg('b', 'queued')]),
      'b',
      10
    );
    expect(accepted?.messages.find(message => message.messageId === 'b')?.state.kind).toBe(
      'accepted'
    );
  });
});

describe('recordAcceptedMessageActivity', () => {
  it('updates only the accepted message activity timestamp', () => {
    const messages: SessionMessage[] = [
      acceptedWith('a', { acceptedAt: 10, lastActivityAt: 20 }),
      msg('b', 'queued'),
      msg('c', 'completed'),
    ];
    expect(recordAcceptedMessageActivity(messages, 30)).toEqual([
      acceptedWith('a', { acceptedAt: 10, lastActivityAt: 30 }),
      msg('b', 'queued'),
      msg('c', 'completed'),
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
    const queuedPrompt = createSessionMessageRecord({ turn: promptTurn, agent: defaultAgent });
    const prompt: SessionMessage = {
      messageId: promptTurn.messageId,
      state: acceptedState({
        intent: queuedPrompt.state.intent,
        legacyInvalidIntent: undefined,
        acceptedAt: 20,
        legacy: { prompt: 'stale compatibility prompt' },
      }),
    };
    const queuedCommand = createSessionMessageRecord({
      turn: commandTurn,
      agent: { mode: 'code' },
    });
    const command: SessionMessage = {
      ...queuedCommand,
      state: {
        ...queuedCommand.state,
        legacy: {
          turn: { type: 'prompt', messageId: commandTurn.messageId, prompt: 'stale turn' },
          prompt: 'stale prompt',
        },
      },
    };
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
          {
            messageId: promptTurn.messageId,
            state: terminalState('failed', {
              intent: record.state.intent,
              legacyInvalidIntent: undefined,
              acceptedAt: 20,
              reason: 'prompt_exhausted',
            }),
          },
          { ...record, state: terminalState('completed') },
          { ...record, state: terminalState('cancelled') },
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
          error: 'prompt_exhausted',
          timestamp: 20,
        },
      },
    ]);
  });

  it('marks accepted legacy prompts as sent without changing genuinely queued snapshots', () => {
    expect(
      streamQueuedSnapshots(
        [
          queuedWith('a', { legacy: { prompt: 'hello' } }),
          acceptedWith('b', { acceptedAt: 20, legacy: { prompt: 'world' } }),
          { messageId: 'c', state: terminalState('completed', { legacy: { prompt: 'done' } }) },
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
          acceptedWith('a', {
            acceptedAt: 20,
            legacy: { turn: { type: 'prompt', messageId: 'a', prompt: 'hello' } },
          }),
          queuedWith('b', {
            legacy: {
              turn: { type: 'command', messageId: 'b', command: 'review', arguments: '--all' },
            },
          }),
          queuedWith('c', {
            legacy: {
              turn: { type: 'command', messageId: 'c', command: 'status', arguments: '' },
            },
          }),
          queuedWith('command', {
            intent: {
              turn: {
                type: 'command',
                messageId: 'command',
                command: 'compact',
                arguments: '--aggressive',
              },
              agent: { mode: 'plan', model: 'override-model' },
            },
            legacyInvalidIntent: undefined,
          }),
          queuedWith('attachment', {
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
            legacyInvalidIntent: undefined,
          }),
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
          acceptedWith('prompt', {
            acceptedAt: 50,
            intent: {
              turn: { type: 'prompt', messageId: 'prompt', prompt: 'canonical text' },
              agent: { mode: 'code', model: 'selected-model' },
            },
            legacyInvalidIntent: undefined,
            legacy: {
              prompt: 'stale compatibility text',
              turn: { type: 'prompt', messageId: 'prompt', prompt: 'stale upstream text' },
            },
          }),
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
            state: terminalState('failed', {
              reason: 'preparation_failed',
              legacy: { prompt: 'never sent' },
            }),
          },
          {
            messageId: 'accepted_failure',
            state: terminalState('failed', {
              reason: 'wrapper_failed',
              acceptedAt: 20,
              legacy: { prompt: 'already sent' },
            }),
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
          error: 'preparation_failed',
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
          error: 'wrapper_failed',
          timestamp: 20,
        },
      },
    ]);
  });
});

const fixtureDeps: SessionFixtureDeps = {
  eventQueries: orchestrationMocks.eventQueries,
  signedAttachments: orchestrationMocks.signedAttachments,
};

function sessionFixture(
  overrides: Partial<SessionMetadata> = {},
  sharedControl?: Control,
  callbackQueue?: Pick<Queue<CallbackJob>, 'send'>
) {
  return createSessionFixture(fixtureDeps, overrides, sharedControl, callbackQueue);
}

/** Rebuild the stored canonical envelope with one message replaced (test-only). */
function updateStoredMessage(
  fixture: ReturnType<typeof sessionFixture>,
  messageId: string,
  update: (message: SessionMessage) => SessionMessage
): void {
  const stored = readSessionValueSync<{ messages?: SessionMessage[] }>(fixture.storage.kv);
  writeSessionValueSync(fixture.storage.kv, {
    ...stored,
    messages: (stored?.messages ?? []).map(message =>
      message.messageId === messageId ? update(message) : message
    ),
  });
}

/** Land a Stop marker on a stored accepted turn without going through the DO. */
function markStoredCancellation(
  fixture: ReturnType<typeof sessionFixture>,
  messageId: string
): void {
  updateStoredMessage(fixture, messageId, message => ({
    ...message,
    cancellation: { operationId: 'stop_1', deadlineAt: Date.now() + 60_000 },
  }));
}

/**
 * Mark the accepted turn as having already spent its one automatic no-output
 * recovery, so the next inactivity detection is the second identical detection
 * and reaches the existing terminal path. The recovery itself is driven by the
 * accepted-inactivity tests plus `test/integration/sandbox-session-no-output-recovery.test.ts`
 * and the `redispatchAcceptedMessage` unit tests.
 */
function markNoOutputRecoverySpent(
  fixture: ReturnType<typeof sessionFixture>,
  messageId: string
): void {
  const stored = readSessionValueSync<{ messages?: SessionMessage[] }>(fixture.storage.kv);
  const accepted = (stored?.messages ?? []).some(
    message => message.messageId === messageId && message.state.kind === 'accepted'
  );
  if (!accepted) throw new Error(`No accepted message ${messageId} to recover`);
  updateStoredMessage(fixture, messageId, message => ({
    ...message,
    state: { ...message.state, recoveryAttempts: 1 },
  }));
}

function controlDiagnostics(
  fields: { mock: { calls: Parameters<typeof logger.withFields>[] } },
  diagnosticEvent: string
): Record<string, unknown>[] {
  return fields.mock.calls
    .map(call => call[0] as Record<string, unknown>)
    .filter(call => call.diagnosticEvent === diagnosticEvent);
}

function captureCloudAgentReports(
  fixture: ReturnType<typeof sessionFixture>
): CloudAgentQueueReport[] {
  const reports: CloudAgentQueueReport[] = [];
  (
    fixture.env as unknown as { CLOUD_AGENT_REPORT_QUEUE: { send: unknown } }
  ).CLOUD_AGENT_REPORT_QUEUE = {
    send: async (report: CloudAgentQueueReport) => {
      reports.push(report);
    },
  };
  return reports;
}

function failedRunReport(
  reports: readonly CloudAgentQueueReport[],
  messageId: string
): CloudAgentQueueReport['run'] | undefined {
  return reports.find(
    report => report.run.messageId === messageId && report.run.status === 'failed'
  )?.run;
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

function connectionFence(connectionId: string): Extract<RuntimeProxyFence, { plane: 'control' }> {
  return {
    plane: 'control',
    allocationId: 'allocation_1',
    providerInstanceId: 'provider_1',
    connectionId,
    wrapperInstanceId: RUNTIME_ID,
  };
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

  it('persists and sends a terminal callback after a completed outcome', async () => {
    const send = vi.fn(async (_job: CallbackJob) => ({}) as QueueSendResponse);
    const fixture = sessionFixture(
      { callback: { target: { url: 'https://example.com/callback' } } },
      undefined,
      { send }
    );

    await fixture.admit('callback_message');
    await fixture.flush();
    await fixture.outcome('callback_message', 'completed');
    await fixture.flush();

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { url: 'https://example.com/callback' },
        payload: expect.objectContaining({
          sessionId: SESSION_ID,
          cloudAgentSessionId: SESSION_ID,
          messageId: 'callback_message',
          status: 'completed',
          idempotencyKey: 'callback_message',
        }),
      })
    );
    expect(fixture.alarmAt()).toBe(Date.now());
  });

  it('sends one terminal callback for a drained batch naming the last admitted message', async () => {
    const send = vi.fn(async (_job: CallbackJob) => ({}) as QueueSendResponse);
    const fixture = sessionFixture(
      { callback: { target: { url: 'https://example.com/callback' } } },
      undefined,
      { send }
    );

    await fixture.admit('a');
    await fixture.flush();
    await fixture.admit('b');
    await fixture.flush();
    await fixture.admit('c');
    await fixture.flush();
    expect(fixture.record('a')?.state.kind).toBe('accepted');
    expect(fixture.record('b')?.state.kind).toBe('accepted');
    expect(fixture.record('c')?.state.kind).toBe('accepted');

    await fixture.outcome('a', 'completed');
    await fixture.flush();
    expect(send).toHaveBeenCalledTimes(0);

    await fixture.outcome('b', 'completed');
    await fixture.flush();
    expect(send).toHaveBeenCalledTimes(0);

    await fixture.outcome('c', 'completed');
    await fixture.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          messageId: 'c',
          executionId: 'c',
          idempotencyKey: 'c',
          status: 'completed',
        }),
      })
    );
  });

  it('counts callback-bearing outstanding messages against admission capacity', async () => {
    const fixture = sessionFixture({
      callback: { target: { url: 'https://example.com/callback' } },
    });
    writeMessages(
      fixture.storage.kv,
      Array.from({ length: PENDING_SESSION_MESSAGE_LIMIT }, (_, index) =>
        index === 0 ? acceptedWith(`existing_${index}`) : queuedWith(`existing_${index}`)
      )
    );

    await expect(fixture.admit('overflow')).resolves.toMatchObject({
      success: false,
      code: 'PENDING_QUEUE_FULL',
    });
    expect(readRawSessionMessages(fixture.values)).toHaveLength(PENDING_SESSION_MESSAGE_LIMIT);
  });

  it('arms callback repair after the outer operation-result transaction', async () => {
    const send = vi.fn(async (_job: CallbackJob) => ({}) as QueueSendResponse);
    const fixture = sessionFixture(
      { callback: { target: { url: 'https://example.com/callback' } } },
      undefined,
      { send }
    );
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      operationResults: true,
    });
    await fixture.admit('receipted_callback');
    await fixture.flush();
    const authorization = fixture.record('receipted_callback')?.proofs?.prompt?.authorization;
    if (!authorization) throw new Error('Missing prompt operation authorization');
    const event = receiptedEvent(1, {
      type: 'session.status',
      properties: { sessionID: 'kilo_root', status: { type: 'busy' } },
    });

    await expect(fixture.session.receiveSandboxControlEvent(event)).resolves.toEqual({
      applied: true,
    });
    await expect(
      fixture.session.receiveSandboxOperationResult({
        session: authorization.session,
        wrapperInstanceId: RUNTIME_ID,
        delivery: {
          version: 2,
          authorization,
          completedAt: Date.now(),
          result: { ok: true, result: { messageId: 'receipted_callback', status: 'accepted' } },
          outcome: { messageId: 'receipted_callback', status: 'completed' },
          events: [],
          preparing: [],
        },
      })
    ).resolves.toMatchObject({ disposition: 'applied' });
    await fixture.flush();

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          messageId: 'receipted_callback',
          status: 'completed',
        }),
      })
    );
    expect(fixture.alarmAt()).toBe(Date.now());
  });

  it('reports the named runtime gate with incoming, expected, and fence identities', async () => {
    const fixture = sessionFixture();
    const expectedWrapperInstanceId = RUNTIME_ID;
    const wrapperInstanceId = '44444444-4444-4444-8444-444444444444';
    const fenceNativeRuntimeId = NEXT_RUNTIME_ID;
    writeMessages(fixture.storage.kv, [
      {
        messageId: 'queued',
        state: queuedState({
          wrapperInstanceId: expectedWrapperInstanceId,
        }),
      },
    ]);
    fixture.storage.kv.put('native_runtime_fence', {
      sandboxId: SANDBOX_ID,
      wrapperInstanceId: expectedWrapperInstanceId,
      nativeRuntimeId: fenceNativeRuntimeId,
      attachmentEpoch: 1,
      authorization: {
        operation: 'session.attach',
        operationId: 'attempt_1',
        messageId: 'queued',
        session: { sessionId: SESSION_ID, kiloSessionId: 'kilo_root', directory: DIRECTORY },
        wrapperInstanceId: expectedWrapperInstanceId,
        dispatchDeadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS,
      },
    });
    const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
    try {
      const event = receiptedEvent(
        1,
        { type: 'session.updated', properties: { info: { id: 'kilo_root' } } },
        wrapperInstanceId,
        '55555555-5555-4555-8555-555555555555'
      );
      const before = structuredClone([...fixture.values]);
      await expect(fixture.session.receiveSandboxControlEvent(event)).resolves.toEqual({
        applied: false,
      });
      expect([...fixture.values]).toEqual(before);
      expect(fields).toHaveBeenCalledWith(
        expect.objectContaining({
          diagnosticEvent: 'session_event_result',
          disposition: 'runtime_mismatch',
          wrapperInstanceId,
          expectedWrapperInstanceId,
          nativeRuntimeId: '55555555-5555-4555-8555-555555555555',
          fenceWrapperInstanceId: expectedWrapperInstanceId,
          fenceNativeRuntimeId,
          receiptId: event.receiptId,
        })
      );
    } finally {
      fields.mockRestore();
    }
  });

  it('keeps an unreceipted outcome on the early publication path', async () => {
    const fixture = sessionFixture();
    writeMessages(fixture.storage.kv, [
      {
        messageId: 'queued',
        state: queuedState({
          wrapperInstanceId: RUNTIME_ID,
        }),
      },
    ]);
    const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
    try {
      const input = {
        identity: {
          directory: DIRECTORY,
          kiloSessionId: 'kilo_root',
          rootKiloSessionId: 'kilo_root',
        },
        wrapperInstanceId: NEXT_RUNTIME_ID,
        payload: {
          type: 'session.message.outcome',
          properties: { messageId: 'missing', status: 'completed' },
        },
      } as const;
      const before = structuredClone([...fixture.values]);
      await expect(fixture.session.receiveSandboxControlEvent(input)).resolves.toEqual({
        applied: false,
      });
      expect([...fixture.values]).toEqual(before);
      expect(fields).toHaveBeenCalledWith(
        expect.objectContaining({
          diagnosticEvent: 'session_event_result',
          disposition: 'message_missing',
        })
      );

      await expect(
        fixture.session.receiveSandboxControlEvent({
          ...input,
          identity: { ...input.identity, nativeRuntimeId: NEXT_RUNTIME_ID },
        })
      ).resolves.toEqual({ applied: false });
      expect(fields).toHaveBeenCalledWith(
        expect.objectContaining({
          diagnosticEvent: 'session_event_result',
          disposition: 'native_runtime_mismatch',
        })
      );
    } finally {
      fields.mockRestore();
    }
  });

  it('rejects an unreceipted remaining event from a stale wrapper', async () => {
    const fixture = sessionFixture();
    writeMessages(fixture.storage.kv, [
      {
        messageId: 'queued',
        state: queuedState({
          wrapperInstanceId: RUNTIME_ID,
        }),
      },
    ]);
    const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
    try {
      const before = structuredClone([...fixture.values]);
      const events = fixture.eventQueries.findByEntityPrefix('');
      await expect(
        fixture.session.receiveSandboxControlEvent({
          identity: {
            directory: DIRECTORY,
            kiloSessionId: 'kilo_root',
            rootKiloSessionId: 'kilo_root',
          },
          wrapperInstanceId: NEXT_RUNTIME_ID,
          payload: { type: 'session.updated', properties: { info: { id: 'kilo_root' } } },
        })
      ).resolves.toEqual({ applied: false });
      expect([...fixture.values]).toEqual(before);
      expect(fixture.eventQueries.findByEntityPrefix('')).toEqual(events);
      expect(fields).toHaveBeenCalledWith(
        expect.objectContaining({
          diagnosticEvent: 'session_event_result',
          disposition: 'runtime_mismatch',
        })
      );
    } finally {
      fields.mockRestore();
    }
  });

  it('rejects partial receipt identities without recording events or receipts', async () => {
    const fixture = sessionFixture();
    writeMessages(fixture.storage.kv, [
      {
        messageId: 'queued',
        state: queuedState({
          wrapperInstanceId: RUNTIME_ID,
          preparationAttemptId: 'attempt_1',
        }),
      },
    ]);
    const event = receiptedEvent(1, {
      type: 'session.updated',
      properties: { info: { id: 'kilo_root' } },
    });
    const preparing = receiptedPreparing(1, {
      version: 2,
      attemptId: 'attempt_1',
      triggerMessageId: 'queued',
      revision: 1,
      timestamp: Date.now(),
      step: 'workspace_setup',
      action: 'attempt_started',
      message: 'Preparing environment',
    });
    const before = structuredClone([...fixture.values]);
    const events = fixture.eventQueries.findByEntityPrefix('');
    const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);

    try {
      await expect(
        fixture.session.receiveSandboxControlEvent({
          ...event,
          receiptId: undefined,
          sequence: undefined,
          receiptHash: 'a'.repeat(64),
        })
      ).resolves.toEqual({ applied: false });
      expect(fields).toHaveBeenCalledWith(
        expect.objectContaining({
          diagnosticEvent: 'session_event_result',
          disposition: 'receipt_conflict',
        })
      );

      await expect(
        fixture.session.receiveSandboxControlEvent({
          ...event,
          receiptId: undefined,
        })
      ).resolves.toEqual({ applied: false });
      expect(fields).toHaveBeenCalledWith(
        expect.objectContaining({
          diagnosticEvent: 'session_event_result',
          disposition: 'receipt_conflict',
        })
      );

      await expect(
        fixture.session.receiveSandboxControlPreparing({
          ...preparing,
          receiptId: undefined,
          sequence: undefined,
          receiptHash: 'a'.repeat(64),
        })
      ).resolves.toEqual({ applied: false });
      expect(fields).toHaveBeenCalledWith(
        expect.objectContaining({
          diagnosticEvent: 'session_preparing_result',
          disposition: 'receipt_conflict',
        })
      );

      expect([...fixture.values]).toEqual(before);
      expect(fixture.eventQueries.findByEntityPrefix('')).toEqual(events);
    } finally {
      fields.mockRestore();
    }
  });

  it.each([
    { family: 'session.event', disposition: 'epoch_changed' },
    { family: 'session.event', disposition: 'runtime_mismatch' },
    { family: 'session.event', disposition: 'native_runtime_mismatch' },
    { family: 'session.event', disposition: 'receipt_conflict' },
    { family: 'session.preparing', disposition: 'epoch_changed' },
    { family: 'session.preparing', disposition: 'runtime_mismatch' },
    { family: 'session.preparing', disposition: 'native_runtime_mismatch' },
    { family: 'session.preparing', disposition: 'receipt_conflict' },
  ] as const)(
    'reports $family transaction recheck as $disposition',
    async ({ family, disposition }) => {
      const fixture = sessionFixture();
      const nativeRuntimeId = '55555555-5555-4555-8555-555555555555';
      const replacementNativeRuntimeId = '66666666-6666-4666-8666-666666666666';
      const replacementWrapperInstanceId = '77777777-7777-4777-8777-777777777777';
      const authorization: SessionOperationAuthorization = {
        operation: 'session.attach',
        operationId: 'attempt_1',
        messageId: 'queued',
        session: { sessionId: SESSION_ID, kiloSessionId: 'kilo_root', directory: DIRECTORY },
        wrapperInstanceId: RUNTIME_ID,
        dispatchDeadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS,
      };
      const fence = (runtimeId: string) => ({
        sandboxId: SANDBOX_ID,
        wrapperInstanceId: RUNTIME_ID,
        nativeRuntimeId: runtimeId,
        attachmentEpoch: 1,
        authorization,
      });
      fixture.storage.kv.put('native_runtime_fence', fence(nativeRuntimeId));
      writeMessages(fixture.storage.kv, [
        {
          messageId: 'queued',
          state: queuedState({
            wrapperInstanceId: RUNTIME_ID,
            ...(family === 'session.preparing' ? { preparationAttemptId: 'attempt_1' } : {}),
          }),
          ...(family === 'session.preparing'
            ? { proofs: { attach: { authorization, dispatched: true } } }
            : {}),
        },
      ]);
      const eventInput = receiptedEvent(
        1,
        { type: 'question.asked', properties: { id: 'question_1', sessionID: 'kilo_root' } },
        RUNTIME_ID,
        nativeRuntimeId
      );
      const preparingInput = receiptedPreparing(
        1,
        {
          version: 2,
          attemptId: 'attempt_1',
          triggerMessageId: 'queued',
          revision: 1,
          timestamp: Date.now(),
          step: 'workspace_setup',
          action: 'attempt_started',
          message: 'Preparing environment',
        },
        RUNTIME_ID,
        nativeRuntimeId
      );
      const input = family === 'session.event' ? eventInput : preparingInput;
      const storage = fixture.storage as unknown as {
        transactionSync: <T>(callback: () => T) => T;
      };
      const transactionSync = storage.transactionSync.bind(storage);
      let storageAtRecheck: Array<[string, unknown]> | undefined;
      let restoreEpochCheck: () => void = () => {};
      storage.transactionSync = callback => {
        if (!storageAtRecheck) {
          if (disposition === 'epoch_changed') {
            const lifecycle = (
              fixture.session as unknown as {
                terminalLifecycle: { isCurrent: (epoch: number) => boolean };
              }
            ).terminalLifecycle;
            const epochCheck = vi.spyOn(lifecycle, 'isCurrent').mockReturnValue(false);
            restoreEpochCheck = () => epochCheck.mockRestore();
          } else if (disposition === 'runtime_mismatch') {
            writeMessages(fixture.storage.kv, [
              {
                messageId: 'replacement',
                state: queuedState({
                  wrapperInstanceId: replacementWrapperInstanceId,
                }),
              },
            ]);
          } else if (disposition === 'native_runtime_mismatch' && family === 'session.preparing') {
            writeMessages(fixture.storage.kv, [
              {
                messageId: 'queued',
                state: queuedState({
                  wrapperInstanceId: RUNTIME_ID,
                  preparationAttemptId: 'attempt_1',
                }),
                proofs: {
                  attach: {
                    authorization: { ...authorization, operationId: 'replacement-attach' },
                    dispatched: true,
                    result: {
                      ok: false,
                      error: { code: 'not_ready', message: 'Attach failed', retryable: true },
                    },
                  },
                },
              } satisfies SessionMessage,
            ]);
          } else if (disposition === 'native_runtime_mismatch') {
            fixture.storage.kv.put('native_runtime_fence', fence(replacementNativeRuntimeId));
          } else {
            fixture.storage.kv.put('control_event_receipts', {
              highWater: {},
              retiredWrapperInstanceIds: [],
              receipts: [
                {
                  receiptId: input.receiptId,
                  wrapperInstanceId: RUNTIME_ID,
                  sequence: (input.sequence ?? 0) + 1,
                },
              ],
            });
          }
          storageAtRecheck = structuredClone([...fixture.values]);
        }
        return transactionSync(callback);
      };
      const events = structuredClone(fixture.eventQueries.findByEntityPrefix(''));
      const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
      try {
        const result =
          family === 'session.event'
            ? await fixture.session.receiveSandboxControlEvent(eventInput)
            : await fixture.session.receiveSandboxControlPreparing(preparingInput);
        expect(result).toEqual({ applied: false });
        expect([...fixture.values]).toEqual(storageAtRecheck);
        expect(fixture.eventQueries.findByEntityPrefix('')).toEqual(events);
        expect(fields).toHaveBeenCalledWith(
          expect.objectContaining({
            diagnosticEvent:
              family === 'session.event' ? 'session_event_result' : 'session_preparing_result',
            disposition,
            wrapperInstanceId: RUNTIME_ID,
            expectedWrapperInstanceId: RUNTIME_ID,
            nativeRuntimeId,
            fencePresent: true,
            fenceWrapperInstanceId: RUNTIME_ID,
            fenceNativeRuntimeId: nativeRuntimeId,
          })
        );
        if (family === 'session.preparing') {
          const diagnostic = fields.mock.calls
            .map(([value]) => value)
            .find(value => value.diagnosticEvent === 'session_preparing_result');
          expect(diagnostic).toMatchObject({
            attemptId: 'attempt_1',
            action: 'attempt_started',
            revision: 1,
          });
          expect([diagnostic?.attemptId, diagnostic?.action, diagnostic?.revision]).not.toContain(
            'redacted'
          );
        }
      } finally {
        restoreEpochCheck();
        fields.mockRestore();
      }
    }
  );

  it('reports fencePresent=false when a preparing drop has no native runtime fence', async () => {
    const fixture = sessionFixture();
    const nativeRuntimeId = '55555555-5555-4555-8555-555555555555';
    const authorization: SessionOperationAuthorization = {
      operation: 'session.attach',
      operationId: 'attempt_1',
      messageId: 'queued',
      session: { sessionId: SESSION_ID, kiloSessionId: 'kilo_root', directory: DIRECTORY },
      wrapperInstanceId: RUNTIME_ID,
      dispatchDeadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS,
    };
    writeMessages(fixture.storage.kv, [
      {
        messageId: 'queued',
        state: queuedState({
          wrapperInstanceId: RUNTIME_ID,
          preparationAttemptId: 'attempt_1',
        }),
        proofs: {
          attach: {
            authorization,
            dispatched: true,
            result: {
              ok: false,
              error: { code: 'not_ready', message: 'Attach failed', retryable: true },
            },
          },
        },
      } satisfies SessionMessage,
    ]);
    const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
    try {
      const preparing = receiptedPreparing(
        1,
        {
          version: 2,
          attemptId: 'attempt_1',
          triggerMessageId: 'queued',
          revision: 1,
          timestamp: Date.now(),
          step: 'workspace_setup',
          action: 'attempt_started',
          message: 'Preparing environment',
        },
        RUNTIME_ID,
        nativeRuntimeId
      );
      await expect(fixture.session.receiveSandboxControlPreparing(preparing)).resolves.toEqual({
        applied: false,
      });
      expect(fields).toHaveBeenCalledWith(
        expect.objectContaining({
          diagnosticEvent: 'session_preparing_result',
          disposition: 'native_runtime_mismatch',
          fencePresent: false,
        })
      );
    } finally {
      fields.mockRestore();
    }
  });

  it('persists the alarm and head budget before the first RPC and wakes the head on a fresh ID after reset', async () => {
    const fixture = sessionFixture();
    const firstReady = deferred<ControlStatus>();
    fixture.control.ensureReady.mockImplementationOnce(() => {
      expect(fixture.alarmAt()).not.toBeNull();
      expect(deadlineAtOf(fixture.record('a'))).toBe(Date.now() + SESSION_DELIVERY_TIMEOUT_MS);
      expect(fixture.control.getStatus).not.toHaveBeenCalled();
      return firstReady.promise;
    });
    await fixture.admit('a');
    await fixture.flush();
    const acquisition = fixture.acquisition('a');
    expect(fixture.record('a')?.state.kind).toBe('queued');
    fixture.reload();
    await fixture.admit('b');
    await fixture.flush();

    expect(failedReasonOf(fixture.record('a'))).toBeUndefined();
    // The accepted union no longer carries the queue delivery deadline; the
    // next head still gets its own deadline while `a` stays accepted.
    expect(fixture.record('a')).toMatchObject({ state: { kind: 'accepted' } });
    expect(fixture.record('b')).toMatchObject({ state: { kind: 'queued' } });
    expect(deadlineAtOf(fixture.record('b'))).toBeUndefined();
    expect(fixture.control.ensureReady).toHaveBeenCalledWith(
      expect.objectContaining({ acquisition })
    );
    // `a` completing promotes `b` to the head. Stall its first RPC so the queue
    // deadline `b` acquires as the head is observable before acceptance.
    const bReady = deferred<ControlStatus>();
    fixture.control.ensureReady.mockImplementationOnce(() => {
      expect(deadlineAtOf(fixture.record('b'))).toBe(Date.now() + SESSION_DELIVERY_TIMEOUT_MS);
      return bReady.promise;
    });
    await fixture.outcome('a', 'completed');
    await fixture.flush();
    expect(fixture.record('b')).toMatchObject({ state: { kind: 'queued' } });
    const bQueuedDeadlineAt = deadlineAtOf(fixture.record('b'));
    expect(bQueuedDeadlineAt).toBe(Date.now() + SESSION_DELIVERY_TIMEOUT_MS);

    bReady.resolve({
      allocationIncarnation: 'incarnation_1',
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      attachment: ATTACHMENT,
    });
    await fixture.flush();
    expect(fixture.record('b')?.state.kind).toBe('accepted');
    // The accepted execution bound is derived from the acceptance time, never
    // inherited from the queue-head delivery deadline.
    const bAccepted = fixture.record('b');
    const bAcceptedAt = acceptedAtOf(bAccepted);
    const bExecutionDeadlineAt =
      bAccepted?.state.kind === 'accepted' ? bAccepted.state.executionDeadlineAt : undefined;
    expect(bExecutionDeadlineAt).toBe((bAcceptedAt ?? 0) + POLICY.acceptedExecutionBoundMs);
    // Keep the distinction, or an inherited queue deadline could coincide with the
    // expected bound and the equality above would lose its teeth.
    expect(bExecutionDeadlineAt).not.toBe(bQueuedDeadlineAt);
  });

  it.each(['modern', 'legacy'] as const)(
    'wires %s control events through the production bridge',
    async mode => {
      vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
      const fixture = sessionFixture();
      await fixture.admit('bridge');
      await fixture.flush();
      const requests: Request[] = [];
      fixture.env.SESSION_INGEST = {
        fetch: async (request: Request) => {
          requests.push(request);
          return Response.json({ success: true });
        },
      } as Env['SESSION_INGEST'];
      let token = fixture.metadata.auth.kilocodeToken;
      if (mode === 'modern') {
        installModernRuntimeAuthorization(fixture);
        const signed = await signModernKiloToken({
          secret: 'test-secret',
          userId: 'user_1',
          pepper: null,
          audience: ['kilo-api', 'kilo-gateway', 'session-ingest'],
          tokenPurpose: 'delegated-workload',
          credentialExchange: false,
          expiresInSeconds: 3600,
          extra: {
            runtimeAuthorization: {
              id: '44444444-4444-4444-8444-444444444444',
              resourceKind: 'cloud-agent-next',
              resourceId: SESSION_ID,
            },
          },
        });
        token = signed.token;
        fixture.storage.kv.put(
          'session_metadata',
          serializeSessionMetadata({
            ...fixture.metadata,
            auth: { ...fixture.metadata.auth, kilocodeToken: token },
          })
        );
      } else {
        fixture.env.NEXTAUTH_SECRET = '';
      }
      await expect(
        fixture.session.receiveSandboxControlEvent(
          receiptedEvent(1, {
            type: 'message.updated',
            properties: { info: { id: 'msg_bridge', sessionID: 'kilo_root', role: 'user' } },
          })
        )
      ).resolves.toEqual({ applied: true });
      await fixture.flush();
      await fixture.settleBackground();
      expect(requests).toHaveLength(1);
      expect(requests[0].headers.get('Authorization')).toBe(`Bearer ${token}`);
      if (mode === 'modern') {
        expect(
          await verifyRuntimeProxyAttestation({
            value: requests[0].headers.get(RUNTIME_PROXY_ATTESTATION_HEADER),
            secret: 'test-secret',
            audience: 'session-ingest',
            userId: 'user_1',
            authorizationId: '44444444-4444-4444-8444-444444444444',
            resourceId: SESSION_ID,
            bearer: token ?? '',
          })
        ).toBe(true);
      } else expect(requests[0].headers.has(RUNTIME_PROXY_ATTESTATION_HEADER)).toBe(false);
    }
  );

  it('refreshes the modern followup model-validation credential and preserves the legacy path', async () => {
    const fixture = sessionFixture();
    const runtimeToken = vi
      .spyOn(fixture.session, 'getRuntimeToken')
      .mockResolvedValue('refreshed-token');
    await fixture.admit('legacy-preflight');
    expect(runtimeToken).not.toHaveBeenCalled();
    installModernRuntimeAuthorization(fixture);
    await fixture.admit('modern-preflight');
    expect(runtimeToken).toHaveBeenCalled();
    expect(assertKiloModelAvailable).toHaveBeenLastCalledWith(
      expect.objectContaining({ originalToken: 'refreshed-token' })
    );
  });

  it('maps modern credential infrastructure failure to retryable model-validation failure', async () => {
    const fixture = sessionFixture();
    installModernRuntimeAuthorization(fixture);
    vi.spyOn(fixture.session, 'getRuntimeToken').mockRejectedValue(new Error('unavailable'));
    await expect(fixture.admit('unavailable')).resolves.toMatchObject({
      success: false,
      code: 'MODEL_VALIDATION_UNAVAILABLE',
    });
    expect(fixture.record('unavailable')).toBeUndefined();
  });

  it('does not admit when recovery starts during model validation', async () => {
    const fixture = sessionFixture();
    vi.mocked(assertKiloModelAvailable).mockImplementationOnce(async () => {
      fixture.storage.kv.put('runtime_authorization_recovery', {
        expectedOldId: 'old',
        recoveryId: 'new',
      });
    });
    await expect(fixture.admit('recovering')).resolves.toMatchObject({
      success: false,
      code: 'COMPUTE_STOPPING',
    });
    expect(fixture.record('recovering')).toBeUndefined();
  });

  it('commits one canonical outcome with its receipt and replays it after a lost response', async () => {
    const fixture = sessionFixture();
    await fixture.admit('receipt');
    await fixture.flush();
    const event = {
      identity: {
        directory: DIRECTORY,
        kiloSessionId: 'kilo_root',
        rootKiloSessionId: 'kilo_root',
      },
      wrapperInstanceId: RUNTIME_ID,
      receiptId: '11111111-1111-4111-8111-111111111111',
      sequence: 1,
      payload: {
        type: 'session.message.outcome',
        properties: { messageId: 'receipt', status: 'completed' },
      },
    };

    await expect(
      Promise.all([
        fixture.session.receiveSandboxControlEvent(event),
        fixture.session.receiveSandboxControlEvent(event),
      ])
    ).resolves.toEqual([{ applied: true }, { applied: true }]);
    expect(fixture.record('receipt')?.state.kind).toBe('completed');
    expect(fixture.terminalEvents()).toHaveLength(1);
    expect(fixture.values.get('control_event_receipts')).toMatchObject({
      highWater: { [RUNTIME_ID]: 1 },
    });

    fixture.reload();
    await expect(fixture.session.receiveSandboxControlEvent(event)).resolves.toEqual({
      applied: true,
    });
    await expect(
      fixture.session.receiveSandboxControlEvent({
        ...event,
        sequence: 2,
      })
    ).resolves.toEqual({ applied: false });
    expect(fixture.terminalEvents()).toHaveLength(1);
  });

  it('applies a batch in order and reports per-item outcomes', async () => {
    const fixture = sessionFixture();
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      operationResults: true,
    });
    await fixture.admit('batch_a');
    await fixture.flush();
    const first = receiptedEvent(1, {
      type: 'session.status',
      properties: { sessionID: 'kilo_root', status: { type: 'busy' } },
    });
    const rejected = receiptedEvent(2, {
      type: 'session.status',
      properties: { sessionID: 'kilo_root', status: { type: 'idle' } },
    });
    const last = receiptedEvent(3, {
      type: 'session.updated',
      properties: { info: { id: 'kilo_root' } },
    });
    const items = [
      {
        event: 'session.event' as const,
        session: first.identity,
        payload: first.payload,
        receiptId: first.receiptId,
        sequence: first.sequence,
      },
      {
        event: 'session.event' as const,
        session: { ...rejected.identity, directory: '/workspace/other' },
        payload: rejected.payload,
        receiptId: rejected.receiptId,
        sequence: rejected.sequence,
      },
      {
        event: 'session.event' as const,
        session: last.identity,
        payload: last.payload,
        receiptId: last.receiptId,
        sequence: last.sequence,
      },
    ];

    await expect(
      fixture.session.receiveSandboxControlEventBatch({ items, wrapperInstanceId: RUNTIME_ID })
    ).resolves.toEqual({
      outcomes: [
        { receiptId: first.receiptId, status: 'applied' },
        { receiptId: rejected.receiptId, status: 'rejected' },
        { receiptId: last.receiptId, status: 'applied' },
      ],
    });
  });

  it('applies interleaved snapshot, delta, interaction, and completion items in order', async () => {
    const fixture = sessionFixture();
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      operationResults: true,
    });
    writeMessages(fixture.storage.kv, [
      {
        messageId: 'mixed',
        state: queuedState({
          wrapperInstanceId: RUNTIME_ID,
        }),
      },
    ]);
    const items = [
      receiptedEvent(1, {
        type: 'session.updated',
        properties: { info: { id: 'kilo_root' } },
      }),
      receiptedEvent(2, {
        type: 'message.updated',
        properties: { info: { id: 'msg_assistant', sessionID: 'kilo_root', role: 'assistant' } },
      }),
      receiptedEvent(3, {
        type: 'message.part.updated',
        properties: {
          part: { id: 'part_1', messageID: 'msg_assistant', sessionID: 'kilo_root', type: 'text' },
        },
      }),
      receiptedEvent(4, {
        type: 'question.asked',
        properties: { id: 'question_1', sessionID: 'kilo_root', questions: [] },
      }),
      receiptedEvent(5, {
        type: 'session.message.outcome',
        properties: { messageId: 'mixed', status: 'completed' },
      }),
    ].map(item => ({
      event: 'session.event' as const,
      session: item.identity,
      payload: item.payload,
      receiptId: item.receiptId,
      sequence: item.sequence,
    }));

    await expect(
      fixture.session.receiveSandboxControlEventBatch({ items, wrapperInstanceId: RUNTIME_ID })
    ).resolves.toEqual({
      outcomes: items.map(item => ({ receiptId: item.receiptId, status: 'applied' })),
    });
    expect(fixture.record('mixed')?.state.kind).toBe('completed');
  });

  it('continues applying the remainder after an item exception', async () => {
    const fixture = sessionFixture();
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      operationResults: true,
    });
    await fixture.admit('batch_b');
    await fixture.flush();
    const first = receiptedEvent(1, {
      type: 'session.status',
      properties: { sessionID: 'kilo_root', status: { type: 'busy' } },
    });
    const failing = receiptedEvent(2, {
      type: 'session.updated',
      properties: { info: { id: 'kilo_root' } },
    });
    const remaining = receiptedEvent(3, {
      type: 'session.updated',
      properties: { info: { id: 'kilo_root' } },
    });
    const items = [first, failing, remaining].map(item => ({
      event: 'session.event' as const,
      session: item.identity,
      payload: item.payload,
      receiptId: item.receiptId,
      sequence: item.sequence,
    }));
    const internal = fixture.session as unknown as {
      applySandboxControlEvent: (input: unknown) => Promise<{ applied: boolean }>;
    };
    const original = internal.applySandboxControlEvent.bind(fixture.session);
    const spy = vi.spyOn(internal, 'applySandboxControlEvent');
    spy.mockImplementationOnce(original);
    spy.mockImplementationOnce(async () => {
      throw new Error('forced application failure');
    });
    const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
    try {
      await expect(
        fixture.session.receiveSandboxControlEventBatch({ items, wrapperInstanceId: RUNTIME_ID })
      ).resolves.toEqual({
        outcomes: [
          { receiptId: first.receiptId, status: 'applied' },
          { receiptId: failing.receiptId, status: 'unknown' },
          { receiptId: remaining.receiptId, status: 'applied' },
        ],
      });
      expect(spy).toHaveBeenCalledTimes(3);
      const failed = controlDiagnostics(fields, 'session_event_batch_item_failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({
        eventFamily: 'session.event',
        eventType: 'session.updated',
        receiptId: failing.receiptId,
        sequence: failing.sequence,
        eventIndex: 1,
        batchSize: 3,
        disposition: 'application_exception',
      });
    } finally {
      spy.mockRestore();
      fields.mockRestore();
    }
  });

  it('attributes a session id mismatch without applying or storing the event', async () => {
    const fixture = sessionFixture();
    const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
    try {
      const event = receiptedEvent(1, {
        type: 'session.updated',
        properties: { info: { sessionID: 'kilo_root', id: 'kilo_other' } },
      });
      const before = structuredClone([...fixture.values]);
      await expect(fixture.session.receiveSandboxControlEvent(event)).resolves.toEqual({
        applied: false,
      });
      expect([...fixture.values]).toEqual(before);
      expect(controlDiagnostics(fields, 'session_event_result')[0]).toMatchObject({
        applied: false,
        disposition: 'session_id_mismatch',
        eventType: 'session.updated',
      });
    } finally {
      fields.mockRestore();
    }
  });

  it('attributes a child lineage mismatch without applying or storing the event', async () => {
    const fixture = sessionFixture();
    const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
    try {
      const receipted = receiptedEvent(1, {
        type: 'session.created',
        properties: { info: { id: 'kilo_child', parentID: 'kilo_child', directory: DIRECTORY } },
      });
      const event = {
        ...receipted,
        identity: { directory: DIRECTORY, rootKiloSessionId: 'kilo_root' },
      };
      const before = structuredClone([...fixture.values]);
      await expect(fixture.session.receiveSandboxControlEvent(event)).resolves.toEqual({
        applied: false,
      });
      expect([...fixture.values]).toEqual(before);
      expect(controlDiagnostics(fields, 'session_event_result')[0]).toMatchObject({
        applied: false,
        disposition: 'child_lineage_mismatch',
        eventType: 'session.created',
      });
    } finally {
      fields.mockRestore();
    }
  });

  it('attributes a failed delta with its event family and type', async () => {
    const fixture = sessionFixture();
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      operationResults: true,
    });
    await fixture.admit('batch_delta');
    await fixture.flush();
    const first = receiptedEvent(1, {
      type: 'session.status',
      properties: { sessionID: 'kilo_root', status: { type: 'busy' } },
    });
    const delta = receiptedEvent(2, {
      type: 'message.part.delta',
      properties: { sessionID: 'kilo_root', messageID: 'msg_1', partID: 'part_1', delta: 'x' },
    });
    const remaining = receiptedEvent(3, {
      type: 'session.updated',
      properties: { info: { id: 'kilo_root' } },
    });
    const items = [first, delta, remaining].map(item => ({
      event: 'session.event' as const,
      session: item.identity,
      payload: item.payload,
      receiptId: item.receiptId,
      sequence: item.sequence,
    }));
    const internal = fixture.session as unknown as {
      applySandboxControlEvent: (input: unknown) => Promise<{ applied: boolean }>;
    };
    const original = internal.applySandboxControlEvent.bind(fixture.session);
    const spy = vi.spyOn(internal, 'applySandboxControlEvent');
    spy.mockImplementationOnce(original);
    spy.mockImplementationOnce(async () => {
      throw new Error('forced delta failure');
    });
    const emitted: Array<{ level: 'info' | 'warn'; fields: Record<string, unknown> }> = [];
    let pendingFields: Record<string, unknown> = {};
    const fields = vi.spyOn(logger, 'withFields').mockImplementation(next => {
      pendingFields = next as Record<string, unknown>;
      return logger;
    });
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {
      emitted.push({ level: 'info', fields: pendingFields });
    });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {
      emitted.push({ level: 'warn', fields: pendingFields });
    });
    try {
      await expect(
        fixture.session.receiveSandboxControlEventBatch({ items, wrapperInstanceId: RUNTIME_ID })
      ).resolves.toEqual({
        outcomes: [
          { receiptId: first.receiptId, status: 'applied' },
          { receiptId: delta.receiptId, status: 'unknown' },
          { receiptId: remaining.receiptId, status: 'applied' },
        ],
      });
      const failed = controlDiagnostics(fields, 'session_event_batch_item_failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({
        eventFamily: 'session.event',
        eventType: 'message.part.delta',
        eventIndex: 1,
        batchSize: 3,
        disposition: 'application_exception',
      });
      expect(
        emitted
          .filter(emission => emission.fields.diagnosticEvent === 'session_event_batch_item_failed')
          .map(emission => emission.level)
      ).toEqual(['warn']);
    } finally {
      spy.mockRestore();
      fields.mockRestore();
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it('contains multiple item exceptions and keeps applying the rest', async () => {
    const fixture = sessionFixture();
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      operationResults: true,
    });
    await fixture.admit('batch_remainder');
    await fixture.flush();
    const applied = receiptedEvent(1, {
      type: 'session.status',
      properties: { sessionID: 'kilo_root', status: { type: 'busy' } },
    });
    const failing = receiptedEvent(2, {
      type: 'session.updated',
      properties: { info: { id: 'kilo_root' } },
    });
    const delta = receiptedEvent(3, {
      type: 'message.part.delta',
      properties: { sessionID: 'kilo_root', messageID: 'msg_1', partID: 'part_1', delta: 'x' },
    });
    const trailing = receiptedEvent(4, {
      type: 'session.updated',
      properties: { info: { id: 'kilo_root' } },
    });
    const items = [applied, failing, delta, trailing].map(item => ({
      event: 'session.event' as const,
      session: item.identity,
      payload: item.payload,
      receiptId: item.receiptId,
      sequence: item.sequence,
    }));
    const internal = fixture.session as unknown as {
      applySandboxControlEvent: (input: unknown) => Promise<{ applied: boolean }>;
    };
    const original = internal.applySandboxControlEvent.bind(fixture.session);
    const spy = vi.spyOn(internal, 'applySandboxControlEvent');
    spy.mockImplementationOnce(original);
    spy.mockImplementationOnce(async () => {
      throw new Error('forced failing failure');
    });
    spy.mockImplementationOnce(async () => {
      throw new Error('forced delta failure');
    });
    const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
    try {
      await expect(
        fixture.session.receiveSandboxControlEventBatch({ items, wrapperInstanceId: RUNTIME_ID })
      ).resolves.toEqual({
        outcomes: [
          { receiptId: applied.receiptId, status: 'applied' },
          { receiptId: failing.receiptId, status: 'unknown' },
          { receiptId: delta.receiptId, status: 'unknown' },
          { receiptId: trailing.receiptId, status: 'applied' },
        ],
      });
      const failed = controlDiagnostics(fields, 'session_event_batch_item_failed');
      expect(failed).toHaveLength(2);
      expect(failed).toMatchObject([
        { eventIndex: 1, batchSize: 4, receiptId: failing.receiptId },
        { eventIndex: 2, batchSize: 4, receiptId: delta.receiptId },
      ]);
    } finally {
      spy.mockRestore();
      fields.mockRestore();
    }
  });

  it('contains a failure on the final item', async () => {
    const fixture = sessionFixture();
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      operationResults: true,
    });
    await fixture.admit('batch_final');
    await fixture.flush();
    const applied = receiptedEvent(1, {
      type: 'session.status',
      properties: { sessionID: 'kilo_root', status: { type: 'busy' } },
    });
    const failing = receiptedEvent(2, {
      type: 'session.updated',
      properties: { info: { id: 'kilo_root' } },
    });
    const items = [applied, failing].map(item => ({
      event: 'session.event' as const,
      session: item.identity,
      payload: item.payload,
      receiptId: item.receiptId,
      sequence: item.sequence,
    }));
    const internal = fixture.session as unknown as {
      applySandboxControlEvent: (input: unknown) => Promise<{ applied: boolean }>;
    };
    const original = internal.applySandboxControlEvent.bind(fixture.session);
    const spy = vi.spyOn(internal, 'applySandboxControlEvent');
    spy.mockImplementationOnce(original);
    spy.mockImplementationOnce(async () => {
      throw new Error('forced final failure');
    });
    const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
    try {
      await expect(
        fixture.session.receiveSandboxControlEventBatch({ items, wrapperInstanceId: RUNTIME_ID })
      ).resolves.toEqual({
        outcomes: [
          { receiptId: applied.receiptId, status: 'applied' },
          { receiptId: failing.receiptId, status: 'unknown' },
        ],
      });
      const failed = controlDiagnostics(fields, 'session_event_batch_item_failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({
        eventIndex: 1,
        batchSize: 2,
        disposition: 'application_exception',
      });
      expect(failed[0]).not.toHaveProperty('unattemptedCount');
      expect(failed[0]).not.toHaveProperty('unattemptedDeltaCount');
      expect(failed[0]).not.toHaveProperty('firstUnattemptedSequence');
    } finally {
      spy.mockRestore();
      fields.mockRestore();
    }
  });

  it('never surfaces the thrown value in the item failure diagnostic', async () => {
    const fixture = sessionFixture();
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      operationResults: true,
    });
    await fixture.admit('batch_secret');
    await fixture.flush();
    const applied = receiptedEvent(1, {
      type: 'session.status',
      properties: { sessionID: 'kilo_root', status: { type: 'busy' } },
    });
    const failing = receiptedEvent(2, {
      type: 'session.updated',
      properties: { info: { id: 'kilo_root' } },
    });
    const items = [applied, failing].map(item => ({
      event: 'session.event' as const,
      session: item.identity,
      payload: item.payload,
      receiptId: item.receiptId,
      sequence: item.sequence,
    }));
    const internal = fixture.session as unknown as {
      applySandboxControlEvent: (input: unknown) => Promise<{ applied: boolean }>;
    };
    const original = internal.applySandboxControlEvent.bind(fixture.session);
    const spy = vi.spyOn(internal, 'applySandboxControlEvent');
    spy.mockImplementationOnce(original);
    spy.mockImplementationOnce(async () => {
      const failure = new Error('sk-live-EXAMPLE-message');
      failure.name = 'sk-live-EXAMPLE';
      throw failure;
    });
    const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
    try {
      await expect(
        fixture.session.receiveSandboxControlEventBatch({ items, wrapperInstanceId: RUNTIME_ID })
      ).resolves.toEqual({
        outcomes: [
          { receiptId: applied.receiptId, status: 'applied' },
          { receiptId: failing.receiptId, status: 'unknown' },
        ],
      });
      const failed = controlDiagnostics(fields, 'session_event_batch_item_failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ disposition: 'application_exception' });
      for (const emitted of fields.mock.calls) {
        for (const value of Object.values(emitted[0] as Record<string, unknown>)) {
          if (typeof value === 'string') expect(value).not.toContain('sk-live-EXAMPLE');
        }
      }
    } finally {
      spy.mockRestore();
      fields.mockRestore();
    }
  });

  it('resolves the batch result when the item failure diagnostic construction throws', async () => {
    const fixture = sessionFixture();
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      operationResults: true,
    });
    await fixture.admit('batch_containment');
    await fixture.flush();
    const first = receiptedEvent(1, {
      type: 'session.status',
      properties: { sessionID: 'kilo_root', status: { type: 'busy' } },
    });
    const failing = receiptedEvent(2, {
      type: 'session.updated',
      properties: { info: { id: 'kilo_root' } },
    });
    const remaining = receiptedEvent(3, {
      type: 'session.updated',
      properties: { info: { id: 'kilo_root' } },
    });
    const items = [first, failing, remaining].map(item => ({
      event: 'session.event' as const,
      session: item.identity,
      payload: item.payload,
      receiptId: item.receiptId,
      sequence: item.sequence,
    }));
    Object.defineProperty(items[1], 'sequence', {
      get: () => {
        throw new Error('forced diagnostic field failure');
      },
      enumerable: true,
      configurable: true,
    });
    const internal = fixture.session as unknown as {
      applySandboxControlEvent: (input: unknown) => Promise<{ applied: boolean }>;
    };
    const spy = vi.spyOn(internal, 'applySandboxControlEvent');
    const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
    try {
      await expect(
        fixture.session.receiveSandboxControlEventBatch({ items, wrapperInstanceId: RUNTIME_ID })
      ).resolves.toEqual({
        outcomes: [
          { receiptId: first.receiptId, status: 'applied' },
          { receiptId: failing.receiptId, status: 'unknown' },
          { receiptId: remaining.receiptId, status: 'applied' },
        ],
      });
      expect(controlDiagnostics(fields, 'session_event_batch_item_failed')).toHaveLength(0);
    } finally {
      spy.mockRestore();
      fields.mockRestore();
    }
  });

  it.each([
    { type: 'session.status', properties: { sessionID: 'kilo_root', status: { type: 'busy' } } },
    {
      type: 'question.asked',
      properties: { id: 'question-a', sessionID: 'kilo_root', questions: [] },
    },
  ])(
    'replays $type after the operation result completes A without another event',
    async payload => {
      const fixture = sessionFixture();
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: RUNTIME_ID,
        operationResults: true,
      });
      await fixture.admit('a');
      await fixture.flush();
      const event = receiptedEvent(1, payload);
      await expect(fixture.session.receiveSandboxControlEvent(event)).resolves.toEqual({
        applied: true,
      });
      const authorization = fixture.record('a')?.proofs?.prompt?.authorization;
      if (!authorization) throw new Error('Missing prompt operation authorization');
      await expect(
        fixture.session.receiveSandboxOperationResult({
          session: authorization.session,
          wrapperInstanceId: RUNTIME_ID,
          delivery: {
            version: 2,
            authorization,
            completedAt: Date.now(),
            result: { ok: true, result: { messageId: 'a', status: 'accepted' } },
            outcome: { messageId: 'a', status: 'completed' },
            events: [],
            preparing: [],
          },
        })
      ).resolves.toMatchObject({ disposition: 'applied' });
      expect(fixture.record('a')?.state.kind).toBe('completed');
      const events = fixture.eventQueries.findByEntityPrefix('');
      fixture.reload();
      await expect(fixture.session.receiveSandboxControlEvent(event)).resolves.toEqual({
        applied: true,
      });
      expect(fixture.eventQueries.findByEntityPrefix('')).toEqual(events);
      expect(fixture.terminalEvents()).toHaveLength(1);

      const invalid = { ...event, identity: { ...event.identity, directory: '/foreign' } };
      await expect(fixture.session.receiveSandboxControlEvent(invalid)).resolves.toEqual({
        applied: false,
      });
      expect(fixture.eventQueries.findByEntityPrefix('')).toEqual(events);
    }
  );

  it('receipts ignored trailing interactions without reviving them for the next message', async () => {
    const fixture = sessionFixture();
    await fixture.admit('a');
    await fixture.flush();
    await fixture.outcome('a', 'completed');
    const event = receiptedEvent(1, {
      type: 'question.asked',
      properties: { id: 'late-question', sessionID: 'kilo_root', questions: [] },
    });
    const events = fixture.eventQueries.findByEntityPrefix('');
    await expect(fixture.session.receiveSandboxControlEvent(event)).resolves.toEqual({
      applied: true,
    });
    expect(fixture.eventQueries.findByEntityPrefix('')).toEqual(events);
    expect(fixture.values.get('control_event_receipts')).toMatchObject({
      highWater: { [RUNTIME_ID]: 1 },
    });
    await fixture.admit('b');
    await fixture.flush();
    fixture.reload();
    const beforeReplay = fixture.eventQueries.findByEntityPrefix('');
    await expect(fixture.session.receiveSandboxControlEvent(event)).resolves.toEqual({
      applied: true,
    });
    expect(fixture.eventQueries.findByEntityPrefix('')).toEqual(beforeReplay);
    expect(fixture.values.get('session_pending_interactions')).not.toMatchObject({
      questions: [expect.objectContaining({ id: 'late-question' })],
    });
    expect(fixture.record('b')?.state.kind).toBe('accepted');
  });

  it('accepts valid trailing native status after A completes without runtime cleanup', async () => {
    const fixture = sessionFixture();
    await fixture.admit('a');
    await fixture.flush();
    await fixture.outcome('a', 'completed');
    const event = receiptedEvent(1, {
      type: 'session.updated',
      properties: { info: { id: 'kilo_root', title: 'Completed turn' } },
    });
    await expect(fixture.session.receiveSandboxControlEvent(event)).resolves.toEqual({
      applied: true,
    });
    const events = fixture.eventQueries.findByEntityPrefix('');
    await expect(fixture.session.receiveSandboxControlEvent(event)).resolves.toEqual({
      applied: true,
    });
    expect(fixture.eventQueries.findByEntityPrefix('')).toEqual(events);
    expect(fixture.record('a')?.state.kind).toBe('completed');
  });

  it('dispatches the first normal attach and prompt once with operation receipts enabled', async () => {
    const fixture = sessionFixture();
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      operationResults: true,
    });

    await fixture.admit('a');
    await fixture.flush();

    const operations = fixture.control.request.mock.calls
      .map(([input]) => input.operation)
      .filter(operation => operation.startsWith('session.'));
    expect(operations).toEqual(['session.attach', 'session.prompt']);
    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'accepted' },
      proofs: {
        attach: { dispatched: true },
        prompt: { dispatched: true },
      },
    });
  });

  it('retries a completed retryable attach with a new authorization before delivering the prompt', async () => {
    const fixture = sessionFixture();
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      operationResults: true,
    });
    const original = fixture.control.request.getMockImplementation();
    if (!original) throw new Error('Missing control fixture');
    let attachAttempts = 0;
    delegateRequest(fixture, 'session.attach', async input =>
      ++attachAttempts === 1 ? controlFailure(true, 'not_ready') : original(input)
    );

    await fixture.admit('a');
    await fixture.flush();
    const firstAuthorization = fixture.record('a')?.proofs?.attach?.authorization;
    if (!firstAuthorization) throw new Error('Missing first attach authorization');

    const delivery: SessionOperationDelivery = {
      version: 2,
      authorization: firstAuthorization,
      completedAt: Date.now(),
      result: {
        ok: false,
        error: { code: 'not_ready', message: 'Wrapper is not ready', retryable: true },
      },
      events: [],
      preparing: [],
    };
    await fixture.session.receiveSandboxOperationResult({
      session: firstAuthorization.session,
      wrapperInstanceId: RUNTIME_ID,
      delivery,
    });
    await fixture.flush();
    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'queued', preparationAttemptId: firstAuthorization.operationId },
      proofs: { attach: { dispatched: true, result: delivery.result } },
    });
    delegateRequest(fixture, 'session.operation.get', async () =>
      controlResponse({ state: 'completed', delivery })
    );

    const now = Date.now();
    await fixture.fireAlarm();
    await fixture.flush();
    expect(
      fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.attach')
    ).toHaveLength(1);
    expect(
      fixture.control.request.mock.calls.filter(
        ([input]) => input.operation === 'session.operation.get'
      )
    ).toHaveLength(1);
    const retryNotBefore = retryNotBeforeOf(fixture.record('a'));
    if (retryNotBefore === undefined) throw new Error('Missing attach retry time');
    expect(retryNotBefore - now).toBe(5_000);

    vi.setSystemTime(retryNotBefore);
    await fixture.fireAlarm();
    await fixture.flush();
    const attachRequests = fixture.control.request.mock.calls.filter(
      ([input]) => input.operation === 'session.attach'
    );
    expect(attachRequests).toHaveLength(2);
    const secondAuthorization = attachRequests[1]?.[0].authorization;
    expect(secondAuthorization?.operationId).not.toBe(firstAuthorization.operationId);
    // Amendment A retains `preparationAttemptId` on the accepted union: the
    // message must own the second dispatched attempt, while its attach proof
    // carries the matching authorization.
    const secondAttemptId = fixture.record('a')?.state;
    expect(
      secondAttemptId?.kind === 'queued' || secondAttemptId?.kind === 'accepted'
        ? secondAttemptId.preparationAttemptId
        : undefined
    ).toBe(secondAuthorization?.operationId);
    expect(fixture.record('a')?.proofs?.attach?.authorization?.operationId).toBe(
      secondAuthorization?.operationId
    );
    expect(
      fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.prompt')
    ).toHaveLength(1);
  });

  it('reconstructs a released attach retry after its retry time has passed', async () => {
    const fixture = sessionFixture();
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      operationResults: true,
    });
    writeMessages(fixture.storage.kv, [
      {
        messageId: 'recovered',
        state: queuedState({
          intent: {
            turn: { type: 'prompt', messageId: 'recovered', prompt: 'continue delivery' },
            agent: defaultAgent,
          },
          legacyInvalidIntent: undefined,
          deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS,
          retryNotBefore: Date.now() - 1,
          wrapperInstanceId: RUNTIME_ID,
        }),
      },
    ]);

    await fixture.fireAlarm();
    await fixture.flush();

    const attach = fixture.control.request.mock.calls.find(
      ([input]) => input.operation === 'session.attach'
    )?.[0];
    const recoveredState = fixture.record('recovered')?.state;
    // Amendment A retains the preparation attempt on the accepted union, so the
    // recovered head must own the dispatched attempt and not merely mirror it in
    // its attach proof.
    expect(
      recoveredState?.kind === 'queued' || recoveredState?.kind === 'accepted'
        ? recoveredState.preparationAttemptId
        : undefined
    ).toBe(attach?.authorization?.operationId);
    expect(fixture.record('recovered')?.proofs?.attach?.authorization?.operationId).toBe(
      attach?.authorization?.operationId
    );
    expect(fixture.record('recovered')?.proofs?.attach?.dispatched).toBe(true);
    expect(
      fixture.control.request.mock.calls
        .map(([input]) => input.operation)
        .filter(operation => operation === 'session.attach' || operation === 'session.prompt')
    ).toEqual(['session.attach', 'session.prompt']);
  });

  it.each(['running', 'completed'] as const)(
    'reconciles a late accepted prompt against its original %s operation result',
    async state => {
      const fixture = sessionFixture();
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: RUNTIME_ID,
        operationResults: true,
      });
      await fixture.admit('a');
      await fixture.flush();
      const authorization = fixture.record('a')?.proofs?.prompt?.authorization;
      if (!authorization) throw new Error('Missing prompt operation authorization');
      const completedAt = authorization.dispatchDeadlineAt + 1;
      const delivery: SessionOperationDelivery = {
        version: 2,
        authorization,
        completedAt,
        result: { ok: true, result: { messageId: 'a', status: 'accepted' } },
        outcome: { messageId: 'a', status: 'completed' },
        events: [],
        preparing: [],
      };
      const resultHash = await sessionOperationResultHash(delivery);
      delegateRequest(fixture, 'session.operation.get', async input => {
        expect(input).toMatchObject({
          expectedWrapperInstanceId: RUNTIME_ID,
          payload: authorization,
        });
        expect(input.deadlineAt).toBe(sessionOperationExpiresAt(authorization));
        return controlResponse(
          state === 'running' ? { state, authorization } : { state, delivery }
        );
      });
      delegateRequest(fixture, 'session.operation.ack', async input => {
        expect(state).toBe('completed');
        expect(input).toMatchObject({
          expectedWrapperInstanceId: RUNTIME_ID,
          payload: {
            version: 2,
            authorization,
            resultHash,
            disposition: 'applied',
            decision: { state: 'completed', at: completedAt },
          },
        });
        expect(input.deadlineAt).toBe(completedAt + SANDBOX_CONTROL_OUTCOME_TIMEOUT_MS);
        return controlResponse({ acknowledged: true });
      });

      vi.setSystemTime(authorization.dispatchDeadlineAt + 1);
      fixture.reload();
      await fixture.fireAlarm();
      await fixture.flush();

      expect(
        fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.prompt')
      ).toHaveLength(1);
      expect(
        fixture.control.request.mock.calls.filter(
          ([input]) => input.operation === 'session.operation.get'
        )
      ).toHaveLength(1);
      expect(
        fixture.control.request.mock.calls.filter(
          ([input]) => input.operation === 'session.operation.ack'
        )
      ).toHaveLength(state === 'completed' ? 1 : 0);
      expect(fixture.record('a')?.state.kind).toBe(state === 'completed' ? 'completed' : 'queued');
      if (state === 'running') {
        // An operation receipt is liveness, not progress: the inactivity bound
        // spends the turn's one no-output recovery instead of refreshing its
        // clock. A second identical detection would terminalize.
        expect(fixture.record('a')?.state.recoveryAttempts).toBe(1);
        expect(failedReasonOf(fixture.record('a'))).toBeUndefined();
      }
    }
  );

  it('settles an accepted no-output turn from a stored completed reply instead of recovering it', async () => {
    const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
    const fixture = sessionFixture();
    fixture.setStatus({
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      allocationIncarnation: 'incarnation_1',
      operationResults: true,
    });
    await fixture.admit('a');
    await fixture.flush();
    const authorization = fixture.record('a')?.proofs?.prompt?.authorization;
    if (!authorization) throw new Error('Missing prompt operation authorization');
    // The runtime went silent, but the answer already reached the DO over the
    // ingest channel. Re-dispatching would run the turn and its side effects a
    // second time.
    fixture.eventQueries.upsert({
      executionId: '',
      sessionId: SESSION_ID,
      streamEventType: 'kilocode',
      entityId: 'message/ase_stored_reply',
      payload: JSON.stringify({
        event: 'message.updated',
        properties: {
          info: {
            id: 'ase_stored_reply',
            role: 'assistant',
            sessionID: 'kilo_root',
            parentID: 'a',
            time: { created: 1, completed: 2 },
          },
        },
      }),
      timestamp: 2,
    });
    delegateRequest(fixture, 'session.operation.get', async () =>
      controlResponse({ state: 'running', authorization })
    );

    vi.setSystemTime(authorization.dispatchDeadlineAt + 1);
    fixture.reload();
    await fixture.fireAlarm();
    await fixture.flush();

    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'completed', source: 'coordinator' },
    });
    expect(fixture.record('a')?.state.recoveryAttempts).toBeUndefined();
    expect(failedReasonOf(fixture.record('a'))).toBeUndefined();
    expect(
      fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.prompt')
    ).toHaveLength(1);
    expect(controlDiagnostics(fields, 'accepted_no_output_reconciled')).toHaveLength(1);
  });

  it('does not recover an accepted turn whose stop was admitted while the alarm observed it', async () => {
    const fixture = sessionFixture();
    fixture.setStatus({
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      allocationIncarnation: 'incarnation_1',
      operationResults: true,
    });
    await fixture.admit('a');
    await fixture.flush();
    const authorization = fixture.record('a')?.proofs?.prompt?.authorization;
    if (!authorization) throw new Error('Missing prompt operation authorization');
    // The user's Stop lands while the alarm awaits the observation: the record
    // stays `accepted` and only gains `cancellation`.
    delegateRequest(fixture, 'session.operation.get', async () => {
      markStoredCancellation(fixture, 'a');
      return controlResponse({ state: 'running', authorization });
    });

    vi.setSystemTime(authorization.dispatchDeadlineAt + 1);
    fixture.reload();
    await fixture.fireAlarm();
    await fixture.flush();

    const record = fixture.record('a');
    expect(record?.state.kind).toBe('accepted');
    expect(record?.cancellation).toEqual({
      operationId: 'stop_1',
      deadlineAt: expect.any(Number),
    });
    expect(record?.state.recoveryAttempts).toBeUndefined();
    expect(failedReasonOf(record)).toBeUndefined();
    expect(
      fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.prompt')
    ).toHaveLength(1);
  });

  it('releases an accepted turn whose stop was admitted while the alarm awaited its health sync', async () => {
    const fixture = sessionFixture();
    await fixture.admit('a');
    await fixture.flush();
    const acceptedAt = acceptedAtOf(fixture.record('a'));
    if (acceptedAt === undefined) throw new Error('Missing accepted timestamp');
    // The liveness snapshot cannot keep the turn alive, so the inactivity bound
    // is due. The user's Stop lands while the alarm awaits that snapshot: the
    // record stays `accepted` and only gains `cancellation`. The stop lifecycle
    // owns the turn now, so the watchdog must release it instead of treating it
    // as lost execution and failing it, which would quarantine the wrapper.
    delegateRequest(fixture, 'session.sync', async () => {
      markStoredCancellation(fixture, 'a');
      return controlResponse({ status: { type: 'idle' }, questions: [], permissions: [] });
    });

    vi.setSystemTime(acceptedAt + DEADLINE_MS.kiloInactivity);
    await fixture.fireAlarm();
    await fixture.flush();

    const record = fixture.record('a');
    expect(record?.state.kind).toBe('accepted');
    expect(record?.cancellation).toEqual({
      operationId: 'stop_1',
      deadlineAt: expect.any(Number),
    });
    expect(failedReasonOf(record)).toBeUndefined();
    expect(fixture.terminalEvents()).toHaveLength(0);
  });

  describe('native startup attach authority', () => {
    it.each([false, true])(
      'applies preparing from its pending attach proof without changing prior fence=%s',
      async priorFence => {
        const fixture = sessionFixture();
        const attach = deferred<ResponseFrame>();
        const nativeRuntimeId = NEXT_RUNTIME_ID;
        if (priorFence) {
          const authorization: SessionOperationAuthorization = {
            operation: 'session.attach',
            operationId: 'previous-attach',
            messageId: 'previous',
            session: { sessionId: SESSION_ID, kiloSessionId: 'kilo_root', directory: DIRECTORY },
            wrapperInstanceId: '11111111-1111-4111-8111-111111111111',
            dispatchDeadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS,
          };
          writeMessages(fixture.storage.kv, [
            {
              messageId: 'previous',
              state: terminalState('completed'),
              proofs: {
                attach: {
                  authorization,
                  dispatched: true,
                  completedAt: Date.now(),
                  attachmentEpoch: 1,
                },
              },
            } satisfies SessionMessage,
          ]);
          await fixture.session.recordNativeRuntime({
            sandboxId: SANDBOX_ID,
            wrapperInstanceId: authorization.wrapperInstanceId,
            nativeRuntimeId: '44444444-4444-4444-8444-444444444444',
            authorization,
          });
        }
        const fence = structuredClone(fixture.values.get('native_runtime_fence'));
        fixture.setStatus({
          allocationIncarnation: 'incarnation_1',
          physical: 'running',
          connection: 'ready',
          wrapperInstanceId: RUNTIME_ID,
          operationResults: true,
        });
        delegateRequest(fixture, 'session.attach', () => attach.promise);
        await fixture.admit('a');
        await fixture.flush();
        const message = fixture.record('a');
        const authorization = message?.proofs?.attach?.authorization;
        const attemptId = preparationAttemptIdOf(message);
        if (!authorization || !attemptId) throw new Error('Missing pending attach authority');
        const preparing = receiptedPreparing(
          1,
          {
            version: 2,
            attemptId,
            triggerMessageId: 'a',
            revision: 1_000,
            timestamp: Date.now(),
            step: 'workspace_setup',
            action: 'step_progress',
            message: 'Preparing environment',
            stepId: 'phase:workspace_setup',
            detail: 'Preparing environment',
          },
          RUNTIME_ID,
          nativeRuntimeId
        );
        await expect(fixture.session.receiveSandboxControlPreparing(preparing)).resolves.toEqual({
          applied: true,
        });
        expect(fixture.values.get('native_runtime_fence')).toEqual(fence);
        expect(fixture.values.get('control_event_receipts')).toBeDefined();
        const receipts = structuredClone(fixture.values.get('control_event_receipts'));
        expect(
          fixture.eventQueries.findByEntityPrefix(`preparation/attempt/${attemptId}`).length
        ).toBeGreaterThan(0);
        const prepared = fixture.eventQueries.findByEntityPrefix('');
        expect(
          JSON.parse(
            fixture.eventQueries.findByEntityId(`preparation/attempt/${attemptId}`)?.payload ?? '{}'
          )
        ).toMatchObject({ revision: 1_000, triggerMessageId: 'a' });
        await expect(fixture.session.receiveSandboxControlPreparing(preparing)).resolves.toEqual({
          applied: true,
        });
        expect(fixture.values.get('control_event_receipts')).toEqual(receipts);
        expect(fixture.eventQueries.findByEntityPrefix('')).toEqual(prepared);

        const nativeEvents = [
          receiptedEvent(
            2,
            {
              type: 'session.status',
              properties: { sessionID: 'kilo_root', status: { type: 'busy' } },
            },
            RUNTIME_ID,
            nativeRuntimeId
          ),
          receiptedEvent(
            3,
            {
              type: 'session.updated',
              properties: { info: { id: 'kilo_root', title: 'Native startup' } },
            },
            RUNTIME_ID,
            nativeRuntimeId
          ),
        ];
        for (const event of nativeEvents) {
          const values = structuredClone([...fixture.values]);
          const events = fixture.eventQueries.findByEntityPrefix('');
          await expect(fixture.session.receiveSandboxControlEvent(event)).resolves.toEqual({
            applied: false,
            retryable: true,
          });
          expect([...fixture.values]).toEqual(values);
          expect(fixture.eventQueries.findByEntityPrefix('')).toEqual(events);
        }
        expect(fixture.values.get('native_runtime_fence')).toEqual(fence);

        attach.resolve(controlResponse({ attached: true, nativeRuntimeId }));
        await fixture.flush();
        expect(fixture.values.get('native_runtime_fence')).toMatchObject({
          wrapperInstanceId: RUNTIME_ID,
          nativeRuntimeId,
          authorization,
        });
        for (const event of nativeEvents)
          await expect(fixture.session.receiveSandboxControlEvent(event)).resolves.toEqual({
            applied: true,
          });
      }
    );

    it('rejects unreceipted preparing from a stale wrapper before persistence', async () => {
      const fixture = sessionFixture();
      const attach = deferred<ResponseFrame>();
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: RUNTIME_ID,
        operationResults: true,
      });
      delegateRequest(fixture, 'session.attach', () => attach.promise);
      await fixture.admit('a');
      await fixture.flush();
      const attemptId = preparationAttemptIdOf(fixture.record('a'));
      if (!attemptId) throw new Error('Missing preparation attempt');
      const preparing = unreceiptedPreparing(
        1,
        {
          version: 2,
          attemptId,
          triggerMessageId: 'a',
          revision: 1,
          timestamp: Date.now(),
          step: 'workspace_setup',
          action: 'attempt_started',
          message: 'Preparing environment',
        },
        NEXT_RUNTIME_ID
      );
      const before = structuredClone([...fixture.values]);
      const events = fixture.eventQueries.findByEntityPrefix('');
      const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
      try {
        await expect(fixture.session.receiveSandboxControlPreparing(preparing)).resolves.toEqual({
          applied: false,
        });
        expect([...fixture.values]).toEqual(before);
        expect(fixture.eventQueries.findByEntityPrefix('')).toEqual(events);
        expect(fields).toHaveBeenCalledWith(
          expect.objectContaining({
            diagnosticEvent: 'session_preparing_result',
            disposition: 'runtime_mismatch',
          })
        );
      } finally {
        fields.mockRestore();
      }
    });

    it('rechecks an unreceipted preparing trigger inside its transaction', async () => {
      const fixture = sessionFixture();
      const attach = deferred<ResponseFrame>();
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: RUNTIME_ID,
        operationResults: true,
      });
      delegateRequest(fixture, 'session.attach', () => attach.promise);
      await fixture.admit('a');
      await fixture.flush();
      const message = fixture.record('a');
      const attemptId = preparationAttemptIdOf(message);
      if (!message || !attemptId) throw new Error('Missing preparation attempt');
      const preparing = unreceiptedPreparing(1, {
        version: 2,
        attemptId,
        triggerMessageId: 'a',
        revision: 1,
        timestamp: Date.now(),
        step: 'workspace_setup',
        action: 'attempt_started',
        message: 'Preparing environment',
      });
      const storage = fixture.storage as unknown as {
        transactionSync: <T>(callback: () => T) => T;
      };
      const transactionSync = storage.transactionSync.bind(storage);
      storage.transactionSync = callback => {
        writeMessages(fixture.storage.kv, [
          { ...message, cancellation: { operationId: 'cancel', deadlineAt: Date.now() } },
        ]);
        return transactionSync(callback);
      };
      const events = fixture.eventQueries.findByEntityPrefix('');
      const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
      try {
        await expect(fixture.session.receiveSandboxControlPreparing(preparing)).resolves.toEqual({
          applied: false,
        });
        expect(fixture.eventQueries.findByEntityPrefix('')).toEqual(events);
        expect(fixture.record('a')?.cancellation).toBeDefined();
        expect(fields).toHaveBeenCalledWith(
          expect.objectContaining({
            diagnosticEvent: 'session_preparing_result',
            disposition: 'native_runtime_mismatch',
          })
        );
      } finally {
        fields.mockRestore();
      }
    });

    it('persists unreceipted preparing after its pending attach proof passes', async () => {
      const fixture = sessionFixture();
      const attach = deferred<ResponseFrame>();
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: RUNTIME_ID,
        operationResults: true,
      });
      delegateRequest(fixture, 'session.attach', () => attach.promise);
      await fixture.admit('a');
      await fixture.flush();
      const attemptId = preparationAttemptIdOf(fixture.record('a'));
      if (!attemptId) throw new Error('Missing preparation attempt');
      const preparing = unreceiptedPreparing(
        1,
        {
          version: 2,
          attemptId,
          triggerMessageId: 'a',
          revision: 1,
          timestamp: Date.now(),
          step: 'workspace_setup',
          action: 'attempt_started',
          message: 'Preparing environment',
        },
        RUNTIME_ID,
        NEXT_RUNTIME_ID
      );
      await expect(fixture.session.receiveSandboxControlPreparing(preparing)).resolves.toEqual({
        applied: true,
      });
      expect(
        fixture.eventQueries.findByEntityPrefix(`preparation/attempt/${attemptId}`).length
      ).toBeGreaterThan(0);
      expect(fixture.values.get('control_event_receipts')).toMatchObject({ receipts: [] });
    });

    it('uses only the trigger message attach proof for pending preparation authority', async () => {
      const fixture = sessionFixture();
      const attach = deferred<ResponseFrame>();
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: RUNTIME_ID,
        operationResults: true,
      });
      delegateRequest(fixture, 'session.attach', () => attach.promise);
      await fixture.admit('trigger');
      await fixture.flush();
      const trigger = fixture.record('trigger');
      const proof = trigger?.proofs?.attach;
      const attemptId = preparationAttemptIdOf(trigger);
      if (!trigger || !proof || !attemptId) throw new Error('Missing trigger attach authority');
      writeMessages(fixture.storage.kv, [
        {
          messageId: 'head',
          state: queuedState({
            wrapperInstanceId: RUNTIME_ID,
            preparationAttemptId: 'head-attempt',
          }),
          proofs: {
            attach: {
              ...proof,
              authorization: {
                ...proof.authorization,
                operationId: 'head-attach',
                messageId: 'head',
              },
            },
          },
        } satisfies SessionMessage,
        { ...trigger, proofs: undefined },
      ]);
      const preparing = receiptedPreparing(
        1,
        {
          version: 2,
          attemptId,
          triggerMessageId: 'trigger',
          revision: 1,
          timestamp: Date.now(),
          step: 'workspace_setup',
          action: 'attempt_started',
          message: 'Preparing environment',
        },
        RUNTIME_ID,
        NEXT_RUNTIME_ID
      );
      const before = structuredClone([...fixture.values]);
      const events = fixture.eventQueries.findByEntityPrefix('');
      await expect(fixture.session.receiveSandboxControlPreparing(preparing)).resolves.toEqual({
        applied: false,
      });
      expect([...fixture.values]).toEqual(before);
      expect(fixture.eventQueries.findByEntityPrefix('')).toEqual(events);
    });

    it('applies preparation from a non-head trigger with its own pending attach proof', async () => {
      const fixture = sessionFixture();
      const attach = deferred<ResponseFrame>();
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: RUNTIME_ID,
        operationResults: true,
      });
      delegateRequest(fixture, 'session.attach', () => attach.promise);
      await fixture.admit('trigger');
      await fixture.flush();
      const trigger = fixture.record('trigger');
      const attemptId = preparationAttemptIdOf(trigger);
      if (!trigger || !attemptId) throw new Error('Missing trigger attach authority');
      writeMessages(fixture.storage.kv, [
        {
          messageId: 'head',
          state: queuedState({
            wrapperInstanceId: RUNTIME_ID,
          }),
        },
        trigger,
      ]);
      await expect(
        fixture.session.receiveSandboxControlPreparing(
          receiptedPreparing(
            1,
            {
              version: 2,
              attemptId,
              triggerMessageId: 'trigger',
              revision: 1,
              timestamp: Date.now(),
              step: 'workspace_setup',
              action: 'attempt_started',
              message: 'Preparing environment',
            },
            RUNTIME_ID,
            NEXT_RUNTIME_ID
          )
        )
      ).resolves.toEqual({ applied: true });
    });

    it.each([
      'wrong_message',
      'wrong_attempt',
      'undispatched',
      'cancelled',
      'expired',
      'wrapper_mismatch',
      'scope_mismatch',
      'failed_result',
      'mismatched_result',
    ] as const)('rejects pending preparation with %s attach authority', async invalid => {
      const fixture = sessionFixture();
      const attach = deferred<ResponseFrame>();
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: RUNTIME_ID,
        operationResults: true,
      });
      delegateRequest(fixture, 'session.attach', () => attach.promise);
      await fixture.admit('a');
      await fixture.flush();
      const message = fixture.record('a');
      const proof = message?.proofs?.attach;
      const attemptId = preparationAttemptIdOf(message);
      if (!message || !proof || !attemptId) throw new Error('Missing pending attach authority');
      const triggerMessageId = invalid === 'wrong_message' ? 'missing' : 'a';
      const eventAttemptId = invalid === 'wrong_attempt' ? 'wrong-attempt' : attemptId;
      const altered: SessionMessage = {
        ...message,
        ...(invalid === 'cancelled'
          ? { cancellation: { operationId: 'cancel', deadlineAt: Date.now() } }
          : {}),
        ...(invalid === 'wrapper_mismatch'
          ? {
              state: {
                ...(message.state as QueuedMessageState),
                wrapperInstanceId: NEXT_RUNTIME_ID,
              },
            }
          : {}),
        proofs:
          invalid === 'undispatched'
            ? { attach: { ...proof, dispatched: false } }
            : invalid === 'expired'
              ? {
                  attach: {
                    ...proof,
                    authorization: {
                      ...proof.authorization,
                      dispatchDeadlineAt: Date.now() - SESSION_DELIVERY_TIMEOUT_MS,
                    },
                  },
                }
              : invalid === 'scope_mismatch'
                ? {
                    attach: {
                      ...proof,
                      authorization: {
                        ...proof.authorization,
                        session: { ...proof.authorization.session, directory: '/wrong-directory' },
                      },
                    },
                  }
                : invalid === 'failed_result'
                  ? {
                      attach: {
                        ...proof,
                        result: {
                          ok: false,
                          error: { code: 'not_ready', message: 'Attach failed', retryable: true },
                        },
                      },
                    }
                  : invalid === 'mismatched_result'
                    ? {
                        attach: {
                          ...proof,
                          result: {
                            ok: true,
                            result: {
                              attached: true,
                              nativeRuntimeId: '11111111-1111-4111-8111-111111111111',
                            },
                          },
                        },
                      }
                    : { attach: proof },
      };
      writeMessages(fixture.storage.kv, [altered]);
      const preparing = receiptedPreparing(
        1,
        {
          version: 2,
          attemptId: eventAttemptId,
          triggerMessageId,
          revision: 1,
          timestamp: Date.now(),
          step: 'workspace_setup',
          action: 'attempt_started',
          message: 'Preparing environment',
        },
        RUNTIME_ID,
        NEXT_RUNTIME_ID
      );
      const before = structuredClone([...fixture.values]);
      const events = fixture.eventQueries.findByEntityPrefix('');
      await expect(fixture.session.receiveSandboxControlPreparing(preparing)).resolves.toEqual({
        applied: false,
      });
      expect([...fixture.values]).toEqual(before);
      expect(fixture.eventQueries.findByEntityPrefix('')).toEqual(events);
    });

    it('acknowledges queued duplicates before attachment and settled duplicates after a fence rebound', async () => {
      const fixture = sessionFixture();
      const attach = deferred<ResponseFrame>();
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: RUNTIME_ID,
        operationResults: true,
      });
      delegateRequest(fixture, 'session.attach', () => attach.promise);
      await fixture.admit('a');
      await fixture.flush();
      const message = fixture.record('a');
      const attemptId = preparationAttemptIdOf(message);
      const authorization = message?.proofs?.attach?.authorization;
      if (!message || !attemptId || !authorization)
        throw new Error('Missing pending attach authority');
      const preparing = receiptedPreparing(
        1,
        {
          version: 2,
          attemptId,
          triggerMessageId: 'a',
          revision: 1,
          timestamp: Date.now(),
          step: 'workspace_setup',
          action: 'attempt_started',
          message: 'Preparing environment',
        },
        RUNTIME_ID,
        NEXT_RUNTIME_ID
      );
      await expect(fixture.session.receiveSandboxControlPreparing(preparing)).resolves.toEqual({
        applied: true,
      });
      const events = fixture.eventQueries.findByEntityPrefix('');
      fixture.storage.kv.put('native_runtime_fence', {
        sandboxId: SANDBOX_ID,
        wrapperInstanceId: RUNTIME_ID,
        nativeRuntimeId: NEXT_RUNTIME_ID,
      });
      fixture.values.delete('native_runtime_fence');
      await expect(fixture.session.receiveSandboxControlPreparing(preparing)).resolves.toEqual({
        applied: true,
      });
      expect(fixture.eventQueries.findByEntityPrefix('')).toEqual(events);

      writeMessages(fixture.storage.kv, [
        {
          ...message,
          state: acceptedState({
            intent: message.state.intent,
            legacy: message.state.legacy,
            legacyInvalidIntent: undefined,
            acceptedAt: 1_000,
            wrapperInstanceId: RUNTIME_ID,
            preparationAttemptId: attemptId,
          }),
        },
      ]);
      fixture.storage.kv.put('native_runtime_fence', {
        sandboxId: SANDBOX_ID,
        wrapperInstanceId: RUNTIME_ID,
        nativeRuntimeId: '11111111-1111-4111-8111-111111111111',
        attachmentEpoch: 1,
        authorization,
      });
      const settledMessages = structuredClone(readRawSessionMessages(fixture.values));
      const settledReceipts = structuredClone(fixture.values.get('control_event_receipts'));
      const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
      try {
        await expect(fixture.session.receiveSandboxControlPreparing(preparing)).resolves.toEqual({
          applied: true,
        });
        expect(fields).toHaveBeenCalledWith(
          expect.objectContaining({
            diagnosticEvent: 'session_preparing_result',
            disposition: 'duplicate',
          })
        );
        expect(fixture.eventQueries.findByEntityPrefix('')).toEqual(events);
        expect(readRawSessionMessages(fixture.values)).toEqual(settledMessages);
        expect(fixture.values.get('control_event_receipts')).toEqual(settledReceipts);
        const newReceipt = receiptedPreparing(2, preparing.payload, RUNTIME_ID, NEXT_RUNTIME_ID);
        const before = structuredClone([...fixture.values]);
        await expect(fixture.session.receiveSandboxControlPreparing(newReceipt)).resolves.toEqual({
          applied: false,
        });
        expect([...fixture.values]).toEqual(before);
        expect(fixture.eventQueries.findByEntityPrefix('')).toEqual(events);
        expect(fields).toHaveBeenCalledWith(
          expect.objectContaining({
            diagnosticEvent: 'session_preparing_result',
            disposition: 'native_runtime_mismatch',
          })
        );
      } finally {
        fields.mockRestore();
      }
    });

    it('retries a startup event until the authorized attach response registers its native fence', async () => {
      const fixture = sessionFixture();
      const nativeRuntimeId = NEXT_RUNTIME_ID;
      const attach = deferred<ResponseFrame>();
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: RUNTIME_ID,
        operationResults: true,
      });
      delegateRequest(fixture, 'session.attach', () => attach.promise);
      await fixture.admit('a');
      await fixture.flush();
      const authorization = fixture.record('a')?.proofs?.attach?.authorization;
      if (!authorization) throw new Error('Missing attach authorization');
      const event = receiptedEvent(
        1,
        {
          type: 'session.updated',
          properties: { info: { id: 'kilo_root', title: 'Native startup' } },
        },
        RUNTIME_ID,
        nativeRuntimeId
      );
      const before = fixture.eventQueries.findByEntityPrefix('');
      const receipts = structuredClone(fixture.values.get('control_event_receipts'));
      await expect(fixture.session.receiveSandboxControlEvent(event)).resolves.toEqual({
        applied: false,
        retryable: true,
      });
      expect(fixture.values.has('native_runtime_fence')).toBe(false);
      expect(fixture.values.get('control_event_receipts')).toEqual(receipts);
      expect(fixture.eventQueries.findByEntityPrefix('')).toEqual(before);
      expect(fixture.record('a')).toMatchObject({
        state: { kind: 'queued' },
        proofs: { attach: { dispatched: true, authorization } },
      });
      expect(fixture.record('a')?.proofs?.attach?.completedAt).toBeUndefined();
      expect(
        fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.prompt')
      ).toHaveLength(0);

      attach.resolve(controlResponse({ attached: true, nativeRuntimeId }));
      await fixture.flush();
      expect(fixture.values.get('native_runtime_fence')).toMatchObject({
        sandboxId: SANDBOX_ID,
        wrapperInstanceId: RUNTIME_ID,
        nativeRuntimeId,
        authorization,
        attachmentEpoch: fixture.record('a')?.proofs?.attach?.attachmentEpoch,
      });
      expect(fixture.record('a')?.proofs?.attach?.completedAt).toBeDefined();
      expect(fixture.record('a')?.state.kind).toBe('accepted');
      const beforeApply = fixture.eventQueries.findByEntityPrefix('');
      await expect(fixture.session.receiveSandboxControlEvent(event)).resolves.toEqual({
        applied: true,
      });
      const applied = fixture.eventQueries.findByEntityPrefix('');
      expect(applied).toHaveLength(beforeApply.length + 1);
      const broadcasts = orchestrationMocks.broadcast.mock.calls.length;
      await expect(fixture.session.receiveSandboxControlEvent(event)).resolves.toEqual({
        applied: true,
      });
      expect(fixture.eventQueries.findByEntityPrefix('')).toEqual(applied);
      expect(orchestrationMocks.broadcast).toHaveBeenCalledTimes(broadcasts);
      const promptAuthorization = fixture.record('a')?.proofs?.prompt?.authorization;
      if (!promptAuthorization) throw new Error('Missing prompt authorization');
      await expect(
        fixture.session.receiveSandboxOperationResult({
          session: promptAuthorization.session,
          wrapperInstanceId: RUNTIME_ID,
          delivery: {
            version: 2,
            authorization: promptAuthorization,
            completedAt: Date.now(),
            result: { ok: true, result: { messageId: 'a', status: 'accepted' } },
            outcome: { messageId: 'a', status: 'completed' },
            events: [],
            preparing: [],
          },
        })
      ).resolves.toMatchObject({ disposition: 'applied' });
      await fixture.flush();
      fixture.reload();
      await expect(fixture.session.receiveSandboxControlEvent(event)).resolves.toEqual({
        applied: true,
      });
      expect(fixture.record('a')?.state.kind).toBe('completed');
      expect(fixture.terminalEvents()).toHaveLength(1);
      expect(
        fixture.control.request.mock.calls
          .map(([input]) => input.operation)
          .filter(operation => operation === 'session.attach' || operation === 'session.prompt')
      ).toEqual(['session.attach', 'session.prompt']);
    });

    it.each(['publication', 'lookup'] as const)(
      'registers the native fence from an exact retained attach %s after response loss',
      async source => {
        const fixture = sessionFixture();
        const attach = deferred<ResponseFrame>();
        fixture.setStatus({
          allocationIncarnation: 'incarnation_1',
          physical: 'running',
          connection: 'ready',
          wrapperInstanceId: RUNTIME_ID,
          operationResults: true,
        });
        delegateRequest(fixture, 'session.attach', () => attach.promise);
        await fixture.admit('a');
        await fixture.flush();
        const authorization = fixture.record('a')?.proofs?.attach?.authorization;
        if (!authorization) throw new Error('Missing attach authorization');
        const event = receiptedEvent(
          1,
          {
            type: 'session.updated',
            properties: { info: { id: 'kilo_root', title: 'Buffered native startup' } },
          },
          RUNTIME_ID,
          NEXT_RUNTIME_ID
        );
        await expect(fixture.session.receiveSandboxControlEvent(event)).resolves.toEqual({
          applied: false,
          retryable: true,
        });
        const delivery: SessionOperationDelivery = {
          version: 2,
          authorization,
          completedAt: Date.now(),
          result: { ok: true, result: { attached: true, nativeRuntimeId: NEXT_RUNTIME_ID } },
          events: [],
          preparing: [],
        };
        const expectedFence = {
          sandboxId: SANDBOX_ID,
          wrapperInstanceId: RUNTIME_ID,
          nativeRuntimeId: NEXT_RUNTIME_ID,
          authorization,
        };
        fixture.reload();
        if (source === 'publication') {
          await expect(
            fixture.session.receiveSandboxOperationResult({
              session: authorization.session,
              wrapperInstanceId: RUNTIME_ID,
              delivery,
            })
          ).resolves.toMatchObject({ disposition: 'applied' });
          expect(fixture.values.get('native_runtime_fence')).toMatchObject(expectedFence);
        }
        delegateRequest(fixture, 'session.operation.get', async input => {
          expect(input.payload).toEqual(authorization);
          return controlResponse({ state: 'completed', delivery });
        });
        let fenceAtAcknowledgement: unknown;
        delegateRequest(fixture, 'session.operation.ack', async () => {
          fenceAtAcknowledgement = structuredClone(fixture.values.get('native_runtime_fence'));
          return controlResponse({ acknowledged: true });
        });
        await fixture.fireAlarm();
        await fixture.flush();
        expect(fenceAtAcknowledgement).toMatchObject(expectedFence);
        expect(fixture.record('a')).toMatchObject({
          state: { kind: 'accepted' },
          proofs: { attach: { resultHash: await sessionOperationResultHash(delivery) } },
        });
        fixture.values.delete('native_runtime_fence');
        fixture.reload();
        const beforeRegistration = structuredClone([...fixture.values]);
        await fixture.session.recordNativeRuntime({
          ...expectedFence,
          nativeRuntimeId: '11111111-1111-4111-8111-111111111111',
        });
        expect([...fixture.values]).toEqual(beforeRegistration);
        expect(fixture.values.has('native_runtime_fence')).toBe(false);
        await expect(
          fixture.session.receiveSandboxOperationResult({
            session: authorization.session,
            wrapperInstanceId: RUNTIME_ID,
            delivery,
          })
        ).resolves.toMatchObject({ disposition: 'identical' });
        expect(fixture.values.get('native_runtime_fence')).toMatchObject(expectedFence);
        const before = fixture.eventQueries.findByEntityPrefix('');
        await expect(fixture.session.receiveSandboxControlEvent(event)).resolves.toEqual({
          applied: true,
        });
        const applied = fixture.eventQueries.findByEntityPrefix('');
        expect(applied).toHaveLength(before.length + 1);
        await expect(fixture.session.receiveSandboxControlEvent(event)).resolves.toEqual({
          applied: true,
        });
        expect(fixture.eventQueries.findByEntityPrefix('')).toEqual(applied);
        expect(
          fixture.control.request.mock.calls
            .map(([input]) => input.operation)
            .filter(operation => operation === 'session.attach' || operation === 'session.prompt')
        ).toEqual(['session.attach', 'session.prompt']);
      }
    );

    it.each([false, true])(
      'never adopts stale N1 during pending N2 attach or replaces N2 within the same attach epoch with prior fence=%s',
      async priorFence => {
        const fixture = sessionFixture();
        const attach = deferred<ResponseFrame>();
        const prompt = deferred<ResponseFrame>();
        const staleNativeRuntimeId = '11111111-1111-4111-8111-111111111111';
        if (priorFence) {
          const previousAuthorization: SessionOperationAuthorization = {
            operation: 'session.attach',
            operationId: 'attach-previous',
            messageId: 'previous',
            session: { sessionId: SESSION_ID, kiloSessionId: 'kilo_root', directory: DIRECTORY },
            wrapperInstanceId: RUNTIME_ID,
            dispatchDeadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS,
          };
          writeMessages(fixture.storage.kv, [
            {
              messageId: 'previous',
              state: terminalState('completed'),
              proofs: {
                attach: {
                  authorization: previousAuthorization,
                  dispatched: true,
                  completedAt: Date.now() - 1,
                  attachmentEpoch: 1,
                },
              },
            } satisfies SessionMessage,
          ]);
          await fixture.session.recordNativeRuntime({
            sandboxId: SANDBOX_ID,
            wrapperInstanceId: RUNTIME_ID,
            nativeRuntimeId: staleNativeRuntimeId,
            authorization: previousAuthorization,
          });
          expect(fixture.values.get('native_runtime_fence')).toMatchObject({
            nativeRuntimeId: staleNativeRuntimeId,
            attachmentEpoch: 1,
          });
        }
        fixture.setStatus({
          allocationIncarnation: 'incarnation_1',
          physical: 'running',
          connection: 'ready',
          wrapperInstanceId: RUNTIME_ID,
          operationResults: true,
        });
        delegateRequest(fixture, 'session.attach', () => attach.promise);
        await fixture.admit('a');
        await fixture.flush();
        const authorization = fixture.record('a')?.proofs?.attach?.authorization;
        if (!authorization) throw new Error('Missing attach authorization');
        delegateRequest(fixture, 'session.prompt', () => prompt.promise);
        const payload = {
          type: 'session.updated',
          properties: { info: { id: 'kilo_root', title: 'Native startup' } },
        };
        const stale = receiptedEvent(1, payload, RUNTIME_ID, staleNativeRuntimeId);
        const pendingState = structuredClone([...fixture.values]);
        const pendingEvents = fixture.eventQueries.findByEntityPrefix('');
        await expect(fixture.session.receiveSandboxControlEvent(stale)).resolves.toEqual({
          applied: false,
          retryable: true,
        });
        expect([...fixture.values]).toEqual(pendingState);
        expect(fixture.eventQueries.findByEntityPrefix('')).toEqual(pendingEvents);
        expect(fixture.values.has('native_runtime_fence')).toBe(priorFence);
        attach.resolve(controlResponse({ attached: true, nativeRuntimeId: NEXT_RUNTIME_ID }));
        await fixture.flush();
        const fence = structuredClone(fixture.values.get('native_runtime_fence'));
        expect(fence).toMatchObject({
          nativeRuntimeId: NEXT_RUNTIME_ID,
          authorization,
          attachmentEpoch: priorFence ? 2 : 1,
        });
        await fixture.session.recordNativeRuntime({
          sandboxId: SANDBOX_ID,
          wrapperInstanceId: RUNTIME_ID,
          nativeRuntimeId: staleNativeRuntimeId,
          authorization,
        });
        expect(fixture.values.get('native_runtime_fence')).toEqual(fence);
        expect(fixture.record('a')?.state.kind).toBe('queued');
        const before = fixture.eventQueries.findByEntityPrefix('');
        await expect(fixture.session.receiveSandboxControlEvent(stale)).resolves.toEqual({
          applied: false,
        });
        expect(fixture.eventQueries.findByEntityPrefix('')).toEqual(before);
        await expect(
          fixture.session.receiveSandboxControlEvent(
            receiptedEvent(1, payload, RUNTIME_ID, NEXT_RUNTIME_ID)
          )
        ).resolves.toEqual({ applied: true });
        prompt.resolve(controlResponse({ messageId: 'a', status: 'accepted' }));
        await fixture.flush();
        fixture.reload();
        await expect(fixture.session.receiveSandboxControlEvent(stale)).resolves.toEqual({
          applied: false,
        });
        expect(fixture.record('a')?.state.kind).toBe('accepted');
        expect(fixture.values.get('native_runtime_fence')).toEqual(fence);
      }
    );

    it.each([false, true])(
      'never falls back to the previous N1 fence across pending B expiry with retained N2 result=%s',
      async retainedResult => {
        const fixture = sessionFixture();
        const attach = deferred<ResponseFrame>();
        fixture.setStatus({
          allocationIncarnation: 'incarnation_1',
          physical: 'running',
          connection: 'ready',
          wrapperInstanceId: RUNTIME_ID,
          operationResults: true,
        });
        delegateRequest(fixture, 'session.attach', () => attach.promise);
        await fixture.admit('b');
        await fixture.flush();
        const current = fixture.record('b');
        const proof = current?.proofs?.attach;
        if (!current || !proof) throw new Error('Missing B attach proof');
        const previousAuthorization = {
          ...proof.authorization,
          operationId: 'attach-a',
          messageId: 'a',
        };
        writeMessages(fixture.storage.kv, [
          {
            messageId: 'a',
            state: terminalState('completed'),
            proofs: {
              attach: {
                authorization: previousAuthorization,
                dispatched: true,
                completedAt: Date.now() - 1,
                attachmentEpoch: 1,
              },
            },
          } satisfies SessionMessage,
          current,
        ]);
        const nativeRuntimeId = '11111111-1111-4111-8111-111111111111';
        await fixture.session.recordNativeRuntime({
          sandboxId: SANDBOX_ID,
          wrapperInstanceId: RUNTIME_ID,
          nativeRuntimeId,
          authorization: previousAuthorization,
        });
        expect(fixture.values.get('native_runtime_fence')).toMatchObject({
          nativeRuntimeId,
          attachmentEpoch: 1,
        });
        if (retainedResult) {
          const registration = vi.spyOn(fixture.session, 'recordNativeRuntime');
          registration.mockResolvedValueOnce(undefined);
          await expect(
            fixture.session.receiveSandboxOperationResult({
              session: proof.authorization.session,
              wrapperInstanceId: RUNTIME_ID,
              delivery: {
                version: 2,
                authorization: proof.authorization,
                completedAt: Date.now(),
                result: { ok: true, result: { attached: true, nativeRuntimeId: NEXT_RUNTIME_ID } },
                events: [],
                preparing: [],
              },
            })
          ).resolves.toMatchObject({ disposition: 'applied' });
          registration.mockRestore();
          expect(fixture.record('b')?.proofs?.attach).toMatchObject({
            attachmentEpoch: 2,
            result: { ok: true, result: { attached: true, nativeRuntimeId: NEXT_RUNTIME_ID } },
          });
        }
        const event = receiptedEvent(
          1,
          {
            type: 'session.updated',
            properties: { info: { id: 'kilo_root', title: 'Stale N1 startup' } },
          },
          RUNTIME_ID,
          nativeRuntimeId
        );
        const before = structuredClone([...fixture.values]);
        const events = fixture.eventQueries.findByEntityPrefix('');
        vi.setSystemTime(sessionOperationExpiresAt(proof.authorization) - 1);
        await expect(fixture.session.receiveSandboxControlEvent(event)).resolves.toEqual(
          retainedResult ? { applied: false } : { applied: false, retryable: true }
        );
        expect([...fixture.values]).toEqual(before);
        vi.setSystemTime(sessionOperationExpiresAt(proof.authorization));
        await expect(fixture.session.receiveSandboxControlEvent(event)).resolves.toEqual({
          applied: false,
        });
        expect([...fixture.values]).toEqual(before);
        expect(fixture.eventQueries.findByEntityPrefix('')).toEqual(events);
        expect(fixture.values.get('native_runtime_fence')).toMatchObject({
          nativeRuntimeId,
          attachmentEpoch: 1,
        });
        expect(await fixture.session.isSandboxCleanupScheduled()).toBe(false);
      }
    );

    it('rejects an unknown native event when the pending attach proof expires without cleanup', async () => {
      const fixture = sessionFixture();
      const attach = deferred<ResponseFrame>();
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: RUNTIME_ID,
        operationResults: true,
      });
      delegateRequest(fixture, 'session.attach', () => attach.promise);
      await fixture.admit('a');
      await fixture.flush();
      const authorization = fixture.record('a')?.proofs?.attach?.authorization;
      if (!authorization) throw new Error('Missing attach authorization');
      const event = receiptedEvent(
        1,
        {
          type: 'session.updated',
          properties: { info: { id: 'kilo_root', title: 'Expired native startup' } },
        },
        RUNTIME_ID,
        NEXT_RUNTIME_ID
      );
      vi.setSystemTime(sessionOperationExpiresAt(authorization) - 1);
      await expect(fixture.session.receiveSandboxControlEvent(event)).resolves.toEqual({
        applied: false,
        retryable: true,
      });
      const before = structuredClone([...fixture.values]);
      const events = fixture.eventQueries.findByEntityPrefix('');
      vi.setSystemTime(sessionOperationExpiresAt(authorization));
      await expect(fixture.session.receiveSandboxControlEvent(event)).resolves.toEqual({
        applied: false,
      });
      expect([...fixture.values]).toEqual(before);
      expect(fixture.eventQueries.findByEntityPrefix('')).toEqual(events);
      expect(fixture.values.has('native_runtime_fence')).toBe(false);
      expect(await fixture.session.isSandboxCleanupScheduled()).toBe(false);
    });
  });

  it('binds a new wrapper receipt lifetime when B starts unbound after idle recycle', async () => {
    const fixture = sessionFixture();
    await fixture.admit('a');
    await fixture.flush();
    const originalEvent = receiptedEvent(1, {
      type: 'session.message.outcome',
      properties: { messageId: 'a', status: 'completed' },
    });
    await expect(fixture.session.receiveSandboxControlEvent(originalEvent)).resolves.toEqual({
      applied: true,
    });
    const ready = deferred<ControlStatus>();
    fixture.control.ensureReady.mockImplementationOnce(() => ready.promise);
    await fixture.admit('b');
    await fixture.flush();
    expect(fixture.record('b')).toMatchObject({ state: { kind: 'queued' } });
    expect(activeWrapperInstanceId(fixture.record('b'))).toBeUndefined();
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: NEXT_RUNTIME_ID,
    });
    ready.resolve({
      allocationIncarnation: 'incarnation_1',
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: NEXT_RUNTIME_ID,
      attachment: ATTACHMENT,
    });
    await fixture.flush();
    expect(fixture.record('b')).toMatchObject({
      state: { kind: 'accepted', wrapperInstanceId: NEXT_RUNTIME_ID },
    });
    expect(fixture.values.get('control_event_receipts')).toMatchObject({
      activeWrapperInstanceId: NEXT_RUNTIME_ID,
      highWater: {},
      retiredWrapperInstanceIds: [RUNTIME_ID],
    });
    fixture.reload();
    const nextEvent = receiptedEvent(
      1,
      {
        type: 'permission.asked',
        properties: {
          id: 'permission-b',
          sessionID: 'kilo_root',
          permission: 'bash',
          patterns: ['*'],
        },
      },
      NEXT_RUNTIME_ID
    );
    await expect(fixture.session.receiveSandboxControlEvent(nextEvent)).resolves.toEqual({
      applied: true,
    });
    const events = fixture.eventQueries.findByEntityPrefix('');
    await expect(fixture.session.receiveSandboxControlEvent(originalEvent)).resolves.toEqual({
      applied: false,
    });
    await expect(
      fixture.session.receiveSandboxControlEvent(
        receiptedEvent(2, {
          type: 'session.message.outcome',
          properties: { messageId: 'b', status: 'failed' },
        })
      )
    ).resolves.toEqual({ applied: false });
    expect(fixture.record('b')?.state.kind).toBe('accepted');
    expect(fixture.eventQueries.findByEntityPrefix('')).toEqual(events);
    expect(fixture.values.get('control_event_receipts')).toMatchObject({
      activeWrapperInstanceId: NEXT_RUNTIME_ID,
      highWater: { [NEXT_RUNTIME_ID]: 1 },
    });
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
      expect(fixture.record('b')?.state.kind).toBe('accepted');
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
    const intent = fixture.record('a')?.state.intent;
    expect(fixture.control.ensureReady).not.toHaveBeenCalled();
    expect(fixture.alarmAt()).not.toBeNull();
    fixture.reload();
    await fixture.fireAlarm();
    expect(fixture.control.ensureReady).toHaveBeenCalledWith(
      expect.objectContaining({ acquisition })
    );
    // Accepted drops the queued preparation attempt and delivery deadline; the
    // durable intent and acceptance are what the union keeps.
    expect(fixture.record('a')).toMatchObject({ state: { kind: 'accepted', intent } });
    signing.resolve([]);
    await fixture.flush();
    expect(fixture.control.ensureReady).toHaveBeenCalledOnce();
    expect(fixture.record('a')?.state.kind).toBe('accepted');
  });

  it.each([
    ['vercel-small', { vcpus: 2, memory: 4096 }],
    ['vercel-large', { vcpus: 4, memory: 8192 }],
  ] as const)(
    'forwards persisted %s resources through readiness after a session reset',
    async (sandboxAllocation, resources) => {
      const fixture = sessionFixture({
        identity: {
          sessionId: SESSION_ID,
          userId: 'user_1',
          orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        },
        workspace: {
          sandboxId: SANDBOX_ID,
          workspacePath: DIRECTORY,
          sandboxProvider: 'vercel',
          sandboxAllocation,
        },
      });
      const signing = deferred<[]>();
      orchestrationMocks.signedAttachments.mockImplementationOnce(() => signing.promise);
      await fixture.admit('sized');
      await fixture.flush();
      expect(fixture.control.ensureReady).not.toHaveBeenCalled();
      fixture.reload();
      await fixture.fireAlarm();
      expect(fixture.control.ensureReady).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'vercel', resources })
      );
      expect(fixture.record('sized')?.state.kind).toBe('accepted');
      signing.resolve([]);
      await fixture.flush();
    }
  );

  it.each([
    { name: 'fence', error: () => new SandboxAcquisitionLostError() },
    {
      name: 'billing admission revalidation',
      error: () =>
        new SandboxAcquisitionLostError('Sandbox runtime changed during billing admission'),
    },
    {
      name: 'readiness revalidation',
      error: () => new SandboxAcquisitionLostError('Sandbox allocation changed during readiness'),
    },
  ])(
    'rotates the preparation attempt and recovers after $name reports acquisition loss',
    async ({ error }) => {
      const fixture = sessionFixture();
      const acquisitions: Parameters<Control['ensureReady']>[0][] = [];
      fixture.control.ensureReady.mockImplementation(async input => {
        acquisitions.push(input);
        if (acquisitions.length === 1) throw error();
        const replacement = {
          allocationIncarnation: 'incarnation_1',
          physical: 'running' as const,
          connection: 'ready' as const,
          wrapperInstanceId: NEXT_RUNTIME_ID,
        } satisfies ControlStatus;
        fixture.setStatus(replacement);
        return { ...replacement, attachment: ATTACHMENT };
      });

      await fixture.admit('a');
      await fixture.flush();
      const first = acquisitions[0]?.acquisition;
      const deadlineAt = deadlineAtOf(fixture.record('a'));
      if (!first || deadlineAt === undefined) throw new Error('Missing first acquisition');
      expect(fixture.record('a')).toMatchObject({
        state: { kind: 'queued', deadlineAt: deadlineAt },
      });
      expect(fixture.record('a')?.state).not.toHaveProperty('preparationAttemptId');
      const retryAt = fixture.alarmAt();
      if (retryAt === null) throw new Error('Missing queue retry alarm');
      expect(retryAt).toBeLessThanOrEqual(deadlineAt);

      vi.setSystemTime(retryAt);
      await fixture.fireAlarm();
      await fixture.flush();

      const second = acquisitions[1]?.acquisition;
      expect(second).toEqual({ id: expect.any(String), deadlineAt });
      expect(second?.id).not.toBe(first.id);
      expect(fixture.record('a')).toMatchObject({ state: { kind: 'accepted' } });
      expect(fixture.terminalEvents()).toHaveLength(0);
    }
  );

  it('does not rotate a tombstone-free same-allocation billing error', async () => {
    const fixture = sessionFixture();
    let firstAcquisitionId: string | undefined;
    fixture.control.ensureReady.mockImplementationOnce(async input => {
      firstAcquisitionId = input.acquisition?.id;
      throw new Error('Sandbox runtime changed during billing admission');
    });
    await fixture.admit('a');
    await fixture.flush();
    if (!firstAcquisitionId) throw new Error('Missing first acquisition');
    const calls = fixture.control.ensureReady.mock.calls.length;
    // The terminal union drops the queued preparation attempt.
    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'failed', reason: 'environment_failed' },
    });
    await fixture.fireAlarm();
    expect(fixture.control.ensureReady).toHaveBeenCalledTimes(calls);
  });

  it('clears a definitively unadmitted attach proof when rotating the preparation attempt', async () => {
    const fixture = sessionFixture();
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      operationResults: true,
    });
    const original = fixture.control.request.getMockImplementation();
    if (!original) throw new Error('Missing control fixture');
    let spent = false;
    delegateRequest(fixture, 'session.attach', async input => {
      if (spent) return original(input);
      spent = true;
      return {
        type: 'response',
        requestId: 'request',
        ok: false,
        error: {
          code: 'not_ready',
          message: 'not admitted',
          retryable: true,
          admission: 'not-admitted',
        },
      } satisfies ResponseFrame;
    });

    await fixture.admit('a');
    await fixture.flush();
    const first = fixture.record('a');
    const firstAttemptId = preparationAttemptIdOf(first);
    const deadlineAt = deadlineAtOf(first);
    if (!firstAttemptId || deadlineAt === undefined) throw new Error('Missing first attempt');
    expect(first).toMatchObject({
      state: { kind: 'queued', attachFailures: 1 },
      proofs: { attach: { dispatched: false } },
    });

    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: NEXT_RUNTIME_ID,
      operationResults: true,
    });
    fixture.control.ensureReady.mockRejectedValueOnce(new SandboxAcquisitionLostError());
    const firstRetryAt = fixture.alarmAt();
    if (firstRetryAt === null) throw new Error('Missing first retry alarm');
    vi.setSystemTime(firstRetryAt);
    await fixture.fireAlarm();
    await fixture.flush();
    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'queued', deadlineAt: deadlineAt, attachFailures: 1 },
    });
    expect(fixture.record('a')?.state).not.toHaveProperty('preparationAttemptId');
    expect(fixture.record('a')?.proofs?.attach).toBeUndefined();

    const secondRetryAt = fixture.alarmAt();
    if (secondRetryAt === null) throw new Error('Missing second retry alarm');
    vi.setSystemTime(secondRetryAt);
    await fixture.fireAlarm();
    await fixture.flush();
    const second = fixture.record('a');
    // The accepted union drops the queued attach failures and delivery deadline.
    expect(second).toMatchObject({ state: { kind: 'accepted' } });
    const attachRequests = fixture.control.request.mock.calls
      .map(([input]) => input)
      .filter(input => input.operation === 'session.attach');
    expect(attachRequests).toHaveLength(2);
    expect(attachRequests[1]?.authorization?.operationId).not.toBe(firstAttemptId);
    expect(second?.proofs?.attach?.authorization.operationId).toBe(
      attachRequests[1]?.authorization?.operationId
    );
  });

  it('bounds repeated acquisition loss by the original head deadline', async () => {
    const fixture = sessionFixture();
    const acquisitions: Parameters<Control['ensureReady']>[0][] = [];
    fixture.control.ensureReady.mockImplementation(async input => {
      acquisitions.push(input);
      throw new SandboxAcquisitionLostError();
    });
    await fixture.admit('a');
    await fixture.flush();
    const deadlineAt = deadlineAtOf(fixture.record('a'));
    if (deadlineAt === undefined) throw new Error('Missing delivery deadline');

    for (let cycle = 0; cycle < 2; cycle++) {
      const retryAt = fixture.alarmAt();
      if (retryAt === null) throw new Error('Missing queue retry alarm');
      vi.setSystemTime(retryAt);
      await fixture.fireAlarm();
      await fixture.flush();
      expect(fixture.record('a')).toMatchObject({
        state: { kind: 'queued', deadlineAt: deadlineAt },
      });
      expect(fixture.record('a')?.state).not.toHaveProperty('preparationAttemptId');
      expect(fixture.alarmAt()).not.toBeNull();
    }
    expect(acquisitions).toHaveLength(3);
    expect(new Set(acquisitions.map(input => input.acquisition?.id)).size).toBe(3);
    expect(acquisitions.map(input => input.acquisition?.deadlineAt)).toEqual([
      deadlineAt,
      deadlineAt,
      deadlineAt,
    ]);

    vi.setSystemTime(deadlineAt);
    await fixture.fireAlarm();
    await fixture.flush();
    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'failed', reason: 'preparation_timeout', at: deadlineAt },
    });
  });

  describe('ATTACH-RECLAIM acquisition supersession recovery', () => {
    // Real drain: `session.attach` completes against RUNTIME_ID, then the first
    // prompt is refused pre-send, leaving a queued row with a completed attach
    // proof and no dispatched prompt. The control plane is mocked here: there is
    // no real receipt storage, allocation replacement or producer/consumer RPC.
    // The control-owned classification is proven in the lifecycle suite
    // (bindable => superseded, dead/non-live => plain).
    // The identity-less live-record case is source-verified only (`bindable`
    // requires a non-empty `allocationIdentity`) and is not exercised by a test.
    // The lifecycle harness storage is a map-backed transaction emulator, not a
    // real Durable Object transaction. The only real Workers-runtime/RPC evidence
    // is the integration test in test/integration/sandbox-control.test.ts, which
    // proves the serialized error name/message survives and does not prove the
    // full session recovery.
    async function preparedAttachFixture() {
      const fixture = sessionFixture();
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: RUNTIME_ID,
        operationResults: true,
      });
      // Capture the original before installing the one-shot prompt delegate.
      const original = fixture.control.request.getMockImplementation();
      if (!original) throw new Error('Missing control fixture');
      let promptAttempts = 0;
      delegateRequest(fixture, 'session.prompt', async input => {
        promptAttempts += 1;
        return promptAttempts === 1
          ? controlFailure(true, 'not_ready', 'not-admitted')
          : original(input);
      });
      await fixture.admit('a');
      await fixture.flush();
      const first = fixture.control.ensureReady.mock.calls[0]?.[0].acquisition;
      const deadlineAt = deadlineAtOf(fixture.record('a'));
      if (!first || deadlineAt === undefined) throw new Error('Missing first acquisition');
      expect(deadlineAt).toBe(first.deadlineAt);
      expect(fixture.record('a')).toMatchObject({
        state: { kind: 'queued', wrapperInstanceId: RUNTIME_ID },
        proofs: { attach: { dispatched: true } },
      });
      expect(fixture.record('a')?.proofs?.attach?.completedAt).toBeDefined();
      expect(fixture.record('a')?.proofs?.prompt?.dispatched).not.toBe(true);
      expect(fixture.alarmAt()).not.toBeNull();
      return { fixture, first, deadlineAt };
    }

    it('ATTACH-RECLAIM: a superseded acquisition releases the completed attach and rebinds the replacement', async () => {
      const { fixture, first, deadlineAt } = await preparedAttachFixture();

      fixture.control.ensureReady.mockRejectedValueOnce(new SandboxAcquisitionSupersededError());
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: NEXT_RUNTIME_ID,
        operationResults: true,
      });
      const recoveryAt = fixture.alarmAt();
      if (recoveryAt === null) throw new Error('Missing recovery alarm');
      vi.setSystemTime(recoveryAt);
      await fixture.fireAlarm();
      await fixture.flush();

      expect(fixture.record('a')).toMatchObject({
        state: { kind: 'queued', deadlineAt: deadlineAt },
      });
      expect(fixture.record('a')?.state).not.toHaveProperty('preparationAttemptId');
      expect(fixture.record('a')?.state).not.toHaveProperty('wrapperInstanceId');
      expect(fixture.record('a')?.proofs?.attach).toBeUndefined();
      expect(fixture.record('a')?.proofs?.retiredAttach).toBeDefined();
      expect(fixture.terminalEvents()).toHaveLength(0);
      expect(fixture.record('a')?.state.kind).not.toBe('failed');

      const retryAt = fixture.alarmAt();
      if (retryAt === null) throw new Error('Missing post-release retry alarm');
      vi.setSystemTime(retryAt);
      await fixture.fireAlarm();
      await fixture.flush();

      expect(fixture.record('a')).toMatchObject({ state: { kind: 'accepted' } });
      expect(fixture.terminalEvents()).toHaveLength(0);
      const postRelease = fixture.control.ensureReady.mock.calls.at(-1)?.[0].acquisition;
      expect(postRelease?.id).toBeDefined();
      expect(postRelease?.id).not.toBe(first.id);
      expect(postRelease?.deadlineAt).toBe(deadlineAt);
      const postReleaseState = fixture.record('a')?.state;
      expect(
        postReleaseState?.kind === 'queued' || postReleaseState?.kind === 'accepted'
          ? postReleaseState.preparationAttemptId
          : undefined
      ).toBe(postRelease?.id);
      const attachRequests = fixture.control.request.mock.calls
        .map(([input]) => input)
        .filter(input => input.operation === 'session.attach');
      expect(attachRequests).toHaveLength(2);
      expect(attachRequests[1]?.authorization?.operationId).not.toBe(
        attachRequests[0]?.authorization?.operationId
      );
      expect(attachRequests[1]?.authorization?.wrapperInstanceId).toBe(NEXT_RUNTIME_ID);
    });

    it('ATTACH-RECLAIM: a plain acquisition loss with a dispatched attach still terminalizes environment_failed', async () => {
      const { fixture } = await preparedAttachFixture();

      fixture.control.ensureReady.mockRejectedValueOnce(new SandboxAcquisitionLostError());
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: NEXT_RUNTIME_ID,
        operationResults: true,
      });
      const recoveryAt = fixture.alarmAt();
      if (recoveryAt === null) throw new Error('Missing recovery alarm');
      vi.setSystemTime(recoveryAt);
      await fixture.fireAlarm();
      await fixture.flush();

      expect(fixture.record('a')).toMatchObject({
        state: { kind: 'failed', reason: 'environment_failed' },
      });
      expect(fixture.terminalEvents()).toHaveLength(1);
      expect(
        fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.attach')
      ).toHaveLength(1);
    });

    it('ATTACH-RECLAIM: after classification the replacement can vanish and the turn ends preparation_timeout', async () => {
      const { fixture, deadlineAt } = await preparedAttachFixture();

      fixture.control.ensureReady.mockRejectedValueOnce(new SandboxAcquisitionSupersededError());
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: NEXT_RUNTIME_ID,
        operationResults: true,
      });
      const recoveryAt = fixture.alarmAt();
      if (recoveryAt === null) throw new Error('Missing recovery alarm');
      vi.setSystemTime(recoveryAt);
      await fixture.fireAlarm();
      await fixture.flush();
      expect(fixture.record('a')).toMatchObject({
        state: { kind: 'queued', deadlineAt: deadlineAt },
      });
      expect(fixture.record('a')?.state).not.toHaveProperty('preparationAttemptId');
      expect(fixture.record('a')?.proofs?.attach).toBeUndefined();
      expect(fixture.record('a')?.proofs?.retiredAttach).toBeDefined();
      expect(fixture.terminalEvents()).toHaveLength(0);

      // Residual limitation: bindability was established at classification only.
      // The replacement is unavailable from here, so the pre-existing bounded
      // path exhausts the original head deadline and stores preparation_timeout.
      // This is not counted as recovery and adds no new stored reason.
      fixture.control.ensureReady.mockRejectedValue(new SandboxAcquisitionLostError());

      let guard = 0;
      while (Date.now() < deadlineAt) {
        if (++guard > 400) throw new Error('Replacement outage did not reach the head deadline');
        const retryAt = fixture.alarmAt();
        if (retryAt === null) throw new Error('Missing queue retry alarm');
        vi.setSystemTime(Math.min(retryAt, deadlineAt));
        await fixture.fireAlarm();
        await fixture.flush();
      }

      expect(fixture.record('a')).toMatchObject({
        state: { kind: 'failed', reason: 'preparation_timeout' },
      });
    });
  });

  it('clears a serialized pre-send not_ready refusal so the next attempt really sends', async () => {
    const fixture = sessionFixture();
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      operationResults: true,
    });
    const original = fixture.control.request.getMockImplementation();
    if (!original) throw new Error('Missing control fixture');
    let attachAttempts = 0;
    delegateRequest(fixture, 'session.attach', async input => {
      attachAttempts += 1;
      if (attachAttempts === 1) {
        // Cloudflare RPC serializes a rejection to its own fields; the custom
        // prototype does not cross. The production control-rpc boundary must
        // rebuild it into a local ControlRequestError.
        throw Object.assign(new Error('Sandbox runtime is not ready'), {
          name: 'ControlRequestError',
          code: 'not_ready',
          retryable: true,
          admission: 'not-admitted',
        });
      }
      return original(input);
    });

    await fixture.admit('a');
    await fixture.flush();

    expect(attachAttempts).toBe(1);
    expect(fixture.record('a')).toMatchObject({ state: { kind: 'queued' } });
    // `record(false)` must run. A residual dispatched proof would reconcile a
    // phantom operation on the next drain instead of sending.
    expect(fixture.record('a')?.proofs?.attach?.dispatched).toBe(false);
    expect(fixture.terminalEvents()).toHaveLength(0);

    const retryAt = fixture.alarmAt();
    if (retryAt === null) throw new Error('Missing queue retry alarm');
    vi.setSystemTime(retryAt);
    await fixture.fireAlarm();
    await fixture.flush();

    expect(attachAttempts).toBe(2);
    expect(
      fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.attach')
    ).toHaveLength(2);
    expect(
      fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.prompt')
    ).toHaveLength(1);
    expect(fixture.record('a')).toMatchObject({ state: { kind: 'accepted' } });
  });

  it('bounds a serialized pre-send not_ready attach refusal by the original head deadline', async () => {
    const fixture = sessionFixture();
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      operationResults: true,
    });
    let attachAttempts = 0;
    delegateRequest(fixture, 'session.attach', async () => {
      attachAttempts += 1;
      throw Object.assign(new Error('Sandbox runtime is not ready'), {
        name: 'ControlRequestError',
        code: 'not_ready',
        retryable: true,
        admission: 'not-admitted',
      });
    });

    await fixture.admit('a');
    await fixture.flush();

    const deadlineAt = deadlineAtOf(fixture.record('a'));
    if (deadlineAt === undefined) throw new Error('Missing head delivery deadline');
    expect(deadlineAt).toBe(Date.now() + SESSION_DELIVERY_TIMEOUT_MS);
    // The ~11 minute bound is far beyond the 5-minute E2E recovery budget.
    expect(SESSION_DELIVERY_TIMEOUT_MS).toBe(11 * 60_000);

    let guard = 0;
    while (fixture.record('a')?.state.kind === 'queued') {
      if (++guard > 300) throw new Error('Attach refusal did not reach the head deadline');
      const retryAt = fixture.alarmAt();
      if (retryAt === null) throw new Error('Missing queue retry alarm');
      vi.setSystemTime(retryAt);
      await fixture.fireAlarm();
      await fixture.flush();
    }

    expect(attachAttempts).toBeGreaterThan(1);
    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'failed', reason: 'preparation_timeout', at: deadlineAt },
    });
    expect(fixture.terminalEvents()).toHaveLength(1);
  });

  it('exhausts a serialized pre-send not_ready prompt refusal at the cap before the head deadline', async () => {
    const fixture = sessionFixture();
    let promptAttempts = 0;
    delegateRequest(fixture, 'session.prompt', async () => {
      promptAttempts += 1;
      throw Object.assign(new Error('Sandbox runtime is not ready'), {
        name: 'ControlRequestError',
        code: 'not_ready',
        retryable: true,
        admission: 'not-admitted',
      });
    });

    await fixture.admit('a');
    await fixture.flush();

    const deadlineAt = deadlineAtOf(fixture.record('a'));
    if (deadlineAt === undefined) throw new Error('Missing head delivery deadline');
    expect(promptFailuresOf(fixture.record('a'))).toBe(1);

    for (let attempt = 2; attempt <= PROMPT_FAILURE_LIMIT; attempt++) {
      const retryAt = fixture.alarmAt();
      if (retryAt === null) throw new Error('Missing queue retry alarm');
      vi.setSystemTime(retryAt);
      await fixture.fireAlarm();
      await fixture.flush();
      if (attempt < PROMPT_FAILURE_LIMIT)
        expect(promptFailuresOf(fixture.record('a'))).toBe(attempt);
    }

    expect(promptAttempts).toBe(PROMPT_FAILURE_LIMIT);
    expect(Date.now()).toBeLessThan(deadlineAt);
    // The terminal union drops the queued prompt failure counter.
    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'failed', reason: 'prompt_exhausted' },
    });
    expect(fixture.terminalEvents()).toHaveLength(1);
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
        state: { kind: 'failed', reason: 'environment_failed' },
      });
      expect(fixture.record('b')?.state.kind).toBe('failed');
      expect(fixture.terminalEvents()).toHaveLength(2);
      await fixture.fireAlarm();
      expect(fixture.control.ensureReady).toHaveBeenCalledOnce();
      expect(fixture.control.getStatus).not.toHaveBeenCalled();
      expect(fixture.control.request).not.toHaveBeenCalled();
      fixture.control.ensureReady.mockResolvedValue({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: NEXT_RUNTIME_ID,
        attachment: ATTACHMENT,
      });
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: NEXT_RUNTIME_ID,
      });
      await fixture.admit('c');
      await fixture.flush();
      expect(fixture.record('c')?.state.kind).toBe('accepted');
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
    const deadlineAt = deadlineAtOf(fixture.record('a'));
    if (deadlineAt === undefined) throw new Error('Missing head delivery deadline');
    expect(deadlineAt).toBe(Date.now() + SESSION_DELIVERY_TIMEOUT_MS);
    const acquisition = fixture.acquisition('a');
    const initialCalls = fixture.control.ensureReady.mock.calls.length;
    fixture.reload();
    const retryAt = fixture.alarmAt();
    if (retryAt === null) throw new Error('Missing queue retry alarm');
    vi.setSystemTime(retryAt);
    await fixture.fireAlarm();
    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'queued', deadlineAt: deadlineAt },
    });
    expect(deadlineAtOf(fixture.record('b'))).toBeUndefined();
    vi.setSystemTime(deadlineAt - 1);
    await fixture.fireAlarm();
    expect(fixture.record('a')?.state.kind).toBe('queued');
    expect(fixture.alarmAt()).toBe(deadlineAt);
    const callsBeforeDeadline = fixture.control.ensureReady.mock.calls.length;
    vi.setSystemTime(deadlineAt);
    await fixture.fireAlarm();
    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'failed', reason: 'preparation_timeout', at: deadlineAt },
    });
    expect(fixture.record('b')?.state.kind).toBe('failed');
    expect(fixture.terminalEvents()).toHaveLength(2);
    expect(fixture.control.ensureReady).toHaveBeenCalledTimes(callsBeforeDeadline);
    for (const [input] of fixture.control.ensureReady.mock.calls.slice(initialCalls)) {
      expect(input.acquisition).toEqual(acquisition);
      expect(input.allowCreate).toBeUndefined();
    }
    // The deadline check probes the control plane for an in-flight runtime
    // replacement before terminalizing. Absent one, it terminalizes without
    // dispatching or quarantining.
    expect(fixture.control.getStatus).toHaveBeenCalledWith({ sessionId: SESSION_ID });
    expect(fixture.control.request).not.toHaveBeenCalled();
  });

  it('continues the same acquisition across background stop observations', async () => {
    const fixture = sessionFixture();
    fixture.control.ensureReady.mockRejectedValueOnce(
      Object.assign(new Error('Transient admission failure'), { retryable: true })
    );
    await fixture.admit('a');
    await fixture.flush();
    const acquisition = fixture.acquisition('a');
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      physical: 'stopping',
      connection: 'disconnected',
    });
    await fixture.fireAlarm();
    expect(fixture.record('a')?.state.kind).toBe('queued');
    expect(fixture.alarmAt()).toBeGreaterThan(Date.now());
    expect(fixture.control.ensureReady).toHaveBeenLastCalledWith(
      expect.objectContaining({ acquisition })
    );
    fixture.control.ensureReady.mockImplementationOnce(async () => {
      const ready = {
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: NEXT_RUNTIME_ID,
      } satisfies ControlStatus;
      fixture.setStatus(ready);
      return { ...ready, attachment: ATTACHMENT };
    });
    await fixture.fireAlarm();
    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'accepted', wrapperInstanceId: NEXT_RUNTIME_ID },
    });
    expect(fixture.control.ensureReady).toHaveBeenLastCalledWith(
      expect.objectContaining({ acquisition })
    );
  });

  it('realizes a queued Vercel head from stopped while still observing the allocation', async () => {
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
    // The alarm observes a stopping allocation rather than creating from it; a
    // Cloudflare acquisition would instead keep its acquisition path.
    const stopping = {
      allocationIncarnation: 'incarnation_1',
      physical: 'stopping',
      connection: 'disconnected',
    } satisfies ControlStatus;
    const stopped = {
      allocationIncarnation: 'incarnation_1',
      physical: 'stopped',
      connection: 'disconnected',
    } satisfies ControlStatus;
    fixture.control.ensureReady
      .mockResolvedValueOnce({ ...stopping, attachment: ATTACHMENT })
      .mockResolvedValue({ ...stopped, attachment: ATTACHMENT });
    fixture.control.getStatus.mockResolvedValue({ ...stopped });
    const alarm = fixture.fireAlarm();
    await vi.advanceTimersByTimeAsync(5_000);
    await alarm;
    expect(fixture.record('a')?.state.kind).toBe('queued');
    expect(failedReasonOf(fixture.record('a'))).toBeUndefined();
    expect(fixture.control.ensureReady).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: 'vercel', allowCreate: true })
    );
    expect(
      fixture.control.ensureReady.mock.calls.every(([input]) => input.acquisition === undefined)
    ).toBe(true);
    expect(fixture.alarmAt()).not.toBeNull();
    expect(fixture.control.request).not.toHaveBeenCalled();
  });

  it('keeps a stopping Vercel head queued when the startup observation slice expires', async () => {
    const fixture = sessionFixture({
      workspace: { sandboxId: SANDBOX_ID, workspacePath: DIRECTORY, sandboxProvider: 'vercel' },
    });
    fixture.control.ensureReady.mockRejectedValueOnce(
      Object.assign(new Error('Transient admission failure'), { retryable: true })
    );
    await fixture.admit('a');
    await fixture.flush();
    const deadlineAt = deadlineAtOf(fixture.record('a'));
    if (deadlineAt === undefined) throw new Error('Missing head delivery deadline');
    // The allocation stays stopping for longer than the startup observation
    // slice while the head still has its full delivery budget. The slice is a
    // bound on one alarm, not the head deadline, so the head must stay queued.
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      physical: 'stopping',
      connection: 'disconnected',
    });
    const alarm = fixture.fireAlarm();
    await vi.advanceTimersByTimeAsync(DEADLINE_MS.startup + 5_000);
    await alarm;
    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'queued', deadlineAt: deadlineAt },
    });
    expect(failedReasonOf(fixture.record('a'))).toBeUndefined();
    expect(fixture.alarmAt()).not.toBeNull();
    expect(fixture.control.request).not.toHaveBeenCalled();
  });

  it('fails the stopping Vercel head once the delivery deadline expires', async () => {
    const fixture = sessionFixture({
      workspace: { sandboxId: SANDBOX_ID, workspacePath: DIRECTORY, sandboxProvider: 'vercel' },
    });
    fixture.control.ensureReady.mockRejectedValueOnce(
      Object.assign(new Error('Transient admission failure'), { retryable: true })
    );
    await fixture.admit('a');
    await fixture.flush();
    const deadlineAt = deadlineAtOf(fixture.record('a'));
    if (deadlineAt === undefined) throw new Error('Missing head delivery deadline');
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      physical: 'stopping',
      connection: 'disconnected',
    });
    // Start one startup slice before the head deadline so the observation ends
    // exactly when the head budget is gone.
    vi.setSystemTime(deadlineAt - DEADLINE_MS.startup);
    const alarm = fixture.fireAlarm();
    await vi.advanceTimersByTimeAsync(DEADLINE_MS.startup);
    await alarm;
    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'failed', reason: 'preparation_timeout' },
    });
  });

  describe('feed-recovery prompt rejection policy', () => {
    it('does not count a not-admitted session_busy rejection and re-arms until the head deadline', async () => {
      const fixture = sessionFixture();
      let requests = 0;
      delegateRequest(fixture, 'session.prompt', async () => {
        requests += 1;
        return controlFailure(true, 'session_busy', 'not-admitted');
      });
      await fixture.admit('a');
      await fixture.flush();
      const deadlineAt = fixture.acquisition('a').deadlineAt;
      expect(fixture.record('a')).toMatchObject({
        state: { kind: 'queued', deliveryRetryScope: 'message', deadlineAt: deadlineAt },
      });
      expect(promptFailuresOf(fixture.record('a'))).toBe(0);
      expect(fixture.terminalEvents()).toHaveLength(0);

      for (let attempt = 0; attempt < 6; attempt++) {
        fixture.reload();
        const retryAt = fixture.alarmAt();
        if (retryAt === null) throw new Error('Missing queue retry alarm');
        vi.setSystemTime(retryAt);
        await fixture.fireAlarm();
        expect(fixture.record('a')).toMatchObject({
          state: { kind: 'queued', deliveryRetryScope: 'message', deadlineAt: deadlineAt },
        });
        expect(promptFailuresOf(fixture.record('a'))).toBe(0);
      }
      expect(requests).toBe(7);
      expect(fixture.terminalEvents()).toHaveLength(0);

      fixture.reload();
      vi.setSystemTime(deadlineAt);
      await fixture.fireAlarm();
      expect(fixture.record('a')).toMatchObject({
        state: { kind: 'failed', reason: 'preparation_timeout' },
      });
      expect(fixture.terminalEvents()).toHaveLength(1);
    });
  });

  describe('prompt-phase rejection marking', () => {
    it('does not mark a completed attach proof on a prompt rejection', async () => {
      const fixture = sessionFixture();
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: RUNTIME_ID,
        operationResults: true,
      });
      delegateRequest(fixture, 'session.prompt', async () => controlFailure(true, 'not_ready'));
      await fixture.admit('a');
      await fixture.flush();

      const record = fixture.record('a');
      expect(record?.proofs?.attach?.dispatched).toBe(true);
      expect(record?.proofs?.attach?.rejectionReceived).toBeUndefined();
      expect(record?.proofs?.attach?.rejectionSubtype).toBeUndefined();
    });
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
        return { writer, sibling };
      }

      it.each(['accepted', 'expired'] as const)(
        'keeps an accepted sibling alive while contention retries become %s across resets',
        async outcome => {
          const { writer, sibling } = sharedSessions();
          await writer.admit('writer');
          await writer.flush();
          expect(writer.record('writer')?.state.kind).toBe('accepted');
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
              state: {
                kind: 'queued',
                deliveryRetryScope: 'message',
                deadlineAt: acquisition.deadlineAt,
                preparationAttemptId: acquisition.id,
              },
            });
            expect(attachFailuresOf(sibling.record('waiting'))).toBe(0);
            expect(promptFailuresOf(sibling.record('waiting'))).toBe(0);
            expect(writer.record('writer')?.state.kind).toBe('accepted');
          }
          expect(requests).toEqual(Array.from({ length: 7 }, () => requests[0]));
          if (outcome === 'expired') {
            sibling.reload();
            vi.setSystemTime(acquisition.deadlineAt);
            await sibling.fireAlarm();
            expect(sibling.record('waiting')).toMatchObject({
              state: { kind: 'failed', reason: 'preparation_timeout', at: acquisition.deadlineAt },
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
            expect(sibling.record('follow-up')?.state.kind).toBe('accepted');
          } else {
            busy = false;
            await sibling.fireAlarm();
            expect(sibling.record('waiting')).toMatchObject({
              state: { kind: 'accepted', wrapperInstanceId: RUNTIME_ID },
            });
            await sibling.outcome('waiting', 'completed');
          }
          // Real progress keeps the accepted writer alive across the sibling's
          // contention window; a snapshot/operation receipt alone must not. Fire
          // the health check at least 90s after the progress so it exercises the
          // runtime-health branch rather than a plain rearm.
          const progressAt = Date.now();
          await writer.rawEvent('session.status', { status: { type: 'busy' } });
          vi.setSystemTime(progressAt + 120_000);
          await writer.fireAlarm();
          expect(writer.record('writer')?.state.kind).toBe('accepted');
          expect(lastActivityAtOf(writer.record('writer'))).toBe(progressAt);
          expect(writer.alarmAt()).not.toBeNull();
          expect(writer.alarmAt()!).toBeLessThanOrEqual(progressAt + DEADLINE_MS.kiloInactivity);
          expect(writer.terminalEvents()).toHaveLength(0);
          await writer.outcome('writer', 'completed');
          expect(writer.record('writer')?.state.kind).toBe('completed');
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
          state: { kind: 'failed', reason: 'preparation_timeout' },
        });
        expect(sibling.record('next')?.state.kind).toBe('queued');
        expect(deadlineAtOf(sibling.record('next'))).toBeUndefined();
        expect(await sibling.session.getCurrentMessageWork()).toMatchObject({
          messageId: 'next',
          status: 'pending',
        });
        expect(writer.record('writer')?.state.kind).toBe('accepted');
        writer.control.request.mockImplementation(original);
        await sibling.fireAlarm();
        expect(sibling.record('next')).toMatchObject({
          state: { kind: 'accepted', wrapperInstanceId: RUNTIME_ID },
        });
        expect(sibling.terminalEvents()).toHaveLength(1);
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
          if (operation === 'session.attach') {
            expect(sibling.record('rejected')).toMatchObject({
              state: { kind: 'failed', reason: 'attach_exhausted' },
            });
          } else {
            expect(sibling.record('rejected')).toMatchObject({
              state: { kind: 'failed', reason: 'prompt_exhausted' },
            });
          }
          expect(sibling.terminalEvents()).toHaveLength(1);
          expect(await sibling.session.isSandboxCleanupScheduled()).toBe(false);
          await writer.outcome('writer', 'completed');
          expect(writer.record('writer')?.state.kind).toBe('completed');
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
        expect(sibling.record('waiting')?.state.kind).toBe('cancelled');
        expect(sibling.terminalEvents()).toHaveLength(1);
        await writer.outcome('writer', 'completed');
        expect(writer.record('writer')?.state.kind).toBe('completed');
      });

      it.each(['ensureReady', 'attachSession'] as const)(
        'preserves the accepted sibling when a busy retry is cancelled during %s',
        async stage => {
          const { writer, sibling } = sharedSessions();
          await writer.admit('writer');
          await writer.flush();
          const ready = {
            allocationIncarnation: 'incarnation_1',
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
            state: { kind: 'queued', deliveryRetryScope: 'message', wrapperInstanceId: RUNTIME_ID },
          });
          expect(unresolvedDispatchOf(sibling.record('waiting'))).toBeUndefined();
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
            expect(unresolvedDispatchOf(sibling.record('waiting'))).toBeUndefined();
            await expect(sibling.session.interruptExecution()).resolves.toEqual({ success: true });
            expect(writer.record('writer')?.state.kind).toBe('accepted');
            expect(writer.terminalEvents()).toHaveLength(0);
            expect(sibling.record('waiting')?.state.kind).toBe('cancelled');
            expect(sibling.terminalEvents()).toHaveLength(1);
            expect(await sibling.session.isSandboxCleanupScheduled()).toBe(false);
          } finally {
            pending.resolve(undefined);
            await retry;
            await sibling.flush();
          }
          await sibling.fireAlarm();
          expect(writer.control.request).not.toHaveBeenCalled();
          expect(sibling.record('waiting')?.state.kind).toBe('cancelled');
          expect(sibling.terminalEvents()).toHaveLength(1);
          expect(writer.record('writer')?.state.kind).toBe('accepted');
          await writer.outcome('writer', 'completed');
          expect(writer.record('writer')?.state.kind).toBe('completed');
        }
      );
    }
  );

  it('retains acknowledged prompt ownership until acceptance is persisted atomically', async () => {
    const fixture = sessionFixture();
    let acknowledged = false;
    delegateRequest(fixture, 'session.prompt', async () => {
      acknowledged = true;
      return controlResponse({ messageId: 'waiting', status: 'accepted' });
    });
    const writes: SessionMessage[] = [];
    const put = fixture.storage.kv.put.bind(fixture.storage.kv);
    vi.spyOn(fixture.storage.kv, 'put').mockImplementation((key, value) => {
      if (isSessionMessagesKey(key) && acknowledged) {
        writes.push(...structuredClone((value as { messages: SessionMessage[] }).messages));
      }
      put(key, value);
    });
    await fixture.admit('waiting');
    await fixture.flush();
    expect(writes.some(message => message.state.kind === 'accepted')).toBe(true);
    expect(
      writes
        .filter(message => message.state.kind === 'queued')
        .every(message => message.state.kind === 'queued' && message.state.unresolvedDispatch)
    ).toBe(true);
    expect(unresolvedDispatchOf(fixture.record('waiting'))).toBeUndefined();
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
    expect(unresolvedDispatchOf(fixture.record('waiting'))).toBe(true);
    await fixture.fireAlarm();
    expect(fixture.record('waiting')).toMatchObject({
      state: { kind: 'queued', deliveryRetryScope: 'message' },
    });
    expect(unresolvedDispatchOf(fixture.record('waiting'))).toBeUndefined();
    fixture.reload();
    await expect(fixture.session.interruptExecution()).resolves.toEqual({ success: true });
    expect(fixture.record('waiting')?.state.kind).toBe('cancelled');
    lostAcknowledgement.resolve(controlResponse({ attached: true }));
    await fixture.flush();
    expect(fixture.record('waiting')?.state.kind).toBe('cancelled');
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

  it('resolves and reuses a runtime proxy handle when only the control connection changes', async () => {
    const fixture = sessionFixture();
    const backingToken = installModernRuntimeAuthorization(fixture);
    const fenceMock = fixture.control.getRuntimeCredentialProxyFence;
    const f1 = connectionFence('connection_1');
    const f2 = connectionFence('connection_2');
    fenceMock.mockResolvedValueOnce(f1).mockResolvedValueOnce(f1).mockResolvedValue(f2);

    const handle = await fixture.session.issueRuntimeCredentialProxyGrant({
      wrapperRunId: 'ignored',
      wrapperGeneration: 0,
      wrapperConnectionId: 'ignored',
    });
    expect(handle).toEqual(expect.any(String));
    expect(fixture.values.get(RUNTIME_PROXY_GRANT_KEY)).toMatchObject({
      plane: 'control',
      connectionId: 'connection_1',
    });

    await expect(
      fixture.session.resolveRuntimeCredentialProxyGrant(handle!)
    ).resolves.toMatchObject({ token: backingToken });

    const reused = await fixture.session.issueRuntimeCredentialProxyGrant({
      wrapperRunId: 'ignored',
      wrapperGeneration: 0,
      wrapperConnectionId: 'ignored',
    });
    expect(reused).toBe(handle);
    expect(
      runtimeProxyGrantSchema.parse(fixture.values.get(RUNTIME_PROXY_GRANT_KEY))
    ).toMatchObject({ plane: 'control', connectionId: 'connection_2' });
  });

  it('reuses a runtime proxy handle when the control connection changes between the two reads', async () => {
    const fixture = sessionFixture();
    installModernRuntimeAuthorization(fixture);
    const fenceMock = fixture.control.getRuntimeCredentialProxyFence;
    const f1 = connectionFence('connection_1');
    const f2 = connectionFence('connection_2');

    fenceMock.mockResolvedValue(f1);
    const handle = await fixture.session.issueRuntimeCredentialProxyGrant({
      wrapperRunId: 'ignored',
      wrapperGeneration: 0,
      wrapperConnectionId: 'ignored',
    });
    expect(handle).toEqual(expect.any(String));

    fenceMock.mockReset();
    fenceMock.mockResolvedValueOnce(f1).mockResolvedValue(f2);
    const reused = await fixture.session.issueRuntimeCredentialProxyGrant({
      wrapperRunId: 'ignored',
      wrapperGeneration: 0,
      wrapperConnectionId: 'ignored',
    });
    expect(reused).toBe(handle);
    expect(
      runtimeProxyGrantSchema.parse(fixture.values.get(RUNTIME_PROXY_GRANT_KEY))
    ).toMatchObject({ plane: 'control', connectionId: 'connection_2' });
  });

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

  it.each([false, true])(
    'sends modern attach credentials through a fenced proxy grant with operation results %s',
    async operationResults => {
      const fixture = sessionFixture();
      const backingToken = installModernRuntimeAuthorization(fixture);

      const nativeRuntimeId = '44444444-4444-4444-8444-444444444444';
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: RUNTIME_ID,
        ...(operationResults ? { operationResults: true as const } : {}),
      });
      delegateRequest(fixture, 'session.attach', async () =>
        controlResponse({ attached: true, nativeRuntimeId })
      );

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
      if (operationResults) {
        expect(fixture.values.get('native_runtime_fence')).toMatchObject({
          sandboxId: SANDBOX_ID,
          wrapperInstanceId: RUNTIME_ID,
          nativeRuntimeId,
          authorization: attach?.authorization,
        });
      }
      const serialized = JSON.stringify(attach?.payload);
      expect(serialized).not.toContain(KILO_CREDENTIAL);
      expect(serialized).not.toContain(backingToken);
      expect(serialized).not.toContain('test-secret');
    }
  );
  it('fences admissions and snapshots callbacks before deletion', async () => {
    const send = vi.fn(async (_job: CallbackJob) => ({}) as QueueSendResponse);
    const fixture = sessionFixture(
      { callback: { target: { url: 'https://example.com/callback' } } },
      undefined,
      { send }
    );

    await fixture.admit('a');
    await fixture.flush();
    expect(fixture.record('a')?.state.kind).toBe('accepted');

    const deletion = fixture.session.deleteSession();
    await expect(fixture.admit('b')).resolves.toMatchObject({
      success: false,
      code: 'NOT_FOUND',
    });

    await deletion;
    await fixture.flush();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ messageId: 'a', status: 'interrupted' }),
      })
    );
  });

  it('snapshots one callback for the last admitted row when deleting multiple active messages', async () => {
    const send = vi.fn(async (_job: CallbackJob) => ({}) as QueueSendResponse);
    const fixture = sessionFixture(
      { callback: { target: { url: 'https://example.com/callback' } } },
      undefined,
      { send }
    );
    const abort = deferred<ResponseFrame>();
    delegateRequest(fixture, 'session.abort', () => abort.promise);

    await fixture.admit('a');
    await fixture.flush();
    await fixture.admit('b');
    await fixture.flush();
    await fixture.admit('c');
    await fixture.flush();
    expect(fixture.record('a')?.state.kind).toBe('accepted');
    expect(fixture.record('b')?.state.kind).toBe('accepted');
    expect(fixture.record('c')?.state.kind).toBe('accepted');

    const deletion = fixture.session.deleteSession();
    expect(fixture.record('a')?.state.kind).toBe('cancelled');
    expect(fixture.record('b')?.state.kind).toBe('cancelled');
    expect(fixture.record('c')?.state.kind).toBe('cancelled');

    abort.resolve(controlResponse({ status: 'aborted' }));
    await deletion;
    await fixture.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ messageId: 'c', status: 'interrupted' }),
      })
    );
  });

  it('does not block session deletion on a stalled reference-forget RPC', async () => {
    const fixture = sessionFixture();
    fixture.control.forgetSessionReference.mockImplementation(() => new Promise(() => {}));
    const deletion = fixture.session.deleteSession();
    await vi.advanceTimersByTimeAsync(SANDBOX_CONTROL_REQUEST_TIMEOUT_MS);
    await deletion;
    await fixture.flush();
    expect(fixture.control.forgetSessionReference).toHaveBeenCalledTimes(1);
    expect(await fixture.session.getMetadata()).toBeNull();
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
          state: { kind: 'queued', wrapperInstanceId: RUNTIME_ID },
        });
        return prompt.promise;
      });
      await fixture.admit('a');
      await fixture.admit('b');
      await fixture.flush();
      expect(fixture.record('a')?.state.kind).toBe('queued');
      await expect(fixture.outcome('a', status)).resolves.toEqual({ applied: true });
      await fixture.flush();
      expect(fixture.record('b')?.state.kind).toBe('accepted');
      const terminal = fixture.eventQueries.findByEntityId('terminal-message/a');
      expect(terminal).not.toBeNull();
      prompt.resolve(controlResponse({ messageId: 'a', status: 'accepted' }));
      await fixture.flush();
      await expect(fixture.outcome('a', status)).resolves.toEqual({ applied: true });
      await fixture.outcome('a', status === 'failed' ? 'completed' : 'failed');
      expect(fixture.record('a')?.state.kind).toBe(status);
      expect(fixture.record('b')?.state.kind).toBe('accepted');
      expect(fixture.eventQueries.findByEntityId('terminal-message/a')).toEqual(terminal);
      expect(fixture.terminalEvents()).toHaveLength(1);
      expect(fixture.eventQueries.findByEntityId('accepted-message/a')).toBeNull();
      expect(fixture.eventQueries.findByEntityId('accepted-message/b')?.stream_event_type).toBe(
        'cloud.message.sent'
      );
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
    const messages = readSessionValueSync(fixture.storage.kv);
    const events = fixture.eventQueries.findByEntityPrefix('');
    const alarmAt = fixture.alarmAt();
    // The completed union drops the preparation attempt; the materialized
    // preparation snapshot is the durable owner.
    const attemptId = getPreparationSnapshots(fixture.eventQueries)
      .map(
        row =>
          JSON.parse(row.payload) as {
            action?: string;
            attemptId?: string;
            triggerMessageId?: string;
          }
      )
      .find(data => data.action === 'attempt_snapshot' && data.triggerMessageId === 'a')?.attemptId;
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
    expect(readSessionValueSync(fixture.storage.kv)).toEqual(messages);
    expect(fixture.eventQueries.findByEntityPrefix('')).toEqual(events);
    expect(fixture.alarmAt()).toBe(alarmAt);
    await expect(fixture.session.getCurrentMessageWork()).resolves.toEqual({
      messageId: 'b',
      status: 'running',
      health: 'healthy',
    });
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
    expect(fixture.record('b')?.state.kind).toBe('accepted');
    prompt.reject(new Error('Lost acknowledgement'));
    await fixture.flush();
    expect(fixture.record('a')?.state.kind).toBe('completed');
    expect(fixture.record('b')?.state.kind).toBe('accepted');
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
    expect(fixture.record('a')?.state.kind).toBe('accepted');
    expect(fixture.record('b')?.state.kind).toBe('queued');
    expect(fixture.terminalEvents()).toHaveLength(0);
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
      // Cancellation reasons live on the cancelled union, not the failed union.
      const record = fixture.record('a');
      expect(record?.state.kind).toBe('cancelled');
      expect(record?.state.kind === 'cancelled' ? record.state.reason : undefined).toBe(reason);
    }
  );

  it('settles cancelled preparation history across reset, late events, and reconnect', async () => {
    const fixture = sessionFixture();
    const attach = deferred<ResponseFrame>();
    delegateRequest(fixture, 'session.attach', () => attach.promise);
    await fixture.admit('a');
    await fixture.flush();
    const attemptId = preparationAttemptIdOf(fixture.record('a'));
    if (!attemptId) throw new Error('Missing preparation attempt');
    expect(readPreparationAttempt(fixture.eventQueries, attemptId)?.status).toBe('running');
    expect(readStep(fixture.eventQueries, attemptId, 'phase:workspace_setup').status).toBe(
      'running'
    );

    await expect(fixture.session.interruptExecution()).resolves.toEqual({ success: true });
    expect(fixture.record('a')?.state.kind).toBe('cancelled');
    expect(readPreparationAttempt(fixture.eventQueries, attemptId)).toMatchObject({
      status: 'failed',
      safeError: 'The message was interrupted',
      completedAt: terminalAtOf(fixture.record('a')),
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
    expect(fixture.record('a')?.state.kind).toBe('cancelled');
    expect(fixture.terminalEvents()).toHaveLength(1);
    expect(
      fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.prompt')
    ).toHaveLength(0);
  });

  it('persists a retained operation result without nested transactionSync', async () => {
    const fixture = sessionFixture();
    const kiloSessionId = fixture.metadata.auth.kiloSessionId;
    if (!kiloSessionId) throw new Error('Missing Kilo session ID');
    const authorization = {
      operation: 'session.prompt',
      operationId: 'a',
      messageId: 'a',
      session: { sessionId: SESSION_ID, kiloSessionId, directory: DIRECTORY },
      wrapperInstanceId: RUNTIME_ID,
      dispatchDeadlineAt: Date.now() + 60_000,
    } satisfies SessionOperationAuthorization;
    seedMessages(fixture.values, [
      {
        messageId: 'a',
        state: acceptedState({
          wrapperInstanceId: RUNTIME_ID,
        }),
        proofs: { prompt: { authorization, dispatched: true } },
      } as SessionMessage,
    ]);
    let depth = 0;
    const transactionSync = fixture.storage.transactionSync.bind(fixture.storage);
    fixture.storage.transactionSync = <T>(callback: () => T): T => {
      if (depth > 0) throw new Error('nested transactionSync');
      depth += 1;
      try {
        return transactionSync(callback);
      } finally {
        depth -= 1;
      }
    };
    await expect(
      fixture.session.receiveSandboxOperationResult({
        session: authorization.session,
        wrapperInstanceId: authorization.wrapperInstanceId,
        delivery: {
          version: 2,
          authorization,
          completedAt: Date.now(),
          result: { ok: true, result: { messageId: 'a', status: 'accepted' } },
          outcome: { messageId: 'a', status: 'completed' },
          events: [
            {
              type: 'autocommit_completed',
              properties: { success: true, messageId: 'a' },
              timestamp: new Date().toISOString(),
            },
          ],
          preparing: [],
        },
      })
    ).resolves.toMatchObject({ disposition: 'applied' });
    expect(fixture.record('a')?.state.kind).toBe('completed');
  });

  it('persists a retained operation result without nested transactionSync', async () => {
    const fixture = sessionFixture();
    const kiloSessionId = fixture.metadata.auth.kiloSessionId;
    if (!kiloSessionId) throw new Error('Missing Kilo session ID');
    const authorization = {
      operation: 'session.prompt',
      operationId: 'a',
      messageId: 'a',
      session: { sessionId: SESSION_ID, kiloSessionId, directory: DIRECTORY },
      wrapperInstanceId: RUNTIME_ID,
      dispatchDeadlineAt: Date.now() + 60_000,
    } satisfies SessionOperationAuthorization;
    seedMessages(fixture.values, [
      {
        messageId: 'a',
        state: acceptedState({
          wrapperInstanceId: RUNTIME_ID,
        }),
        proofs: { prompt: { authorization, dispatched: true } },
      } as SessionMessage,
    ]);
    let depth = 0;
    const transactionSync = fixture.storage.transactionSync.bind(fixture.storage);
    fixture.storage.transactionSync = <T>(callback: () => T): T => {
      if (depth > 0) throw new Error('nested transactionSync');
      depth += 1;
      try {
        return transactionSync(callback);
      } finally {
        depth -= 1;
      }
    };
    await expect(
      fixture.session.receiveSandboxOperationResult({
        session: authorization.session,
        wrapperInstanceId: authorization.wrapperInstanceId,
        delivery: {
          version: 2,
          authorization,
          completedAt: Date.now(),
          result: { ok: true, result: { messageId: 'a', status: 'accepted' } },
          outcome: { messageId: 'a', status: 'completed' },
          events: [
            {
              type: 'autocommit_completed',
              properties: { success: true, messageId: 'a' },
              timestamp: new Date().toISOString(),
            },
          ],
          preparing: [],
        },
      })
    ).resolves.toMatchObject({ disposition: 'applied' });
    expect(fixture.record('a')?.state.kind).toBe('completed');
  });

  it('records the native runtime fence after attach completion is persisted', async () => {
    const fixture = sessionFixture();
    const kiloSessionId = fixture.metadata.auth.kiloSessionId;
    if (!kiloSessionId) throw new Error('Missing Kilo session ID');
    const nativeRuntimeId = '44444444-4444-4444-8444-444444444444';
    const authorization = {
      operation: 'session.attach',
      operationId: '11111111-1111-4111-8111-111111111111',
      messageId: 'a',
      session: { sessionId: SESSION_ID, kiloSessionId, directory: DIRECTORY },
      wrapperInstanceId: RUNTIME_ID,
      dispatchDeadlineAt: Date.now() + 60_000,
    } satisfies SessionOperationAuthorization;
    seedMessages(fixture.values, [
      {
        messageId: 'a',
        state: acceptedState({
          wrapperInstanceId: RUNTIME_ID,
        }),
        proofs: { attach: { authorization, dispatched: true } },
      } as SessionMessage,
    ]);
    await fixture.session.recordNativeRuntime({
      sandboxId: SANDBOX_ID,
      wrapperInstanceId: RUNTIME_ID,
      nativeRuntimeId,
      authorization,
    });
    expect(fixture.values.get('native_runtime_fence')).toBeUndefined();
    seedMessages(fixture.values, [
      {
        messageId: 'a',
        state: acceptedState({
          wrapperInstanceId: RUNTIME_ID,
        }),
        proofs: {
          attach: {
            authorization,
            dispatched: true,
            completedAt: Date.now(),
            attachmentEpoch: 1,
          },
        },
      } as SessionMessage,
    ]);
    await fixture.session.recordNativeRuntime({
      sandboxId: SANDBOX_ID,
      wrapperInstanceId: RUNTIME_ID,
      nativeRuntimeId,
      authorization,
    });
    expect(fixture.values.get('native_runtime_fence')).toEqual(
      expect.objectContaining({
        sandboxId: SANDBOX_ID,
        wrapperInstanceId: RUNTIME_ID,
        nativeRuntimeId,
      })
    );
  });

  it('does not let a late N1 attachment record replace the current N2 fence', async () => {
    const fixture = sessionFixture();
    const kiloSessionId = fixture.metadata.auth.kiloSessionId;
    if (!kiloSessionId) throw new Error('Missing Kilo session ID');
    const authorization = (messageId: string, operationId: string, deadline: number) =>
      ({
        operation: 'session.attach',
        operationId,
        messageId,
        session: {
          sessionId: SESSION_ID,
          kiloSessionId,
          directory: DIRECTORY,
        },
        wrapperInstanceId: RUNTIME_ID,
        dispatchDeadlineAt: deadline,
      }) satisfies SessionOperationAuthorization;
    const oldAuthorization = authorization(
      'old',
      '11111111-1111-4111-8111-111111111111',
      Date.now() + 1_000
    );
    const nextAuthorization = authorization(
      'next',
      '22222222-2222-4222-8222-222222222222',
      Date.now() + 2_000
    );
    seedMessages(fixture.values, [
      {
        messageId: 'old',
        state: acceptedState({
          wrapperInstanceId: RUNTIME_ID,
        }),
        proofs: {
          attach: {
            authorization: oldAuthorization,
            dispatched: true,
            completedAt: Date.now(),
            attachmentEpoch: 1,
          },
        },
      } as SessionMessage,
      {
        messageId: 'next',
        state: acceptedState({
          wrapperInstanceId: RUNTIME_ID,
        }),
        proofs: {
          attach: {
            authorization: nextAuthorization,
            dispatched: true,
            completedAt: Date.now(),
            attachmentEpoch: 2,
          },
        },
      } as SessionMessage,
    ]);

    await fixture.session.recordNativeRuntime({
      sandboxId: SANDBOX_ID,
      wrapperInstanceId: RUNTIME_ID,
      nativeRuntimeId: '22222222-2222-4222-8222-222222222222',
      authorization: nextAuthorization,
    });
    await fixture.session.recordNativeRuntime({
      sandboxId: SANDBOX_ID,
      wrapperInstanceId: RUNTIME_ID,
      nativeRuntimeId: '11111111-1111-4111-8111-111111111111',
      authorization: oldAuthorization,
    });

    await fixture.session.failWaitingMessages(
      'late_old_native_failure',
      RUNTIME_ID,
      '11111111-1111-4111-8111-111111111111'
    );

    expect(fixture.record('old')?.state.kind).toBe('accepted');
    expect(fixture.record('next')?.state.kind).toBe('accepted');
  });

  it('advances the activity clock only for real progress events', async () => {
    const fixture = sessionFixture();
    await fixture.admit('a');
    await fixture.flush();
    const acceptedAt = acceptedAtOf(fixture.record('a'));
    if (acceptedAt === undefined) throw new Error('Missing accepted timestamp');

    vi.setSystemTime(acceptedAt + 1_000);
    await fixture.rawEvent('session.status', { status: { type: 'retry' } });
    await fixture.rawEvent('session.status', { status: { type: 'offline' } });
    await fixture.rawEvent('question.asked', { id: 'question_1', sessionID: 'kilo_root' });
    await fixture.rawEvent('permission.asked', { id: 'permission_1', sessionID: 'kilo_root' });
    expect(lastActivityAtOf(fixture.record('a'))).toBe(acceptedAt);

    vi.setSystemTime(acceptedAt + 2_000);
    await fixture.rawEvent('message.part.updated', {
      part: { id: 'prt_1', messageID: 'a', sessionID: 'kilo_root', type: 'text' },
    });
    expect(lastActivityAtOf(fixture.record('a'))).toBe(acceptedAt + 2_000);

    vi.setSystemTime(acceptedAt + 3_000);
    await fixture.rawEvent('session.status', { status: { type: 'busy' } });
    expect(lastActivityAtOf(fixture.record('a'))).toBe(acceptedAt + 3_000);
  });

  it('applies a retry status event without treating it as progress', async () => {
    const fixture = sessionFixture();
    await fixture.admit('a');
    await fixture.flush();
    const acceptedAt = acceptedAtOf(fixture.record('a'));
    if (acceptedAt === undefined) throw new Error('Missing accepted timestamp');

    await fixture.rawEvent('session.status', {
      sessionID: 'kilo_root',
      status: { type: 'retry' },
    });

    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'accepted', lastActivityAt: acceptedAt },
    });
    expect(
      orchestrationMocks.broadcast.mock.calls.some(([event]) => {
        const payload = (event as { payload?: unknown }).payload;
        return typeof payload === 'string' && payload.includes('"retry"');
      })
    ).toBe(true);
  });

  it('fails a retrying prompt at seven minutes without real events on the second no-output detection', async () => {
    const fixture = sessionFixture();
    const reports: CloudAgentQueueReport[] = [];
    (
      fixture.env as unknown as { CLOUD_AGENT_REPORT_QUEUE: { send: unknown } }
    ).CLOUD_AGENT_REPORT_QUEUE = {
      send: async (report: CloudAgentQueueReport) => {
        reports.push(report);
      },
    };
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      operationResults: true,
    });
    await fixture.admit('a');
    await fixture.flush();
    const authorization = fixture.record('a')?.proofs?.prompt?.authorization;
    if (!authorization) throw new Error('Missing prompt operation authorization');
    const acceptedAt = acceptedAtOf(fixture.record('a'));
    if (acceptedAt === undefined) throw new Error('Missing accepted timestamp');
    // The prompt operation is still running and the wrapper synthesizes `busy`
    // (the default `session.sync`), while the native status is retry. None of
    // these are real progress.
    await fixture.rawEvent('session.status', { status: { type: 'retry' } });
    delegateRequest(fixture, 'session.operation.get', async () =>
      controlResponse({ state: 'running', authorization })
    );
    await fixture.admit('b');
    await fixture.flush();

    vi.setSystemTime(acceptedAt + DEADLINE_MS.kiloInactivity - 1);
    await fixture.fireAlarm();
    expect(fixture.record('a')?.state.kind).toBe('accepted');
    // The next wake must be at or before the due bound, not a past 90s
    // threshold that already elapsed.
    expect(fixture.alarmAt()).toBe(acceptedAt + DEADLINE_MS.kiloInactivity);

    // The turn already spent its one automatic no-output recovery, so this
    // second identical detection reaches the existing terminal path.
    markNoOutputRecoverySpent(fixture, 'a');
    vi.setSystemTime(acceptedAt + DEADLINE_MS.kiloInactivity);
    await fixture.fireAlarm();
    await fixture.flush();

    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'failed', reason: 'accepted_overdue', detail: 'Turn did not complete' },
    });
    // The check branch fell through on the prior alarm, so the default prompt
    // already accepted the follow-up. It stays accepted after `a` fails.
    expect(fixture.record('b')?.state.kind).toBe('accepted');
    const failed = reports.find(
      report => report.run.messageId === 'a' && report.run.status === 'failed'
    );
    expect(failed?.run).toMatchObject({
      messageId: 'a',
      status: 'failed',
      failureStage: 'post_dispatch_no_activity',
      failureCode: 'wrapper_no_output',
      failureResponsibility: 'platform',
      failureReason: 'wrapper_liveness',
    });
  });

  it('classifies a live wrapper outcome carrying bounded assistant facts', async () => {
    const fixture = sessionFixture();
    const reports = captureCloudAgentReports(fixture);
    await fixture.admit('a');
    await fixture.flush();
    // The default fixture has no operation-results capability, so the prompt is
    // dispatched without an operation proof and the live outcome is accepted.
    expect(fixture.record('a')?.proofs?.prompt).toBeUndefined();

    await fixture.rawEvent('session.message.outcome', {
      messageId: 'a',
      status: 'failed',
      assistantReason: 'rate_limited',
      providerOwnership: 'unknown',
    });
    await fixture.fireAlarm();
    await fixture.flush();

    expect(fixture.record('a')).toMatchObject({
      state: {
        kind: 'failed',
        source: 'wrapper_outcome',
        assistantReason: 'rate_limited',
        providerOwnership: 'unknown',
      },
    });
    expect(failedRunReport(reports, 'a')).toMatchObject({
      failureStage: 'agent_activity',
      failureCode: 'assistant_error',
      failureResponsibility: 'provider',
      failureReason: 'rate_limited',
    });
  });

  it('attributes a live wrapper outcome to the user for insufficient credits', async () => {
    const fixture = sessionFixture();
    const reports = captureCloudAgentReports(fixture);
    await fixture.admit('a');
    await fixture.flush();
    // The default fixture has no operation-results capability, so the prompt is
    // dispatched without an operation proof and the live outcome is accepted.
    expect(fixture.record('a')?.proofs?.prompt).toBeUndefined();

    await fixture.rawEvent('session.message.outcome', {
      messageId: 'a',
      status: 'failed',
      assistantReason: 'insufficient_credits',
      providerOwnership: 'unknown',
    });
    await fixture.fireAlarm();
    await fixture.flush();

    expect(fixture.record('a')).toMatchObject({
      state: {
        kind: 'failed',
        source: 'wrapper_outcome',
        assistantReason: 'insufficient_credits',
        providerOwnership: 'unknown',
      },
    });
    expect(failedRunReport(reports, 'a')).toMatchObject({
      failureStage: 'agent_activity',
      failureCode: 'payment_required',
      failureResponsibility: 'user',
      failureReason: 'insufficient_credits',
    });
  });

  it('classifies a nested operation-result outcome carrying bounded assistant facts', async () => {
    const fixture = sessionFixture();
    const reports = captureCloudAgentReports(fixture);
    fixture.setStatus({
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      operationResults: true,
    });
    await fixture.admit('a');
    await fixture.flush();
    const authorization = fixture.record('a')?.proofs?.prompt?.authorization;
    if (!authorization) throw new Error('Missing prompt operation authorization');
    const completedAt = authorization.dispatchDeadlineAt + 1;
    const delivery: SessionOperationDelivery = {
      version: 2,
      authorization,
      completedAt,
      result: { ok: true, result: { messageId: 'a', status: 'accepted' } },
      outcome: {
        messageId: 'a',
        status: 'failed',
        assistantReason: 'rate_limited',
        providerOwnership: 'unknown',
      },
      events: [],
      preparing: [],
    };
    delegateRequest(fixture, 'session.operation.get', async input => {
      expect(input).toMatchObject({
        expectedWrapperInstanceId: RUNTIME_ID,
        payload: authorization,
      });
      return controlResponse({ state: 'completed', delivery });
    });
    delegateRequest(fixture, 'session.operation.ack', async () =>
      controlResponse({ acknowledged: true })
    );

    vi.setSystemTime(authorization.dispatchDeadlineAt + 1);
    fixture.reload();
    await fixture.fireAlarm();
    await fixture.flush();
    // The report obligation recorded by the operation-result commit is enqueued
    // after this alarm's repair pass, so a second wake delivers it.
    await fixture.fireAlarm();
    await fixture.flush();

    expect(fixture.record('a')).toMatchObject({
      state: {
        kind: 'failed',
        source: 'operation_result',
        assistantReason: 'rate_limited',
        providerOwnership: 'unknown',
      },
    });
    expect(failedRunReport(reports, 'a')).toMatchObject({
      failureStage: 'agent_activity',
      failureCode: 'assistant_error',
      failureResponsibility: 'provider',
      failureReason: 'rate_limited',
    });
  });

  it('does not treat a coordinator token sent as wrapper text as a coordinator cause', async () => {
    const fixture = sessionFixture();
    const reports = captureCloudAgentReports(fixture);
    await fixture.admit('a');
    await fixture.flush();

    await fixture.rawEvent('session.message.outcome', {
      messageId: 'a',
      status: 'failed',
      reason: 'kilo_unhealthy',
    });
    await fixture.fireAlarm();
    await fixture.flush();

    expect(terminalSourceOf(fixture.record('a'))).toBe('wrapper_outcome');
    expect(failedRunReport(reports, 'a')).toMatchObject({
      failureStage: 'unknown',
      failureCode: 'unclassified',
      failureResponsibility: 'unknown',
      failureReason: 'unclassified',
    });
  });

  it('keeps arbitrary wrapper text unclassified', async () => {
    const fixture = sessionFixture();
    const reports = captureCloudAgentReports(fixture);
    await fixture.admit('a');
    await fixture.flush();

    await fixture.rawEvent('session.message.outcome', {
      messageId: 'a',
      status: 'failed',
      reason: 'some wrapper text',
    });
    await fixture.fireAlarm();
    await fixture.flush();

    expect(terminalSourceOf(fixture.record('a'))).toBe('wrapper_outcome');
    expect(failedRunReport(reports, 'a')).toMatchObject({
      failureStage: 'unknown',
      failureCode: 'unclassified',
      failureResponsibility: 'unknown',
      failureReason: 'unclassified',
    });
  });

  it('keeps the turn alive when a real event lands during a deferred sync', async () => {
    const fixture = sessionFixture();
    const sync = deferred<ResponseFrame>();
    delegateRequest(fixture, 'session.sync', () => sync.promise);
    await fixture.admit('a');
    await fixture.flush();
    const acceptedAt = acceptedAtOf(fixture.record('a'));
    if (acceptedAt === undefined) throw new Error('Missing accepted timestamp');

    vi.setSystemTime(acceptedAt + DEADLINE_MS.kiloInactivity);
    const alarm = fixture.fireAlarm();
    await vi.advanceTimersByTimeAsync(0);
    // Real progress arrives while the health check is awaiting its sync.
    await fixture.rawEvent('message.part.updated', {
      part: { id: 'prt_1', messageID: 'a', sessionID: 'kilo_root', type: 'text' },
    });
    sync.resolve(controlResponse({ status: { type: 'busy' }, questions: [], permissions: [] }));
    await alarm;
    await fixture.flush();

    expect(fixture.record('a')?.state.kind).toBe('accepted');
    expect(fixture.terminalEvents()).toHaveLength(0);
  });

  it.each([
    {
      name: 'question',
      type: 'question.asked',
      properties: { id: 'question_1', sessionID: 'kilo_root' },
    },
    {
      name: 'permission',
      type: 'permission.asked',
      properties: { id: 'permission_1', sessionID: 'kilo_root' },
    },
  ])(
    'keeps a watchdog and recovers once when a $name event supersedes the health-check sync',
    async ({ type, properties }) => {
      const fixture = sessionFixture();
      const sync = deferred<ResponseFrame>();
      delegateRequest(fixture, 'session.sync', () => sync.promise);
      await fixture.admit('a');
      await fixture.flush();
      const acceptedAt = acceptedAtOf(fixture.record('a'));
      if (acceptedAt === undefined) throw new Error('Missing accepted timestamp');

      vi.setSystemTime(acceptedAt + DEADLINE_MS.acceptedOverdue);
      const alarm = fixture.fireAlarm();
      await vi.advanceTimersByTimeAsync(0);
      // A pending-input event arrives while the health check awaits its sync,
      // changing the interaction scope and discarding the sync result as
      // superseded.
      await fixture.rawEvent(type, properties);
      sync.resolve(controlResponse({ status: { type: 'busy' }, questions: [], permissions: [] }));
      await alarm;
      await fixture.flush();

      // The watchdog must survive for the still-accepted turn.
      expect(fixture.record('a')?.state.kind).toBe('accepted');
      expect(fixture.alarmAt()).not.toBeNull();
      expect(fixture.alarmAt()!).toBeLessThanOrEqual(acceptedAt + DEADLINE_MS.kiloInactivity);

      // At the bound the same sync resolves empty. The revision is now stable,
      // so that empty snapshot replaces the pending input in KV before
      // `failOverdueAcceptedMessage` reads it: the turn spends its one no-output
      // recovery instead of terminalizing.
      vi.setSystemTime(acceptedAt + DEADLINE_MS.kiloInactivity);
      await fixture.fireAlarm();
      await fixture.flush();
      expect(fixture.record('a')).toMatchObject({
        state: { kind: 'queued', recoveryAttempts: 1 },
      });
      expect(failedReasonOf(fixture.record('a'))).toBeUndefined();
    }
  );

  it('keeps the inactivity failure after a late cancelled outcome', async () => {
    const fixture = sessionFixture();
    delegateRequest(fixture, 'session.sync', async () =>
      controlResponse({ status: { type: 'busy' }, questions: [], permissions: [] })
    );
    await fixture.admit('a');
    await fixture.flush();
    const acceptedAt = acceptedAtOf(fixture.record('a'));
    if (acceptedAt === undefined) throw new Error('Missing accepted timestamp');

    // Second identical detection: the turn already spent its one no-output
    // recovery, so the existing terminal path applies.
    markNoOutputRecoverySpent(fixture, 'a');
    vi.setSystemTime(acceptedAt + DEADLINE_MS.kiloInactivity);
    await fixture.fireAlarm();
    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'failed', reason: 'accepted_overdue' },
    });

    // A late cancelled outcome must not overwrite the settled failure.
    await fixture.outcome('a', 'cancelled');
    await fixture.flush();
    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'failed', reason: 'accepted_overdue' },
    });
    expect(fixture.terminalEvents()).toHaveLength(1);
  });

  it('recovers silent tool work once at the inactivity bound', async () => {
    const fixture = sessionFixture();
    delegateRequest(fixture, 'session.sync', async input => {
      expect(input.session).toEqual({
        sessionId: SESSION_ID,
        kiloSessionId: 'kilo_root',
        directory: DIRECTORY,
      });
      return controlResponse({ status: { type: 'busy' }, questions: [], permissions: [] });
    });
    await fixture.admit('a');
    await fixture.admit('b');
    await fixture.flush();
    const acceptedAt = acceptedAtOf(fixture.record('a'));
    if (acceptedAt === undefined) throw new Error('Missing accepted timestamp');

    // 90s: a snapshot is liveness, not progress, so the turn is waiting. The
    // check branch falls through to the tail, so the default prompt accepts the
    // queued follow-up. The next wake is capped toward the inactivity bound.
    vi.setSystemTime(acceptedAt + DEADLINE_MS.acceptedOverdue);
    await fixture.fireAlarm();
    expect(fixture.record('a')?.state.kind).toBe('accepted');
    expect(fixture.record('b')?.state.kind).toBe('accepted');
    // The recheck arms `now + acceptedAlarmCap`, but the in-alarm follow-up
    // delivery also arms its queue retry (`now + QUEUE_RETRY_MS`), which is
    // earlier. Either way the next wake is in the future and capped toward the
    // inactivity bound, never the already-elapsed 90s threshold.
    expect(fixture.alarmAt()).toBeGreaterThan(Date.now());
    expect(fixture.alarmAt()!).toBeLessThanOrEqual(acceptedAt + DEADLINE_MS.kiloInactivity);

    // At the inactivity bound a busy snapshot with no pending input is genuine
    // no output: the turn spends its one recovery and is re-queued for a fresh
    // runtime. This alarm returns, so the accepted follow-up is left alone.
    vi.setSystemTime(acceptedAt + DEADLINE_MS.kiloInactivity);
    await fixture.fireAlarm();
    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'queued', recoveryAttempts: 1 },
    });
    expect(failedReasonOf(fixture.record('a'))).toBeUndefined();
    expect(fixture.record('b')?.state.kind).toBe('accepted');
    expect(fixture.terminalEvents()).toHaveLength(0);
  });

  it.each([
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
  ])('keeps a turn parked on $name accepted at the inactivity bound', async snapshot => {
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
      return controlResponse(result);
    });
    await fixture.admit('a');
    await fixture.admit('b');
    await fixture.flush();
    const acceptedAt = acceptedAtOf(fixture.record('a'));
    if (acceptedAt === undefined) throw new Error('Missing accepted timestamp');

    // 90s: a pending-input snapshot is liveness, not progress, so the turn is
    // waiting. The next wake is capped toward the inactivity bound.
    vi.setSystemTime(acceptedAt + DEADLINE_MS.acceptedOverdue);
    await fixture.fireAlarm();
    expect(fixture.record('a')?.state.kind).toBe('accepted');
    expect(fixture.record('b')?.state.kind).toBe('accepted');
    expect(fixture.alarmAt()).not.toBeNull();
    expect(fixture.alarmAt()!).toBeGreaterThan(Date.now());
    expect(fixture.alarmAt()!).toBeLessThanOrEqual(acceptedAt + DEADLINE_MS.kiloInactivity);

    // At the bound the authoritative sync still reports the parked input, so
    // the guard refuses recovery and spends no attempt. The guard is
    // session-scoped: `b` is also accepted, and unresolved input anywhere in
    // the session means the watched turn is not proven no-output.
    vi.setSystemTime(acceptedAt + DEADLINE_MS.kiloInactivity);
    await fixture.fireAlarm();
    expect(fixture.record('a')).toMatchObject({ state: { kind: 'accepted' } });
    expect(recoveryAttemptsOf(fixture.record('a'))).toBeUndefined();
    expect(failedReasonOf(fixture.record('a'))).toBeUndefined();
    expect(fixture.record('b')?.state.kind).toBe('accepted');
    expect(fixture.terminalEvents()).toHaveLength(0);
    // Suppression re-arms a future recheck rather than a tight immediate loop.
    expect(fixture.alarmAt()).toBeGreaterThan(Date.now());
  });

  it('keeps and rearms an accepted turn when the sandbox is disconnected but still running', async () => {
    const fixture = sessionFixture();
    await fixture.admit('a');
    await fixture.flush();
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      physical: 'running',
      connection: 'disconnected',
      wrapperInstanceId: RUNTIME_ID,
    });
    const acceptedAt = acceptedAtOf(fixture.record('a'));
    if (acceptedAt === undefined) throw new Error('Missing accepted timestamp');

    vi.setSystemTime(acceptedAt + DEADLINE_MS.kiloInactivity);
    await fixture.fireAlarm();
    await fixture.flush();

    expect(fixture.record('a')?.state.kind).toBe('accepted');
    expect(fixture.alarmAt()).toBeGreaterThan(Date.now());
    expect(fixture.terminalEvents()).toHaveLength(0);
    expect(
      fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.abort')
    ).toHaveLength(0);
  });

  it('keeps and rearms when the health-check sync throws after a ready status', async () => {
    const fixture = sessionFixture();
    delegateRequest(fixture, 'session.sync', async () => {
      throw new Error('sync transport failed');
    });
    await fixture.admit('a');
    await fixture.flush();
    const acceptedAt = acceptedAtOf(fixture.record('a'));
    if (acceptedAt === undefined) throw new Error('Missing accepted timestamp');

    vi.setSystemTime(acceptedAt + DEADLINE_MS.kiloInactivity);
    await fixture.fireAlarm();
    await fixture.flush();

    expect(fixture.record('a')?.state.kind).toBe('accepted');
    expect(fixture.alarmAt()).toBeGreaterThan(Date.now());
  });

  it('fails the accepted turn and attempts a stop when the sandbox is authoritatively stopped', async () => {
    const fixture = sessionFixture();
    await fixture.admit('a');
    await fixture.flush();
    const abortRequests: SandboxControlOutboundRequest[] = [];
    delegateRequest(fixture, 'session.abort', async input => {
      abortRequests.push(input);
      return controlResponse({ status: 'unconfirmed' });
    });
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      physical: 'stopped',
      connection: 'disconnected',
      wrapperInstanceId: RUNTIME_ID,
    });
    const acceptedAt = acceptedAtOf(fixture.record('a'));
    if (acceptedAt === undefined) throw new Error('Missing accepted timestamp');

    vi.setSystemTime(acceptedAt + DEADLINE_MS.kiloInactivity);
    await fixture.fireAlarm();
    await fixture.flush();

    expect(fixture.record('a')?.state.kind).toBe('failed');
    expect(abortRequests).toHaveLength(1);
  });

  it.each([
    { name: 'unknown physical', physical: 'unknown' as const, connection: 'disconnected' as const },
    {
      name: 'stopping physical',
      physical: 'stopping' as const,
      connection: 'disconnected' as const,
    },
    {
      name: 'wrapper mismatch',
      physical: 'running' as const,
      connection: 'ready' as const,
      wrapperInstanceId: NEXT_RUNTIME_ID,
    },
  ])('keeps and rearms for $name while the sandbox is not stopped', async status => {
    const fixture = sessionFixture();
    await fixture.admit('a');
    await fixture.flush();
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      wrapperInstanceId: RUNTIME_ID,
      ...status,
    });
    const acceptedAt = acceptedAtOf(fixture.record('a'));
    if (acceptedAt === undefined) throw new Error('Missing accepted timestamp');

    vi.setSystemTime(acceptedAt + DEADLINE_MS.kiloInactivity);
    await fixture.fireAlarm();
    await fixture.flush();

    expect(fixture.record('a')?.state.kind).toBe('accepted');
    expect(fixture.alarmAt()).toBeGreaterThan(Date.now());
    expect(fixture.terminalEvents()).toHaveLength(0);
  });

  it.each(['rejected', 'uncertain'] as const)(
    'keeps and rearms when the accepted operation lookup is %s at the inactivity bound',
    async lookup => {
      const fixture = sessionFixture();
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: RUNTIME_ID,
        operationResults: true,
      });
      await fixture.admit('a');
      await fixture.flush();
      delegateRequest(fixture, 'session.operation.get', async () => {
        if (lookup === 'rejected') return controlFailure(true, 'not_ready');
        throw new Error('operation transport failed');
      });
      const acceptedAt = acceptedAtOf(fixture.record('a'));
      if (acceptedAt === undefined) throw new Error('Missing accepted timestamp');

      vi.setSystemTime(acceptedAt + DEADLINE_MS.kiloInactivity);
      await fixture.fireAlarm();
      await fixture.flush();

      expect(fixture.record('a')?.state.kind).toBe('accepted');
      expect(recoveryAttemptsOf(fixture.record('a'))).toBeUndefined();
      expect(fixture.alarmAt()).toBeGreaterThan(Date.now());
      expect(
        fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.abort')
      ).toHaveLength(0);
    }
  );

  it('recovers the accepted turn once when the operation is missing', async () => {
    const fixture = sessionFixture();
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      operationResults: true,
    });
    await fixture.admit('a');
    await fixture.flush();
    delegateRequest(fixture, 'session.operation.get', async () =>
      controlResponse({ state: 'missing' })
    );
    const acceptedAt = acceptedAtOf(fixture.record('a'));
    if (acceptedAt === undefined) throw new Error('Missing accepted timestamp');

    // The runtime is ready, so `missing` falls through to the snapshot path: an
    // unsuccessful operation lookup is not proof the turn is dead, and the turn
    // spends its one no-output recovery instead of terminalizing.
    vi.setSystemTime(acceptedAt + DEADLINE_MS.kiloInactivity);
    await fixture.fireAlarm();
    await fixture.flush();

    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'queued', recoveryAttempts: 1 },
    });
    expect(failedReasonOf(fixture.record('a'))).toBeUndefined();
  });

  it('fails a proof-backed accepted row and attempts a stop when the sandbox is physically stopped', async () => {
    const fixture = sessionFixture();
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      operationResults: true,
    });
    await fixture.admit('a');
    await fixture.flush();
    const abortRequests: SandboxControlOutboundRequest[] = [];
    delegateRequest(fixture, 'session.abort', async input => {
      abortRequests.push(input);
      return controlResponse({ status: 'unconfirmed' });
    });
    // A stopped observation is authoritative: the ready-runtime receipt must
    // not be consulted at all.
    delegateRequest(fixture, 'session.operation.get', async () =>
      controlResponse({ state: 'running' })
    );
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      physical: 'stopped',
      connection: 'disconnected',
      wrapperInstanceId: RUNTIME_ID,
      operationResults: true,
    });
    const acceptedAt = acceptedAtOf(fixture.record('a'));
    if (acceptedAt === undefined) throw new Error('Missing accepted timestamp');

    vi.setSystemTime(acceptedAt + DEADLINE_MS.kiloInactivity);
    await fixture.fireAlarm();
    await fixture.flush();

    expect(fixture.record('a')?.state.kind).toBe('failed');
    expect(abortRequests).toHaveLength(1);
    expect(
      fixture.control.request.mock.calls.filter(
        ([input]) => input.operation === 'session.operation.get'
      )
    ).toHaveLength(0);
  });

  it('keeps a proof-backed accepted row when the sandbox is disconnected but running', async () => {
    const fixture = sessionFixture();
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      operationResults: true,
    });
    await fixture.admit('a');
    await fixture.flush();
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      physical: 'running',
      connection: 'disconnected',
      wrapperInstanceId: RUNTIME_ID,
      operationResults: true,
    });
    const acceptedAt = acceptedAtOf(fixture.record('a'));
    if (acceptedAt === undefined) throw new Error('Missing accepted timestamp');

    vi.setSystemTime(acceptedAt + DEADLINE_MS.kiloInactivity);
    await fixture.fireAlarm();
    await fixture.flush();

    expect(fixture.record('a')?.state.kind).toBe('accepted');
    expect(fixture.alarmAt()).toBeGreaterThan(Date.now());
  });

  it.each([
    { label: 'unspent', spent: false },
    { label: 'spent', spent: true },
  ])(
    'keeps an accepted turn whose not-ready status is raced by a $label revision move',
    async ({ spent }) => {
      const fixture = sessionFixture();
      await fixture.admit('a');
      await fixture.flush();
      const acceptedAt = acceptedAtOf(fixture.record('a'));
      if (acceptedAt === undefined) throw new Error('Missing accepted timestamp');
      if (spent) markNoOutputRecoverySpent(fixture, 'a');
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'disconnected',
        wrapperInstanceId: RUNTIME_ID,
      });
      const status = deferred<ControlStatus>();
      fixture.control.getStatus.mockImplementation(() => status.promise);

      vi.setSystemTime(acceptedAt + DEADLINE_MS.kiloInactivity);
      const alarm = fixture.fireAlarm();
      await vi.advanceTimersByTimeAsync(0);
      // The question changes the interaction revision while the status read is
      // pending. A not-ready status is a blip, not recovery and not a supersede.
      await fixture.rawEvent('question.asked', { id: 'question_1', sessionID: 'kilo_root' });
      status.resolve({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'disconnected',
        wrapperInstanceId: RUNTIME_ID,
      });
      await alarm;
      await fixture.flush();

      expect(fixture.record('a')).toMatchObject({ state: { kind: 'accepted' } });
      expect(recoveryAttemptsOf(fixture.record('a'))).toBe(spent ? 1 : undefined);
      expect(fixture.alarmAt()).toBeGreaterThan(Date.now());
      expect(
        fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.abort')
      ).toHaveLength(0);
    }
  );

  it.each([
    { label: 'unspent', spent: false },
    { label: 'spent', spent: true },
  ])(
    'keeps an accepted turn whose sync throw is raced by a $label revision move',
    async ({ spent }) => {
      const fixture = sessionFixture();
      const sync = deferred<ResponseFrame>();
      delegateRequest(fixture, 'session.sync', () => sync.promise);
      await fixture.admit('a');
      await fixture.flush();
      const acceptedAt = acceptedAtOf(fixture.record('a'));
      if (acceptedAt === undefined) throw new Error('Missing accepted timestamp');
      if (spent) markNoOutputRecoverySpent(fixture, 'a');

      vi.setSystemTime(acceptedAt + DEADLINE_MS.kiloInactivity);
      const alarm = fixture.fireAlarm();
      await vi.advanceTimersByTimeAsync(0);
      await fixture.rawEvent('question.asked', { id: 'question_1', sessionID: 'kilo_root' });
      sync.reject(new Error('sync transport failed'));
      await alarm;
      await fixture.flush();

      expect(fixture.record('a')).toMatchObject({ state: { kind: 'accepted' } });
      expect(recoveryAttemptsOf(fixture.record('a'))).toBe(spent ? 1 : undefined);
      expect(fixture.alarmAt()).toBeGreaterThan(Date.now());
      expect(
        fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.abort')
      ).toHaveLength(0);
    }
  );

  it.each([
    { label: 'unspent', spent: false },
    { label: 'spent', spent: true },
  ])(
    'keeps an accepted turn whose returned control failure is raced by a $label revision move',
    async ({ spent }) => {
      const fixture = sessionFixture();
      const sync = deferred<ResponseFrame>();
      delegateRequest(fixture, 'session.sync', () => sync.promise);
      await fixture.admit('a');
      await fixture.flush();
      const acceptedAt = acceptedAtOf(fixture.record('a'));
      if (acceptedAt === undefined) throw new Error('Missing accepted timestamp');
      if (spent) markNoOutputRecoverySpent(fixture, 'a');

      vi.setSystemTime(acceptedAt + DEADLINE_MS.kiloInactivity);
      const alarm = fixture.fireAlarm();
      await vi.advanceTimersByTimeAsync(0);
      await fixture.rawEvent('question.asked', { id: 'question_1', sessionID: 'kilo_root' });
      // A resolved `{ ok: false }` is a failure, not a superseded `undefined`, so
      // the revision move cannot turn it into recovery.
      sync.resolve(controlFailure(true, 'not_ready'));
      await alarm;
      await fixture.flush();

      expect(fixture.record('a')).toMatchObject({ state: { kind: 'accepted' } });
      expect(recoveryAttemptsOf(fixture.record('a'))).toBe(spent ? 1 : undefined);
      expect(fixture.alarmAt()).toBeGreaterThan(Date.now());
      expect(
        fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.abort')
      ).toHaveLength(0);
    }
  );

  it('keeps the accepted turn when a superseded sync leaves a pending question', async () => {
    const fixture = sessionFixture();
    const sync = deferred<ResponseFrame>();
    delegateRequest(fixture, 'session.sync', () => sync.promise);
    await fixture.admit('a');
    await fixture.flush();
    const acceptedAt = acceptedAtOf(fixture.record('a'));
    if (acceptedAt === undefined) throw new Error('Missing accepted timestamp');

    vi.setSystemTime(acceptedAt + DEADLINE_MS.kiloInactivity);
    const alarm = fixture.fireAlarm();
    await vi.advanceTimersByTimeAsync(0);
    await fixture.rawEvent('question.asked', { id: 'question_1', sessionID: 'kilo_root' });
    sync.resolve(controlResponse({ status: { type: 'busy' }, questions: [], permissions: [] }));
    await alarm;
    await fixture.flush();

    // The resolved frame is superseded, not applied, so the pending question
    // stays in KV. `rescheduleAcceptedWatchdog` re-checks on the bound alarm and
    // `failOverdueAcceptedMessage` refuses recovery while that input is open.
    expect(fixture.record('a')).toMatchObject({ state: { kind: 'accepted' } });
    expect(recoveryAttemptsOf(fixture.record('a'))).toBeUndefined();
    expect(failedReasonOf(fixture.record('a'))).toBeUndefined();
  });

  it.each([
    {
      name: 'question',
      questions: [{ id: 'question_1', sessionID: 'kilo_root' }],
      permissions: [],
    },
    {
      name: 'permission',
      questions: [],
      permissions: [{ id: 'permission_1', sessionID: 'kilo_root' }],
    },
  ])(
    'keeps an accepted turn parked while the authoritative sync keeps reporting a $name',
    async snapshot => {
      const fixture = sessionFixture();
      delegateRequest(fixture, 'session.sync', async () =>
        controlResponse({
          status: { type: 'idle' },
          questions: snapshot.questions,
          permissions: snapshot.permissions,
        })
      );
      await fixture.admit('a');
      await fixture.flush();
      const acceptedAt = acceptedAtOf(fixture.record('a'));
      if (acceptedAt === undefined) throw new Error('Missing accepted timestamp');

      vi.setSystemTime(acceptedAt + DEADLINE_MS.kiloInactivity);
      await fixture.fireAlarm();
      await fixture.flush();

      expect(fixture.record('a')).toMatchObject({ state: { kind: 'accepted' } });
      expect(recoveryAttemptsOf(fixture.record('a'))).toBeUndefined();
      expect(failedReasonOf(fixture.record('a'))).toBeUndefined();
    }
  );

  it.each([
    {
      name: 'question',
      type: 'question.asked',
      properties: { id: 'question_1', sessionID: 'kilo_root' },
      questions: [{ id: 'question_1', sessionID: 'kilo_root' }],
      permissions: [],
    },
    {
      name: 'permission',
      type: 'permission.asked',
      properties: { id: 'permission_1', sessionID: 'kilo_root' },
      questions: [],
      permissions: [{ id: 'permission_1', sessionID: 'kilo_root' }],
    },
  ])(
    'keeps a turn parked when a $name supersedes the sync and the next sync still reports it',
    async snapshot => {
      const fixture = sessionFixture();
      const sync = deferred<ResponseFrame>();
      delegateRequest(fixture, 'session.sync', () => sync.promise);
      await fixture.admit('a');
      await fixture.flush();
      const acceptedAt = acceptedAtOf(fixture.record('a'));
      if (acceptedAt === undefined) throw new Error('Missing accepted timestamp');
      const attachRequestsBefore = fixture.control.request.mock.calls.filter(
        ([input]) => input.operation === 'session.attach'
      ).length;

      // First alarm: the input event moves the interaction revision while the
      // sync is awaited, so the resolved frame is superseded and only the KV
      // snapshot carries the input.
      vi.setSystemTime(acceptedAt + DEADLINE_MS.kiloInactivity);
      const firstAlarm = fixture.fireAlarm();
      await vi.advanceTimersByTimeAsync(0);
      await fixture.rawEvent(snapshot.type, snapshot.properties);
      sync.resolve(controlResponse({ status: { type: 'busy' }, questions: [], permissions: [] }));
      await firstAlarm;
      await fixture.flush();

      expect(fixture.record('a')).toMatchObject({ state: { kind: 'accepted' } });
      expect(recoveryAttemptsOf(fixture.record('a'))).toBeUndefined();
      expect(fixture.alarmAt()).toBeGreaterThan(Date.now());

      // Second alarm: the authoritative sync still reports the parked input, so
      // the guard refuses recovery again and re-arms a future recheck.
      delegateRequest(fixture, 'session.sync', async () =>
        controlResponse({
          status: { type: 'idle' },
          questions: snapshot.questions,
          permissions: snapshot.permissions,
        })
      );
      await fixture.fireAlarm();
      await fixture.flush();

      expect(fixture.record('a')).toMatchObject({ state: { kind: 'accepted' } });
      expect(recoveryAttemptsOf(fixture.record('a'))).toBeUndefined();
      expect(failedReasonOf(fixture.record('a'))).toBeUndefined();
      expect(fixture.alarmAt()).toBeGreaterThan(Date.now());
      expect(
        fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.attach')
      ).toHaveLength(attachRequestsBefore);
    }
  );

  it('restores recovery when a current empty snapshot clears stale pending input', async () => {
    const fixture = sessionFixture();
    delegateRequest(fixture, 'session.sync', async () =>
      controlResponse({ status: { type: 'idle' }, questions: [], permissions: [] })
    );
    await fixture.admit('a');
    await fixture.flush();
    const acceptedAt = acceptedAtOf(fixture.record('a'));
    if (acceptedAt === undefined) throw new Error('Missing accepted timestamp');

    // A stale question is in KV, but the current authoritative sync resolves
    // empty. The revision is stable, so the empty snapshot replaces the question
    // before the inactivity decision and recovery is allowed again.
    await fixture.rawEvent('question.asked', { id: 'question_1', sessionID: 'kilo_root' });

    vi.setSystemTime(acceptedAt + DEADLINE_MS.kiloInactivity);
    await fixture.fireAlarm();
    await fixture.flush();

    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'queued', recoveryAttempts: 1 },
    });
    expect(failedReasonOf(fixture.record('a'))).toBeUndefined();
  });

  it('restores recovery after question.replied clears the parked question', async () => {
    const fixture = sessionFixture();
    let result: {
      status: { type: string };
      questions: Array<{ id: string; sessionID: string }>;
      permissions: Array<{ id: string; sessionID: string }>;
    } = {
      status: { type: 'idle' },
      questions: [{ id: 'question_1', sessionID: 'kilo_root' }],
      permissions: [],
    };
    delegateRequest(fixture, 'session.sync', async () => controlResponse(result));
    await fixture.admit('a');
    await fixture.flush();
    const acceptedAt = acceptedAtOf(fixture.record('a'));
    if (acceptedAt === undefined) throw new Error('Missing accepted timestamp');

    // The question is parked: the snapshot path refreshes it and the guard
    // refuses recovery, so no attempt is spent.
    vi.setSystemTime(acceptedAt + DEADLINE_MS.kiloInactivity);
    await fixture.fireAlarm();
    await fixture.flush();
    expect(fixture.record('a')).toMatchObject({ state: { kind: 'accepted' } });
    expect(recoveryAttemptsOf(fixture.record('a'))).toBeUndefined();

    // The user answers. The reply drops the id from the snapshot, and the
    // answered snapshot is empty, so the next inactivity alarm is genuine no
    // output again and recovers once.
    await fixture.rawEvent('question.replied', { requestID: 'question_1' });
    expect(fixture.storage.kv.get('session_pending_interactions')).toMatchObject({
      questions: [],
    });
    result = { status: { type: 'idle' }, questions: [], permissions: [] };
    await fixture.fireAlarm();
    await fixture.flush();
    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'queued', recoveryAttempts: 1 },
    });
    expect(failedReasonOf(fixture.record('a'))).toBeUndefined();
  });

  it('keeps a proof-backed accepted turn parked on a question and recovers after the reply', async () => {
    const fixture = sessionFixture();
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      operationResults: true,
    });
    await fixture.admit('a');
    await fixture.flush();
    const authorization = fixture.record('a')?.proofs?.prompt?.authorization;
    if (!authorization) throw new Error('Missing prompt operation authorization');
    delegateRequest(fixture, 'session.operation.get', async () =>
      controlResponse({ state: 'running', authorization })
    );
    const acceptedAt = acceptedAtOf(fixture.record('a'));
    if (acceptedAt === undefined) throw new Error('Missing accepted timestamp');

    // A question is parked before the inactivity alarm. The proof-backed
    // `running` branch does not refresh interactions, so this KV write is the
    // only pending-input evidence the guard sees.
    await fixture.rawEvent('question.asked', { id: 'question_1', sessionID: 'kilo_root' });
    const attachRequestsBefore = fixture.control.request.mock.calls.filter(
      ([input]) => input.operation === 'session.attach'
    ).length;

    vi.setSystemTime(acceptedAt + DEADLINE_MS.kiloInactivity);
    await fixture.fireAlarm();
    await fixture.flush();

    // Unresolved input suppresses recovery for the proof-backed turn, and the
    // `running` branch re-arms without attaching.
    expect(fixture.record('a')).toMatchObject({ state: { kind: 'accepted' } });
    expect(recoveryAttemptsOf(fixture.record('a'))).toBeUndefined();
    expect(
      fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.attach')
    ).toHaveLength(attachRequestsBefore);

    // The reply clears the question. The next inactivity alarm is genuine no
    // output and recovers once on the proof path.
    await fixture.rawEvent('question.replied', { requestID: 'question_1' });
    await fixture.fireAlarm();
    await fixture.flush();
    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'queued', recoveryAttempts: 1 },
    });
    expect(failedReasonOf(fixture.record('a'))).toBeUndefined();
  });

  it.each([
    {
      name: 'connected connection',
      connection: 'connected' as const,
      physical: 'running' as const,
      spent: false,
    },
    {
      name: 'connected connection',
      connection: 'connected' as const,
      physical: 'running' as const,
      spent: true,
    },
    {
      name: 'stopping physical',
      connection: 'disconnected' as const,
      physical: 'stopping' as const,
      spent: false,
    },
    {
      name: 'stopping physical',
      connection: 'disconnected' as const,
      physical: 'stopping' as const,
      spent: true,
    },
    {
      name: 'wrapper mismatch',
      connection: 'ready' as const,
      physical: 'running' as const,
      wrapperInstanceId: NEXT_RUNTIME_ID,
      spent: false,
    },
    {
      name: 'wrapper mismatch',
      connection: 'ready' as const,
      physical: 'running' as const,
      wrapperInstanceId: NEXT_RUNTIME_ID,
      spent: true,
    },
  ])(
    'does not read the operation receipt unless the runtime is ready for $name ($spent)',
    async ({ connection, physical, wrapperInstanceId, spent }) => {
      const fixture = sessionFixture();
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: RUNTIME_ID,
        operationResults: true,
      });
      await fixture.admit('a');
      await fixture.flush();
      if (spent) markNoOutputRecoverySpent(fixture, 'a');
      delegateRequest(fixture, 'session.operation.get', async () =>
        controlResponse({ state: 'running' })
      );
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical,
        connection,
        wrapperInstanceId: wrapperInstanceId ?? RUNTIME_ID,
        operationResults: true,
      });
      const acceptedAt = acceptedAtOf(fixture.record('a'));
      if (acceptedAt === undefined) throw new Error('Missing accepted timestamp');

      vi.setSystemTime(acceptedAt + DEADLINE_MS.kiloInactivity);
      await fixture.fireAlarm();
      await fixture.flush();

      expect(fixture.record('a')).toMatchObject({ state: { kind: 'accepted' } });
      expect(recoveryAttemptsOf(fixture.record('a'))).toBe(spent ? 1 : undefined);
      expect(fixture.alarmAt()).toBeGreaterThan(Date.now());
      expect(
        fixture.control.request.mock.calls.filter(
          ([input]) => input.operation === 'session.operation.get'
        )
      ).toHaveLength(0);
      expect(
        fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.abort')
      ).toHaveLength(0);
    }
  );

  it('prompts a session_busy follow-up on two check alarms after the overdue bound', async () => {
    const fixture = sessionFixture();
    await fixture.admit('a');
    await fixture.flush();
    let busyPrompts = 0;
    delegateRequest(fixture, 'session.prompt', async input => {
      const parsed = sessionPromptPayloadSchema.parse(input.payload);
      if (parsed.messageId === 'a') return controlResponse({ messageId: 'a', status: 'accepted' });
      busyPrompts += 1;
      return controlFailure(true, 'session_busy');
    });
    await fixture.admit('b');
    await fixture.flush();

    expect(fixture.record('a')?.state.kind).toBe('accepted');
    expect(fixture.record('b')?.state.kind).toBe('queued');
    expect(busyPrompts).toBe(1);
    const acceptedAt = acceptedAtOf(fixture.record('a'));
    if (acceptedAt === undefined) throw new Error('Missing accepted timestamp');

    vi.setSystemTime(acceptedAt + DEADLINE_MS.acceptedOverdue);
    await fixture.fireAlarm();
    await fixture.flush();
    expect(busyPrompts).toBe(2);
    expect(fixture.record('b')?.state.kind).toBe('queued');

    await fixture.fireAlarm();
    await fixture.flush();
    expect(busyPrompts).toBe(3);
    expect(fixture.record('b')?.state.kind).toBe('queued');
    expect(fixture.record('a')?.state.kind).toBe('accepted');
  });

  it('does not prompt the re-queued head or a follow-up on the recovery alarm', async () => {
    const fixture = sessionFixture();
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      operationResults: true,
    });
    await fixture.admit('a');
    await fixture.flush();
    let busyPrompts = 0;
    let headPrompts = 0;
    delegateRequest(fixture, 'session.prompt', async input => {
      const parsed = sessionPromptPayloadSchema.parse(input.payload);
      if (parsed.messageId === 'a') {
        headPrompts += 1;
        return controlResponse({ messageId: 'a', status: 'accepted' });
      }
      busyPrompts += 1;
      return controlFailure(true, 'session_busy');
    });
    await fixture.admit('b');
    await fixture.flush();
    const authorization = fixture.record('a')?.proofs?.prompt?.authorization;
    if (!authorization) throw new Error('Missing prompt operation authorization');
    delegateRequest(fixture, 'session.operation.get', async () =>
      controlResponse({ state: 'running', authorization })
    );
    const acceptedAt = acceptedAtOf(fixture.record('a'));
    if (acceptedAt === undefined) throw new Error('Missing accepted timestamp');
    const headPromptsBeforeAlarm = headPrompts;

    vi.setSystemTime(acceptedAt + DEADLINE_MS.kiloInactivity);
    await fixture.fireAlarm();
    await fixture.flush();

    // The alarm that re-queued the watched head returns before the tail, so the
    // re-queued head and the session_busy follow-up are not prompted again.
    expect(headPrompts).toBe(headPromptsBeforeAlarm);
    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'queued', recoveryAttempts: 1 },
    });
    expect(busyPrompts).toBe(1);
    expect(fixture.record('b')?.state.kind).toBe('queued');
  });

  it.each([
    { label: 'throws', probe: 'throw', spent: false },
    { label: 'throws', probe: 'throw', spent: true },
    { label: 'returns running but connected', probe: 'connected', spent: false },
    { label: 'returns running but connected', probe: 'connected', spent: true },
    { label: 'returns running but disconnected', probe: 'disconnected', spent: false },
    { label: 'returns running but disconnected', probe: 'disconnected', spent: true },
  ])(
    'fails only the queued head when the delivery status probe $label ($spent)',
    async ({ probe, spent }) => {
      const fixture = sessionFixture();
      await fixture.admit('a');
      await fixture.flush();
      delegateRequest(fixture, 'session.prompt', async input => {
        const parsed = sessionPromptPayloadSchema.parse(input.payload);
        if (parsed.messageId === 'a')
          return controlResponse({ messageId: 'a', status: 'accepted' });
        return controlFailure(true, 'session_busy');
      });
      await fixture.admit('b');
      await fixture.flush();
      if (spent) markNoOutputRecoverySpent(fixture, 'a');
      const acceptedAt = acceptedAtOf(fixture.record('a'));
      if (acceptedAt === undefined) throw new Error('Missing accepted timestamp');
      expect(fixture.record('b')?.state.kind).toBe('queued');

      if (probe === 'throw') {
        fixture.control.getStatus.mockImplementation(async () => {
          throw new Error('status transport failed');
        });
      } else {
        fixture.control.getStatus.mockImplementation(async () => ({
          allocationIncarnation: 'incarnation_1',
          physical: 'running',
          connection: probe as ControlStatus['connection'],
          wrapperInstanceId: RUNTIME_ID,
        }));
      }

      vi.setSystemTime(acceptedAt + DEADLINE_MS.kiloInactivity);
      await fixture.fireAlarm();
      await fixture.flush();

      // The watchdog sees a blip and preserves the accepted turn; the tail's
      // readiness check fails only the queued head.
      expect(fixture.record('a')).toMatchObject({ state: { kind: 'accepted' } });
      expect(recoveryAttemptsOf(fixture.record('a'))).toBe(spent ? 1 : undefined);
      expect(fixture.record('b')).toMatchObject({
        state: { kind: 'failed', reason: 'environment_failed' },
      });
      expect(
        fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.abort')
      ).toHaveLength(0);
    }
  );

  it('fails the accepted sibling when the delivery status read is stopped', async () => {
    const fixture = sessionFixture();
    await fixture.admit('a');
    await fixture.flush();
    delegateRequest(fixture, 'session.prompt', async input => {
      const parsed = sessionPromptPayloadSchema.parse(input.payload);
      if (parsed.messageId === 'a') return controlResponse({ messageId: 'a', status: 'accepted' });
      return controlFailure(true, 'session_busy');
    });
    await fixture.admit('b');
    await fixture.flush();
    const acceptedAt = acceptedAtOf(fixture.record('a'));
    if (acceptedAt === undefined) throw new Error('Missing accepted timestamp');

    let statusCalls = 0;
    fixture.control.getStatus.mockImplementation(async () => {
      statusCalls += 1;
      if (statusCalls === 1) throw new Error('status transport failed');
      return {
        allocationIncarnation: 'incarnation_1',
        physical: 'stopped',
        connection: 'disconnected',
        wrapperInstanceId: RUNTIME_ID,
      };
    });
    const abortRequests: SandboxControlOutboundRequest[] = [];
    delegateRequest(fixture, 'session.abort', async input => {
      abortRequests.push(input);
      return controlResponse({ status: 'aborted', quiescent: false });
    });

    vi.setSystemTime(acceptedAt + DEADLINE_MS.kiloInactivity);
    await fixture.fireAlarm();
    await fixture.flush();

    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'failed', reason: 'runtime_unhealthy' },
    });
    expect(abortRequests).toHaveLength(1);
  });

  it.each(['returns not-ready', 'rejects'] as const)(
    'fails only the expired queued head when the replacement probe %s',
    async probe => {
      const fixture = sessionFixture();
      await fixture.admit('a');
      await fixture.flush();
      expect(activeWrapperInstanceId(fixture.record('a'))).toBe(RUNTIME_ID);
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'connected',
        wrapperInstanceId: RUNTIME_ID,
      });
      await fixture.admit('b');
      await fixture.flush();
      const b = fixture.record('b');
      expect(b?.state.kind).toBe('queued');
      expect(activeWrapperInstanceId(b)).toBe(RUNTIME_ID);
      expect(b?.state).not.toHaveProperty('deliveryRetryScope');
      const deadlineAt = deadlineAtOf(b);
      if (deadlineAt === undefined) throw new Error('Missing head delivery deadline');

      if (probe === 'rejects') {
        fixture.control.getStatus.mockImplementation(async () => {
          throw new Error('probe failed');
        });
      }
      vi.setSystemTime(deadlineAt);
      await fixture.fireAlarm();
      await fixture.flush();

      expect(fixture.record('b')).toMatchObject({
        state: { kind: 'failed', reason: 'preparation_timeout', at: deadlineAt },
      });
      expect(fixture.record('a')).toMatchObject({ state: { kind: 'accepted' } });
      expect(recoveryAttemptsOf(fixture.record('a'))).toBeUndefined();
      expect(
        fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.abort')
      ).toHaveLength(0);
    }
  );

  it('probes a serialized pre-send not_ready prompt refusal with an accepted sibling', async () => {
    const fixture = sessionFixture();
    await fixture.admit('a');
    await fixture.flush();
    expect(fixture.record('a')?.state.kind).toBe('accepted');
    let promptAttempts = 0;
    delegateRequest(fixture, 'session.prompt', async input => {
      const parsed = sessionPromptPayloadSchema.parse(input.payload);
      if (parsed.messageId === 'a') return controlResponse({ messageId: 'a', status: 'accepted' });
      promptAttempts += 1;
      throw Object.assign(new Error('Sandbox runtime is not ready'), {
        name: 'ControlRequestError',
        code: 'not_ready',
        retryable: true,
        admission: 'not-admitted',
      });
    });
    await fixture.admit('b');
    await fixture.flush();
    const deadlineAt = deadlineAtOf(fixture.record('b'));
    if (deadlineAt === undefined) throw new Error('Missing head delivery deadline');
    expect(promptFailuresOf(fixture.record('b'))).toBe(1);
    expect(fixture.record('b')?.state).toMatchObject({
      kind: 'queued',
      deliveryRetryScope: 'message',
    });

    for (let attempt = 2; attempt <= PROMPT_FAILURE_LIMIT; attempt++) {
      const retryAt = fixture.alarmAt();
      if (retryAt === null) throw new Error('Missing queue retry alarm');
      vi.setSystemTime(retryAt);
      await fixture.fireAlarm();
      await fixture.flush();
    }

    expect(promptAttempts).toBe(PROMPT_FAILURE_LIMIT);
    expect(Date.now()).toBeLessThan(deadlineAt);
    expect(fixture.record('b')).toMatchObject({
      state: { kind: 'failed', reason: 'prompt_exhausted' },
    });
    expect(fixture.record('a')?.state.kind).toBe('accepted');
  });

  it('fails a lone queued head as environment_failed when the post-attach status is stopped', async () => {
    const fixture = sessionFixture();
    await fixture.admit('a');
    const deadlineAt = deadlineAtOf(fixture.record('a'));
    if (deadlineAt === undefined) throw new Error('Missing head delivery deadline');
    fixture.control.getStatus.mockImplementation(async () => ({
      allocationIncarnation: 'incarnation_1',
      physical: 'stopped',
      connection: 'disconnected',
      wrapperInstanceId: RUNTIME_ID,
    }));
    await fixture.flush();

    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'failed', reason: 'environment_failed' },
    });
    expect(Date.now()).toBeLessThan(deadlineAt);
    expect(
      fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.abort')
    ).toHaveLength(0);
  });

  it('fails only the provider_unknown head when an accepted sibling shares the wrapper', async () => {
    const fixture = sessionFixture();
    await fixture.admit('a');
    await fixture.flush();
    expect(activeWrapperInstanceId(fixture.record('a'))).toBe(RUNTIME_ID);
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      physical: 'unknown',
      connection: 'disconnected',
      wrapperInstanceId: RUNTIME_ID,
    });
    await fixture.admit('b');
    await fixture.flush();

    expect(fixture.record('b')?.state.wrapperInstanceId).toBe(RUNTIME_ID);
    expect(fixture.record('b')).toMatchObject({
      state: { kind: 'failed', reason: 'provider_unknown' },
    });
    expect(fixture.record('a')?.state.kind).toBe('accepted');
    expect(
      fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.abort')
    ).toHaveLength(0);
  });

  it.each(['returns not-ready', 'rejects'] as const)(
    'fails only the unbound expired head when the replacement probe %s',
    async probe => {
      const fixture = sessionFixture();
      await fixture.admit('a');
      await fixture.flush();
      expect(activeWrapperInstanceId(fixture.record('a'))).toBe(RUNTIME_ID);
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'connected',
      });
      await fixture.admit('b');
      await fixture.flush();
      const b = fixture.record('b');
      expect(b?.state.kind).toBe('queued');
      expect(activeWrapperInstanceId(b)).toBeUndefined();
      expect(b?.state).not.toHaveProperty('deliveryRetryScope');
      expect(fixture.record('a')?.state.kind).toBe('accepted');
      const deadlineAt = deadlineAtOf(b);
      if (deadlineAt === undefined) throw new Error('Missing head delivery deadline');

      if (probe === 'rejects') {
        fixture.control.getStatus.mockImplementation(async () => {
          throw new Error('probe failed');
        });
      }
      vi.setSystemTime(deadlineAt);
      await fixture.fireAlarm();
      await fixture.flush();

      expect(fixture.record('b')).toMatchObject({
        state: { kind: 'failed', reason: 'preparation_timeout', at: deadlineAt },
      });
      expect(fixture.record('b')?.state.wrapperInstanceId).toBeUndefined();
      expect(fixture.record('a')).toMatchObject({ state: { kind: 'accepted' } });
      expect(recoveryAttemptsOf(fixture.record('a'))).toBeUndefined();
      expect(
        fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.abort')
      ).toHaveLength(0);
    }
  );

  it('fails only the unbound head when the initial ensureReady transport fails', async () => {
    const fixture = sessionFixture();
    await fixture.admit('a');
    await fixture.flush();
    expect(activeWrapperInstanceId(fixture.record('a'))).toBe(RUNTIME_ID);
    const ready = deferred<ControlStatus>();
    fixture.control.ensureReady.mockImplementation(() => ready.promise);
    await fixture.admit('b');
    await fixture.flush();
    const b = fixture.record('b');
    expect(b?.state.kind).toBe('queued');
    expect(activeWrapperInstanceId(b)).toBeUndefined();
    expect(b?.state).not.toHaveProperty('deliveryRetryScope');
    expect(fixture.record('a')?.state.kind).toBe('accepted');
    const deadlineAt = deadlineAtOf(b);
    if (deadlineAt === undefined) throw new Error('Missing head delivery deadline');

    ready.reject(new Error('ensureReady transport failed'));
    await fixture.flush();

    expect(Date.now()).toBeLessThan(deadlineAt);
    expect(fixture.record('b')).toMatchObject({
      state: { kind: 'failed', reason: 'environment_failed' },
    });
    expect(fixture.record('b')?.state.wrapperInstanceId).toBeUndefined();
    expect(fixture.record('a')?.state.kind).toBe('accepted');
    expect(
      fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.abort')
    ).toHaveLength(0);
  });

  it('fails only the unbound head as provider_unknown when ensureReady omits the wrapper', async () => {
    const fixture = sessionFixture();
    await fixture.admit('a');
    await fixture.flush();
    expect(activeWrapperInstanceId(fixture.record('a'))).toBe(RUNTIME_ID);
    const ready = deferred<ControlStatus>();
    fixture.control.ensureReady.mockImplementation(() => ready.promise);
    await fixture.admit('b');
    await fixture.flush();
    const b = fixture.record('b');
    expect(b?.state.kind).toBe('queued');
    expect(activeWrapperInstanceId(b)).toBeUndefined();
    expect(b?.state).not.toHaveProperty('deliveryRetryScope');
    const deadlineAt = deadlineAtOf(b);
    if (deadlineAt === undefined) throw new Error('Missing head delivery deadline');

    ready.resolve({
      allocationIncarnation: 'incarnation_1',
      physical: 'unknown',
      connection: 'disconnected',
    });
    await fixture.flush();

    expect(Date.now()).toBeLessThan(deadlineAt);
    expect(fixture.record('b')).toMatchObject({
      state: { kind: 'failed', reason: 'provider_unknown' },
    });
    expect(fixture.record('b')?.state.wrapperInstanceId).toBeUndefined();
    expect(fixture.record('a')?.state.kind).toBe('accepted');
    expect(
      fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.abort')
    ).toHaveLength(0);
  });

  it('dispatches a connected follow-up on the running operation without the first outcome', async () => {
    const fixture = sessionFixture();
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      operationResults: true,
    });
    await fixture.admit('a');
    await fixture.flush();
    await fixture.admit('b');
    await fixture.flush();

    expect(fixture.record('a')?.state.kind).toBe('accepted');
    expect(fixture.record('b')?.state.kind).toBe('accepted');
    const prompts = fixture.control.request.mock.calls.filter(
      ([input]) => input.operation === 'session.prompt'
    );
    expect(
      prompts.map(([input]) => sessionPromptPayloadSchema.parse(input.payload).messageId)
    ).toEqual(['a', 'b']);
    expect(
      fixture.control.request.mock.calls.filter(
        ([input]) => input.operation === 'session.operation.get'
      )
    ).toHaveLength(0);
  });

  it('keeps a session_busy follow-up queued and redispatches it on the alarm', async () => {
    const fixture = sessionFixture();
    await fixture.admit('a');
    await fixture.flush();
    let busyPrompts = 0;
    delegateRequest(fixture, 'session.prompt', async input => {
      const parsed = sessionPromptPayloadSchema.parse(input.payload);
      if (parsed.messageId === 'a') return controlResponse({ messageId: 'a', status: 'accepted' });
      busyPrompts += 1;
      return controlFailure(true, 'session_busy');
    });
    await fixture.admit('b');
    await fixture.flush();

    expect(fixture.record('a')?.state.kind).toBe('accepted');
    expect(fixture.record('b')?.state.kind).toBe('queued');
    expect(busyPrompts).toBe(1);

    await fixture.fireAlarm();
    await fixture.flush();
    expect(busyPrompts).toBe(2);
    expect(fixture.record('b')?.state.kind).toBe('queued');
  });

  it('ignores delayed old-runtime failures during a new runtime handoff and for its followers', async () => {
    const fixture = sessionFixture();
    await fixture.admit('a');
    await fixture.flush();
    await fixture.session.failWaitingMessages('old_runtime_failed', RUNTIME_ID);
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
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
      state: { kind: 'queued', wrapperInstanceId: NEXT_RUNTIME_ID },
    });
    await fixture.session.failWaitingMessages('late_old_runtime_failure', RUNTIME_ID);
    expect(fixture.record('b')?.state.kind).toBe('queued');
    expect(fixture.record('c')?.state.kind).toBe('queued');
    prompt.resolve(controlResponse({ messageId: 'b', status: 'accepted' }));
    await fixture.flush();
    expect(fixture.record('b')?.state.kind).toBe('accepted');
    expect(fixture.terminalEvents()).toHaveLength(1);
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
    expect(fixture.record('a')?.state.kind).toBe('completed');
    expect(fixture.record('b')?.state.kind).toBe('accepted');
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

  it('keeps an accepted turn pending interactions when a queued follow-up terminalizes', async () => {
    const fixture = sessionFixture();
    await fixture.admit('a');
    await fixture.flush();
    expect(fixture.record('a')?.state.kind).toBe('accepted');

    const question = {
      id: 'question_1',
      sessionID: 'kilo_root',
      questions: [{ question: 'Proceed?' }],
    };
    await fixture.rawEvent('question.asked', question);
    expect(fixture.storage.kv.get('session_pending_interactions')).toMatchObject({
      questions: [question],
    });

    delegateRequest(fixture, 'session.prompt', async input => {
      const parsed = sessionPromptPayloadSchema.parse(input.payload);
      if (parsed.messageId === 'a') return controlResponse({ messageId: 'a', status: 'accepted' });
      return controlFailure(true, 'session_busy');
    });
    await fixture.admit('b');
    await fixture.flush();
    expect(fixture.record('b')?.state.kind).toBe('queued');

    await fixture.outcome('b', 'failed');
    await fixture.flush();
    expect(fixture.record('b')?.state.kind).toBe('failed');
    // The running accepted turn still owns the session-wide interactions; the
    // queued follow-up's terminal event must not clear them.
    expect(fixture.storage.kv.get('session_pending_interactions')).toMatchObject({
      questions: [question],
    });
    expect(fixture.record('a')?.state.kind).toBe('accepted');
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
    await fixture.flush();
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
      pendingInteractions: { questions: [childQuestion], permissions: [childPermission] },
    });
    await fixture.flush();
    expect(fixture.storage.kv.get('session_pending_interactions')).toMatchObject({
      questions: [rootQuestion, childQuestion],
      permissions: [childPermission],
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
      expect(fixture.record('a')?.state.kind).toBe('accepted');
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
    await fixture.flush();
    expect(fixture.storage.kv.get('session_pending_interactions')).toBeUndefined();
    delegateRequest(fixture, 'session.sync', async input => {
      expect(input.session?.directory).toBe(DIRECTORY);
      return controlResponse({
        status: { type: 'busy' },
        questions: [{ id: 'q' }],
        permissions: [{ id: 'p' }],
      });
    });
    expect(await fixture.snapshot()).not.toHaveProperty('pendingInteractions');
    await fixture.flush();
    expect(fixture.storage.kv.get('session_pending_interactions')).toMatchObject({
      questions: [{ id: 'q' }],
      permissions: [{ id: 'p' }],
    });
    delegateRequest(fixture, 'session.sync', async () =>
      controlResponse({ status: { type: 'busy' }, questions: [], permissions: [] })
    );
    expect(await fixture.snapshot()).toMatchObject({
      pendingInteractions: { questions: [{ id: 'q' }], permissions: [{ id: 'p' }] },
    });
    await fixture.flush();
    expect(fixture.storage.kv.get('session_pending_interactions')).toMatchObject({
      questions: [],
      permissions: [],
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
      pendingInteractions: { questions: [question], permissions: [] },
    });
    await fixture.flush();
    expect(fixture.storage.kv.get('session_pending_interactions')).toMatchObject({
      questions: [],
      permissions: [],
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
    expect(fixture.record('warm')?.state.kind).toBe('queued');
    expect(fixture.eventQueries.findByEntityPrefix('preparation/attempt/')).toEqual(
      coldPreparation
    );
    expect(orchestrationMocks.broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ stream_event_type: 'preparing' })
    );
    ready.resolve({
      allocationIncarnation: 'incarnation_1',
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
    });
    await fixture.flush();
    expect(fixture.record('warm')?.state.kind).toBe('accepted');
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
    const fixture = sessionFixture();
    installModernRuntimeAuthorization(fixture);
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
        allocationIncarnation: 'incarnation_1',
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
      // The accepted union retains the preparation attempt (Amendment A), so the
      // attach request must carry the message's own recorded attempt.
      const coldAttemptId = fixture.record('cold')?.state.preparationAttemptId;
      expect(coldAttemptId).toBeDefined();
      expect(fixture.control.request).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'session.attach',
          payload: {
            ...initial,
            preparation: {
              attemptId: coldAttemptId,
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
      expect(fixture.record('warm')).toMatchObject({
        state: { kind: 'queued', unresolvedDispatch: true },
      });
      attached.resolve(controlResponse({ attached: true }));
      await fixture.flush();
      expect(fixture.control.request.mock.calls.map(([input]) => input.operation)).toEqual([
        'session.attach',
        'session.prompt',
      ]);
      expect(fixture.record('warm')).toMatchObject({
        state: { kind: 'accepted', wrapperInstanceId: RUNTIME_ID },
      });
      expect(unresolvedDispatchOf(fixture.record('warm'))).toBeUndefined();
      expect(orchestrationMocks.broadcast).not.toHaveBeenCalledWith(
        expect.objectContaining({ stream_event_type: 'preparing' })
      );
      expect(fixture.eventQueries.findByEntityPrefix('preparation/attempt/')).toEqual(
        coldPreparation
      );
      expect(await fixture.snapshot()).toMatchObject({ preparationSnapshots: coldPreparation });
    }
  );

  it('delivers a containment-off follow-up on the attached operation without re-attaching', async () => {
    const fixture = sessionFixture();
    const ready = {
      allocationIncarnation: 'incarnation_1',
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      operationResults: true,
      attachment: {
        ...ATTACHMENT,
        kilo: { ...ATTACHMENT.kilo, containmentEnabled: false },
      },
    } satisfies ControlStatus;
    fixture.setStatus(ready);
    fixture.control.ensureReady.mockResolvedValue(ready);

    await fixture.admit('a');
    await fixture.flush();
    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'accepted', wrapperInstanceId: RUNTIME_ID },
      proofs: { attach: { dispatched: true }, prompt: { dispatched: true } },
    });
    expect(fixture.control.attachSession).toHaveBeenCalledOnce();

    // An accepted row already admitted a prompt on this runtime, so the wrapper
    // rejects a second attach with `session_busy` while the operation is active.
    // Reporting it as a not-admitted rejection keeps a re-attaching follow-up
    // queued, so the assertions below fail instead of accepting it anyway.
    delegateRequest(fixture, 'session.attach', async () =>
      controlFailure(true, 'session_busy', 'not-admitted')
    );

    await fixture.admit('b');
    await fixture.flush();

    expect(
      fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.attach')
    ).toHaveLength(1);
    expect(fixture.control.attachSession).toHaveBeenCalledOnce();
    const prompts = fixture.control.request.mock.calls.filter(
      ([input]) => input.operation === 'session.prompt'
    );
    expect(
      prompts.map(([input]) => sessionPromptPayloadSchema.parse(input.payload).messageId)
    ).toEqual(['a', 'b']);
    expect(fixture.record('b')).toMatchObject({
      state: { kind: 'accepted', wrapperInstanceId: RUNTIME_ID },
      proofs: { prompt: { dispatched: true } },
    });
  });

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
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId,
      });
      if (reason === 'missing legacy attachment')
        fixture.values.delete('terminal_attached_session');
      orchestrationMocks.broadcast.mockClear();
      await fixture.admit('rebuild');
      await fixture.flush();
      expect(fixture.record('rebuild')).toMatchObject({
        state: { kind: 'accepted', wrapperInstanceId },
      });
      expect(fixture.control.ensureReady).toHaveBeenCalledTimes(2);
      expect(fixture.control.attachSession).toHaveBeenCalledTimes(2);
      expect(
        fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.attach')
      ).toHaveLength(2);
      expect(orchestrationMocks.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ stream_event_type: 'preparing' })
      );
      // The accepted union drops the preparation attempt; find the materialized
      // snapshot by its trigger instead of by a message-state id.
      const snapshot = getPreparationSnapshots(fixture.eventQueries)
        .map(row => JSON.parse(row.payload) as { action?: string; triggerMessageId?: string })
        .find(data => data.action === 'attempt_snapshot' && data.triggerMessageId === 'rebuild');
      expect(snapshot).toMatchObject({
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
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: RUNTIME_ID,
        attachment: ATTACHMENT,
      };
    });
    await fixture.admit('a');
    const acquisitionA = fixture.acquisition('a');
    await fixture.admit('b');
    await fixture.flush();
    expect(fixture.record('a')?.state.kind).toBe('accepted');
    expect(fixture.control.ensureReady).toHaveBeenCalledOnce();
    allowed = false;
    await fixture.outcome('a', 'completed');
    await fixture.flush();
    expect(fixture.record('b')).toMatchObject({
      state: { kind: 'failed', reason: 'environment_failed' },
    });
    expect(fixture.control.ensureReady).toHaveBeenCalledTimes(2);
    // The terminal union retains b's delivery identity (Amendment A), so the
    // warm handoff must reuse b's own attempt acquisition rather than a's.
    const bAcquisition = fixture.control.ensureReady.mock.calls[1]?.[0].acquisition;
    const bAttemptId = fixture.record('b')?.state.preparationAttemptId;
    expect(bAttemptId).toBeDefined();
    expect(bAcquisition).toMatchObject({ id: bAttemptId, deadlineAt: expect.any(Number) });
    expect(bAcquisition?.id).not.toBe(acquisitionA.id);
    expect(fixture.control.getStatus).toHaveBeenCalledOnce();
    await fixture.fireAlarm();
    expect(fixture.control.ensureReady).toHaveBeenCalledTimes(2);
    expect(
      fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.prompt')
    ).toHaveLength(1);
    allowed = true;
    await fixture.admit('c');
    const acquisitionC = fixture.acquisition('c');
    await fixture.flush();
    expect(fixture.record('c')?.state.kind).toBe('accepted');
    expect(fixture.control.ensureReady).toHaveBeenCalledTimes(3);
    expect(fixture.control.ensureReady).toHaveBeenLastCalledWith(
      expect.objectContaining({ acquisition: acquisitionC })
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

  it('gives a non-worktree control session the default auto-commit path', async () => {
    const fixture = sessionFixture();
    expect(fixture.metadata.workspace?.worktreeId).toBeUndefined();
    await expect(fixture.admit('a')).resolves.toMatchObject({ success: true });
    await fixture.flush();
    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'accepted', intent: { finalization: { autoCommit: true } } },
    });
    expect(fixture.control.request).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'session.prompt',
        payload: expect.objectContaining({ finalization: { autoCommit: true } }),
      })
    );
  });

  it('honors a non-worktree control session stored auto-commit override', async () => {
    const fixture = sessionFixture({ finalization: { autoCommit: false } });
    await expect(fixture.admit('a')).resolves.toMatchObject({ success: true });
    await fixture.flush();
    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'accepted', intent: { finalization: { autoCommit: false } } },
    });
  });

  it.each([
    [{ autoCommit: true }, { autoCommit: true }],
    [{ condenseOnComplete: true }, { autoCommit: true, condenseOnComplete: true }],
  ])(
    'defaults auto-commit for non-worktree follow-up %j through prompt handoff',
    async (submitted, effective) => {
      const fixture = sessionFixture();
      await expect(fixture.admit('a', { finalization: submitted })).resolves.toMatchObject({
        success: true,
      });
      await fixture.flush();
      const record = fixture.record('a');
      if (record?.state.kind !== 'accepted' || !record.state.intent) {
        throw new Error('expected accepted record');
      }
      expect(record.state.intent.finalization).toEqual(effective);
      expect(fixture.control.request).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'session.prompt',
          payload: expect.objectContaining({ finalization: effective }),
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
      state: { kind: 'accepted', intent: { finalization } },
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
    expect(supported.record('b')?.state.kind).toBe('accepted');
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

  it('does not cancel a new submission while aborting the previously accepted message', async () => {
    const fixture = sessionFixture();
    await fixture.admit('a');
    await fixture.flush();
    const abort = deferred<ResponseFrame>();
    delegateRequest(fixture, 'session.abort', () => abort.promise);
    const interruption = fixture.session.interruptExecution();
    await fixture.flush();
    await fixture.admit('b');
    await fixture.flush();
    // The accepted row waits for the abort result; the new submission is
    // delivered on the same wrapper and must not be cancelled with it.
    expect(fixture.record('a')?.state.kind).toBe('accepted');
    expect(fixture.record('b')?.state.kind).toBe('accepted');
    abort.resolve(controlResponse({ status: 'aborted' }));
    await expect(interruption).resolves.toEqual({ success: true });
    await fixture.flush();
    expect(fixture.record('a')?.state.kind).toBe('cancelled');
    expect(fixture.record('b')?.state.kind).not.toBe('cancelled');
    await fixture.fireAlarm();
    await fixture.flush();
    expect(fixture.record('b')?.state.kind).toBe('accepted');
  });

  it.each(['aborted', 'already_idle'] as const)(
    'sends one fenced abort and confirms an accepted message only after the wrapper reports %s',
    async status => {
      const fixture = sessionFixture();
      await fixture.admit('a');
      await fixture.flush();
      const abort = deferred<ResponseFrame>();
      const abortRequests: SandboxControlOutboundRequest[] = [];
      delegateRequest(fixture, 'session.abort', input => {
        abortRequests.push(input);
        return abort.promise;
      });
      fixture.control.ensureReady.mockClear();

      const interruption = fixture.session.interruptExecution();
      await fixture.flush();

      // The accepted row is not terminalized before the abort resolves.
      const pending = fixture.record('a');
      expect(pending?.state.kind).toBe('accepted');
      expect(pending?.cancellation?.operationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
      expect(pending?.cancellation?.deadlineAt).toBe(Date.now() + POLICY.cancellationDeadlineMs);
      expect(abortRequests).toHaveLength(1);
      const request = abortRequests[0];
      if (!request) throw new Error('Missing abort request');
      expect(request).toMatchObject({
        operation: 'session.abort',
        expectedWrapperInstanceId: RUNTIME_ID,
        session: { sessionId: SESSION_ID, kiloSessionId: 'kilo_root', directory: DIRECTORY },
        payload: {
          messageId: 'a',
          operationId: pending?.cancellation?.operationId,
          cleanupDeadlineAt: pending?.cancellation?.deadlineAt,
        },
      });
      // No allocation stop was dispatched.
      expect(fixture.control.ensureReady).not.toHaveBeenCalled();

      abort.resolve(controlResponse({ status }));
      await expect(interruption).resolves.toEqual({ success: true });
      await fixture.flush();
      expect(fixture.record('a')?.state.kind).toBe('cancelled');
      expect(fixture.terminalEvents()).toHaveLength(1);
      expect(
        fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.abort')
      ).toHaveLength(1);
    }
  );

  it('leaves the marker and reports unconfirmed when the wrapper cannot confirm the abort', async () => {
    const fixture = sessionFixture();
    await fixture.admit('a');
    await fixture.flush();
    delegateRequest(fixture, 'session.abort', async () =>
      controlResponse({ status: 'unconfirmed' })
    );

    await expect(fixture.session.interruptExecution()).resolves.toEqual({
      success: false,
      unconfirmed: true,
      message: expect.any(String),
    });
    await fixture.flush();
    const record = fixture.record('a');
    expect(record?.state.kind).toBe('accepted');
    expect(record?.cancellation).toBeDefined();
    expect(fixture.terminalEvents()).toHaveLength(0);
    expect(
      fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.abort')
    ).toHaveLength(1);
  });

  it('settles an expired cancellation marker on the alarm and unblocks the successor', async () => {
    const fixture = sessionFixture();
    await fixture.admit('a');
    await fixture.flush();
    delegateRequest(fixture, 'session.abort', async () =>
      controlResponse({ status: 'unconfirmed' })
    );
    await expect(fixture.session.interruptExecution()).resolves.toEqual({
      success: false,
      unconfirmed: true,
      message: expect.any(String),
    });
    await fixture.flush();
    const deadlineAt = fixture.record('a')?.cancellation?.deadlineAt;
    if (deadlineAt === undefined) throw new Error('Missing cancellation deadline');

    // A successor submitted after the interrupt is delivered on the same
    // wrapper while the cancellation marker is still live.
    await fixture.admit('b');
    await fixture.flush();
    expect(fixture.record('b')?.state.kind).toBe('accepted');

    // First alarm before expiry keeps the marker and arms at the deadline.
    await fixture.fireAlarm();
    await fixture.flush();
    expect(fixture.record('a')?.state.kind).toBe('accepted');
    expect(fixture.record('a')?.cancellation).toBeDefined();
    expect(fixture.alarmAt()).toBe(deadlineAt);

    // Second alarm at expiry settles the accepted row as an unconfirmed cancellation.
    vi.setSystemTime(deadlineAt);
    await fixture.fireAlarm();
    await fixture.flush();
    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'failed', reason: 'cancellation_unconfirmed' },
    });
    expect(fixture.terminalEvents()).toHaveLength(1);
    await fixture.fireAlarm();
    await fixture.flush();
    expect(fixture.record('b')?.state.kind).toBe('accepted');
  });

  it('records the marker and sends no abort when the accepted row has no wrapper instance', async () => {
    const fixture = sessionFixture();
    writeMessages(fixture.storage.kv, [acceptedWith('a')]);

    await expect(fixture.session.interruptExecution()).resolves.toEqual({
      success: false,
      unconfirmed: true,
      message: expect.any(String),
    });
    await fixture.flush();

    // No fence identity exists, so a replacement wrapper could answer the abort.
    expect(
      fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.abort')
    ).toHaveLength(0);
    const record = fixture.record('a');
    expect(record?.state.kind).toBe('accepted');
    expect(record?.cancellation?.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(record?.cancellation?.deadlineAt).toBe(Date.now() + POLICY.cancellationDeadlineMs);
    expect(fixture.alarmAt()).toBe(record?.cancellation?.deadlineAt);
  });

  it('records the marker before a missing sandbox return and settles it at the deadline', async () => {
    const fixture = sessionFixture({ workspace: { workspacePath: DIRECTORY } });
    writeMessages(fixture.storage.kv, [acceptedWith('a', { wrapperInstanceId: RUNTIME_ID })]);

    await expect(fixture.session.interruptExecution()).resolves.toEqual({
      success: false,
      unconfirmed: true,
      message: expect.any(String),
    });
    await fixture.flush();

    // The missing routing data must not skip the durable marker.
    expect(
      fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.abort')
    ).toHaveLength(0);
    const record = fixture.record('a');
    expect(record?.state.kind).toBe('accepted');
    const deadlineAt = record?.cancellation?.deadlineAt;
    if (deadlineAt === undefined) throw new Error('Missing cancellation deadline');
    expect(fixture.alarmAt()).toBe(deadlineAt);

    vi.setSystemTime(deadlineAt);
    await fixture.fireAlarm();
    await fixture.flush();
    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'failed', reason: 'cancellation_unconfirmed' },
    });
    expect(fixture.terminalEvents()).toHaveLength(1);
  });
});

describe('message-owned delivery identity fences', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses a late operation result after allocation loss cleared the identity', () => {
    const authorization: SessionOperationAuthorization = {
      operation: 'session.prompt',
      operationId: 'a',
      messageId: 'a',
      session: { sessionId: SESSION_ID, kiloSessionId: 'kilo_root', directory: DIRECTORY },
      wrapperInstanceId: RUNTIME_ID,
      dispatchDeadlineAt: 100,
    };
    const dispatchedPrompt: SessionOperationProof = { authorization, dispatched: true };
    const delivery: SessionOperationDelivery = {
      version: 2,
      authorization,
      completedAt: 300,
      result: { ok: true, result: { messageId: 'a', status: 'completed' } },
      outcome: { messageId: 'a', status: 'completed' },
      events: [],
      preparing: [],
    };
    const accepted: SessionAggregate = {
      binding: { kind: 'unbound' },
      messages: [
        {
          messageId: 'a',
          state: acceptedState({ wrapperInstanceId: RUNTIME_ID }),
          proofs: { prompt: dispatchedPrompt },
        },
      ],
    };
    // Positive control: the accepted message owns the wrapper, so the result applies.
    expect(applySessionOperationResult(accepted, delivery, 'hash', 300)).toMatchObject({
      disposition: 'applied',
    });
    // STOPPED terminalizes the turn and clears the delivery identity while the
    // dispatched proof survives.
    const stopped = terminalizeOnStop(accepted, 'allocation_stopped', 250);
    expect(stopped.messages[0]?.state.wrapperInstanceId).toBeUndefined();
    expect(stopped.messages[0]?.proofs?.prompt?.dispatched).toBe(true);
    // HEAD compares the union-wide message wrapper before the terminal branch, so
    // the late result is refused rather than acknowledged from the stale proof.
    expect(applySessionOperationResult(stopped, delivery, 'hash', 300)).toBeUndefined();
  });

  it('rejects a stale-attempt replay of a settled preparation before the settled branch', async () => {
    const fixture = sessionFixture();
    const attach = deferred<ResponseFrame>();
    fixture.setStatus({
      allocationIncarnation: 'incarnation_1',
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      operationResults: true,
    });
    delegateRequest(fixture, 'session.attach', () => attach.promise);
    await fixture.admit('a');
    await fixture.flush();
    const message = fixture.record('a');
    const attemptId = preparationAttemptIdOf(message);
    if (!message || !attemptId) throw new Error('Missing pending attach authority');
    // Settle the turn while retaining the preparation attempt (Amendment A).
    writeMessages(fixture.storage.kv, [
      {
        ...message,
        state: acceptedState({
          intent: message.state.intent,
          legacy: message.state.legacy,
          legacyInvalidIntent: undefined,
          acceptedAt: 1_000,
          wrapperInstanceId: RUNTIME_ID,
          preparationAttemptId: attemptId,
        }),
      },
    ]);
    const preparing = receiptedPreparing(
      1,
      {
        version: 2,
        attemptId,
        triggerMessageId: 'a',
        revision: 1,
        timestamp: Date.now(),
        step: 'workspace_setup',
        action: 'attempt_started',
        message: 'Preparing environment',
      },
      RUNTIME_ID
    );
    await expect(fixture.session.receiveSandboxControlPreparing(preparing)).resolves.toEqual({
      applied: true,
    });
    const before = structuredClone([...fixture.values]);
    // Same receipt identity, stale attempt: HEAD fences the attempt before the
    // settled branch, so this must not be acknowledged as a duplicate replay.
    const stale = {
      ...preparing,
      payload: { ...preparing.payload, attemptId: 'stale-attempt', revision: 2 },
    };
    await expect(fixture.session.receiveSandboxControlPreparing(stale)).resolves.toEqual({
      applied: false,
    });
    expect([...fixture.values]).toEqual(before);
  });

  it('requires the stored wrapper to acknowledge a replayed outcome for a terminal turn', async () => {
    const fixture = sessionFixture();
    writeMessages(fixture.storage.kv, [
      {
        messageId: 'a',
        state: terminalState('completed', {
          at: 10,
          source: 'wrapper_outcome',
          wrapperInstanceId: RUNTIME_ID,
        }),
      },
      {
        messageId: 'b',
        state: acceptedState({ wrapperInstanceId: NEXT_RUNTIME_ID }),
      },
    ]);
    // `b` owns the current runtime, but `a` retained a different wrapper. HEAD's
    // duplicate-outcome branch requires the stored wrapper to match, so the
    // replay is refused instead of acknowledged through the stale proof.
    await expect(
      fixture.session.receiveSandboxControlEvent({
        identity: {
          directory: DIRECTORY,
          kiloSessionId: 'kilo_root',
          rootKiloSessionId: 'kilo_root',
        },
        wrapperInstanceId: NEXT_RUNTIME_ID,
        payload: {
          type: 'session.message.outcome',
          properties: { messageId: 'a', status: 'completed' },
        },
      })
    ).resolves.toMatchObject({ applied: false });
  });

  it('fences runtime admission on the retained wrapper of a terminal-only session', async () => {
    const fixture = sessionFixture();
    writeMessages(fixture.storage.kv, [
      {
        messageId: 'a',
        state: terminalState('completed', {
          at: 10,
          source: 'wrapper_outcome',
          wrapperInstanceId: RUNTIME_ID,
        }),
      },
    ]);
    const send = (wrapperInstanceId: string) =>
      fixture.session.receiveSandboxControlEvent({
        identity: {
          directory: DIRECTORY,
          kiloSessionId: 'kilo_root',
          rootKiloSessionId: 'kilo_root',
        },
        wrapperInstanceId,
        payload: {
          type: 'session.status',
          properties: { sessionID: 'kilo_root', status: { type: 'busy' } },
        },
      });
    // The terminal row retains its wrapper, so a matching runtime is admitted…
    await expect(send(RUNTIME_ID)).resolves.toMatchObject({ applied: true });
    // …and a different runtime is fenced out instead of treated as unconstrained.
    await expect(send(NEXT_RUNTIME_ID)).resolves.toMatchObject({ applied: false });
  });

  it('never resurrects a terminal row from a stale queued or accepted copy', () => {
    const fixture = sessionFixture();
    const terminal: SessionMessage = {
      messageId: 'a',
      state: terminalState('failed', {
        reason: 'allocation_stopped',
        wrapperInstanceId: RUNTIME_ID,
        preparationAttemptId: 'attempt-1',
      }),
    };
    writeMessages(fixture.storage.kv, [terminal]);
    const save = (
      fixture.session as unknown as {
        saveMessages: (messages: SessionMessage[]) => boolean;
      }
    ).saveMessages.bind(fixture.session);
    const queuedCopy: SessionMessage = {
      messageId: 'a',
      state: queuedState({
        wrapperInstanceId: NEXT_RUNTIME_ID,
        preparationAttemptId: 'attempt-2',
      }),
    };
    const acceptedCopy: SessionMessage = {
      messageId: 'a',
      state: acceptedState({
        wrapperInstanceId: NEXT_RUNTIME_ID,
        preparationAttemptId: 'attempt-2',
      }),
    };
    expect(save([queuedCopy])).toBe(true);
    expect(fixture.record('a')).toEqual(terminal);
    expect(save([acceptedCopy])).toBe(true);
    expect(fixture.record('a')).toEqual(terminal);
  });

  it('settles a confirmed Stop as interrupted when runtime retirement reports the internal reason', async () => {
    const fixture = sessionFixture();
    await fixture.admit('a');
    await fixture.flush();
    delegateRequest(fixture, 'session.abort', async () =>
      controlResponse({ status: 'unconfirmed' })
    );
    await expect(fixture.session.interruptExecution()).resolves.toEqual({
      success: false,
      unconfirmed: true,
      message: expect.any(String),
    });
    await fixture.flush();
    // This exercises the retirement-notification receiver (`failWaitingMessages`
    // with the exact reason/wrapper/native triple). It does not exercise
    // `NativeRuntimeRetirement.complete -> notifyNativeRetirementReceivers ->
    // stub.failWaitingMessages`.
    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'accepted' },
      cancellation: { operationId: expect.any(String) },
    });

    fixture.storage.kv.put('native_runtime_fence', {
      sandboxId: SANDBOX_ID,
      wrapperInstanceId: RUNTIME_ID,
      nativeRuntimeId: NEXT_RUNTIME_ID,
      attachmentEpoch: 1,
      authorization: {
        operation: 'session.attach',
        operationId: '11111111-1111-4111-8111-111111111111',
        messageId: 'a',
        session: { sessionId: SESSION_ID, kiloSessionId: 'kilo_root', directory: DIRECTORY },
        wrapperInstanceId: RUNTIME_ID,
        dispatchDeadlineAt: Date.now() + 60_000,
      },
    });

    await fixture.session.failWaitingMessages('Scoped Stop cleanup', RUNTIME_ID, NEXT_RUNTIME_ID);

    expect(fixture.record('a')?.state.kind).toBe('cancelled');
    expect(failedReasonOf(fixture.record('a'))).toBeUndefined();
    const terminalEvents = fixture.terminalEvents();
    expect(terminalEvents).toHaveLength(1);
    expect(JSON.parse(terminalEvents[0]!.payload)).toMatchObject({
      messageId: 'a',
      status: 'interrupted',
      reason: 'interrupted',
      delivery: 'sent',
      accepted: true,
      error: 'The message was interrupted',
    });
    expect(terminalEvents[0]!.payload).not.toContain('Scoped Stop cleanup');
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

describe('recovery chunk 1: proof-based wait classification', () => {
  const wrapper = RUNTIME_ID;

  function authorization(
    operation: 'session.attach' | 'session.prompt',
    messageId: string,
    operationId: string
  ): SessionOperationAuthorization {
    return {
      operation,
      operationId,
      messageId,
      session: { sessionId: SESSION_ID, kiloSessionId: 'kilo_root', directory: DIRECTORY },
      wrapperInstanceId: wrapper,
      dispatchDeadlineAt: 500_000,
    };
  }

  type MessageOverrides = {
    state?: Omit<Partial<QueuedMessageState>, 'kind'> &
      Omit<Partial<AcceptedMessageState>, 'kind'> &
      Omit<Partial<FailedMessageState>, 'kind'> &
      Omit<Partial<CancelledMessageState>, 'kind'> & { kind?: SessionMessageState };
    proofs?: SessionMessage['proofs'];
    cancellation?: SessionMessage['cancellation'];
  };

  function queuedRecord(messageId: string, overrides: MessageOverrides = {}): SessionMessage {
    const { kind = 'queued', ...state } = overrides.state ?? {};
    const carried = {
      intent: { turn: { ...promptTurn, messageId }, agent: defaultAgent },
      legacyInvalidIntent: undefined,
      ...state,
    };
    return {
      messageId,
      state:
        kind === 'queued'
          ? queuedState(carried)
          : kind === 'accepted'
            ? acceptedState(carried)
            : terminalState(kind, carried),
      ...(overrides.proofs ? { proofs: overrides.proofs } : {}),
      ...(overrides.cancellation ? { cancellation: overrides.cancellation } : {}),
    };
  }

  const completedAttach: SessionOperationProof = {
    authorization: authorization('session.attach', 'attached', 'attempt-old'),
    dispatched: true,
    completedAt: 1_500,
    attachmentEpoch: 1,
  };
  const ambiguousAttach: SessionOperationProof = {
    authorization: authorization('session.attach', 'ambiguous', 'attempt-ambiguous'),
    dispatched: true,
  };
  const dispatchedPrompt: SessionOperationProof = {
    authorization: authorization('session.prompt', 'prompted', 'attempt-prompt'),
    dispatched: true,
  };

  describe('cancelPendingMessage', () => {
    it('drops a waiting queued message with a deadline and preparation state', () => {
      const messages = [
        queuedRecord('a', {
          state: {
            wrapperInstanceId: wrapper,
            preparationAttemptId: 'attempt-1',
            deadlineAt: 12_345,
            attachFailures: 1,
          },
        }),
      ];

      const result = cancelPendingMessage(boundAggregate(messages), 'a');

      expect(result.dropped).toBe(true);
      expect(result.messages?.[0]).toMatchObject({
        state: { kind: 'cancelled', reason: 'queued_message_cancelled' },
      });
    });

    it('drops a queued message with an in-flight (incomplete) attach proof', () => {
      const messages = [
        queuedRecord('a', {
          state: { wrapperInstanceId: wrapper },
          proofs: {
            attach: {
              authorization: authorization('session.attach', 'a', 'attempt-a'),
              dispatched: true,
            },
          },
        }),
      ];

      expect(cancelPendingMessage(boundAggregate(messages), 'a').dropped).toBe(true);
    });

    it('is idempotent for an already-cancelled queued message', () => {
      const messages = [
        queuedRecord('a', {
          state: { kind: 'cancelled', reason: 'queued_message_cancelled' },
        }),
      ];

      expect(cancelPendingMessage(boundAggregate(messages), 'a')).toEqual({ dropped: true });
    });

    it('refuses a dispatched prompt and an unresolved dispatch', () => {
      expect(
        cancelPendingMessage(
          boundAggregate([queuedRecord('prompted', { proofs: { prompt: dispatchedPrompt } })]),
          'prompted'
        )
      ).toEqual({ dropped: false });
      expect(
        cancelPendingMessage(
          boundAggregate([queuedRecord('a', { state: { unresolvedDispatch: true } })]),
          'a'
        )
      ).toEqual({ dropped: false });
    });

    it('a cancelled message cannot be revived by a late attach or prompt dispatch', () => {
      const cancelled = cancelPendingMessage(
        boundAggregate([
          queuedRecord('a', { state: { wrapperInstanceId: wrapper } }),
          queuedRecord('b'),
        ]),
        'a'
      );
      expect(cancelled.dropped).toBe(true);
      const messages = cancelled.messages ?? [];
      // The follower stays the usable head.
      expect(nextQueuedMessageId(messages)).toBe('b');

      expect(
        recordSessionOperationDispatch(messages, authorization('session.prompt', 'a', 'attempt-a'))
      ).toBeUndefined();
      expect(
        completeSessionOperationAttachment(
          messages,
          authorization('session.attach', 'a', 'attempt-a')
        )
      ).toBeUndefined();
    });
  });

  describe('cancellation race with a real attach completion', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      orchestrationMocks.broadcast.mockClear();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('cancelling the attach->prompt transition never dispatches the prompt and keeps the follower usable', async () => {
      const fixture = sessionFixture();
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: wrapper,
        operationResults: true,
      });
      // Hold the first post-attach status read so the real
      // completion -> prompt-dispatch transition is suspended mid-flight.
      const statusGate = deferred<ControlStatus>();
      fixture.control.getStatus.mockImplementationOnce(() => statusGate.promise);
      await fixture.admit('a');
      await fixture.admit('b');
      await fixture.flush();

      const completed = fixture.record('a');
      expect(completed?.proofs?.attach?.completedAt).toBeDefined();
      expect(completed?.proofs?.prompt).toBeUndefined();

      await expect(fixture.session.cancelQueuedMessage('a')).resolves.toEqual({ dropped: true });
      statusGate.resolve({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: wrapper,
      });
      await fixture.flush();

      expect(fixture.record('a')?.state.kind).toBe('cancelled');
      expect(
        fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.prompt')
      ).toHaveLength(0);
      expect(nextQueuedMessageId(readRawSessionMessages(fixture.storage.kv))).toBe('b');

      // The follower is still a usable head.
      await fixture.fireAlarm();
      await fixture.flush();
      expect(fixture.record('b')?.state.kind).toBe('accepted');
    });
  });

  describe('releaseUnadmittedWaitingMessages', () => {
    const wrapperA = 'wrapper-a';

    function queued(messageId: string, overrides: MessageOverrides = {}): SessionMessage {
      return queuedRecord(messageId, {
        ...overrides,
        state: { wrapperInstanceId: wrapperA, ...overrides.state },
      });
    }

    it('preserves deliveryDeadlineAt for a never-dispatched release', () => {
      const { messages } = releaseUnadmittedWaitingMessages(
        [
          queued('a', {
            state: {
              deadlineAt: 8_000,
              preparationAttemptId: 'attempt-1',
            },
          }),
        ],
        wrapperA
      );

      expect(messages[0]).toMatchObject({
        state: { kind: 'queued', deadlineAt: 8_000 },
      });
      expect(messages[0]?.state).not.toHaveProperty('wrapperInstanceId');
      expect(messages[0]?.state).not.toHaveProperty('preparationAttemptId');
    });

    it('releases an ambiguous attach only for an authoritative retirement', () => {
      const messages = [queued('ambiguous', { proofs: { attach: ambiguousAttach } })];

      expect(releaseUnadmittedWaitingMessages(messages, wrapperA).releasedIds).toEqual([]);

      const authoritative = releaseUnadmittedWaitingMessages(messages, wrapperA, {
        releaseDispatchedAttach: true,
      });
      expect(authoritative.releasedIds).toEqual(['ambiguous']);
      expect(authoritative.messages[0]).toMatchObject({
        proofs: { retiredAttach: ambiguousAttach },
      });
      expect(authoritative.messages[0]?.state).not.toHaveProperty('wrapperInstanceId');
      expect(authoritative.messages[0]?.state).not.toHaveProperty('unresolvedDispatch');
    });

    it('never releases a dispatched prompt proof', () => {
      const messages = [queued('prompted', { proofs: { prompt: dispatchedPrompt } })];
      expect(releaseUnadmittedWaitingMessages(messages, wrapperA).releasedIds).toEqual([]);
      expect(rotateLostPreparationAttempt(messages, 'prompted', 200)).toBeUndefined();
    });
  });

  describe('SandboxSession runtime invalidation scope', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      orchestrationMocks.broadcast.mockClear();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('terminalizes accepted/dispatched rows but preserves never-dispatched queued work', async () => {
      const fixture = sessionFixture();
      seedMessages(fixture.values, [
        queuedRecord('accepted', {
          state: { kind: 'accepted', acceptedAt: 1_000, wrapperInstanceId: wrapper },
        }),
        queuedRecord('prompted', {
          state: { wrapperInstanceId: wrapper },
          proofs: { prompt: dispatchedPrompt },
        }),
        queuedRecord('waiting', {
          state: {
            wrapperInstanceId: wrapper,
            preparationAttemptId: 'attempt-1',
            deadlineAt: 9_000,
          },
        }),
      ]);

      await fixture.session.failWaitingMessages('kilo_unhealthy', wrapper);

      expect(fixture.record('accepted')).toMatchObject({
        state: { kind: 'failed', reason: 'kilo_unhealthy' },
      });
      expect(fixture.record('prompted')).toMatchObject({
        state: { kind: 'failed', reason: 'kilo_unhealthy' },
      });
      expect(fixture.record('waiting')).toMatchObject({
        state: { kind: 'queued', deadlineAt: 9_000 },
      });
      expect(fixture.record('waiting')?.state).not.toHaveProperty('wrapperInstanceId');
      expect(fixture.record('waiting')?.state).not.toHaveProperty('preparationAttemptId');
    });

    it('releases a completed attach proof while preserving the original deadline and can rebind', async () => {
      const fixture = sessionFixture();
      const deadlineAt = Date.now() + 60_000;
      seedMessages(fixture.values, [
        queuedRecord('attached', {
          state: {
            wrapperInstanceId: wrapper,
            preparationAttemptId: 'attempt-old',
            deadlineAt: deadlineAt,
          },
          proofs: { attach: completedAttach },
        }),
      ]);

      await fixture.session.failWaitingMessages('kilo_unhealthy', wrapper);

      expect(fixture.record('attached')).toMatchObject({
        state: { kind: 'queued', deadlineAt: deadlineAt },
        proofs: { retiredAttach: completedAttach },
      });
      expect(fixture.record('attached')?.state).not.toHaveProperty('wrapperInstanceId');
      expect(fixture.record('attached')?.state).not.toHaveProperty('preparationAttemptId');
      expect(fixture.record('attached')?.proofs?.attach).toBeUndefined();

      // With the stale attach proof retired, `recordRuntime` can bind a replacement.
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: NEXT_RUNTIME_ID,
      });
      fixture.control.ensureReady.mockResolvedValue({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: NEXT_RUNTIME_ID,
        attachment: { ...ATTACHMENT },
      });
      await fixture.fireAlarm();
      await fixture.flush();
      expect(activeWrapperInstanceId(fixture.record('attached'))).toBe(NEXT_RUNTIME_ID);
    });

    it('releases an authoritatively not-admitted prompt and preserves its deadline', async () => {
      const fixture = sessionFixture();
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: wrapper,
        operationResults: true,
      });
      // A real not-admitted rejection: the prompt proof is recorded with
      // `dispatched: false` before the delivery error is handled.
      delegateRequest(fixture, 'session.prompt', async () =>
        controlFailure(true, 'not_ready', 'not-admitted')
      );
      await fixture.admit('a');
      await fixture.flush();

      const rejected = fixture.record('a');
      expect(rejected?.state.kind).toBe('queued');
      expect(rejected?.proofs?.prompt).toMatchObject({ dispatched: false });
      const deadlineAt = deadlineAtOf(rejected);
      expect(deadlineAt).toBeDefined();

      // A recoverable runtime invalidation must release this never-executed
      // proof, not terminalize the message as if it might have run.
      await fixture.session.failWaitingMessages('kilo_unhealthy', wrapper);

      expect(fixture.record('a')).toMatchObject({
        state: { kind: 'queued', deadlineAt: deadlineAt },
      });
      expect(fixture.record('a')?.state).not.toHaveProperty('wrapperInstanceId');
      expect(fixture.record('a')?.state).not.toHaveProperty('preparationAttemptId');
      expect(fixture.record('a')?.proofs?.prompt).toBeUndefined();
    });

    it('reconciles an ambiguous running attach without failing or quarantining the runtime', async () => {
      const fixture = sessionFixture();
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: wrapper,
        operationResults: true,
      });
      const attachAuthorization: SessionOperationAuthorization = {
        ...authorization('session.attach', 'a', 'attempt-ambiguous'),
        dispatchDeadlineAt: Date.now() + 60_000,
      };
      const deadlineAt = attachAuthorization.dispatchDeadlineAt;
      seedMessages(fixture.values, [
        queuedRecord('a', {
          state: {
            wrapperInstanceId: wrapper,
            preparationAttemptId: attachAuthorization.operationId,
            deadlineAt: deadlineAt,
            unresolvedDispatch: true,
          },
          proofs: { attach: { authorization: attachAuthorization, dispatched: true } },
        }),
      ]);
      delegateRequest(fixture, 'session.operation.get', async () =>
        controlResponse({
          state: 'running',
          authorization: attachAuthorization,
          executionDeadlineAt: Date.now() + 60_000,
        })
      );

      await fixture.fireAlarm();
      await fixture.flush();

      expect(fixture.record('a')).toMatchObject({ state: { kind: 'queued' } });
      expect(failedReasonOf(fixture.record('a'))).toBeUndefined();
      expect(fixture.terminalEvents()).toHaveLength(0);
      const retryAt = fixture.alarmAt();
      if (retryAt === null) throw new Error('Missing queue retry alarm');
      expect(retryAt).toBeLessThanOrEqual(deadlineAt);

      // The durable attach proof is reconciled against its original
      // authorization; no second `session.attach` dispatch is attempted.
      expect(
        fixture.control.request.mock.calls.filter(
          ([input]) => input.operation === 'session.operation.get'
        )
      ).toHaveLength(1);
      expect(
        fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.attach')
      ).toHaveLength(0);
    });

    it('resolves a running attach once it completes and then dispatches the prompt', async () => {
      const fixture = sessionFixture();
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: wrapper,
        operationResults: true,
      });
      const attachAuthorization: SessionOperationAuthorization = {
        ...authorization('session.attach', 'a', 'attempt-continuation'),
        dispatchDeadlineAt: Date.now() + 60_000,
      };
      seedMessages(fixture.values, [
        queuedRecord('a', {
          state: {
            wrapperInstanceId: wrapper,
            preparationAttemptId: attachAuthorization.operationId,
            deadlineAt: attachAuthorization.dispatchDeadlineAt,
            unresolvedDispatch: true,
          },
          proofs: { attach: { authorization: attachAuthorization, dispatched: true } },
        }),
      ]);
      let lookups = 0;
      delegateRequest(fixture, 'session.operation.get', async () => {
        lookups += 1;
        if (lookups === 1)
          return controlResponse({
            state: 'running',
            authorization: attachAuthorization,
            executionDeadlineAt: Date.now() + 60_000,
          });
        return controlResponse({
          state: 'completed',
          delivery: {
            version: 2,
            authorization: attachAuthorization,
            completedAt: Date.now(),
            result: { ok: true, result: { attached: true } },
            events: [],
            preparing: [],
          },
        });
      });

      await fixture.fireAlarm();
      await fixture.flush();
      expect(fixture.record('a')?.state.kind).toBe('queued');

      const retryAt = fixture.alarmAt();
      if (retryAt === null) throw new Error('Missing queue retry alarm');
      vi.setSystemTime(retryAt);
      await fixture.fireAlarm();
      await fixture.flush();

      expect(fixture.record('a')?.state.kind).toBe('accepted');
      expect(lookups).toBe(2);
      expect(
        fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.attach')
      ).toHaveLength(0);
      expect(
        fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.prompt')
      ).toHaveLength(1);
    });

    it('bounds a persistently running attach by the original head deadline', async () => {
      const fixture = sessionFixture();
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: wrapper,
        operationResults: true,
      });
      const attachAuthorization: SessionOperationAuthorization = {
        ...authorization('session.attach', 'a', 'attempt-persistent'),
        dispatchDeadlineAt: Date.now() + 60_000,
      };
      const deadlineAt = attachAuthorization.dispatchDeadlineAt;
      seedMessages(fixture.values, [
        queuedRecord('a', {
          state: {
            wrapperInstanceId: wrapper,
            preparationAttemptId: attachAuthorization.operationId,
            deadlineAt: deadlineAt,
            unresolvedDispatch: true,
          },
          proofs: { attach: { authorization: attachAuthorization, dispatched: true } },
        }),
      ]);
      delegateRequest(fixture, 'session.operation.get', async () =>
        controlResponse({
          state: 'running',
          authorization: attachAuthorization,
          executionDeadlineAt: Date.now() + 60_000,
        })
      );

      await fixture.fireAlarm();
      await fixture.flush();
      expect(fixture.record('a')?.state.kind).toBe('queued');

      let guard = 0;
      while (fixture.record('a')?.state.kind === 'queued') {
        if (++guard > 100) throw new Error('Attach reconcile did not reach the head deadline');
        const retryAt = fixture.alarmAt();
        if (retryAt === null) throw new Error('Missing queue retry alarm');
        expect(retryAt).toBeLessThanOrEqual(deadlineAt);
        vi.setSystemTime(retryAt);
        await fixture.fireAlarm();
        await fixture.flush();
      }

      expect(fixture.record('a')).toMatchObject({
        state: { kind: 'failed', reason: 'preparation_timeout', at: deadlineAt },
      });
      expect(fixture.terminalEvents()).toHaveLength(1);
    });

    it('keeps the existing terminal policy for a completed attach rejection', async () => {
      const fixture = sessionFixture();
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: wrapper,
        operationResults: true,
      });
      const attachAuthorization: SessionOperationAuthorization = {
        ...authorization('session.attach', 'a', 'attempt-rejected'),
        dispatchDeadlineAt: Date.now() + 60_000,
      };
      seedMessages(fixture.values, [
        queuedRecord('a', {
          state: {
            wrapperInstanceId: wrapper,
            preparationAttemptId: attachAuthorization.operationId,
            deadlineAt: attachAuthorization.dispatchDeadlineAt,
            unresolvedDispatch: true,
          },
          proofs: { attach: { authorization: attachAuthorization, dispatched: true } },
        }),
      ]);
      delegateRequest(fixture, 'session.operation.get', async () =>
        controlResponse({
          state: 'completed',
          delivery: {
            version: 2,
            authorization: attachAuthorization,
            completedAt: Date.now(),
            result: {
              ok: false,
              error: { code: 'not_ready', message: 'attach failed', retryable: false },
            },
            events: [],
            preparing: [],
          },
        })
      );

      await fixture.fireAlarm();
      await fixture.flush();

      expect(fixture.record('a')).toMatchObject({
        state: { kind: 'failed', reason: 'attach_exhausted' },
      });
      expect(fixture.terminalEvents()).toHaveLength(1);
      expect(
        fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.attach')
      ).toHaveLength(0);
    });

    it('classifies a completed attach rejection with a git subtype as a workspace setup failure', async () => {
      const fixture = sessionFixture();
      const reports = captureCloudAgentReports(fixture);
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: wrapper,
        operationResults: true,
      });
      const attachAuthorization: SessionOperationAuthorization = {
        ...authorization('session.attach', 'a', 'attempt-rejected'),
        dispatchDeadlineAt: Date.now() + 60_000,
      };
      seedMessages(fixture.values, [
        queuedRecord('a', {
          state: {
            wrapperInstanceId: wrapper,
            preparationAttemptId: attachAuthorization.operationId,
            deadlineAt: attachAuthorization.dispatchDeadlineAt,
            unresolvedDispatch: true,
          },
          proofs: { attach: { authorization: attachAuthorization, dispatched: true } },
        }),
      ]);
      delegateRequest(fixture, 'session.operation.get', async () =>
        controlResponse({
          state: 'completed',
          delivery: {
            version: 2,
            authorization: attachAuthorization,
            completedAt: Date.now(),
            result: {
              ok: false,
              error: {
                code: 'not_ready',
                message: 'git clone failed',
                retryable: false,
                subtype: 'git_rate_limited',
              },
            },
            events: [],
            preparing: [],
          },
        })
      );

      await fixture.fireAlarm();
      await fixture.flush();

      expect(fixture.record('a')).toMatchObject({
        state: { kind: 'failed', reason: 'attach_exhausted' },
        proofs: { attach: { rejectionSubtype: 'git_rate_limited' } },
      });
      expect(failedRunReport(reports, 'a')).toMatchObject({
        failureStage: 'pre_dispatch',
        failureCode: 'workspace_setup_failed',
        failureResponsibility: 'platform',
        failureReason: 'rate_limited',
      });
    });

    it('keeps the git subtype when a retryable completed attach rejection exhausts the budget', async () => {
      const fixture = sessionFixture();
      const reports = captureCloudAgentReports(fixture);
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: wrapper,
        operationResults: true,
      });
      const attachAuthorization: SessionOperationAuthorization = {
        ...authorization('session.attach', 'a', 'attempt-rejected'),
        dispatchDeadlineAt: Date.now() + 60_000,
      };
      seedMessages(fixture.values, [
        queuedRecord('a', {
          state: {
            wrapperInstanceId: wrapper,
            attachFailures: ATTACH_FAILURE_LIMIT - 1,
            preparationAttemptId: attachAuthorization.operationId,
            deadlineAt: attachAuthorization.dispatchDeadlineAt,
            unresolvedDispatch: true,
          },
          proofs: { attach: { authorization: attachAuthorization, dispatched: true } },
        }),
      ]);
      delegateRequest(fixture, 'session.operation.get', async () =>
        controlResponse({
          state: 'completed',
          delivery: {
            version: 2,
            authorization: attachAuthorization,
            completedAt: Date.now(),
            result: {
              ok: false,
              error: {
                code: 'not_ready',
                message: 'git clone failed',
                retryable: true,
                subtype: 'git_clone_timeout',
              },
            },
            events: [],
            preparing: [],
          },
        })
      );

      await fixture.fireAlarm();
      await fixture.flush();

      expect(fixture.record('a')).toMatchObject({
        state: { kind: 'failed', reason: 'attach_exhausted' },
      });
      expect(failedRunReport(reports, 'a')).toMatchObject({
        failureStage: 'pre_dispatch',
        failureCode: 'workspace_setup_failed',
        failureResponsibility: 'platform',
        failureReason: 'source_control_clone_timeout',
      });
    });

    it('does not fall back to a retired git subtype for a current subtype-less rejection', async () => {
      const fixture = sessionFixture();
      const reports = captureCloudAgentReports(fixture);
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: wrapper,
        operationResults: true,
      });
      const retiredAuthorization: SessionOperationAuthorization = {
        ...authorization('session.attach', 'a', 'attempt-retired'),
        dispatchDeadlineAt: Date.now() + 60_000,
      };
      const currentAuthorization: SessionOperationAuthorization = {
        ...authorization('session.attach', 'a', 'attempt-current'),
        dispatchDeadlineAt: Date.now() + 60_000,
      };
      seedMessages(fixture.values, [
        queuedRecord('a', {
          state: {
            wrapperInstanceId: wrapper,
            attachFailures: ATTACH_FAILURE_LIMIT - 1,
            preparationAttemptId: currentAuthorization.operationId,
            deadlineAt: currentAuthorization.dispatchDeadlineAt,
          },
          proofs: {
            retiredAttach: {
              authorization: retiredAuthorization,
              dispatched: true,
              rejectionSubtype: 'git_clone_timeout',
            },
          },
        }),
      ]);
      delegateRequest(fixture, 'session.attach', async () => controlFailure(true));

      await fixture.fireAlarm();
      await fixture.flush();

      expect(fixture.record('a')).toMatchObject({
        state: { kind: 'failed', reason: 'attach_exhausted' },
      });
      expect(failedRunReport(reports, 'a')).toMatchObject({
        failureStage: 'pre_dispatch',
        failureCode: 'wrapper_start_failed',
        failureResponsibility: 'platform',
        failureReason: 'runtime_startup',
      });
    });
  });

  describe('preparation deadline before reconciliation', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      orchestrationMocks.broadcast.mockClear();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('reconciles a dispatched queued prompt instead of failing on the preparation deadline', async () => {
      const fixture = sessionFixture();
      // Canonical ACCEPT needs a bound aggregate. Model a pre-C3b attachment
      // (wrapper without an incarnation) so the reconcile resolves the
      // authoritative incarnation instead of redispatching.
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: wrapper,
      });
      fixture.values.set('terminal_attached_session', {
        ownerId: 'user_1',
        sessionId: SESSION_ID,
        kiloSessionId: 'kilo_root',
        directory: DIRECTORY,
        sandboxId: SANDBOX_ID,
        wrapperInstanceId: wrapper,
      });
      const promptAuthorization: SessionOperationAuthorization = {
        ...authorization('session.prompt', 'a', 'a'),
        dispatchDeadlineAt: Date.now() + 60_000,
      };
      const executionDeadlineAt = Date.now() + 60_000;
      seedMessages(fixture.values, [
        queuedRecord('a', {
          state: {
            wrapperInstanceId: wrapper,
            preparationAttemptId: 'attempt-old',
            // The preparation deadline is already past; it must not bound a
            // prompt that has already been dispatched.
            deadlineAt: Date.now() - 1,
          },
          proofs: {
            prompt: {
              authorization: promptAuthorization,
              dispatched: true,
              executionDeadlineAt,
            },
          },
        }),
      ]);
      const lookup = vi.fn(async () =>
        controlResponse({
          state: 'running',
          authorization: promptAuthorization,
          executionDeadlineAt,
        })
      );
      delegateRequest(fixture, 'session.operation.get', lookup);

      await fixture.fireAlarm();
      await fixture.flush();

      expect(lookup).toHaveBeenCalledTimes(1);
      // The prompt reconcile runs ahead of the pending-cleanup transfer, so a
      // possibly-executing prompt is not reordered behind quarantine and no
      // past alarm can be armed.
      expect(fixture.alarmAt()).toBeGreaterThanOrEqual(Date.now());
      // The dispatched prompt is adopted as accepted; it is not re-dispatched
      // nor failed against the expired preparation deadline. Amendment A keeps
      // the original preparation attempt on the accepted union.
      expect(fixture.record('a')).toMatchObject({
        state: { kind: 'accepted', preparationAttemptId: 'attempt-old' },
      });
      expect(failedReasonOf(fixture.record('a'))).toBeUndefined();
      const details = getPreparationSnapshots(fixture.eventQueries)
        .map(row => JSON.parse(row.payload) as { action?: string })
        .filter(data => data.action === 'step_snapshot');
      expect(details).toHaveLength(0);
    });

    it('terminalizes a dispatched prompt once its execution bound passes unobserved', async () => {
      const fixture = sessionFixture();
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: wrapper,
        operationResults: true,
      });
      const passedAt = Date.now() - 1;
      const promptAuthorization: SessionOperationAuthorization = {
        ...authorization('session.prompt', 'a', 'a'),
        dispatchDeadlineAt: passedAt,
      };
      seedMessages(fixture.values, [
        queuedRecord('a', {
          state: {
            wrapperInstanceId: wrapper,
            preparationAttemptId: 'attempt-old',
            deadlineAt: passedAt,
          },
          proofs: {
            prompt: {
              authorization: promptAuthorization,
              dispatched: true,
              executionDeadlineAt: passedAt,
            },
          },
        }),
      ]);
      delegateRequest(fixture, 'session.operation.get', async () => {
        throw new Error('control transport down');
      });

      await fixture.fireAlarm();
      await fixture.flush();

      expect(fixture.record('a')).toMatchObject({
        state: { kind: 'failed', reason: 'prompt_exhausted' },
      });
    });

    it('keeps an unresolvable dispatched prompt visible, then fails it at the execution bound', async () => {
      const fixture = sessionFixture();
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        // No wrapper is exposed, so the incarnation-less legacy binding cannot be
        // resolved; the head must stay bounded rather than being failed early.
      });
      fixture.values.set('terminal_attached_session', {
        ownerId: 'user_1',
        sessionId: SESSION_ID,
        kiloSessionId: 'kilo_root',
        directory: DIRECTORY,
        sandboxId: SANDBOX_ID,
        wrapperInstanceId: wrapper,
      });
      const promptAuthorization: SessionOperationAuthorization = {
        ...authorization('session.prompt', 'a', 'a'),
        dispatchDeadlineAt: Date.now() + 60_000,
      };
      const executionDeadlineAt = Date.now() + 5_000;
      seedMessages(fixture.values, [
        queuedRecord('a', {
          state: {
            wrapperInstanceId: wrapper,
            preparationAttemptId: 'attempt-old',
            deadlineAt: Date.now() - 1,
          },
          proofs: {
            prompt: {
              authorization: promptAuthorization,
              dispatched: true,
              executionDeadlineAt,
            },
          },
        }),
      ]);
      let lookups = 0;
      delegateRequest(fixture, 'session.operation.get', async () => {
        lookups += 1;
        return controlResponse({
          state: 'running',
          authorization: promptAuthorization,
          executionDeadlineAt,
        });
      });

      await fixture.fireAlarm();
      await fixture.flush();
      // The unresolved condition stays visible while the execution bound is in
      // the future; it is not failed against the expired preparation deadline.
      expect(fixture.record('a')?.state.kind).toBe('queued');
      let guard = 0;
      while (fixture.record('a')?.state.kind === 'queued') {
        if (++guard > 100) throw new Error('Unresolved prompt reconcile did not reach the bound');
        const retryAt = fixture.alarmAt();
        if (retryAt === null) throw new Error('Missing queue retry alarm');
        expect(retryAt).toBeLessThanOrEqual(executionDeadlineAt);
        vi.setSystemTime(retryAt);
        await fixture.fireAlarm();
        await fixture.flush();
      }
      expect(lookups).toBeGreaterThan(1);
      expect(fixture.record('a')).toMatchObject({
        state: { kind: 'failed', reason: 'prompt_exhausted', at: executionDeadlineAt },
      });
    });

    it('keeps the bounded re-arm when a resolver race aborts the reconciliation', async () => {
      const fixture = sessionFixture();
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: wrapper,
      });
      fixture.values.set('terminal_attached_session', {
        ownerId: 'user_1',
        sessionId: SESSION_ID,
        kiloSessionId: 'kilo_root',
        directory: DIRECTORY,
        sandboxId: SANDBOX_ID,
        wrapperInstanceId: wrapper,
      });
      const promptAuthorization: SessionOperationAuthorization = {
        ...authorization('session.prompt', 'a', 'a'),
        dispatchDeadlineAt: Date.now() + 60_000,
      };
      const executionDeadlineAt = Date.now() + 5_000;
      seedMessages(fixture.values, [
        queuedRecord('a', {
          state: {
            wrapperInstanceId: wrapper,
            preparationAttemptId: 'attempt-old',
            deadlineAt: Date.now() - 1,
          },
          proofs: {
            prompt: {
              authorization: promptAuthorization,
              dispatched: true,
              executionDeadlineAt,
            },
          },
        }),
      ]);
      delegateRequest(fixture, 'session.operation.get', async () =>
        controlResponse({
          state: 'running',
          authorization: promptAuthorization,
          executionDeadlineAt,
        })
      );

      // First resolution hydrates, but a concurrent rebind races it: the
      // revalidation must abort instead of applying the stale incarnation. Later
      // resolutions are indeterminate, keeping the head bounded to its deadline.
      const prototype = Object.getPrototypeOf(fixture.session) as {
        resolveLegacyStopAttachment: (
          sandboxId: string,
          wrapperInstanceId: string
        ) => Promise<unknown>;
      };
      let resolverCalls = 0;
      const resolverSpy = vi
        .spyOn(prototype, 'resolveLegacyStopAttachment')
        .mockImplementation(async () => {
          resolverCalls += 1;
          if (resolverCalls === 1) {
            const attachment = fixture.values.get('terminal_attached_session') as Record<
              string,
              unknown
            >;
            fixture.values.set('terminal_attached_session', {
              ...attachment,
              wrapperInstanceId: 'raced-wrapper',
            });
            return { kind: 'hydrate', incarnation: 'raced-incarnation' };
          }
          return { kind: 'unresolved' };
        });

      try {
        await fixture.fireAlarm();
        await fixture.flush();

        // `aborted` must not short-circuit the bounded path: the head stays
        // queued, the raced hydration is not applied, and a retry is armed
        // inside the bound.
        expect(resolverCalls).toBeGreaterThanOrEqual(1);
        expect(fixture.record('a')?.state.kind).toBe('queued');
        expect(
          (fixture.values.get('terminal_attached_session') as { allocationIncarnation?: string })
            .allocationIncarnation
        ).toBeUndefined();
        let guard = 0;
        while (fixture.record('a')?.state.kind === 'queued') {
          if (++guard > 100) throw new Error('Aborted prompt reconcile did not reach the bound');
          const retryAt = fixture.alarmAt();
          if (retryAt === null) throw new Error('Missing queue retry alarm');
          expect(retryAt).toBeLessThanOrEqual(executionDeadlineAt);
          vi.setSystemTime(retryAt);
          await fixture.fireAlarm();
          await fixture.flush();
        }
        expect(fixture.record('a')).toMatchObject({
          state: { kind: 'failed', reason: 'prompt_exhausted', at: executionDeadlineAt },
        });
      } finally {
        resolverSpy.mockRestore();
      }
    });

    it('flushes deferred callback/report repair after reconciling a settled head', async () => {
      const fixture = sessionFixture();
      fixture.setStatus({
        physical: 'running',
        connection: 'ready',
        // No incarnation and no wrapper: the incarnation-less binding settles.
      });
      fixture.values.set('terminal_attached_session', {
        ownerId: 'user_1',
        sessionId: SESSION_ID,
        kiloSessionId: 'kilo_root',
        directory: DIRECTORY,
        sandboxId: SANDBOX_ID,
        wrapperInstanceId: wrapper,
      });
      const promptAuthorization: SessionOperationAuthorization = {
        ...authorization('session.prompt', 'a', 'a'),
        dispatchDeadlineAt: Date.now() + 60_000,
      };
      const executionDeadlineAt = Date.now() + 60_000;
      seedMessages(fixture.values, [
        queuedRecord('a', {
          state: {
            wrapperInstanceId: wrapper,
            preparationAttemptId: 'attempt-old',
            deadlineAt: Date.now() - 1,
          },
          proofs: {
            prompt: {
              authorization: promptAuthorization,
              dispatched: true,
              executionDeadlineAt,
            },
          },
        }),
      ]);
      delegateRequest(fixture, 'session.operation.get', async () =>
        controlResponse({
          state: 'running',
          authorization: promptAuthorization,
          executionDeadlineAt,
        })
      );
      const prototype = Object.getPrototypeOf(fixture.session) as {
        scheduleReportRepair: () => void;
      };
      const reports = vi.spyOn(prototype, 'scheduleReportRepair');

      await fixture.fireAlarm();
      await fixture.flush();

      // `settleReconciledHead` commits with repair scheduling deferred, so the
      // deferred report repair must be flushed after the transaction.
      expect(fixture.record('a')).toMatchObject({
        state: { kind: 'failed', reason: 'environment_stopped' },
      });
      expect(reports).toHaveBeenCalled();
    });
  });

  describe('wait visibility', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      orchestrationMocks.broadcast.mockClear();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('emits a stopped-environment wait reason without a pending cleanup', async () => {
      const fixture = sessionFixture();
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'stopped',
        connection: 'disconnected',
        wrapperInstanceId: wrapper,
      });
      seedMessages(fixture.values, [
        queuedRecord('a', {
          state: {
            wrapperInstanceId: wrapper,
            preparationAttemptId: 'attempt-1',
            deadlineAt: Date.now() + 60_000,
          },
        }),
      ]);

      await fixture.fireAlarm();
      await fixture.flush();

      expect(fixture.record('a')?.state.kind).toBe('queued');
      const details = getPreparationSnapshots(fixture.eventQueries)
        .map(
          row =>
            JSON.parse(row.payload) as { action?: string; stepSnapshot?: { latestDetail?: string } }
        )
        .filter(data => data.action === 'step_snapshot')
        .map(data => data.stepSnapshot?.latestDetail);
      expect(details).toContain('Waiting for the sandbox to become available…');
      const snapshot = (await fixture.snapshot()) as { cloudStatus?: unknown };
      expect(snapshot.cloudStatus).toMatchObject({
        type: 'preparing',
        message: 'Waiting for the sandbox to become available…',
      });
    });

    it('does not re-emit an unchanged stopped-environment reason on a second alarm', async () => {
      const fixture = sessionFixture();
      fixture.setStatus({
        allocationIncarnation: 'incarnation_1',
        physical: 'stopped',
        connection: 'disconnected',
        wrapperInstanceId: wrapper,
      });
      seedMessages(fixture.values, [
        queuedRecord('a', {
          state: {
            wrapperInstanceId: wrapper,
            preparationAttemptId: 'attempt-1',
            deadlineAt: Date.now() + 60_000,
          },
        }),
      ]);

      const waitStep = () =>
        getPreparationSnapshots(fixture.eventQueries)
          .map(
            row =>
              JSON.parse(row.payload) as {
                action?: string;
                stepSnapshot?: { revision?: number; latestDetail?: string };
              }
          )
          .find(
            data =>
              data.action === 'step_snapshot' &&
              data.stepSnapshot?.latestDetail === 'Waiting for the sandbox to become available…'
          )?.stepSnapshot;

      await fixture.fireAlarm();
      await fixture.flush();
      const first = waitStep();
      expect(first).toBeDefined();

      await fixture.fireAlarm();
      await fixture.flush();
      const second = waitStep();
      // An unchanged drain must leave the materialized step untouched; a
      // re-emission would bump its revision.
      expect(second?.revision).toBe(first?.revision);
    });
  });

  describe('coordinator failure and interrupt', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      orchestrationMocks.broadcast.mockClear();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('fails queued immediately when coordinator metadata is missing', async () => {
      const fixture = sessionFixture({ workspace: { workspacePath: DIRECTORY } });
      seedMessages(fixture.values, [queuedRecord('a')]);

      await fixture.fireAlarm();
      await fixture.flush();

      expect(fixture.record('a')).toMatchObject({
        state: { kind: 'failed', reason: 'missing_metadata' },
      });
    });

    it('interrupts a waiting queued row without sending it', async () => {
      const fixture = sessionFixture();
      seedMessages(fixture.values, [
        queuedRecord('a', {
          state: {
            wrapperInstanceId: wrapper,
            preparationAttemptId: 'attempt-1',
            deadlineAt: Date.now() + 60_000,
          },
        }),
      ]);

      await expect(fixture.session.interruptExecution()).resolves.toEqual({ success: true });
      expect(fixture.record('a')?.state.kind).toBe('cancelled');
      const sent = orchestrationMocks.broadcast.mock.calls.filter(
        ([event]) =>
          (event as { stream_event_type?: string } | undefined)?.stream_event_type ===
          'cloud.message.sent'
      );
      expect(sent).toHaveLength(0);
    });
  });

  describe('delivery caps during waits', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      orchestrationMocks.broadcast.mockClear();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('does not increment caps when the runtime is not ready', async () => {
      const fixture = sessionFixture();
      fixture.control.ensureReady.mockResolvedValue({
        allocationIncarnation: 'incarnation_1',
        physical: 'running',
        connection: 'disconnected',
      });
      await fixture.admit('a');
      await fixture.flush();

      expect(fixture.record('a')).toMatchObject({ state: { kind: 'queued' } });
      expect(attachFailuresOf(fixture.record('a'))).toBe(0);
    });

    it('still increments attach caps against a ready runtime', async () => {
      const fixture = sessionFixture();
      delegateRequest(fixture, 'session.attach', async () => controlFailure(true));
      await fixture.admit('a');
      await fixture.flush();

      expect(attachFailuresOf(fixture.record('a'))).toBe(1);
    });
  });
});
