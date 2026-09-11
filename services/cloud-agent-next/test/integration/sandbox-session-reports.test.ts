/**
 * Integration tests for control-plane Cloud Agent run-state reporting.
 *
 * These drive the real `SandboxSession` Durable Object through admission,
 * acceptance, terminal, and deletion commits with a captured
 * `CLOUD_AGENT_REPORT_QUEUE`. They reach the DO transaction boundary and the
 * durable report outbox; they do not reach the report consumer, PostgreSQL
 * store, admin views, or the sandbox control plane (dispatch is suppressed
 * because these sessions have no provisioned sandbox).
 */
import { abortAllDurableObjects, env, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudAgentQueueReport } from '@kilocode/worker-utils/cloud-agent-queue-report';
import type { SandboxSession } from '../../src/sandbox-session/SandboxSession.js';
import type {
  SessionMessageRecord,
  SessionMessageTerminalSource,
} from '../../src/sandbox-session/session-message-queue.js';
import { applyMessageOutcome } from '../../src/sandbox-session/session-message-queue.js';
import {
  REPORT_OUTBOX_PREFIX,
  parsePendingRunReport,
  readReportAnchor,
} from '../../src/sandbox-session/report-outbox.js';

const ownerId = 'report-owner';
const kiloSessionId = 'ses_12345678901234567890123456';
const agent = { mode: 'code' as const, model: 'anthropic/claude-sonnet-4' };

function sessionId(): string {
  return `workspace_${crypto.randomUUID()}`;
}

function sessionStub(id: string) {
  return env.SANDBOX_SESSION.getByName(`${ownerId}:${id}`);
}

function injectReportQueue(instance: SandboxSession, captured: CloudAgentQueueReport[]): void {
  (
    instance as unknown as { env: { CLOUD_AGENT_REPORT_QUEUE: { send: unknown } } }
  ).env.CLOUD_AGENT_REPORT_QUEUE = {
    send: async (report: CloudAgentQueueReport) => {
      captured.push(report);
    },
  };
}

function suppressDispatch(instance: SandboxSession): void {
  (instance as unknown as Record<string, unknown>)['deliverQueuedMessage'] = async () =>
    undefined;
}

function readMessages(state: DurableObjectState): SessionMessageRecord[] {
  return state.storage.kv.get<SessionMessageRecord[]>('session_messages') ?? [];
}

function readObligation(
  state: DurableObjectState,
  messageId: string
): ReturnType<typeof parsePendingRunReport> {
  return parsePendingRunReport(
    state.storage.kv.get<unknown>(`${REPORT_OUTBOX_PREFIX}${messageId}`)
  );
}

async function register(instance: SandboxSession, id: string): Promise<void> {
  await instance.registerSession({
    identity: { sessionId: id, userId: ownerId },
    auth: { kiloSessionId, kilocodeToken: 'test-token' },
    agent,
  });
}

function admit(instance: SandboxSession, messageId: string): Promise<unknown> {
  return instance.admitSubmittedMessage({
    userId: ownerId,
    turn: { type: 'prompt', id: messageId, prompt: `prompt ${messageId}` },
    agent,
  });
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ valid: true }));
});

afterEach(async () => {
  await reset();
  vi.restoreAllMocks();
});

