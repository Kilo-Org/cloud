import { env, reset, runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import type { CloudAgentQueueReport } from '@kilocode/worker-utils/cloud-agent-queue-report';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallbackJob } from '../../src/callbacks/types.js';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { controlPlaneMessages } from '../../src/control-plane/session/sqlite-schema.js';
import { logger } from '../../src/logger.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';
import type { ControlPlanePromptPayload } from '../../src/shared/control-plane-protocol.js';
import { CONTROL_PLANE_TIMERS } from '../../src/shared/control-plane-timers.js';
import { FakeSandboxPeer } from './helpers/fake-sandbox-peer.js';
import { waitFor } from './wait-for.js';

type SessionNamespace = DurableObjectNamespace<SandboxSessionV2>;
const sessions = (env as unknown as { SANDBOX_SESSION: SessionNamespace }).SANDBOX_SESSION;

const NATIVE_KILO_TOKEN = 'native-kilo-token-user';
const QUEUED_BACKSTOP_MS = CONTROL_PLANE_TIMERS.session.queuedBackstopMs;

let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}_${sequence}`;
}
function newSessionId(): string {
  return `workspace_${crypto.randomUUID()}`;
}
function kiloSessionId(): string {
  return `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
}

function metadata(input: { sessionId: string; kiloSessionId: string; sandboxId: string }) {
  return parseSessionMetadata({
    metadataSchemaVersion: 2,
    identity: {
      sessionId: input.sessionId,
      userId: 'user_123',
      orgId: 'org_123',
      createdOnPlatform: 'cloud-agent-web',
    },
    auth: { kiloSessionId: input.kiloSessionId, kilocodeToken: NATIVE_KILO_TOKEN },
    agent: { mode: 'code', model: 'test/model' },
    repository: { type: 'github', repo: 'acme/widgets', upstreamBranch: 'main' },
    workspace: {
      branchName: 'kilo/test-branch',
      sandboxId: input.sandboxId,
      sandboxProvider: 'cloudflare',
    },
    callback: { target: { url: 'https://callback.test/hook' } },
    lifecycle: { version: 1, timestamp: 1 },
  });
}

function promptPayload(messageId: string, prompt = 'hello'): ControlPlanePromptPayload {
  return {
    messageId,
    turn: { type: 'prompt', prompt },
    agent: { mode: 'code', model: 'test/model' },
  };
}

type Captured = {
  reports: CloudAgentQueueReport[];
  callbacks: CallbackJob[];
};

/** Overrides the two outbound queues with in-memory captures the DO reads lazily. */
async function installCapturedQueues(stub: DurableObjectStub<SandboxSessionV2>): Promise<Captured> {
  const captured: Captured = { reports: [], callbacks: [] };
  await runInDurableObject(stub, instance => {
    instance.env.CLOUD_AGENT_REPORT_QUEUE = {
      send: async (report: CloudAgentQueueReport) => {
        captured.reports.push(report);
      },
    } as never;
    instance.env.CALLBACK_QUEUE = {
      send: async (job: CallbackJob) => {
        captured.callbacks.push(job);
      },
    } as never;
  });
  return captured;
}

async function installPeer(
  stub: DurableObjectStub<SandboxSessionV2>,
  peer: FakeSandboxPeer
): Promise<void> {
  await runInDurableObject(stub, instance => {
    instance.sandboxPeerFor = () => peer;
  });
}

async function messageStatus(
  stub: DurableObjectStub<SandboxSessionV2>,
  messageId: string
): Promise<string | null> {
  const result = await stub.getMessageResult(messageId);
  return result.type === 'found' ? result.result.status : null;
}

/** Drives the alarm, which repairs both outboxes; makes queue capture deterministic. */
async function flush(stub: DurableObjectStub<SandboxSessionV2>): Promise<void> {
  await runInDurableObject(stub, instance => instance.alarm());
}

/** Injects custom queue behaviour (for failure/retry tests) the DO reads lazily. */
async function installQueues(
  stub: DurableObjectStub<SandboxSessionV2>,
  sendReport: (report: CloudAgentQueueReport) => Promise<void>,
  sendCallback: (job: CallbackJob) => Promise<void>
): Promise<void> {
  await runInDurableObject(stub, instance => {
    instance.env.CLOUD_AGENT_REPORT_QUEUE = { send: sendReport } as never;
    instance.env.CALLBACK_QUEUE = { send: sendCallback } as never;
  });
}

