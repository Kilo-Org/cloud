/**
 * Integration tests for /ingest WebSocket lifecycle behavior.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { ExecutionMessage } from '../../../src/queue/types.js';
import type { ExecutionId } from '../../../src/types/ids.js';

const delay = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

async function prepareSession(
  stub: DurableObjectStub,
  userId: string,
  sessionId: string
): Promise<void> {
  await runInDurableObject(stub, async instance => {
    await instance.prepare({
      sessionId,
      userId,
      orgId: 'org_test',
      kiloSessionId: '77777777-7777-4777-8777-777777777777',
      prompt: 'test',
      mode: 'code',
      model: 'test-model',
      kilocodeToken: 'test-token',
    });
  });
}

async function enqueueExecution(
  stub: DurableObjectStub,
  exec: ExecutionMessage,
  isInitialize: boolean
): Promise<void> {
  await runInDurableObject(stub, async instance => {
    await instance.enqueueExecution(exec, isInitialize);
  });
}

async function connectIngest(
  stub: DurableObjectStub,
  executionId: string,
  token: string
): Promise<WebSocket> {
  const response = await stub.fetch(
    `https://ingest.test/ingest?executionId=${executionId}&token=${token}`,
    {
      headers: {
        Upgrade: 'websocket',
      },
    }
  );

  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`Unexpected ingest upgrade response: ${response.status}`);
  }

  const ws = response.webSocket;
  ws.accept();
  return ws;
}

describe('/ingest lifecycle', () => {
  it('transitions pending -> running on ingest connect', async () => {
    const userId = 'user_ingest_running';
    const sessionId = 'sess_ingest_running';
    const executionId = 'exec_ingest_running' as ExecutionId;

    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    await prepareSession(stub, userId, sessionId);

    const exec: ExecutionMessage = {
      executionId,
      sessionId,
      userId,
      orgId: 'org_test',
      sandboxId: 'sandbox_test',
      mode: 'code',
      prompt: 'test command',
    };

    await enqueueExecution(stub, exec, true);

    const before = await runInDurableObject(stub, async instance =>
      instance.getExecution(executionId)
    );
    expect(before?.status).toBe('pending');

    const ws = await connectIngest(stub, executionId, executionId);
    await delay();

    const after = await runInDurableObject(stub, async instance =>
      instance.getExecution(executionId)
    );
    expect(after?.status).toBe('running');

    ws.close(1000, 'test done');
  });

  it('captures branch and completes on valid complete event', async () => {
    const userId = 'user_ingest_complete';
    const sessionId = 'sess_ingest_complete';
    const executionId = 'exec_ingest_complete' as ExecutionId;

    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    await prepareSession(stub, userId, sessionId);

    const exec: ExecutionMessage = {
      executionId,
      sessionId,
      userId,
      orgId: 'org_test',
      sandboxId: 'sandbox_test',
      mode: 'code',
      prompt: 'test command',
    };

    await enqueueExecution(stub, exec, true);

    const ws = await connectIngest(stub, executionId, executionId);
    ws.send(
      JSON.stringify({
        streamEventType: 'complete',
        data: {
          exitCode: 0,
          currentBranch: 'main',
        },
      })
    );

    await delay();

    const result = await runInDurableObject(stub, async instance => {
      const execution = await instance.getExecution(executionId);
      const metadata = await instance.getMetadata();
      return { execution, metadata };
    });

    expect(result.execution?.status).toBe('completed');
    expect(result.metadata?.upstreamBranch).toBe('main');

    ws.close(1000, 'test done');
  });

  it('ignores invalid complete payloads (no status change)', async () => {
    const userId = 'user_ingest_invalid_complete';
    const sessionId = 'sess_ingest_invalid_complete';
    const executionId = 'exec_ingest_invalid_complete' as ExecutionId;

    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    await prepareSession(stub, userId, sessionId);

    const exec: ExecutionMessage = {
      executionId,
      sessionId,
      userId,
      orgId: 'org_test',
      sandboxId: 'sandbox_test',
      mode: 'code',
      prompt: 'test command',
    };

    await enqueueExecution(stub, exec, true);

    const ws = await connectIngest(stub, executionId, executionId);
    ws.send(
      JSON.stringify({
        streamEventType: 'complete',
        data: {
          currentBranch: 'main',
        },
      })
    );

    await delay();

    const result = await runInDurableObject(stub, async instance => {
      const execution = await instance.getExecution(executionId);
      const metadata = await instance.getMetadata();
      return { execution, metadata };
    });

    expect(result.execution?.status).toBe('running');
    expect(result.metadata?.upstreamBranch).toBeUndefined();

    ws.close(1000, 'test done');
  });

  it('treats terminal events as idempotent', async () => {
    const userId = 'user_ingest_terminal';
    const sessionId = 'sess_ingest_terminal';
    const executionId = 'exec_ingest_terminal' as ExecutionId;
    const nextExecutionId = 'exec_ingest_terminal_next' as ExecutionId;

    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    await prepareSession(stub, userId, sessionId);

    const exec1: ExecutionMessage = {
      executionId,
      sessionId,
      userId,
      orgId: 'org_test',
      sandboxId: 'sandbox_test',
      mode: 'code',
      prompt: 'first command',
    };

    const exec2: ExecutionMessage = {
      executionId: nextExecutionId,
      sessionId,
      userId,
      orgId: 'org_test',
      sandboxId: 'sandbox_test',
      mode: 'code',
      prompt: 'second command',
    };

    await enqueueExecution(stub, exec1, true);
    await enqueueExecution(stub, exec2, false);

    const ws = await connectIngest(stub, executionId, executionId);
    ws.send(
      JSON.stringify({
        streamEventType: 'error',
        data: {
          fatal: true,
          error: 'boom',
        },
      })
    );

    await delay();

    ws.send(
      JSON.stringify({
        streamEventType: 'interrupted',
        data: {
          reason: 'late interrupt',
        },
      })
    );

    await delay();

    const result = await runInDurableObject(stub, async instance => {
      const exec1Status = await instance.getExecution(executionId);
      const exec2Status = await instance.getExecution(nextExecutionId);
      const activeExecutionId = await instance.getActiveExecutionId();
      return { exec1Status, exec2Status, activeExecutionId };
    });

    expect(result.exec1Status?.status).toBe('failed');
    expect(result.exec2Status?.status).toBe('pending');
    expect(result.activeExecutionId).toBe(nextExecutionId);

    ws.close(1000, 'test done');
  });
});
