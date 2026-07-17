import { type KiloSessionId } from 'cloud-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  CREATE_REMOTE_SESSION_FALLBACK_MESSAGE,
  createRemoteSessionWithFeedback,
} from '@/components/agents/create-remote-session-with-feedback';

describe('createRemoteSessionWithFeedback', () => {
  it('returns success and the new session ID when create resolves', async () => {
    const onError = vi.fn(() => undefined);
    const result = await createRemoteSessionWithFeedback(async () => {
      await Promise.resolve();
      return 'ses_12345678901234567890123456' as KiloSessionId;
    }, onError);

    expect(result).toEqual({ success: true, sessionId: 'ses_12345678901234567890123456' });
    expect(onError).not.toHaveBeenCalled();
  });

  it('toasts the Error message once when create rejects with an Error', async () => {
    const onError = vi.fn(() => undefined);
    const result = await createRemoteSessionWithFeedback(() => {
      throw new Error('CLI_UPGRADE_REQUIRED');
    }, onError);

    expect(result).toEqual({ success: false });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('CLI_UPGRADE_REQUIRED');
  });

  it('toasts the fallback message once when create rejects with a non-Error value', async () => {
    const onError = vi.fn(() => undefined);
    const nonError: unknown = 'mystery failure';
    const result = await createRemoteSessionWithFeedback(() => {
      // eslint-disable-next-line no-throw-literal, @typescript-eslint/only-throw-error
      throw nonError;
    }, onError);

    expect(result).toEqual({ success: false });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(CREATE_REMOTE_SESSION_FALLBACK_MESSAGE);
  });
});
