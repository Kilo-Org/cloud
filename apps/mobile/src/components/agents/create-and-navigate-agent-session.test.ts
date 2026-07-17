import { type KiloSessionId } from 'cloud-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { createAndNavigateAgentSession } from '@/components/agents/create-and-navigate-agent-session';
import { CREATE_REMOTE_SESSION_FALLBACK_MESSAGE } from '@/components/agents/create-remote-session-with-feedback';

const SESSION_ID = 'ses_12345678901234567890123456' as KiloSessionId;
const ORG_ID = 'org_abc123';

function makeRouter() {
  return { replace: vi.fn(() => undefined) };
}

describe('createAndNavigateAgentSession', () => {
  it('replaces with the personal session route on success and returns the new id', async () => {
    const router = makeRouter();
    const onError = vi.fn(() => undefined);
    const create = vi.fn(async () => {
      await Promise.resolve();
      return SESSION_ID;
    });

    const result = await createAndNavigateAgentSession({ create, router, onError });

    expect(create).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, sessionId: SESSION_ID });
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith(`/(app)/agent-chat/${SESSION_ID}`);
  });

  it('preserves the organizationId when replacing on success', async () => {
    const router = makeRouter();
    const onError = vi.fn(() => undefined);

    const result = await createAndNavigateAgentSession({
      create: vi.fn(async () => {
        await Promise.resolve();
        return SESSION_ID;
      }),
      router,
      organizationId: ORG_ID,
      onError,
    });

    expect(onError).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, sessionId: SESSION_ID });
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith(
      `/(app)/agent-chat/${SESSION_ID}?organizationId=${ORG_ID}`
    );
  });

  it('toasts once and never navigates when create rejects with an Error', async () => {
    const router = makeRouter();
    const onError = vi.fn(() => undefined);

    const result = await createAndNavigateAgentSession({
      create: vi.fn(() => {
        throw new Error('CLI_UPGRADE_REQUIRED');
      }),
      router,
      organizationId: ORG_ID,
      onError,
    });

    expect(result).toEqual({ success: false });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('CLI_UPGRADE_REQUIRED');
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('toasts the fallback message once when create rejects with a non-Error value', async () => {
    const router = makeRouter();
    const onError = vi.fn(() => undefined);

    const result = await createAndNavigateAgentSession({
      create: vi.fn(() => {
        // eslint-disable-next-line no-throw-literal, @typescript-eslint/only-throw-error
        throw 'mystery failure';
      }),
      router,
      onError,
    });

    expect(result).toEqual({ success: false });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(CREATE_REMOTE_SESSION_FALLBACK_MESSAGE);
    expect(router.replace).not.toHaveBeenCalled();
  });
});
