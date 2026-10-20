import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

vi.mock('./session-id-guard.js', async () => {
  const { TRPCError } = await import('@trpc/server');
  return {
    assertControlSessionId: (sessionId: string): void => {
      if (!sessionId.startsWith('workspace_')) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Only workspace sessions are supported',
        });
      }
    },
  };
});

import type { SessionMetadata } from '../persistence/session-metadata.js';

const send = vi.fn();
const getMessageResult = vi.fn();
const getSandboxSessionStub = vi.hoisted(() => vi.fn());

getSandboxSessionStub.mockImplementation(() => ({ send, getMessageResult }));

vi.mock('../sandbox-session/session-stub.js', () => ({
  getSandboxSessionStub,
}));

const storedMetadata = {
  metadataSchemaVersion: 2,
  identity: { sessionId: 'workspace_12345678-1234-1234-1234-123456789abc', userId: 'usr_1' },
  auth: { kiloSessionId: 'ses_12345678901234567890123456' },
  agent: { mode: 'code', model: 'test/model' },
  initialMessage: { id: 'msg_prepared_1', turn: { type: 'prompt', prompt: 'hello' } },
  finalization: { autoCommit: true },
  workspace: { sandboxId: 'ses-0123456789abcdef', sandboxProvider: 'cloudflare' },
} as unknown as SessionMetadata;

const fetchSessionMetadata = vi.hoisted(() => vi.fn());

vi.mock('./metadata.js', () => ({ fetchSessionMetadata }));

fetchSessionMetadata.mockResolvedValue(storedMetadata);

vi.mock('../execution/attachment-prompt-parts.js', () => ({
  buildSignedPromptAttachments: vi.fn(async () => []),
}));

vi.mock('../utils/do-retry.js', () => ({
  withDORetry: <TStub, TResult>(
    getStub: () => TStub,
    operation: (stub: TStub) => Promise<TResult>
  ) => operation(getStub()),
}));

import {
  admitLegacyPreparedInitialMessage,
  replayLegacyPreparedInitialMessageIfAlreadyAdmitted,
} from './legacy-prepared-admission.js';

const ctx = { env: {} as never, userId: 'usr_1' };
const input = { cloudAgentSessionId: 'workspace_12345678-1234-1234-1234-123456789abc' };

describe('retained prepared admission on the control plane', () => {
  beforeEach(() => {
    send.mockReset().mockResolvedValue({ type: 'ok' });
    getMessageResult.mockReset();
    getSandboxSessionStub.mockClear();
    vi.mocked(fetchSessionMetadata).mockClear();
  });

  it('admits the stored initial turn through the V2 send RPC', async () => {
    const ack = await admitLegacyPreparedInitialMessage(input, ctx);
    expect(ack.messageId).toBe('msg_prepared_1');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'msg_prepared_1',
        turn: { type: 'prompt', prompt: 'hello' },
        agent: expect.objectContaining({ mode: 'code', model: 'test/model' }),
      })
    );
  });

  it('replays an already-admitted initial turn from the message result', async () => {
    getMessageResult.mockResolvedValue({
      type: 'found',
      result: { status: 'running', messageId: 'msg_prepared_1' },
    });
    const ack = await replayLegacyPreparedInitialMessageIfAlreadyAdmitted(input, ctx);
    expect(ack?.messageId).toBe('msg_prepared_1');
    expect(send).not.toHaveBeenCalled();
  });

  it('does not replay an initial turn that was never admitted', async () => {
    getMessageResult.mockResolvedValue({ type: 'message-not-found' });
    await expect(replayLegacyPreparedInitialMessageIfAlreadyAdmitted(input, ctx)).resolves.toBe(
      undefined
    );
  });

  it('rejects a non-workspace ID before metadata or the Session DO', async () => {
    const legacyInput = { cloudAgentSessionId: 'agent_prepared' };

    await expect(admitLegacyPreparedInitialMessage(legacyInput, ctx)).rejects.toBeInstanceOf(
      TRPCError
    );
    await expect(
      replayLegacyPreparedInitialMessageIfAlreadyAdmitted(legacyInput, ctx)
    ).rejects.toBeInstanceOf(TRPCError);

    expect(fetchSessionMetadata).not.toHaveBeenCalled();
    expect(getSandboxSessionStub).not.toHaveBeenCalled();
  });
});
