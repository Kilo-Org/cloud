import { describe, expect, it } from 'vitest';

import {
  NOTIFICATION_HISTORY_FILTERS,
  notificationHistoryCopy,
  notificationHistoryFilters,
  notificationHistoryTarget,
} from '@/lib/notification-history';

const LOW_BALANCE_PARAMS = { organizationName: 'Acme', minimumBalanceUsd: '5' };

describe('notificationHistoryCopy', () => {
  it('renders the stored catalog key and its params in the requested language', () => {
    const copy = notificationHistoryCopy(
      {
        i18nKey: 'internal.lowBalance',
        i18nParams: LOW_BALANCE_PARAMS,
        title: 'stored title',
        body: 'stored body',
      },
      'de'
    );

    expect(copy.title).toBe('Warnung bei niedrigem Guthaben');
    expect(copy.body).toBe('Das Guthaben von Acme fiel unter $5');
  });

  it('renders English copy for a locale the push catalog does not carry', () => {
    const copy = notificationHistoryCopy(
      { i18nKey: 'internal.lowBalance', i18nParams: LOW_BALANCE_PARAMS, title: '', body: '' },
      'not-a-locale'
    );

    expect(copy).toEqual({
      title: 'Low balance alert',
      body: 'Acme balance fell below $5',
    });
  });

  it('falls back to the stored copy when the catalog key no longer exists', () => {
    const copy = notificationHistoryCopy(
      {
        i18nKey: 'internal.retiredKind',
        i18nParams: { anything: 'x' },
        title: 'Stored title',
        body: 'Stored body',
      },
      'de'
    );

    expect(copy).toEqual({ title: 'Stored title', body: 'Stored body' });
  });

  it('uses the stored copy for a push that carried no catalog key', () => {
    const copy = notificationHistoryCopy(
      { i18nKey: null, i18nParams: null, title: 'Raw title', body: 'Raw body' },
      'de'
    );

    expect(copy).toEqual({ title: 'Raw title', body: 'Raw body' });
  });
});

describe('notificationHistoryTarget', () => {
  it.each([
    [
      { type: 'cloud_agent_session', cliSessionId: 'ses_1', organizationId: 'org-2' },
      '/(app)/agent-chat/ses_1',
    ],
    [
      { type: 'agent_briefing', url: '/agent-briefing' },
      '/(app)/agent-briefing',
    ],
  ])('opens the push destination of a %o row without the push marker', (payload, href) => {
    expect(notificationHistoryTarget(payload)).toMatchObject({ href });
  });

  it('keeps the other query params and drops only the push marker', () => {
    expect(
      notificationHistoryTarget({ type: 'low_balance', organizationId: 'org-acme' })
    ).toMatchObject({
      href: '/(app)/(tabs)/(3_profile)/organization/credit-activity?org=org-acme',
    });
    expect(
      notificationHistoryTarget({
        type: 'spend_alert',
        scope: 'organization',
        organizationId: 'org-acme',
      })
    ).toMatchObject({
      href: '/(app)/(tabs)/(3_profile)/spend-alerts?org=org-acme',
    });
  });

  it('routes a security finding row to its scope', () => {
    expect(
      notificationHistoryTarget({
        type: 'security_finding',
        findingId: 'f-1',
        scope: 'org-9',
      })
    ).toMatchObject({ href: '/(app)/security-agent/org-9/findings/f-1' });
  });

  it('carries the payload the row was recorded from', () => {
    const target = notificationHistoryTarget({
      type: 'cloud_agent_session',
      cliSessionId: 'ses_1',
      organizationId: 'org-2',
    });

    expect(target?.data).toEqual({
      type: 'cloud_agent_session',
      cliSessionId: 'ses_1',
      organizationId: 'org-2',
    });
  });

  it('reports no destination for a payload this app cannot parse', () => {
    expect(notificationHistoryTarget({ type: 'retired_kind' })).toBeNull();
    expect(notificationHistoryTarget({})).toBeNull();
  });
});

describe('notificationHistoryFilters', () => {
  it('offers every recorded category behind an "All" chip', () => {
    expect(NOTIFICATION_HISTORY_FILTERS.map(filter => filter.category)).toEqual([
      null,
      'chatMessages',
      'agentAttention',
      'sessionStatus',
      'balanceAlerts',
      'spendAlerts',
      'securityFindings',
    ]);
  });

  it('drops a category the account cannot receive', () => {
    const filters = notificationHistoryFilters({
      balanceAlerts: { available: false },
      securityFindings: { available: false },
    });

    expect(filters.map(filter => filter.category)).toEqual([
      null,
      'chatMessages',
      'agentAttention',
      'sessionStatus',
      'spendAlerts',
    ]);
  });

  it('keeps every chip while availability is unknown or unread', () => {
    expect(notificationHistoryFilters(undefined)).toEqual(NOTIFICATION_HISTORY_FILTERS);
    expect(notificationHistoryFilters({})).toEqual(NOTIFICATION_HISTORY_FILTERS);
  });
});
