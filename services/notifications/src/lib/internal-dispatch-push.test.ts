import { describe, expect, it } from 'vitest';

import type {
  DispatchPushInput,
  DispatchPushOutcome,
  InternalDispatchLowBalanceRequest,
  InternalDispatchSecurityFindingRequest,
} from '@kilocode/notifications';

import type { UserNotificationPreferences } from './cloud-agent-session-push';
import { dispatchInternalPushCore, type InternalDispatchDeps } from './internal-dispatch-push';

const ALL_ON: UserNotificationPreferences = {
  agentPushEnabled: true,
  chatMessagesEnabled: true,
  agentAttentionEnabled: true,
  sessionStatusEnabled: true,
  kiloclawActivityEnabled: true,
  balanceAlertsEnabled: true,
  securityFindingsEnabled: true,
};

function lowBalance(
  overrides: Partial<InternalDispatchLowBalanceRequest> = {}
): InternalDispatchLowBalanceRequest {
  return {
    kind: 'low_balance',
    recipientUserIds: ['user-a', 'user-b'],
    organizationId: 'org-1',
    organizationName: 'Acme Corp',
    minimumBalanceUsd: 10,
    ...overrides,
  };
}

function securityFinding(
  overrides: Partial<InternalDispatchSecurityFindingRequest> = {}
): InternalDispatchSecurityFindingRequest {
  return {
    kind: 'security_finding',
    recipientUserId: 'user-a',
    notificationId: 'notif-1',
    findingId: 'finding-1',
    scope: 'org-1',
    notificationKind: 'new_finding',
    severity: 'critical',
    repoFullName: 'acme/api',
    title: 'SQL injection in login',
    ...overrides,
  };
}

function expectedLowBalanceInput(userId: string): DispatchPushInput {
  return {
    userId,
    presenceContext: null,
    idempotencyKey: 'low-balance:org-1',
    badge: null,
    push: {
      title: 'Low balance alert',
      body: 'Acme Corp balance fell below $10',
      data: { type: 'low_balance', organizationId: 'org-1' },
      sound: 'default',
      priority: 'high',
    },
  };
}

function fakeDeps(
  options: {
    preferences?:
      | UserNotificationPreferences
      | null
      | ((userId: string) => UserNotificationPreferences | null);
    preferencesThrows?: boolean | ((userId: string) => boolean);
    dispatchPush?: (input: DispatchPushInput) => Promise<DispatchPushOutcome>;
  } = {}
): {
  deps: InternalDispatchDeps;
  calls: { dispatchPushInputs: DispatchPushInput[] };
} {
  const calls = { dispatchPushInputs: [] as DispatchPushInput[] };

  const readPreferences: InternalDispatchDeps['readPreferences'] = async userId => {
    const throws =
      typeof options.preferencesThrows === 'function'
        ? options.preferencesThrows(userId)
        : (options.preferencesThrows ?? false);
    if (throws) throw new Error('prefs db down');

    if (typeof options.preferences === 'function') {
      return options.preferences(userId);
    }
    if (options.preferences === null) return null;
    return options.preferences ?? ALL_ON;
  };

  const dispatchPush =
    options.dispatchPush ??
    (async () => ({ kind: 'delivered' as const, tokenCount: 1 }) satisfies DispatchPushOutcome);

  const deps: InternalDispatchDeps = {
    readPreferences,
    getRecipientDOStub: () => ({
      dispatchPush: async (input: DispatchPushInput) => {
        calls.dispatchPushInputs.push(input);
        return dispatchPush(input);
      },
    }),
  };

  return { deps, calls };
}