async function readAlarm(stub: DurableObjectStub<SandboxSessionV2>): Promise<number | null> {
  return await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
}

async function setup(): Promise<{
  sessionId: string;
  stub: DurableObjectStub<SandboxSessionV2>;
  peer: FakeSandboxPeer;
}> {
  const sessionId = newSessionId();
  const sandboxId = unique('sbx__reports');
  const stub = sessions.getByName(sessionId);
  await stub.registerSessionFromMetadata({
    metadata: metadata({ sessionId, kiloSessionId: kiloSessionId(), sandboxId }),
    sandboxSelection: { provider: 'cloudflare' },
  });
  const peer = new FakeSandboxPeer();
  peer.prepareView = peer.view('ready');
  await installPeer(stub, peer);
  return { sessionId, stub, peer };
}

afterEach(async () => {
  await reset();
});

describe('SandboxSessionV2 reports and callbacks', () => {
  it('writes one report per terminal message and one batch callback under the session id', async () => {
    const { sessionId, stub } = await setup();
    const captured = await installCapturedQueues(stub);

    await stub.send(promptPayload('m1'));
    await stub.send(promptPayload('m2'));
    await waitFor(async () => expect(await messageStatus(stub, 'm2')).toBe('running'));

    await stub.onOutcome({ sessionId, status: 'completed', lastMessageId: 'm2' });
    await flush(stub);

    expect(captured.reports.map(report => report.run.messageId).sort()).toEqual(['m1', 'm2']);
    expect(captured.reports.every(report => report.session.cloudAgentSessionId === sessionId)).toBe(
      true
    );
    expect(captured.reports.map(report => report.run.status)).toEqual(['completed', 'completed']);
    expect(captured.reports[0]?.session).toMatchObject({
      cloudAgentSessionId: sessionId,
      kiloSessionId: expect.any(String),
      initialMessageId: 'm1',
      reportingCreatedAt: expect.any(String),
    });

    expect(captured.callbacks).toHaveLength(1);
    expect(captured.callbacks[0]?.payload).toMatchObject({
      sessionId,
      cloudAgentSessionId: sessionId,
      status: 'completed',
      messageId: 'm2',
    });
  });

  it('writes a failed report with its stage/code and one callback for a failure batch', async () => {
    const { sessionId, stub, peer } = await setup();
    const captured = await installCapturedQueues(stub);

    await stub.send(promptPayload('m1'));
    await stub.send(promptPayload('m2'));
    await waitFor(async () => expect(await messageStatus(stub, 'm2')).toBe('running'));

    await stub.onRoute({
      state: 'failed',
      attemptId: peer.attemptId,
      reason: 'workspace_setup_failed',
      subtype: 'git_rate_limited',
    });
    await flush(stub);

    expect(captured.reports).toHaveLength(2);
    for (const report of captured.reports) {
      expect(report.run.status).toBe('failed');
      expect(report.run.failureStage).toBe('pre_dispatch');
      expect(report.run.failureCode).toBe('workspace_setup_failed');
      expect(report.run.workspaceFailureSubtype).toBe('git_rate_limited');
      expect(report.run.diagnostic).toBeDefined();
    }
    expect(captured.callbacks).toHaveLength(1);
    expect(captured.callbacks[0]?.payload.status).toBe('failed');
  });

  it('writes interrupted reports and one callback for a Stop batch', async () => {
    const { sessionId, stub } = await setup();
    const captured = await installCapturedQueues(stub);

    await stub.send(promptPayload('m1'));
    await stub.send(promptPayload('m2'));
    await waitFor(async () => expect(await messageStatus(stub, 'm2')).toBe('running'));

    await stub.stop();
    await flush(stub);

    expect(captured.reports).toHaveLength(2);
    for (const report of captured.reports) {
      expect(report.run.status).toBe('interrupted');
      expect(report.run.failureStage).toBe('interruption');
      expect(report.run.failureCode).toBe('user_interrupt');
    }
    expect(captured.callbacks).toHaveLength(1);
    expect(captured.callbacks[0]?.payload.status).toBe('interrupted');
  });

  it('writes a backstop report for a new-plane reason', async () => {
    const { stub, peer } = await setup();
    const captured = await installCapturedQueues(stub);

    // Keep the message queued so the queued backstop (`preparation_timeout`) fires.
    peer.prepareView = peer.view('preparing');
    await stub.send(promptPayload('m1'));
    expect(await messageStatus(stub, 'm1')).toBe('queued');
    await runInDurableObject(stub, async (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      await db
        .update(controlPlaneMessages)
        .set({ created_at: Date.now() - QUEUED_BACKSTOP_MS - 1 })
        .where(eq(controlPlaneMessages.message_id, 'm1'));
    });

    await flush(stub);
    expect(await messageStatus(stub, 'm1')).toBe('failed');
    const report = captured.reports.find(candidate => candidate.run.messageId === 'm1');
    expect(report?.run.status).toBe('failed');
    expect(report?.run.failureStage).toBe('pre_dispatch');
    expect(report?.run.failureCode).toBe('wrapper_start_failed');
    expect(captured.callbacks).toHaveLength(1);
    expect(captured.callbacks[0]?.payload.status).toBe('failed');
  });

  it('does not double-write on a repeat outcome', async () => {
    const { sessionId, stub } = await setup();
    const captured = await installCapturedQueues(stub);

    await stub.send(promptPayload('m1'));
    await waitFor(async () => expect(await messageStatus(stub, 'm1')).toBe('running'));

    await stub.onOutcome({ sessionId, status: 'completed', lastMessageId: 'm1' });
    await flush(stub);
    await stub.onOutcome({ sessionId, status: 'completed', lastMessageId: 'm1' });
    await flush(stub);

    expect(captured.reports).toHaveLength(1);
    expect(captured.callbacks).toHaveLength(1);
  });

  it('does not fail the turn when a report cannot be recorded', async () => {
    const { sessionId, stub } = await setup();
    await runInDurableObject(stub, instance => {
      const holder = instance as unknown as {
        reportOutbox: { record(report: CloudAgentQueueReport): void; repair(): Promise<void> };
      };
      holder.reportOutbox = {
        ...holder.reportOutbox,
        record() {
          throw new Error('report record exploded');
        },
      };
      instance.env.CLOUD_AGENT_REPORT_QUEUE = { send: async () => {} } as never;
    });

    await stub.send(promptPayload('m1'));
    await waitFor(async () => expect(await messageStatus(stub, 'm1')).toBe('running'));
    await expect(
      stub.onOutcome({ sessionId, status: 'completed', lastMessageId: 'm1' })
    ).resolves.toBeUndefined();
    expect(await messageStatus(stub, 'm1')).toBe('completed');
  });

  it('keeps the retry alarm armed when the report queue rejects a send, and retries', async () => {
    const { sessionId, stub } = await setup();
    const reports: CloudAgentQueueReport[] = [];
    let attempts = 0;
    await installQueues(
      stub,
      async report => {
        attempts += 1;
        if (attempts === 1) throw new Error('report queue down');
        reports.push(report);
      },
      async () => {}
    );

    await stub.send(promptPayload('m1'));
    await waitFor(async () => expect(await messageStatus(stub, 'm1')).toBe('running'));
    await expect(
      stub.onOutcome({ sessionId, status: 'completed', lastMessageId: 'm1' })
    ).resolves.toBeUndefined();
    await flush(stub);

    expect(await messageStatus(stub, 'm1')).toBe('completed');
    // Nothing is open, yet the failed report keeps a retry alarm armed.
    expect(await readAlarm(stub)).not.toBeNull();

    // Make the retry due and let the armed alarm deliver it.
    await runInDurableObject(stub, async (_instance, state) => {
      for (const [key, value] of state.storage.kv.list({ prefix: 'report_outbox:' })) {
        const entry = value as { report: CloudAgentQueueReport; attempts: number; dueAt: number };
        await state.storage.kv.put(key, { ...entry, dueAt: Date.now() - 1 });
      }
    });
    await flush(stub);

    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(reports).toHaveLength(1);
  });

  it('keeps the retry alarm armed when the callback queue rejects a send, and retries', async () => {
    const { sessionId, stub } = await setup();
    const callbacks: CallbackJob[] = [];
    let attempts = 0;
    await installQueues(
      stub,
      async () => {},
      async job => {
        attempts += 1;
        if (attempts === 1) throw new Error('callback queue down');
        callbacks.push(job);
      }
    );

    await stub.send(promptPayload('m1'));
    await waitFor(async () => expect(await messageStatus(stub, 'm1')).toBe('running'));
    await stub.onOutcome({ sessionId, status: 'completed', lastMessageId: 'm1' });
    await flush(stub);

    // The callback obligation is the only thing keeping the session non-idle.
    expect(await readAlarm(stub)).not.toBeNull();

    await runInDurableObject(stub, async (_instance, state) => {
      for (const [key, value] of state.storage.kv.list({ prefix: 'callback_outbox:' })) {
        const entry = value as { job: CallbackJob; attempts: number; dueAt: number };
        await state.storage.kv.put(key, { ...entry, dueAt: Date.now() - 1 });
      }
    });
    await flush(stub);

    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(callbacks).toHaveLength(1);
  });

  it('emits the session_message_committed diagnostic for accepted and terminal transitions', async () => {
    const { sessionId, stub } = await setup();
    await installCapturedQueues(stub);
    // Spy inside the DO context (the proven pattern) so both the accepted and
    // terminal transitions are observed.
    const committed = await runInDurableObject(stub, async instance => {
      const withFields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
      const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
      try {
        await instance.send(promptPayload('m1'));
        await waitFor(async () => {
          const result = await instance.getMessageResult('m1');
          expect(result.type === 'found' ? result.result.status : null).toBe('running');
        });
        await instance.onOutcome({ sessionId, status: 'completed', lastMessageId: 'm1' });
        await instance.alarm();
        return withFields.mock.calls
          .map(call => call[0] as Record<string, unknown>)
          .filter(fields => fields.diagnosticEvent === 'session_message_committed');
      } finally {
        withFields.mockRestore();
        info.mockRestore();
        warn.mockRestore();
        error.mockRestore();
      }
    });

    expect(committed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId,
          source: 'coordinator',
          messageId: 'm1',
          fromState: 'queued',
          toState: 'accepted',
          lifecycleEventInserted: false,
        }),
        expect.objectContaining({
          sessionId,
          source: 'wrapper_outcome',
          messageId: 'm1',
          fromState: 'accepted',
          toState: 'completed',
          lifecycleEventInserted: true,
          terminalAt: expect.any(Number),
        }),
      ])
    );
  });

  it('reports sandbox_stopped and execution_limit as interrupted instead of dropping them', async () => {
    const stopped = await setup();
    const capturedStopped = await installCapturedQueues(stopped.stub);
    await stopped.stub.send(promptPayload('m1'));
    await waitFor(async () => expect(await messageStatus(stopped.stub, 'm1')).toBe('running'));
    await stopped.stub.onRoute({
      state: 'lost',
      attemptId: stopped.peer.attemptId,
      reason: 'sandbox_stopped',
    });
    await flush(stopped.stub);

    expect(await messageStatus(stopped.stub, 'm1')).toBe('failed');
    expect(capturedStopped.reports).toHaveLength(1);
    expect(capturedStopped.reports[0]?.run.status).toBe('interrupted');
    expect(capturedStopped.reports[0]?.run.failureStage).toBe('interruption');
    expect(capturedStopped.reports[0]?.run.failureCode).toBe('system_interrupt');

    const limited = await setup();
    const capturedLimited = await installCapturedQueues(limited.stub);
    await limited.stub.send(promptPayload('m1'));
    await waitFor(async () => expect(await messageStatus(limited.stub, 'm1')).toBe('running'));
    await limited.stub.onOutcome({
      sessionId: limited.sessionId,
      status: 'failed',
      reason: 'execution_limit',
      lastMessageId: 'm1',
    });
    await flush(limited.stub);

    expect(await messageStatus(limited.stub, 'm1')).toBe('failed');
    expect(capturedLimited.reports).toHaveLength(1);
    expect(capturedLimited.reports[0]?.run.status).toBe('interrupted');
    expect(capturedLimited.reports[0]?.run.failureStage).toBe('interruption');
    expect(capturedLimited.reports[0]?.run.failureCode).toBe('system_interrupt');
  });
});
