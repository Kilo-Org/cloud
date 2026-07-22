import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  DispatchPushInput,
  DispatchPushOutcome,
  SendAgentSessionNotificationParams,
} from '@kilocode/notifications';

import {
  buildAgentSessionNotificationContent,
  buildAgentSessionNotificationDispatchInput,
  dispatchAgentSessionNotificationPush,
  mapAgentDispatchOutcomeToResult,
} from './agent-session-notification-push';
import type { UserNotificationPreferences } from './cloud-agent-session-push';

const baseParams: SendAgentSessionNotificationParams = {
  userId: 'user-1',
  cliSessionId: 'ses_abc',
  notificationId: 'n-1',
  message: 'Build finished',
};

const session = { title: 'Refactor auth module', organizationId: null };

const ALL_ON: UserNotificationPreferences = {
  agentPushEnabled: true,
  chatMessagesEnabled: true,
  agentAttentionEnabled: true,
  sessionStatusEnabled: true,
  kiloclawActivityEnabled: true,
};

function fakeDeps(
  options: {
    session?: { title: string | null; organizationId: string | null } | null;
    hasOrganizationAccess?: boolean;
    /** Partial override applied on top of ALL_ON. `null` ⇒ no row. */
    preferences?: Partial<UserNotificationPreferences> | null;
    preferencesThrows?: boolean;
    dispatchPush?: (input: DispatchPushInput) => Promise<DispatchPushOutcome>;
  } = {}
): {
  deps: Parameters<typeof dispatchAgentSessionNotificationPush>[1];
  calls: {
    dispatchPushInputs: DispatchPushInput[];
  };
} {
  const calls = { dispatchPushInputs: [] as DispatchPushInput[] };
  const sessionRecord = options.session === undefined ? session : options.session;
  const prefsValue: UserNotificationPreferences | null =
    options.preferences === undefined
      ? ALL_ON
      : options.preferences === null
        ? null
        : { ...ALL_ON, ...options.preferences };

  const deps = {
    getSession: vi.fn(async () => sessionRecord),
    hasOrganizationAccess: vi.fn(async () => options.hasOrganizationAccess ?? true),
    readPreferences: options.preferencesThrows
      ? vi.fn(async () => {
          throw new Error('preference read failed');
        })
      : vi.fn(async () => prefsValue),
    dispatchPush: vi.fn(
      options.dispatchPush ?? (async () => ({ kind: 'delivered' as const, tokenCount: 1 }))
    ),
  };
  // Track inputs through a wrapper so we don't double-promise in the spy.
  const originalDispatch = deps.dispatchPush;
  const wrapped = vi.fn(async (input: DispatchPushInput) => {
    calls.dispatchPushInputs.push(input);
    return originalDispatch(input);
  });
  deps.dispatchPush = wrapped as unknown as typeof deps.dispatchPush;
  return { deps, calls };
}

describe('buildAgentSessionNotificationContent', () => {
  it('uses the service-resolved title and pins presence/idempotency keys', () => {
    const content = buildAgentSessionNotificationContent(baseParams, session);
    expect(content).toEqual({
      presenceContext: '/presence/cli-session/ses_abc',
      idempotencyKey: 'agent-notification:ses_abc:n-1',
      title: 'Refactor auth module',
      body: 'Build finished',
    });
  });

  it('falls back to "Agent session" when the session title is null', () => {
    const content = buildAgentSessionNotificationContent(baseParams, {
      title: null,
      organizationId: null,
    });
    expect(content.title).toBe('Agent session');
  });
});

describe('buildAgentSessionNotificationDispatchInput', () => {
  it('composes the dispatch input with cloud_agent_session data, rate limit, and no badge', () => {
    const content = buildAgentSessionNotificationContent(baseParams, session);
    const input = buildAgentSessionNotificationDispatchInput(baseParams, content);
    expect(input).toEqual({
      userId: 'user-1',
      presenceContext: '/presence/cli-session/ses_abc',
      idempotencyKey: 'agent-notification:ses_abc:n-1',
      badge: null,
      push: {
        title: 'Refactor auth module',
        body: 'Build finished',
        data: { type: 'cloud_agent_session', cliSessionId: 'ses_abc' },
        sound: 'default',
        priority: 'high',
      },
      rateLimit: { key: 'agent:ses_abc', limit: 5, windowSeconds: 600 },
    });
  });
});

describe('mapAgentDispatchOutcomeToResult', () => {
  it('maps delivered to dispatched:true with no reason', () => {
    expect(mapAgentDispatchOutcomeToResult({ kind: 'delivered', tokenCount: 1 })).toEqual({
      dispatched: true,
    });
  });

  it('maps every other outcome to the matching reason', () => {
    const expectations: [DispatchPushOutcome, { dispatched: false; reason: string }][] = [
      [{ kind: 'suppressed_presence' }, { dispatched: false, reason: 'suppressed_presence' }],
      [{ kind: 'suppressed_rate_limit' }, { dispatched: false, reason: 'suppressed_rate_limit' }],
      [{ kind: 'no_tokens' }, { dispatched: false, reason: 'no_tokens' }],
      [{ kind: 'duplicate' }, { dispatched: false, reason: 'duplicate' }],
      [
        { kind: 'failed', error: 'boom' },
        { dispatched: false, reason: 'failed' },
      ],
    ];
    for (const [outcome, expected] of expectations) {
      expect(mapAgentDispatchOutcomeToResult(outcome)).toEqual(expected);
    }
  });
});

