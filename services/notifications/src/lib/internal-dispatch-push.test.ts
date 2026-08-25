import { describe, expect, it } from 'vitest';

import {
  pushDataSchema,
  type DispatchPushInput,
  type DispatchPushOutcome,
  type InternalDispatchLowBalanceRequest,
  type InternalDispatchSecurityFindingRequest,
  type InternalDispatchSecurityLifecycleRequest,
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

function securityLifecycle(
  overrides: Partial<InternalDispatchSecurityLifecycleRequest> = {}
): InternalDispatchSecurityLifecycleRequest {
  return {
    kind: 'security_lifecycle',
    event: 'remediation_pr_opened',
    findingId: 'finding-1',
    scope: 'org-1',
    remediationId: 'remediation-1',
    prUrl: 'https://github.com/acme/api/pull/42',
    recipientUserIds: ['user-a', 'user-b'],
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
      i18nKey: 'internal.lowBalance',
      i18nParams: { organizationName: 'Acme Corp', minimumBalanceUsd: '10' },
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

  it('low_balance reads only balanceAlertsEnabled (ignores all other categories)', async () => {
    const { deps, calls } = fakeDeps({
      preferences: {
        ...ALL_ON,
        agentPushEnabled: false,
        chatMessagesEnabled: false,
        agentAttentionEnabled: false,
        sessionStatusEnabled: false,
        kiloclawActivityEnabled: false,
        securityFindingsEnabled: false,
        balanceAlertsEnabled: true,
      },
    });
    const result = await dispatchInternalPushCore(
      lowBalance({ recipientUserIds: ['user-a'] }),
      deps
    );

    expect(result.perRecipient).toEqual([{ userId: 'user-a', outcome: 'delivered' }]);
    expect(calls.dispatchPushInputs).toHaveLength(1);
  });

  it('security_finding reads only securityFindingsEnabled (ignores all other categories)', async () => {
    const { deps, calls } = fakeDeps({
      preferences: {
        ...ALL_ON,
        agentPushEnabled: false,
        chatMessagesEnabled: false,
        agentAttentionEnabled: false,
        sessionStatusEnabled: false,
        kiloclawActivityEnabled: false,
        balanceAlertsEnabled: false,
        securityFindingsEnabled: true,
      },
    });
    const result = await dispatchInternalPushCore(securityFinding(), deps);

    expect(result.perRecipient).toEqual([{ userId: 'user-a', outcome: 'delivered' }]);
    expect(calls.dispatchPushInputs).toHaveLength(1);
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

  it('readPreferences throw (security_finding) → failed with zero dispatchPush calls', async () => {
    const { deps, calls } = fakeDeps({ preferencesThrows: true });
    const result = await dispatchInternalPushCore(securityFinding(), deps);

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
      expectedI18nKey: 'internal.securityFindingNew',
    },
    {
      notificationKind: 'sla_warning' as const,
      severity: 'high',
      expectedTitle: 'SLA warning',
      expectedI18nKey: 'internal.securityFindingSlaWarning',
    },
    {
      notificationKind: 'sla_breach' as const,
      severity: 'medium',
      expectedTitle: 'SLA breach',
      expectedI18nKey: 'internal.securityFindingSlaBreach',
    },
  ])(
    'security_finding $notificationKind copy is exact',
    async ({ notificationKind, severity, expectedTitle, expectedI18nKey }) => {
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
          i18nKey: expectedI18nKey,
          i18nParams: {
            severity,
            findingTitle: 'XSS in admin',
            repoFullName: 'acme/api',
          },
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

  it('security_finding with ghsaId set uses advisory-identity idempotency key', async () => {
    const { deps, calls } = fakeDeps();
    const input = securityFinding({ ghsaId: 'GHSA-abcd-1234' });
    const result = await dispatchInternalPushCore(input, deps);

    expect(result.perRecipient).toEqual([{ userId: 'user-a', outcome: 'delivered' }]);
    expect(calls.dispatchPushInputs).toHaveLength(1);
    expect(calls.dispatchPushInputs[0].idempotencyKey).toBe(
      'security-finding:acme/api:GHSA-abcd-1234:new_finding'
    );
  });

  it.each([undefined, null])(
    'security_finding with ghsaId %s falls back to per-notificationId key',
    async ghsaId => {
      const { deps, calls } = fakeDeps();
      const input = securityFinding({ ghsaId } as Partial<InternalDispatchSecurityFindingRequest>);
      const result = await dispatchInternalPushCore(input, deps);

      expect(result.perRecipient).toEqual([{ userId: 'user-a', outcome: 'delivered' }]);
      expect(calls.dispatchPushInputs).toHaveLength(1);
      expect(calls.dispatchPushInputs[0].idempotencyKey).toBe('security-finding:notif-1');
    }
  );

  it('two sibling findings with same ghsaId+repo+kind share one idempotency key', async () => {
    const { deps, calls } = fakeDeps();
    await dispatchInternalPushCore(
      securityFinding({ notificationId: 'notif-1', ghsaId: 'GHSA-abcd-1234' }),
      deps
    );
    await dispatchInternalPushCore(
      securityFinding({ notificationId: 'notif-2', ghsaId: 'GHSA-abcd-1234' }),
      deps
    );

    expect(calls.dispatchPushInputs).toHaveLength(2);
    expect(calls.dispatchPushInputs[0].idempotencyKey).toBe(
      calls.dispatchPushInputs[1].idempotencyKey
    );
  });

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

  it('security_lifecycle dispatches all recipients with a payload that validates', async () => {
    const { deps, calls } = fakeDeps();
    const result = await dispatchInternalPushCore(securityLifecycle(), deps);

    expect(result.perRecipient).toEqual([
      { userId: 'user-a', outcome: 'delivered' },
      { userId: 'user-b', outcome: 'delivered' },
    ]);
    expect(calls.dispatchPushInputs).toHaveLength(2);
    for (const input of calls.dispatchPushInputs) {
      expect(input.push.data).toEqual({
        type: 'security_lifecycle',
        event: 'remediation_pr_opened',
        findingId: 'finding-1',
        scope: 'org-1',
        remediationId: 'remediation-1',
        prUrl: 'https://github.com/acme/api/pull/42',
      });
      expect(pushDataSchema.safeParse(input.push.data).success).toBe(true);
    }
    expect(calls.dispatchPushInputs[0]).toEqual({
      userId: 'user-a',
      presenceContext: null,
      idempotencyKey: 'security-lifecycle:finding-1:remediation_pr_opened:remediation-1',
      badge: null,
      push: {
        title: 'Kilo',
        body: 'A security finding needs attention',
        i18nKey: 'internal.securityLifecycle',
        data: {
          type: 'security_lifecycle',
          event: 'remediation_pr_opened',
          findingId: 'finding-1',
          scope: 'org-1',
          remediationId: 'remediation-1',
          prUrl: 'https://github.com/acme/api/pull/42',
        },
        sound: 'default',
        priority: 'high',
      },
    } satisfies DispatchPushInput);
  });

  it('security_lifecycle omits optional fields when absent and still validates', async () => {
    const { deps, calls } = fakeDeps();
    const result = await dispatchInternalPushCore(
      securityLifecycle({
        event: 'analysis_completed',
        remediationId: undefined,
        prUrl: undefined,
        recipientUserIds: ['user-a'],
      }),
      deps
    );

    expect(result.perRecipient).toEqual([{ userId: 'user-a', outcome: 'delivered' }]);
    expect(calls.dispatchPushInputs).toHaveLength(1);
    expect(calls.dispatchPushInputs[0].push.data).toEqual({
      type: 'security_lifecycle',
      event: 'analysis_completed',
      findingId: 'finding-1',
      scope: 'org-1',
    });
    expect(pushDataSchema.safeParse(calls.dispatchPushInputs[0].push.data).success).toBe(true);
    expect(calls.dispatchPushInputs[0].idempotencyKey).toBe(
      'security-lifecycle:finding-1:analysis_completed:none'
    );
  });

  it('suppresses security_lifecycle when securityFindingsEnabled is false (no DO call)', async () => {
    const { deps, calls } = fakeDeps({
      preferences: { ...ALL_ON, securityFindingsEnabled: false },
    });
    const result = await dispatchInternalPushCore(securityLifecycle(), deps);

    expect(result.perRecipient).toEqual([
      { userId: 'user-a', outcome: 'suppressed_preference' },
      { userId: 'user-b', outcome: 'suppressed_preference' },
    ]);
    expect(calls.dispatchPushInputs).toHaveLength(0);
  });

  it('security_lifecycle reads only securityFindingsEnabled (ignores all other categories)', async () => {
    const { deps, calls } = fakeDeps({
      preferences: {
        ...ALL_ON,
        agentPushEnabled: false,
        chatMessagesEnabled: false,
        agentAttentionEnabled: false,
        sessionStatusEnabled: false,
        kiloclawActivityEnabled: false,
        balanceAlertsEnabled: false,
        securityFindingsEnabled: true,
      },
    });
    const result = await dispatchInternalPushCore(
      securityLifecycle({ recipientUserIds: ['user-a'] }),
      deps
    );

    expect(result.perRecipient).toEqual([{ userId: 'user-a', outcome: 'delivered' }]);
    expect(calls.dispatchPushInputs).toHaveLength(1);
  });

  it('dedups duplicate recipient ids in security_lifecycle to one call', async () => {
    const { deps, calls } = fakeDeps();
    const result = await dispatchInternalPushCore(
      securityLifecycle({ recipientUserIds: ['user-a', 'user-a', 'user-b'] }),
      deps
    );

    expect(result.perRecipient).toEqual([
      { userId: 'user-a', outcome: 'delivered' },
      { userId: 'user-b', outcome: 'delivered' },
    ]);
    expect(calls.dispatchPushInputs).toHaveLength(2);
  });
});
