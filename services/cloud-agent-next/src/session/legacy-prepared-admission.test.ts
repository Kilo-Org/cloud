import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();
const getMessageResult = vi.fn();

vi.mock('../sandbox-session/session-stub.js', () => ({
  getSandboxSessionStub: () => ({ send, getMessageResult }),
  resolveLegacySessionStub: vi.fn(),
}));

vi.mock('../session-service.js', () => ({
  fetchSessionMetadata: vi.fn(async () => ({
    metadataSchemaVersion: 2,
    identity: { sessionId: 'workspace_12345678-1234-1234-1234-123456789abc', userId: 'usr_1' },
    auth: { kiloSessionId: 'ses_12345678901234567890123456' },
    agent: { mode: 'code', model: 'test/model' },
    initialMessage: { id: 'msg_prepared_1', turn: { type: 'prompt', prompt: 'hello' } },
    finalization: { autoCommit: true },
    workspace: { sandboxId: 'ses-0123456789abcdef', sandboxProvider: 'cloudflare' },
  })),
}));

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

describe('legacy prepared admission on the control plane', () => {
  beforeEach(() => {
    send.mockReset().mockResolvedValue({ type: 'ok' });
    getMessageResult.mockReset();
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
});