describe('dispatchInternalPushCore', () => {
  it('low_balance happy path: dispatches both recipients with exact DispatchPushInput', async () => {
    const { deps, calls } = fakeDeps();
    const result = await dispatchInternalPushCore(lowBalance(), deps);

    expect(result.perRecipient).toEqual([
      { userId: 'user-a', outcome: 'delivered' },
      { userId: 'user-b', outcome: 'delivered' },
    ]);
    expect(calls.dispatchPushInputs).toEqual([
      expectedLowBalanceInput('user-a'),
      expectedLowBalanceInput('user-b'),
    ]);
  });

  it('suppresses low_balance when balanceAlertsEnabled is false (no DO call)', async () => {
    const { deps, calls } = fakeDeps({
      preferences: { ...ALL_ON, balanceAlertsEnabled: false },
    });
    const result = await dispatchInternalPushCore(lowBalance(), deps);

    expect(result.perRecipient).toEqual([
      { userId: 'user-a', outcome: 'suppressed_preference' },
      { userId: 'user-b', outcome: 'suppressed_preference' },
    ]);
    expect(calls.dispatchPushInputs).toHaveLength(0);
  });

  it('suppresses security_finding when securityFindingsEnabled is false (no DO call)', async () => {
    const { deps, calls } = fakeDeps({
      preferences: { ...ALL_ON, securityFindingsEnabled: false },
    });
    const result = await dispatchInternalPushCore(securityFinding(), deps);

    expect(result.perRecipient).toEqual([{ userId: 'user-a', outcome: 'suppressed_preference' }]);
    expect(calls.dispatchPushInputs).toHaveLength(0);
  });

  it('null prefs row is default-on and dispatches', async () => {
    const { deps, calls } = fakeDeps({ preferences: null });
    const result = await dispatchInternalPushCore(
      lowBalance({ recipientUserIds: ['user-a'] }),
      deps
    );

    expect(result.perRecipient).toEqual([{ userId: 'user-a', outcome: 'delivered' }]);
    expect(calls.dispatchPushInputs).toHaveLength(1);
    expect(calls.dispatchPushInputs[0]).toEqual(expectedLowBalanceInput('user-a'));
  });

  it('readPreferences throw → failed with zero dispatchPush calls', async () => {
    const { deps, calls } = fakeDeps({ preferencesThrows: true });
    const result = await dispatchInternalPushCore(
      lowBalance({ recipientUserIds: ['user-a'] }),
      deps
    );

    expect(result.perRecipient).toEqual([{ userId: 'user-a', outcome: 'failed' }]);
    expect(calls.dispatchPushInputs).toHaveLength(0);
  });

  it('mixed recipients: one disabled, one enabled', async () => {
    const { deps, calls } = fakeDeps({
      preferences: userId =>
        userId === 'user-a' ? { ...ALL_ON, balanceAlertsEnabled: false } : ALL_ON,
    });
    const result = await dispatchInternalPushCore(lowBalance(), deps);

    expect(result.perRecipient).toEqual([
      { userId: 'user-a', outcome: 'suppressed_preference' },
      { userId: 'user-b', outcome: 'delivered' },
    ]);
    expect(calls.dispatchPushInputs).toHaveLength(1);
    expect(calls.dispatchPushInputs[0]).toEqual(expectedLowBalanceInput('user-b'));
  });

  it.each([
    {
      notificationKind: 'new_finding' as const,
      severity: 'critical',
      expectedTitle: 'New security finding (critical)',
    },
    {
      notificationKind: 'sla_warning' as const,
      severity: 'high',
      expectedTitle: 'SLA warning',
    },
    {
      notificationKind: 'sla_breach' as const,
      severity: 'medium',
      expectedTitle: 'SLA breach',
    },
  ])(
    'security_finding $notificationKind copy is exact',
    async ({ notificationKind, severity, expectedTitle }) => {
      const { deps, calls } = fakeDeps();
      const input = securityFinding({ notificationKind, severity, title: 'XSS in admin' });
      const result = await dispatchInternalPushCore(input, deps);

      expect(result.perRecipient).toEqual([{ userId: 'user-a', outcome: 'delivered' }]);
      expect(calls.dispatchPushInputs).toHaveLength(1);
      expect(calls.dispatchPushInputs[0]).toEqual({
        userId: 'user-a',
        presenceContext: null,
        idempotencyKey: 'security-finding:notif-1',
        badge: null,
        push: {
          title: expectedTitle,
          body: 'XSS in admin in acme/api',
          data: {
            type: 'security_finding',
            findingId: 'finding-1',
            scope: 'org-1',
          },
          sound: 'default',
          priority: 'high',
        },
      } satisfies DispatchPushInput);
    }
  );

  it('dispatchPush reject → failed', async () => {
    // Pre-attach a no-op catch so the workers vitest pool does not flag the
    // intentional rejection as unhandled; the core still observes it via await.
    const rejected = Promise.reject(new Error('transport down'));
    void rejected.catch(() => {});
    const { deps, calls } = fakeDeps({
      dispatchPush: () => rejected,
    });
    const result = await dispatchInternalPushCore(securityFinding(), deps);

    expect(result.perRecipient).toEqual([{ userId: 'user-a', outcome: 'failed' }]);
    expect(calls.dispatchPushInputs).toHaveLength(1);
  });

  it('passes through DO outcomes duplicate and no_tokens', async () => {
    const outcomes: Record<string, DispatchPushOutcome> = {
      'user-a': { kind: 'duplicate' },
      'user-b': { kind: 'no_tokens' },
    };
    const { deps } = fakeDeps({
      dispatchPush: async input => outcomes[input.userId]!,
    });
    const result = await dispatchInternalPushCore(lowBalance(), deps);

    expect(result.perRecipient).toEqual([
      { userId: 'user-a', outcome: 'duplicate' },
      { userId: 'user-b', outcome: 'no_tokens' },
    ]);
  });

  it('dedups duplicate recipient ids in low_balance to one call', async () => {
    const { deps, calls } = fakeDeps();
    const result = await dispatchInternalPushCore(
      lowBalance({ recipientUserIds: ['user-a', 'user-a', 'user-b', 'user-a'] }),
      deps
    );

    expect(result.perRecipient).toEqual([
      { userId: 'user-a', outcome: 'delivered' },
      { userId: 'user-b', outcome: 'delivered' },
    ]);
    expect(calls.dispatchPushInputs).toHaveLength(2);
    expect(calls.dispatchPushInputs.map(i => i.userId)).toEqual(['user-a', 'user-b']);
  });
});
