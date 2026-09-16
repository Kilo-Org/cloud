import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCached } from '@/lib/active-sessions-live-sync.test-helpers';
import { setSignOutActive } from '@/lib/auth/sign-out-state';
import { setTelemetrySink, type TelemetryEvent } from '@/lib/telemetry/error-sink';
import {
  applyNeedsInputNotifications,
  type NeedsInputNotificationRow,
  notificationIdentifierForSession,
  planNeedsInputNotifications,
  shouldPublishForSession,
} from './needs-input-notification';

const mocks = vi.hoisted(() => ({
  scheduleNotificationAsync: vi.fn(),
  dismissNotificationAsync: vi.fn(),
}));

vi.mock('expo-notifications', () => ({
  scheduleNotificationAsync: mocks.scheduleNotificationAsync,
  dismissNotificationAsync: mocks.dismissNotificationAsync,
}));

const ACTIVE = 'active';
const AWAY = '/agent-chat/ses_other';

function notifiedRow(over: Partial<NeedsInputNotificationRow> = {}): NeedsInputNotificationRow {
  return {
    sessionId: 'ses_1',
    title: 'Fix the bug',
    kind: 'question',
    prUrl: null,
    organizationId: null,
    ...over,
  };
}

beforeEach(() => {
  setSignOutActive(false);
  setTelemetrySink(null);
  mocks.scheduleNotificationAsync.mockReset().mockResolvedValue(undefined);
  mocks.dismissNotificationAsync.mockReset().mockResolvedValue(undefined);
});

describe('notificationIdentifierForSession', () => {
  it('namespaces the identifier so a later result replaces the same notification', () => {
    expect(notificationIdentifierForSession('ses_1')).toBe('needs-input:ses_1');
    expect(notificationIdentifierForSession('ses_1')).not.toBe(
      notificationIdentifierForSession('ses_2')
    );
  });
});

describe('shouldPublishForSession', () => {
  it('publishes while the app is active on another route', () => {
    expect(shouldPublishForSession({ appState: ACTIVE, pathname: AWAY, sessionId: 'ses_1' })).toBe(
      true
    );
  });

  it.each(['background', 'inactive', 'unknown'] as const)(
    'withholds while the app is %s and the server push is the carrier',
    appState => {
      expect(shouldPublishForSession({ appState, pathname: AWAY, sessionId: 'ses_1' })).toBe(false);
    }
  );

  it('withholds while that session chat is open', () => {
    for (const pathname of ['/agent-chat/ses_1', '/(app)/agent-chat/ses_1', '/agent-chat/ses_1/']) {
      expect(shouldPublishForSession({ appState: ACTIVE, pathname, sessionId: 'ses_1' })).toBe(
        false
      );
    }
  });

  it('publishes while a different session chat is open', () => {
    expect(shouldPublishForSession({ appState: ACTIVE, pathname: AWAY, sessionId: 'ses_1' })).toBe(
      true
    );
  });

  it('publishes when the router is not mounted', () => {
    expect(shouldPublishForSession({ appState: ACTIVE, pathname: null, sessionId: 'ses_1' })).toBe(
      true
    );
  });
});

