import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import { createMessageId } from '../session/message-id.js';
import type { Env } from '../types.js';
import { deliverWorkspaceSessionCallback, parentSessionCallbackPrompt } from './parent-session.js';
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
const rootId = 'workspace_12345678-1234-4234-8234-123456789abc';
const targetId = 'workspace_22345678-1234-4234-8234-123456789abc';
const worktreeId = 'worktree_12345678-1234-4234-8234-123456789abc';
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
    target: { url: 'workspace:new-chat' },
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

describe('workspace session callback delivery', () => {
  beforeEach(() => {
    child.parentCloudAgentSessionId = rootId;
    parent = {
      ...parent,
      identity: { userId, sessionId: rootId },
      workspace: { worktreeId },
    };
    getMetadata.mockImplementation(async (_env, owner, sessionId) =>
      owner === userId
        ? sessionId === childId
          ? child
          : sessionId === rootId
            ? parent
            : sessionId === targetId
              ? {
                  ...parent,
                  identity: { userId, sessionId: targetId },
                  parentCloudAgentSessionId: undefined,
                }
              : null
        : null
    );
    job.target = { url: `workspace:${targetId}` };
  });

  it('queues the child result into the addressed chat in the same workspace', async () => {
    expect(await deliverWorkspaceSessionCallback(env, job, 1)).toEqual({ type: 'success' });
    const [input] = queuePrompt.mock.calls[0];
    expect(input.cloudAgentSessionId).toBe(targetId);
    expect(JSON.parse(input.turn.prompt.split('\n')[2])).toMatchObject({
      cloudAgentSessionId: childId,
      callbackSessionId: targetId,
      result: 'Child result',
    });
    expect(assertAccess).toHaveBeenCalledWith(
      expect.objectContaining({ cloudAgentSessionId: targetId })
    );
  });

  it('routes the queue job through the workspace session delivery path', async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    await createCallbackQueueConsumer(env)({
      messages: [{ body: job, attempts: 1, ack, retry }],
    } as unknown as MessageBatch<CallbackJob>);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(queuePrompt).toHaveBeenCalledWith(
      expect.objectContaining({ cloudAgentSessionId: targetId }),
      expect.anything(),
      'workspace_session_callback'
    );
  });

  it.each(['child target', 'other workspace', 'other owner'])(
    'rejects a callback to %s',
    async condition => {
      getMetadata.mockImplementation(async (_env, owner, sessionId) => {
        if (owner !== userId) return null;
        if (sessionId === childId) return child;
        if (sessionId === rootId) return parent;
        if (sessionId !== targetId) return null;
        if (condition === 'other owner')
          return { ...parent, identity: { userId: 'other', sessionId: targetId } };
        return {
          ...parent,
          identity: { userId, sessionId: targetId },
          parentCloudAgentSessionId: condition === 'child target' ? rootId : undefined,
          workspace: {
            worktreeId: condition === 'other workspace' ? 'worktree_other' : worktreeId,
          },
        };
      });
      expect(await deliverWorkspaceSessionCallback(env, job, 1)).toMatchObject({ type: 'failed' });
      expect(queuePrompt).not.toHaveBeenCalled();
    }
  );
});

describe('callback fallbacks', () => {
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