describe('dispatchAgentSessionNotificationPush', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns not_found when the session row is absent', async () => {
    const { deps, calls } = fakeDeps({ session: null });
    const result = await dispatchAgentSessionNotificationPush(baseParams, deps);
    expect(result).toEqual({ dispatched: false, reason: 'not_found' });
    expect(calls.dispatchPushInputs).toHaveLength(0);
    expect(deps.readPreferences).not.toHaveBeenCalled();
  });

  it('returns not_found when org membership is revoked (collapsed with session-missing)', async () => {
    const { deps, calls } = fakeDeps({
      session: { title: 'Org session', organizationId: 'org-1' },
      hasOrganizationAccess: false,
    });
    const result = await dispatchAgentSessionNotificationPush(baseParams, deps);
    expect(result).toEqual({ dispatched: false, reason: 'not_found' });
    expect(calls.dispatchPushInputs).toHaveLength(0);
    expect(deps.readPreferences).not.toHaveBeenCalled();
  });

  it('returns suppressed_preference when the user has turned agent pushes off', async () => {
    const { deps, calls } = fakeDeps({ preferences: { agentPushEnabled: false } });
    const result = await dispatchAgentSessionNotificationPush(baseParams, deps);
    expect(result).toEqual({ dispatched: false, reason: 'suppressed_preference' });
    expect(calls.dispatchPushInputs).toHaveLength(0);
  });

  it('keeps other category preferences irrelevant — only agentPushEnabled gates this RPC', async () => {
    const { deps, calls } = fakeDeps({
      preferences: {
        agentPushEnabled: true,
        chatMessagesEnabled: false,
        agentAttentionEnabled: false,
        sessionStatusEnabled: false,
        kiloclawActivityEnabled: false,
      },
    });
    const result = await dispatchAgentSessionNotificationPush(baseParams, deps);
    expect(result).toEqual({ dispatched: true });
    expect(calls.dispatchPushInputs).toHaveLength(1);
  });

  it('treats a successful read with no row as default-on (preferences returns null)', async () => {
    const { deps, calls } = fakeDeps({ preferences: null });
    const result = await dispatchAgentSessionNotificationPush(baseParams, deps);
    expect(result).toEqual({ dispatched: true });
    expect(calls.dispatchPushInputs).toHaveLength(1);
  });

  it('fails closed with reason failed when the preference read throws', async () => {
    const { deps, calls } = fakeDeps({ preferencesThrows: true });
    const result = await dispatchAgentSessionNotificationPush(baseParams, deps);
    expect(result).toEqual({ dispatched: false, reason: 'failed' });
    expect(calls.dispatchPushInputs).toHaveLength(0);
  });

  it('dispatches with rate limit + presence + title resolved service-side', async () => {
    const { deps, calls } = fakeDeps();
    const result = await dispatchAgentSessionNotificationPush(baseParams, deps);
    expect(result).toEqual({ dispatched: true });
    expect(calls.dispatchPushInputs).toHaveLength(1);
    const input = calls.dispatchPushInputs[0]!;
    expect(input.presenceContext).toBe('/presence/cli-session/ses_abc');
    expect(input.idempotencyKey).toBe('agent-notification:ses_abc:n-1');
    expect(input.rateLimit).toEqual({
      key: 'agent:ses_abc',
      limit: 5,
      windowSeconds: 600,
    });
    expect(input.push.title).toBe('Refactor auth module');
    expect(input.push.data).toEqual({ type: 'cloud_agent_session', cliSessionId: 'ses_abc' });
  });

  it('passes through suppressed_presence / suppressed_rate_limit / no_tokens / duplicate outcomes', async () => {
    const cases: { outcome: DispatchPushOutcome; reason: string }[] = [
      { outcome: { kind: 'suppressed_presence' }, reason: 'suppressed_presence' },
      { outcome: { kind: 'suppressed_rate_limit' }, reason: 'suppressed_rate_limit' },
      { outcome: { kind: 'no_tokens' }, reason: 'no_tokens' },
      { outcome: { kind: 'duplicate' }, reason: 'duplicate' },
    ];
    for (const { outcome, reason } of cases) {
      const { deps, calls } = fakeDeps({
        dispatchPush: async () => outcome,
      });
      const result = await dispatchAgentSessionNotificationPush(baseParams, deps);
      expect(result).toEqual({ dispatched: false, reason });
      expect(calls.dispatchPushInputs).toHaveLength(1);
    }
  });

  it('maps a failed dispatch outcome to reason failed (does not throw)', async () => {
    const { deps, calls } = fakeDeps({
      dispatchPush: async () => ({ kind: 'failed', error: 'expo down' }),
    });
    const result = await dispatchAgentSessionNotificationPush(baseParams, deps);
    expect(result).toEqual({ dispatched: false, reason: 'failed' });
    expect(calls.dispatchPushInputs).toHaveLength(1);
  });

  it('propagates a thrown DO/transport error (does not catch it into failed)', async () => {
    const { deps } = fakeDeps({
      dispatchPush: () => Promise.reject(new Error('transport down')),
    });
    await expect(dispatchAgentSessionNotificationPush(baseParams, deps)).rejects.toThrow(
      'transport down'
    );
  });

  it('rejects invalid params before any dependency call', async () => {
    const { deps } = fakeDeps();
    await expect(
      dispatchAgentSessionNotificationPush(
        { userId: '', cliSessionId: 'ses_abc', notificationId: 'n-1', message: 'x' },
        deps
      )
    ).rejects.toThrow();
    expect(deps.getSession).not.toHaveBeenCalled();
  });
});