describe('planNeedsInputNotifications', () => {
  it('publishes a row transporting into a question', () => {
    const plan = planNeedsInputNotifications({
      previous: [],
      next: [makeCached({ id: 'ses_1', title: 'Fix the bug', status: 'question' })],
      pathname: AWAY,
      appState: ACTIVE,
    });
    expect(plan).toEqual({
      publish: [
        {
          sessionId: 'ses_1',
          title: 'Fix the bug',
          kind: 'question',
          prUrl: null,
          organizationId: null,
        },
      ],
      dismiss: [],
    });
  });

  it('publishes a classified permission with the PR that can be opened', () => {
    const plan = planNeedsInputNotifications({
      previous: [],
      next: [
        makeCached({
          id: 'ses_2',
          title: 'Deploy',
          status: 'permission',
          associatedPr: {
            url: 'https://github.com/org/repo/pull/7',
            number: 7,
            state: 'open',
            title: null,
            headSha: null,
            lastSyncedAt: '2026-01-01T00:00:00.000Z',
            reviewDecision: null,
            reviewDecisionPending: false,
            platform: 'github',
          },
        }),
      ],
      pathname: AWAY,
      appState: ACTIVE,
    });
    expect(plan.publish).toEqual([
      {
        sessionId: 'ses_2',
        title: 'Deploy',
        kind: 'permission',
        prUrl: 'https://github.com/org/repo/pull/7',
        organizationId: null,
      },
    ]);
    expect(plan.dismiss).toEqual([]);
  });

  it('does not re-publish a raise it already notified', () => {
    const plan = planNeedsInputNotifications({
      previous: [notifiedRow()],
      next: [makeCached({ id: 'ses_1', status: 'question' })],
      pathname: AWAY,
      appState: ACTIVE,
    });
    expect(plan).toEqual({ publish: [], dismiss: [] });
  });

  it('dismisses a raise that left needs-input', () => {
    const plan = planNeedsInputNotifications({
      previous: [notifiedRow()],
      next: [makeCached({ id: 'ses_1', status: 'running' })],
      pathname: AWAY,
      appState: ACTIVE,
    });
    expect(plan).toEqual({ publish: [], dismiss: ['needs-input:ses_1'] });
  });

  it('dismisses a raise whose row disappeared', () => {
    const plan = planNeedsInputNotifications({
      previous: [notifiedRow()],
      next: [makeCached({ id: 'ses_other', status: 'running' })],
      pathname: AWAY,
      appState: ACTIVE,
    });
    expect(plan).toEqual({ publish: [], dismiss: ['needs-input:ses_1'] });
  });

  it('dismisses a raise that changed organization without re-posting it', () => {
    const plan = planNeedsInputNotifications({
      previous: [notifiedRow({ organizationId: null })],
      next: [makeCached({ id: 'ses_1', status: 'question', organizationId: 'org-a' })],
      pathname: AWAY,
      appState: ACTIVE,
    });
    expect(plan).toEqual({ publish: [], dismiss: ['needs-input:ses_1'] });
  });

  it('keeps a still-waiting raise when the gate only withholds the post', () => {
    for (const input of [
      { pathname: AWAY, appState: 'background' as const },
      { pathname: '/agent-chat/ses_1', appState: 'active' as const },
    ]) {
      expect(
        planNeedsInputNotifications({
          previous: [notifiedRow()],
          next: [makeCached({ id: 'ses_1', status: 'question' })],
          ...input,
        })
      ).toEqual({ publish: [], dismiss: [] });
    }
  });

  it('dismisses every posted identifier on sign-out and posts nothing', () => {
    setSignOutActive(true);
    const plan = planNeedsInputNotifications({
      previous: [notifiedRow(), notifiedRow({ sessionId: 'ses_2', kind: 'permission' })],
      next: [makeCached({ id: 'ses_1', status: 'question' })],
      pathname: AWAY,
      appState: ACTIVE,
    });
    expect(plan).toEqual({
      publish: [],
      dismiss: ['needs-input:ses_1', 'needs-input:ses_2'],
    });
  });

  it('posts nothing and dismisses the stale identifier when no row needs input', () => {
    const plan = planNeedsInputNotifications({
      previous: [notifiedRow()],
      next: [],
      pathname: AWAY,
      appState: ACTIVE,
    });
    expect(plan).toEqual({ publish: [], dismiss: ['needs-input:ses_1'] });
  });
});

describe('applyNeedsInputNotifications', () => {
  it('dismisses identifiers first, then posts each raise', async () => {
    const order: string[] = [];
    mocks.dismissNotificationAsync.mockImplementation((identifier: string) => {
      order.push(`dismiss:${identifier}`);
    });
    mocks.scheduleNotificationAsync.mockImplementation((request: { identifier: string }) => {
      order.push(`post:${request.identifier}`);
    });

    await applyNeedsInputNotifications({
      publish: [notifiedRow(), notifiedRow({ sessionId: 'ses_2', kind: 'permission' })],
      dismiss: ['needs-input:ses_old'],
    });

    expect(order).toEqual([
      'dismiss:needs-input:ses_old',
      'post:needs-input:ses_1',
      'post:needs-input:ses_2',
    ]);
  });

  it('posts the shared category, channel, payload and time-sensitive level', async () => {
    await applyNeedsInputNotifications({
      publish: [notifiedRow({ title: 'Fix the bug' })],
      dismiss: [],
    });

    expect(mocks.scheduleNotificationAsync).toHaveBeenCalledWith({
      identifier: 'needs-input:ses_1',
      content: {
        title: 'Fix the bug',
        body: 'Agent needs input',
        data: {
          type: 'cloud_agent_session',
          cliSessionId: 'ses_1',
          category: 'attention',
          attentionKind: 'question',
        },
        categoryIdentifier: 'kilo-needs-input:question',
        interruptionLevel: 'timeSensitive',
      },
      trigger: { channelId: 'agent-attention' },
    });
  });

  it('derives the -pr category and payload from the session PR', async () => {
    await applyNeedsInputNotifications({
      publish: [
        notifiedRow({
          kind: 'permission',
          prUrl: 'https://github.com/org/repo/pull/7',
        }),
      ],
      dismiss: [],
    });

    expect(mocks.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          data: expect.objectContaining({ prUrl: 'https://github.com/org/repo/pull/7' }),
          categoryIdentifier: 'kilo-needs-input:permission-pr',
        }),
      })
    );
  });

  it('reports and swallows a rejected schedule so the mount never crashes', async () => {
    const events: TelemetryEvent[] = [];
    setTelemetrySink(event => {
      events.push(event);
    });
    mocks.scheduleNotificationAsync.mockRejectedValue(new Error('permission revoked'));

    await expect(
      applyNeedsInputNotifications({ publish: [notifiedRow()], dismiss: [] })
    ).resolves.toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0]?.tags?.['error.operation']).toBe('needs_input_publish');
  });

  it('reports and swallows a rejected dismissal', async () => {
    const events: TelemetryEvent[] = [];
    setTelemetrySink(event => {
      events.push(event);
    });
    mocks.dismissNotificationAsync.mockRejectedValue(new Error('no presenter'));

    await expect(
      applyNeedsInputNotifications({ publish: [], dismiss: ['needs-input:ses_1'] })
    ).resolves.toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0]?.tags?.['error.operation']).toBe('needs_input_dismiss');
  });
});
