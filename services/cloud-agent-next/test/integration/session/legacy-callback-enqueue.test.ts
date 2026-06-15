import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { CallbackJob } from '../../../src/callbacks/types.js';
import { registerReadySession } from '../../helpers/session-setup.js';

function installCallbackQueue(
  instance: { env: unknown },
  send: (job: CallbackJob) => Promise<void>
): void {
  (
    instance.env as {
      CALLBACK_QUEUE: { send: (job: CallbackJob) => Promise<void> };
    }
  ).CALLBACK_QUEUE = { send };
}

describe('legacy execution callback enqueue', () => {
  it('includes legacy executionId and messageId in callback jobs', async () => {
    const userId = 'user_legacy_callback_payload';
    const sessionId = 'agent_legacy_callback_payload';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const jobs = await runInDurableObject(stub, async instance => {
      const sentCallbackJobs: CallbackJob[] = [];
      installCallbackQueue(instance, async job => {
        sentCallbackJobs.push(job);
      });

      await registerReadySession(instance, {
        sessionId,
        userId,
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kiloSessionId: '44444444-4444-4444-8444-444444444444',
        kilocodeToken: 'token-callback-message',
        callbackTarget: { url: 'https://example.com/callback' },
      });
      await instance.addExecution({
        executionId: 'exc_legacy_callback_payload',
        mode: 'code',
        streamingMode: 'websocket',
        ingestToken: 'exc_legacy_callback_payload',
        messageId: 'msg_018f1e2d3c4bCallMsgAbCdEfG',
      });

      await instance.updateExecutionStatus({
        executionId: 'exc_legacy_callback_payload',
        status: 'running',
      });
      await instance.updateExecutionStatus({
        executionId: 'exc_legacy_callback_payload',
        status: 'completed',
      });

      return sentCallbackJobs;
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toMatchObject({
      executionId: 'exc_legacy_callback_payload',
      messageId: 'msg_018f1e2d3c4bCallMsgAbCdEfG',
      status: 'completed',
    });
  });

  it('adds retryable fallback client errors without parsing legacy error text', async () => {
    const userId = 'user_legacy_callback_error';
    const sessionId = 'agent_legacy_callback_error';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const jobs = await runInDurableObject(stub, async instance => {
      const sentCallbackJobs: CallbackJob[] = [];
      installCallbackQueue(instance, async job => {
        sentCallbackJobs.push(job);
      });
      await registerReadySession(instance, {
        sessionId,
        userId,
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kiloSessionId: '55555555-5555-4555-8555-555555555555',
        kilocodeToken: 'token-callback-error',
        callbackTarget: { url: 'https://example.com/callback' },
      });
      await instance.addExecution({
        executionId: 'exc_legacy_callback_error',
        mode: 'code',
        streamingMode: 'websocket',
        ingestToken: 'exc_legacy_callback_error',
      });
      await instance.updateExecutionStatus({
        executionId: 'exc_legacy_callback_error',
        status: 'failed',
        error: 'assistant_error must not control classification',
      });
      return sentCallbackJobs;
    });

    expect(jobs[0].payload).toMatchObject({
      executionId: 'exc_legacy_callback_error',
      status: 'failed',
      errorMessage: 'assistant_error must not control classification',
      clientError: {
        code: 'EXECUTION_FAILED',
        message: 'assistant_error must not control classification',
        retryable: true,
      },
    });
  });
});
