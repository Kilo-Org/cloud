import { beforeEach, describe, expect, it, vi } from 'vitest';

const { preflightAndQueuePromptMessageMock, requireCurrentSessionAccessMock } = vi.hoisted(() => ({
  preflightAndQueuePromptMessageMock: vi.fn(),
  requireCurrentSessionAccessMock: vi.fn(),
}));

vi.mock('../../session/queue-message.js', () => ({
  preflightAndQueuePromptMessage: preflightAndQueuePromptMessageMock,
  preflightRuntimeAuthorizationRecovery: vi.fn(),
}));
vi.mock('../../session/prepared-session-admission.js', () => ({
  admitPreparedInitialMessage: vi.fn(),
  replayPreparedInitialMessageIfAlreadyAdmitted: vi.fn(),
}));
vi.mock('../../session/model-preflight.js', () => ({
  preflightPreparedInitialPromptModel: vi.fn(),
}));
vi.mock('../../session-access.js', () => ({
  requireCurrentSessionAccess: requireCurrentSessionAccessMock,
}));

import { router } from '../auth.js';
import type { TRPCContext } from '../../types.js';
import { createSessionExecutionV2Handlers } from './session-execution.js';

const cloudAgentSessionId = 'workspace_12345678-1234-4234-8234-123456789012';
const messageId = 'msg_018f1e2d3c4bAbCdEfGhIjKlMn';

const appRouter = router({ ...createSessionExecutionV2Handlers() });
const context = {
  env: {} as TRPCContext['env'],
  request: new Request('https://worker.test/trpc/sendMessageV2'),
  userId: 'user-1',
  authToken: 'token',
} as TRPCContext;

beforeEach(() => {
  preflightAndQueuePromptMessageMock.mockReset().mockResolvedValue({
    cloudAgentSessionId,
    status: 'started',
    streamUrl: `/stream?cloudAgentSessionId=${cloudAgentSessionId}`,
    messageId,
    delivery: 'queued',
  });
  requireCurrentSessionAccessMock.mockReset().mockResolvedValue({
    kiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
    organizationId: null,
  });
});

describe('sendMessageV2 command overrides', () => {
  it('forwards mode, model, and variant through the prompt preflight path', async () => {
    const caller = appRouter.createCaller(context);

    await expect(
      caller.sendMessageV2({
        cloudAgentSessionId,
        messageId,
        payload: {
          type: 'command',
          command: 'compact',
          arguments: '--aggressive',
          mode: 'code',
          model: 'kilo/anthropic/claude-sonnet-4',
          variant: 'high',
        },
      })
    ).resolves.toMatchObject({ messageId, executionId: messageId });

    expect(preflightAndQueuePromptMessageMock).toHaveBeenCalledWith(
      {
        cloudAgentSessionId,
        turn: {
          type: 'command',
          id: messageId,
          command: 'compact',
          arguments: '--aggressive',
          attachments: undefined,
        },
        agent: {
          mode: 'code',
          model: 'kilo/anthropic/claude-sonnet-4',
          variant: 'high',
        },
        finalization: {
          autoCommit: undefined,
          condenseOnComplete: undefined,
        },
      },
      expect.objectContaining({ env: context.env, userId: 'user-1' }),
      'sendMessageV2'
    );
  });

  it('keeps omitted command overrides absent so preflight falls back to the stored model', async () => {
    const caller = appRouter.createCaller(context);

    await caller.sendMessageV2({
      cloudAgentSessionId,
      messageId,
      payload: { type: 'command', command: 'compact', arguments: '' },
    });

    expect(preflightAndQueuePromptMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        turn: expect.objectContaining({ type: 'command', command: 'compact' }),
        agent: { mode: undefined, model: undefined, variant: undefined },
      }),
      expect.anything(),
      'sendMessageV2'
    );
  });
});
