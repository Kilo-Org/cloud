import { describe, expect, it, vi } from 'vitest';
import { sandboxControlRpc } from './control-rpc.js';

describe('sandboxControlRpc', () => {
  it('retries an ambiguous bind response without changing the request identity', async () => {
    const input = {
      ownerId: 'user_1',
      sessionId: 'workspace_11111111-1111-4111-8111-111111111111',
      kiloSessionId: 'ses_abcdefghijklmnopqrstuvwxyz',
      directory: '/workspace/worktree',
      handle: 'session-runtime-proxy-handle',
    };
    const responseLost = Object.assign(new Error('response lost after bind'), { retryable: true });
    const bind = vi
      .fn()
      .mockRejectedValueOnce(responseLost)
      .mockResolvedValueOnce('worktree-runtime-proxy-handle');
    const getByName = vi
      .fn()
      .mockReturnValueOnce({ bindRuntimeCredentialProxyHandle: bind })
      .mockReturnValueOnce({ bindRuntimeCredentialProxyHandle: bind });
    vi.stubGlobal('scheduler', { wait: vi.fn().mockResolvedValue(undefined) });

    try {
      await expect(
        sandboxControlRpc(
          { SANDBOX_CONTROL: { getByName } } as never,
          'sandbox_credential_proxy'
        ).bindRuntimeCredentialProxyHandle(input)
      ).resolves.toBe('worktree-runtime-proxy-handle');
      expect(getByName).toHaveBeenCalledTimes(2);
      expect(bind).toHaveBeenCalledTimes(2);
      expect(bind).toHaveBeenNthCalledWith(1, input);
      expect(bind).toHaveBeenNthCalledWith(2, input);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
