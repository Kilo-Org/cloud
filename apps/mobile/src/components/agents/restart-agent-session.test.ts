import { type KiloSessionId } from '@kilocode/cloud-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { type AgentSessionRouterLike } from '@/components/agents/session-router-like';
import { restartAgentSession } from '@/components/agents/restart-agent-session';
import { i18n } from '@/i18n';

const SESSION_ID: KiloSessionId = 'new-session-id' as KiloSessionId;

function makeRouter(): AgentSessionRouterLike {
  return { replace: vi.fn<() => void>() };
}

describe('restartAgentSession', () => {
  it('creates then exits then replaces, in that order', async () => {
    const order: string[] = [];
    const create = vi.fn<() => Promise<KiloSessionId>>(async () => {
      order.push('create');
      await Promise.resolve();
      return SESSION_ID;
    });
    const exit = vi.fn<() => Promise<void>>(async () => {
      order.push('exit');
      await Promise.resolve();
    });
    const router = makeRouter();
    const routerReplace = vi.fn(() => {
      order.push('replace');
    });
    router.replace = routerReplace;
    const onError = vi.fn<(message: string) => void>();

    const result = await restartAgentSession({
      create,
      exit,
      router,
      onError,
    });

    expect(result).toEqual({ success: true, sessionId: SESSION_ID });
    expect(order).toEqual(['create', 'exit', 'replace']);
    expect(onError).not.toHaveBeenCalled();
  });

  it('fires onError once, never exits, and never navigates when create fails', async () => {
    const create = vi
      .fn<() => Promise<KiloSessionId>>()
      .mockRejectedValue(new Error('network down'));
    const exit = vi.fn<() => Promise<void>>();
    const router = makeRouter();
    const onError = vi.fn<(message: string) => void>();

    const result = await restartAgentSession({
      create,
      exit,
      router,
      onError,
    });

    expect(result).toEqual({ success: false });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('network down');
    expect(exit).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('navigates and reports the old session stayed open when exit fails', async () => {
    const create = vi.fn<() => Promise<KiloSessionId>>(async () => {
      await Promise.resolve();
      return SESSION_ID;
    });
    const exit = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('CLI offline'));
    const router = makeRouter();
    const onError = vi.fn<(message: string) => void>();

    const result = await restartAgentSession({
      create,
      exit,
      router,
      onError,
    });

    expect(result).toEqual({ success: true, sessionId: SESSION_ID });
    expect(create).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(i18n.t('agentChat.remoteSession.restartExitFailed'));
    expect(router.replace).toHaveBeenCalledTimes(1);
  });

  it('passes organizationId through to replaceWithAgentSession', async () => {
    const create = vi.fn<() => Promise<KiloSessionId>>(async () => {
      await Promise.resolve();
      return SESSION_ID;
    });
    const exit = vi.fn<() => Promise<void>>(async () => {
      await Promise.resolve();
    });
    const router = makeRouter();
    const onError = vi.fn<(message: string) => void>();

    await restartAgentSession({
      create,
      exit,
      router,
      onError,
      organizationId: 'org-123',
    });

    expect(router.replace).toHaveBeenCalledTimes(1);
  });
});
