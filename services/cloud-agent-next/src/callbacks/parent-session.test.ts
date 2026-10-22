import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import { createMessageId } from '../session/message-id.js';
import type { Env } from '../types.js';
import { deliverParentSessionCallback, parentSessionCallbackPrompt } from './parent-session.js';
import { createCallbackQueueConsumer } from './queue-consumer.js';
import type { CallbackJob } from './types.js';

const { getMetadata, assertAccess, queuePrompt } = vi.hoisted(() => ({
  getMetadata: vi.fn(),
  assertAccess: vi.fn(),
  queuePrompt: vi.fn(),
}));
vi.mock('../session/metadata.js', () => ({ fetchSessionMetadata: getMetadata }));
vi.mock('../session-access.js', () => ({ requireCurrentSessionAccess: assertAccess }));
vi.mock('../session/queue-message.js', () => ({ preflightAndQueuePromptMessage: queuePrompt }));

const env = {} as Env;
const userId = 'oauth/owner';
const childId = 'workspace_child';
const parentId = 'workspace_parent';
let child: SessionMetadata;
let parent: SessionMetadata;
let job: CallbackJob;

beforeEach(() => {
  vi.clearAllMocks();
  child = {
    metadataSchemaVersion: 2,
    identity: { userId, sessionId: childId },
    parentCloudAgentSessionId: parentId,
    auth: { kiloSessionId: 'ses_child' },
    lifecycle: { version: 1, timestamp: 1 },
  };
  parent = {
    ...child,
    identity: { userId, sessionId: parentId },
    auth: { kiloSessionId: 'ses_parent' },
    parentCloudAgentSessionId: undefined,
    allowSubagentSessions: true,
  };
  job = {
    target: { url: 'session:parent' },
    parentSession: { userId, messageId: createMessageId() },
    payload: {
      sessionId: childId,
      cloudAgentSessionId: childId,
      kiloSessionId: 'ses_child',
      messageId: createMessageId(),
      status: 'completed',
      lastAssistantMessageText: 'Child result',
    },
  };
  getMetadata.mockImplementation(async (_env, owner, sessionId) =>
    owner === userId
      ? sessionId === childId
        ? child
        : sessionId === parentId
          ? parent
          : null
      : null
  );
  assertAccess.mockReset().mockResolvedValue(undefined);
  queuePrompt.mockReset().mockResolvedValue({ delivery: 'queued' });
});

