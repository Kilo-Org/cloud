import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_NOTIFICATION_PREFERENCE,
  deriveAgentPushEditable,
  deriveGateSettled,
  deriveShowEnableCta,
  NOTIFICATION_CATEGORY_KEYS,
  type NotificationPreferences,
  readAgentPushPreference,
} from './agent-push-preference';

const key = ['user', 'getNotificationPreferences'] as const;

function makeQueryClient(): QueryClient {
  return new QueryClient();
}

function fullRow(overrides: Partial<NotificationPreferences> = {}): NotificationPreferences {
  return {
    chatMessages: DEFAULT_NOTIFICATION_PREFERENCE,
    agentAttention: DEFAULT_NOTIFICATION_PREFERENCE,
    agentUpdates: DEFAULT_NOTIFICATION_PREFERENCE,
    sessionStatus: DEFAULT_NOTIFICATION_PREFERENCE,
    kiloclawActivity: DEFAULT_NOTIFICATION_PREFERENCE,
    balanceAlerts: DEFAULT_NOTIFICATION_PREFERENCE,
    securityFindings: DEFAULT_NOTIFICATION_PREFERENCE,
    agentPushEnabled: DEFAULT_NOTIFICATION_PREFERENCE,
    ...overrides,
  };
}

describe('DEFAULT_NOTIFICATION_PREFERENCE', () => {
  it('is true (default ON per plan)', () => {
    expect(DEFAULT_NOTIFICATION_PREFERENCE).toBe(true);
  });
});

describe('NOTIFICATION_CATEGORY_KEYS', () => {
  it('lists the categories rendered on the dedicated screen including balance and security', () => {
    expect([...NOTIFICATION_CATEGORY_KEYS]).toEqual([
      'chatMessages',
      'agentAttention',
      'agentUpdates',
      'sessionStatus',
      'kiloclawActivity',
      'balanceAlerts',
      'securityFindings',
    ]);
  });
});

describe('deriveAgentPushEditable', () => {
  it('is true when the preference query has data and no mutation is pending', () => {
    expect(deriveAgentPushEditable({ hasData: true, isPending: false })).toBe(true);
  });

  it('is false while a mutation is pending even if the query has data', () => {
    expect(deriveAgentPushEditable({ hasData: true, isPending: true })).toBe(false);
  });

  it('is false when the preference query has not loaded', () => {
    expect(deriveAgentPushEditable({ hasData: false, isPending: false })).toBe(false);
  });

  it('is false while a mutation is pending without loaded data', () => {
    expect(deriveAgentPushEditable({ hasData: false, isPending: true })).toBe(false);
  });
});

describe('deriveShowEnableCta (empty-state CTA presence)', () => {
  it('shows the CTA when notifications are disabled (permission not granted OR no backend token)', () => {
    expect(deriveShowEnableCta(false)).toBe(true);
  });

  it('hides the CTA when notifications are fully enabled', () => {
    expect(deriveShowEnableCta(true)).toBe(false);
  });
});

describe('deriveGateSettled (master gate settle flap)', () => {
  // Truth table: permissionSettled, granted, pushTokensSettled, deviceTokenSettled → result
  const cases: [boolean, boolean, boolean, boolean, boolean, string][] = [
    [false, false, false, false, false, 'permission loading'],
    [false, true, true, true, false, 'permission loading ignores settled tokens'],
    // Denied / permission-error (granted falsy): short-circuit; token flags irrelevant
    [true, false, false, false, true, 'denied short-circuits unsettled tokens'],
    [true, false, true, true, true, 'denied with settled tokens still true'],
    // Granted: both token queries must settle (isFetched || isError each)
    [true, true, false, true, false, 'granted, pushTokens in flight'],
    [true, true, true, false, false, 'granted, deviceToken in flight'],
    [true, true, false, false, false, 'granted, both tokens in flight'],
    [true, true, true, true, true, 'granted, both tokens settled'],
  ];

  for (const [
    permissionSettled,
    permissionGranted,
    pushTokensSettled,
    deviceTokenSettled,
    expected,
    label,
  ] of cases) {
    it(label, () => {
      expect(
        deriveGateSettled({
          permissionSettled,
          permissionGranted,
          pushTokensSettled,
          deviceTokenSettled,
        })
      ).toBe(expected);
    });
  }
});

describe('readAgentPushPreference', () => {
  it('returns the default for the requested category when the cache has no snapshot', () => {
    const qc = makeQueryClient();
    for (const category of NOTIFICATION_CATEGORY_KEYS) {
      expect(readAgentPushPreference(qc, key, category)).toBe(DEFAULT_NOTIFICATION_PREFERENCE);
    }
  });

  it('returns the cached value for each category when the full row is present', () => {
    const qc = makeQueryClient();
    qc.setQueryData(key, {
      chatMessages: true,
      agentAttention: false,
      agentUpdates: true,
      sessionStatus: false,
      kiloclawActivity: true,
      balanceAlerts: false,
      securityFindings: true,
      agentPushEnabled: true,
    });
    expect(readAgentPushPreference(qc, key, 'chatMessages')).toBe(true);
    expect(readAgentPushPreference(qc, key, 'agentAttention')).toBe(false);
    expect(readAgentPushPreference(qc, key, 'agentUpdates')).toBe(true);
    expect(readAgentPushPreference(qc, key, 'sessionStatus')).toBe(false);
    expect(readAgentPushPreference(qc, key, 'kiloclawActivity')).toBe(true);
    expect(readAgentPushPreference(qc, key, 'balanceAlerts')).toBe(false);
    expect(readAgentPushPreference(qc, key, 'securityFindings')).toBe(true);
  });

  it('maps the legacy `agentPushEnabled` snapshot to the agentUpdates category', () => {
    const qc = makeQueryClient();
    qc.setQueryData(key, { agentPushEnabled: false });
    expect(readAgentPushPreference(qc, key, 'agentUpdates')).toBe(false);
    // Non-agentUpdates categories fall back to the default when only the
    // legacy field is present.
    expect(readAgentPushPreference(qc, key, 'chatMessages')).toBe(DEFAULT_NOTIFICATION_PREFERENCE);
    expect(readAgentPushPreference(qc, key, 'balanceAlerts')).toBe(DEFAULT_NOTIFICATION_PREFERENCE);
    expect(readAgentPushPreference(qc, key, 'securityFindings')).toBe(
      DEFAULT_NOTIFICATION_PREFERENCE
    );
  });

  it('defaults to the agentUpdates category when no category is passed', () => {
    const qc = makeQueryClient();
    qc.setQueryData(key, fullRow({ agentUpdates: false }));
    expect(readAgentPushPreference(qc, key)).toBe(false);
  });
});