describe('control-plane run-state reporting', () => {
  it('commits a queued obligation with the first-message anchor before any queue send', async () => {
    const id = sessionId();
    const messageId = 'msg_018f1e2d3c4bQueuedReportAB';
    const captured: CloudAgentQueueReport[] = [];

    const result = await runInDurableObject(sessionStub(id), async (instance, state) => {
      injectReportQueue(instance, captured);
      suppressDispatch(instance);
      await register(instance, id);
      await admit(instance, messageId);
      const first = readMessages(state).find(message => message.messageId === messageId);
      const obligation = readObligation(state, messageId);
      const anchor = readReportAnchor(state.storage);
      const replay = await admit(instance, messageId);
      const second = readMessages(state).find(message => message.messageId === messageId);
      const obligationAfterReplay = readObligation(state, messageId);
      return { first, second, obligation, obligationAfterReplay, anchor, replay };
    });

    expect(captured).toEqual([]);
    expect(result.first?.queuedAt).toEqual(expect.any(Number));
    expect(result.second?.queuedAt).toBe(result.first?.queuedAt);
    expect(result.replay).toMatchObject({ success: true, outcome: 'queued' });
    expect(result.anchor).toEqual({
      version: 1,
      kiloSessionId,
      initialMessageId: messageId,
      createdAt: expect.any(Number),
    });
    expect(result.obligation?.obligationId).toEqual(expect.any(String));
    expect(result.obligationAfterReplay?.obligationId).toBe(result.obligation?.obligationId);
    expect(result.obligation?.report.session).toEqual({
      cloudAgentSessionId: id,
      kiloSessionId,
      initialMessageId: messageId,
      reportingCreatedAt: new Date(result.anchor?.createdAt ?? 0).toISOString(),
    });
    expect(result.obligation?.report.run).toMatchObject({
      messageId,
      status: 'queued',
      queuedAt: new Date(result.first?.queuedAt ?? 0).toISOString(),
    });
    expect(result.obligation?.report.run).not.toHaveProperty('dispatchAcceptedAt');
    expect(result.obligation?.report.run).not.toHaveProperty('terminalAt');
  });

  it('never anchors an existing session using a later follow-up id', async () => {
    const id = sessionId();
    const seededMessageId = 'msg_018f1e2d3c4bSeededExisting';
    const followUpId = 'msg_018f1e2d3c4bLaterFollowUpA';
    const captured: CloudAgentQueueReport[] = [];

    const result = await runInDurableObject(sessionStub(id), async (instance, state) => {
      injectReportQueue(instance, captured);
      suppressDispatch(instance);
      await register(instance, id);
      // Pre-existing message and no anchor: a legacy/unanchored session.
      state.storage.kv.put('session_messages', [
        { messageId: seededMessageId, state: 'completed', terminalAt: Date.now() },
      ]);
      await admit(instance, followUpId);
      return {
        anchor: readReportAnchor(state.storage),
        obligation: readObligation(state, followUpId),
        seeded: readMessages(state).some(message => message.messageId === seededMessageId),
      };
    });

    expect(result.anchor).toBeUndefined();
    expect(result.seeded).toBe(true);
    expect(result.obligation?.report.session).toEqual({ cloudAgentSessionId: id });
    expect(result.obligation?.report.session).not.toHaveProperty('initialMessageId');
  });

  it('aborts admission and rolls back the message when the report obligation cannot be written', async () => {
    const id = sessionId();
    const messageId = 'msg_018f1e2d3c4bAtomicAbortAB';

    const result = await runInDurableObject(sessionStub(id), async (instance, state) => {
      suppressDispatch(instance);
      await register(instance, id);
      const original = (instance as unknown as { reportOutbox: unknown }).reportOutbox;
      (instance as unknown as { reportOutbox: unknown }).reportOutbox = {
        ...(original as object),
        record: () => {
          throw new Error('report obligation write failed');
        },
      };
      let succeeded = false;
      let threw = false;
      try {
        const admission = (await admit(instance, messageId)) as { success?: boolean };
        succeeded = admission.success === true;
      } catch {
        threw = true;
      } finally {
        (instance as unknown as { reportOutbox: unknown }).reportOutbox = original;
      }
      return { succeeded, threw, messages: readMessages(state) };
    });

    expect(result.succeeded).toBe(false);
    expect(result.threw || !result.succeeded).toBe(true);
    expect(result.messages.some(message => message.messageId === messageId)).toBe(false);
  });

  it('reports observed acceptance with no fabricated terminal facts', async () => {
    const id = sessionId();
    const messageId = 'msg_018f1e2d3c4bAccepteedAB';
    const captured: CloudAgentQueueReport[] = [];
    const acceptedAt = Date.now();

    await runInDurableObject(sessionStub(id), async (instance, state) => {
      injectReportQueue(instance, captured);
      suppressDispatch(instance);
      await register(instance, id);
      await admit(instance, messageId);
      const messages = readMessages(state).map(message =>
        message.messageId === messageId
          ? { ...message, state: 'accepted' as const, acceptedAt }
          : message
      );
      instance['saveMessages'](messages);
      await instance.alarm();
    });

    const accepted = captured.find(report => report.run.status === 'accepted');
    expect(accepted?.run).toMatchObject({
      messageId,
      status: 'accepted',
      dispatchAcceptedAt: new Date(acceptedAt).toISOString(),
    });
    expect(accepted?.run).not.toHaveProperty('terminalAt');
    expect(accepted?.run).not.toHaveProperty('failureStage');
  });

  it('classifies a pre-dispatch failure with queued and terminal timestamps', async () => {
    const id = sessionId();
    const messageId = 'msg_018f1e2d3c4bPredispatchAB';
    const captured: CloudAgentQueueReport[] = [];

    const queuedAt = await runInDurableObject(sessionStub(id), async (instance, state) => {
      injectReportQueue(instance, captured);
      suppressDispatch(instance);
      await register(instance, id);
      await admit(instance, messageId);
      const queued = readMessages(state).find(message => message.messageId === messageId)?.queuedAt;
      await instance.failWaitingMessages('missing_metadata');
      await instance.alarm();
      return queued;
    });

    const failed = captured.find(report => report.run.status === 'failed');
    expect(failed?.run).toMatchObject({
      messageId,
      status: 'failed',
      queuedAt: new Date(queuedAt ?? 0).toISOString(),
      terminalAt: expect.any(String),
      failureStage: 'pre_dispatch',
      failureCode: 'session_metadata_missing',
      failureResponsibility: 'platform',
      failureReason: 'delivery',
      diagnostic: { errorMessageRedacted: 'Session metadata is unavailable' },
    });
    expect(failed?.run).not.toHaveProperty('dispatchAcceptedAt');
    expect(failed?.run).not.toHaveProperty('agentActivityObservedAt');
  });

  it('classifies a coordinator preparation timeout as platform runtime startup', async () => {
    const id = sessionId();
    const messageId = 'msg_018f1e2d3c4bPrepTimeoutAB';
    const captured: CloudAgentQueueReport[] = [];

    await runInDurableObject(sessionStub(id), async (instance, state) => {
      injectReportQueue(instance, captured);
      suppressDispatch(instance);
      await register(instance, id);
      await admit(instance, messageId);
      await instance.failWaitingMessages('preparation_timeout');
      await instance.alarm();
    });

    const failed = captured.find(report => report.run.status === 'failed');
    expect(failed?.run).toMatchObject({
      messageId,
      status: 'failed',
      failureStage: 'pre_dispatch',
      failureCode: 'wrapper_start_failed',
      failureResponsibility: 'platform',
      failureReason: 'runtime_startup',
    });
  });

  it('classifies post-acceptance failure without losing observed acceptance', async () => {
    const id = sessionId();
    const messageId = 'msg_018f1e2d3c4bPostAcceptAB';
    const captured: CloudAgentQueueReport[] = [];
    const acceptedAt = Date.now();

    await runInDurableObject(sessionStub(id), async (instance, state) => {
      injectReportQueue(instance, captured);
      suppressDispatch(instance);
      await register(instance, id);
      await admit(instance, messageId);
      instance['saveMessages'](
        readMessages(state).map(message =>
          message.messageId === messageId
            ? { ...message, state: 'accepted' as const, acceptedAt }
            : message
        )
      );
      await instance.failWaitingMessages('runtime_unhealthy');
      await instance.alarm();
    });

    const failed = captured.find(report => report.run.status === 'failed');
    expect(failed?.run).toMatchObject({
      messageId,
      status: 'failed',
      dispatchAcceptedAt: new Date(acceptedAt).toISOString(),
      failureStage: 'post_dispatch_no_activity',
      failureCode: 'wrapper_disconnected',
    });
  });

  it.each(['wrapper_outcome', 'operation_result'] as const)(
    'does not treat an inferred acceptedAt as observed acceptance for a %s terminal-before-ACK',
    async terminalSource => {
      const id = sessionId();
      const messageId = 'msg_018f1e2d3c4bTermBeforeAck';
      const captured: CloudAgentQueueReport[] = [];
      const wrapperInstanceId = 'wr_terminal_before_ack';

      const applied = await runInDurableObject(sessionStub(id), async (instance, state) => {
        injectReportQueue(instance, captured);
        suppressDispatch(instance);
        await register(instance, id);
        await admit(instance, messageId);
        // The wrapper runtime is fenced so the real outcome mapper applies.
        const messages = readMessages(state).map(message =>
          message.messageId === messageId ? { ...message, wrapperInstanceId } : message
        );
        const updated = applyMessageOutcome(
          messages,
          { messageId, status: 'failed', reason: 'missing_metadata' },
          wrapperInstanceId,
          Date.now(),
          terminalSource
        );
        expect(updated).toBeDefined();
        expect(
          updated?.find(message => message.messageId === messageId)?.acceptedAt
        ).toEqual(expect.any(Number));
        state.storage.kv.put('session_messages', messages);
        instance['saveMessages'](updated as SessionMessageRecord[]);
        await instance.alarm();
        return true;
      });

      expect(applied).toBe(true);
      const failed = captured.find(report => report.run.status === 'failed');
      // Arbitrary wrapper/operation text is not a known coordinator cause.
      expect(failed?.run).toMatchObject({
        messageId,
        status: 'failed',
        failureStage: 'unknown',
        failureCode: 'unclassified',
        failureResponsibility: 'unknown',
        failureReason: 'unclassified',
      });
      expect(failed?.run).not.toHaveProperty('dispatchAcceptedAt');
    }
  );

  it('reports a cancelled queued message as an interruption without dispatch acceptance', async () => {
    const id = sessionId();
    const messageId = 'msg_018f1e2d3c4bCancelReportAB';
    const captured: CloudAgentQueueReport[] = [];

    const queuedAt = await runInDurableObject(sessionStub(id), async (instance, state) => {
      injectReportQueue(instance, captured);
      suppressDispatch(instance);
      await register(instance, id);
      await admit(instance, messageId);
      const queued = readMessages(state).find(message => message.messageId === messageId)?.queuedAt;
      expect(await instance.cancelQueuedMessage(messageId)).toEqual({ dropped: true });
      await instance.alarm();
      return queued;
    });

    const interrupted = captured.find(report => report.run.status === 'interrupted');
    expect(interrupted?.run).toMatchObject({
      messageId,
      status: 'interrupted',
      queuedAt: new Date(queuedAt ?? 0).toISOString(),
      terminalAt: expect.any(String),
      failureStage: 'interruption',
      failureCode: 'user_interrupt',
    });
    expect(interrupted?.run).not.toHaveProperty('dispatchAcceptedAt');
  });

  it('recovers a failed send after eviction and delivers it on the next alarm', async () => {
    const id = sessionId();
    const messageId = 'msg_018f1e2d3c4bRecoveryABcDE';
    const captured: CloudAgentQueueReport[] = [];

    await runInDurableObject(sessionStub(id), async (instance, state) => {
      (
        instance as unknown as { env: { CLOUD_AGENT_REPORT_QUEUE: { send: unknown } } }
      ).env.CLOUD_AGENT_REPORT_QUEUE = {
        send: async () => {
          throw new Error('report queue unavailable');
        },
      };
      suppressDispatch(instance);
      await register(instance, id);
      await admit(instance, messageId);
      await instance.alarm();

      const pending = readObligation(state, messageId);
      expect(pending?.attempts).toBe(1);
      expect(await state.storage.getAlarm()).not.toBeNull();

      // Simulate the retry interval elapsing without waiting 30 seconds.
      state.storage.kv.put(`${REPORT_OUTBOX_PREFIX}${messageId}`, {
        ...pending,
        dueAt: 0,
      });
    });

    await abortAllDurableObjects();

    await runInDurableObject(sessionStub(id), async (instance, state) => {
      injectReportQueue(instance, captured);
      suppressDispatch(instance);
      await instance.alarm();
      expect(readObligation(state, messageId)).toBeUndefined();
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].run).toMatchObject({ messageId, status: 'queued' });
  });
});