describe('parent session callback delivery', () => {
  it('preserves gate and structured failure results in the queued parent prompt', async () => {
    job.payload.gateResult = 'fail';
    job.payload.failure = { code: 'workspace_setup_failed', stage: 'pre_dispatch' };
    job.payload.failureStage = 'pre_dispatch';
    expect(await deliverParentSessionCallback(env, job, 1)).toEqual({ type: 'success' });
    const [input] = queuePrompt.mock.calls[0];
    expect(JSON.parse(input.turn.prompt.split('\n')[2])).toMatchObject({
      status: 'completed',
      gateResult: 'fail',
      failure: job.payload.failure,
      failureStage: 'pre_dispatch',
    });
  });

  it.each(['completed', 'failed', 'interrupted'] as const)(
    'queues %s with the persisted callback message ID and the parent authorization',
    async status => {
      job.payload.status = status;
      job.payload.errorMessage = status === 'completed' ? undefined : 'Child stopped';
      expect(await deliverParentSessionCallback(env, job, 1)).toEqual({ type: 'success' });
      expect(assertAccess).toHaveBeenCalledWith({
        env,
        kiloUserId: userId,
        cloudAgentSessionId: parentId,
        expectedOrganizationId: null,
        expectedKiloSessionId: 'ses_parent',
      });
      const [input, context] = queuePrompt.mock.calls[0];
      expect(input.cloudAgentSessionId).toBe(parentId);
      expect(input.turn.id).toBe(job.parentSession?.messageId);
      expect(JSON.parse(input.turn.prompt.split('\n')[2])).toMatchObject({
        cloudAgentSessionId: childId,
        messageId: job.payload.messageId,
        status,
        result: 'Child result',
      });
      expect(context).toEqual({ env, userId });
    }
  );

  it.each(['missing lineage', 'self', 'owner', 'organization', 'disabled', 'missing parent'])(
    'does not send with invalid parent routing: %s',
    async condition => {
      if (condition === 'missing lineage') delete child.parentCloudAgentSessionId;
      if (condition === 'self') child.parentCloudAgentSessionId = childId;
      if (condition === 'owner') parent.identity.userId = 'another-user';
      if (condition === 'organization') parent.identity.orgId = 'another-org';
      if (condition === 'disabled') parent.allowSubagentSessions = false;
      if (condition === 'missing parent') child.parentCloudAgentSessionId = 'workspace_deleted';
      expect(await deliverParentSessionCallback(env, job, 1)).toMatchObject({ type: 'failed' });
      expect(queuePrompt).not.toHaveBeenCalled();
    }
  );

  it('rejects callbacks without server-owned routing context', async () => {
    delete job.parentSession;
    expect(await deliverParentSessionCallback(env, job, 1)).toMatchObject({ type: 'failed' });
    expect(getMetadata).not.toHaveBeenCalled();
    expect(queuePrompt).not.toHaveBeenCalled();
  });

  it('checks current access before sending to a deleted session or removed organization member', async () => {
    assertAccess.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    expect(await deliverParentSessionCallback(env, job, 1)).toMatchObject({ type: 'failed' });
    expect(queuePrompt).not.toHaveBeenCalled();
  });

  it('does not renew or replace revoked parent authorization', async () => {
    queuePrompt.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    expect(await deliverParentSessionCallback(env, job, 1)).toMatchObject({ type: 'failed' });
  });

  it('retries a full queue with the same message identity and stops after five attempts', async () => {
    queuePrompt.mockRejectedValue(new TRPCError({ code: 'TOO_MANY_REQUESTS' }));
    expect(await deliverParentSessionCallback(env, job, 1)).toEqual({
      type: 'retry',
      delaySeconds: 60,
    });
    expect(await deliverParentSessionCallback(env, job, 5)).toMatchObject({ type: 'failed' });
    expect(queuePrompt.mock.calls.map(([input]) => input.turn.id)).toEqual([
      job.parentSession?.messageId,
      job.parentSession?.messageId,
    ]);
  });

  it('preserves matching organization scope', async () => {
    parent.identity.orgId = child.identity.orgId = 'org_owner';
    expect(await deliverParentSessionCallback(env, job, 1)).toEqual({ type: 'success' });
    expect(assertAccess.mock.calls[0][0].expectedOrganizationId).toBe('org_owner');
  });

  it('routes parent jobs through the queue consumer without HTTP delivery', async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    try {
      await createCallbackQueueConsumer(env)({
        messages: [{ body: job, attempts: 1, ack, retry }],
      } as unknown as MessageBatch<CallbackJob>);
      expect(ack).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(queuePrompt).toHaveBeenCalledOnce();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('keeps HTTP callbacks on the existing HTTP delivery path', async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    job.target = { url: 'https://example.com/callback', headers: { 'X-Callback': 'fixture' } };
    delete job.parentSession;
    try {
      await createCallbackQueueConsumer(env)({
        messages: [{ body: job, attempts: 1, ack, retry }],
      } as unknown as MessageBatch<CallbackJob>);
      expect(ack).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();
      expect(queuePrompt).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledWith(
        job.target.url,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(job.payload),
          headers: { 'Content-Type': 'application/json', 'X-Callback': 'fixture' },
        })
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('bounds child output and reports omitted answers', () => {
    job.payload.lastAssistantMessageText = 'x'.repeat(20_000);
    expect(JSON.parse(parentSessionCallbackPrompt(job.payload).split('\n')[2])).toMatchObject({
      result: 'x'.repeat(12_000),
      resultTruncated: true,
    });
    delete job.payload.lastAssistantMessageText;
    job.payload.recentActivity = 'Partial activity';
    job.payload.lastAssistantMessageTextTruncation = {
      originalUtf8ByteLength: 200_000,
      retainedUtf8ByteLength: 0,
    };
    expect(JSON.parse(parentSessionCallbackPrompt(job.payload).split('\n')[2])).toMatchObject({
      result: 'Partial activity',
      resultTruncated: true,
    });
  });
});
