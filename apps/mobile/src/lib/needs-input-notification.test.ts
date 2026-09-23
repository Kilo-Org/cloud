/* eslint-disable max-lines -- one suite pins the plan's publish/dismiss decisions */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCached } from '@/lib/active-sessions-live-sync.test-helpers';
import { setSignOutActive } from '@/lib/auth/sign-out-state';
import { setTelemetrySink, type TelemetryEvent } from '@/lib/telemetry/error-sink';
import {
  applyNeedsInputNotifications,
  type NeedsInputNotificationRow,
  notificationIdentifierForSession,
  planNeedsInputNotifications,
  reconcileNotifiedAfterApply,
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
      attentionEnabled: true,
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
      updates: [],
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
      attentionEnabled: true,
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
      attentionEnabled: true,
    });
    expect(plan).toEqual({ publish: [], dismiss: [], updates: [] });
  });

  it('re-publishes a still-waiting raise whose associated PR appeared', () => {
    // A raise posted before the PR link reached the cache carries no Open PR
    // control; once the enriched row lands while the raise still waits, the
    // notification must offer the action the session now supports. The same
    // identifier replaces the standing notification in place.
    const plan = planNeedsInputNotifications({
      previous: [notifiedRow()],
      next: [
        makeCached({
          id: 'ses_1',
          title: 'Fix the bug',
          status: 'question',
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
      attentionEnabled: true,
    });
    expect(plan.publish).toEqual([notifiedRow({ prUrl: 'https://github.com/org/repo/pull/7' })]);
    expect(plan.dismiss).toEqual([]);
  });

  it('re-publishes a still-waiting raise whose kind moved', () => {
    const plan = planNeedsInputNotifications({
      previous: [notifiedRow({ kind: 'question' })],
      next: [makeCached({ id: 'ses_1', title: 'Fix the bug', status: 'permission' })],
      pathname: AWAY,
      appState: ACTIVE,
      attentionEnabled: true,
    });
    expect(plan.publish).toEqual([notifiedRow({ kind: 'permission' })]);
    expect(plan.dismiss).toEqual([]);
  });

  it('withholds the re-publish while that session chat is open', () => {
    const plan = planNeedsInputNotifications({
      previous: [notifiedRow()],
      next: [
        makeCached({
          id: 'ses_1',
          title: 'Fix the bug',
          status: 'question',
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
      pathname: '/agent-chat/ses_1',
      appState: ACTIVE,
      attentionEnabled: true,
    });
    expect(plan).toEqual({ publish: [], dismiss: [], updates: [] });
  });

  it('dismisses a raise that left needs-input', () => {
    const plan = planNeedsInputNotifications({
      previous: [notifiedRow()],
      next: [makeCached({ id: 'ses_1', status: 'running' })],
      pathname: AWAY,
      appState: ACTIVE,
      attentionEnabled: true,
    });
    expect(plan).toEqual({ publish: [], dismiss: ['needs-input:ses_1'], updates: [] });
  });

  it('dismisses a raise whose row disappeared', () => {
    const plan = planNeedsInputNotifications({
      previous: [notifiedRow()],
      next: [makeCached({ id: 'ses_other', status: 'running' })],
      pathname: AWAY,
      appState: ACTIVE,
      attentionEnabled: true,
    });
    expect(plan).toEqual({ publish: [], dismiss: ['needs-input:ses_1'], updates: [] });
  });

  it('dismisses a raise that changed organization without re-posting it', () => {
    const plan = planNeedsInputNotifications({
      previous: [notifiedRow({ organizationId: null })],
      next: [makeCached({ id: 'ses_1', status: 'question', organizationId: 'org-a' })],
      pathname: AWAY,
      appState: ACTIVE,
      attentionEnabled: true,
    });
    expect(plan).toEqual({ publish: [], dismiss: ['needs-input:ses_1'], updates: [] });
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
          attentionEnabled: true,
          ...input,
        })
      ).toEqual({ publish: [], dismiss: [], updates: [] });
    }
  });

  it('posts nothing while the agentAttention preference is off', () => {
    const plan = planNeedsInputNotifications({
      previous: [],
      next: [makeCached({ id: 'ses_1', status: 'question' })],
      pathname: AWAY,
      appState: ACTIVE,
      attentionEnabled: false,
    });
    expect(plan).toEqual({ publish: [], dismiss: [], updates: [] });
  });

  it('dismisses a raise already on screen when agentAttention is turned off', () => {
    const plan = planNeedsInputNotifications({
      previous: [notifiedRow(), notifiedRow({ sessionId: 'ses_2', kind: 'permission' })],
      next: [
        makeCached({ id: 'ses_1', status: 'question' }),
        makeCached({ id: 'ses_2', status: 'permission' }),
      ],
      pathname: AWAY,
      appState: ACTIVE,
      attentionEnabled: false,
    });
    expect(plan).toEqual({
      publish: [],
      dismiss: ['needs-input:ses_1', 'needs-input:ses_2'],
      updates: [],
    });
  });

  it('withholds posting, and keeps what is posted, until the preference row loads', () => {
    // Before the `agentAttention` row is in the cache the plan must not fall
    // back to ON (it would alert a category the user turned off after a
    // restart) and must not fall back to OFF (it would drop a standing raise):
    // it waits, leaving both the publish and dismiss sets empty.
    const plan = planNeedsInputNotifications({
      previous: [notifiedRow(), notifiedRow({ sessionId: 'ses_gone', kind: 'permission' })],
      next: [makeCached({ id: 'ses_1', status: 'question' })],
      pathname: AWAY,
      appState: ACTIVE,
      attentionEnabled: undefined,
    });
    expect(plan).toEqual({ publish: [], dismiss: [], updates: [] });
  });

  it('signs out even while the preference row has not loaded', () => {
    setSignOutActive(true);
    const plan = planNeedsInputNotifications({
      previous: [notifiedRow()],
      next: [makeCached({ id: 'ses_1', status: 'question' })],
      pathname: AWAY,
      appState: ACTIVE,
      attentionEnabled: undefined,
    });
    expect(plan).toEqual({ publish: [], dismiss: ['needs-input:ses_1'], updates: [] });
  });

  it('dismisses every posted identifier on sign-out and posts nothing', () => {
    setSignOutActive(true);
    const plan = planNeedsInputNotifications({
      previous: [notifiedRow(), notifiedRow({ sessionId: 'ses_2', kind: 'permission' })],
      next: [makeCached({ id: 'ses_1', status: 'question' })],
      pathname: AWAY,
      appState: ACTIVE,
      attentionEnabled: true,
    });
    expect(plan).toEqual({
      publish: [],
      dismiss: ['needs-input:ses_1', 'needs-input:ses_2'],
      updates: [],
    });
  });

  it('posts nothing and dismisses the stale identifier when no row needs input', () => {
    const plan = planNeedsInputNotifications({
      previous: [notifiedRow()],
      next: [],
      pathname: AWAY,
      appState: ACTIVE,
      attentionEnabled: true,
    });
    expect(plan).toEqual({ publish: [], dismiss: ['needs-input:ses_1'], updates: [] });
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
      updates: [],
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
      updates: [],
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
      trigger: { channelId: 'needs-input' },
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
      updates: [],
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

  it('re-posts an already-posted raise quietly so a status change never alerts again', async () => {
    const plan = planNeedsInputNotifications({
      previous: [notifiedRow()],
      next: [makeCached({ id: 'ses_1', title: 'Fix the bug', status: 'permission' })],
      pathname: AWAY,
      appState: ACTIVE,
      attentionEnabled: true,
    });
    expect(plan.updates).toEqual(['ses_1']);

    await applyNeedsInputNotifications(plan);

    expect(mocks.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          categoryIdentifier: 'kilo-needs-input:permission',
          sound: false,
        }),
      })
    );
  });

  it('keeps a first post of a raise alerting on the shared channel', async () => {
    const plan = planNeedsInputNotifications({
      previous: [],
      next: [makeCached({ id: 'ses_1', title: 'Fix the bug', status: 'question' })],
      pathname: AWAY,
      appState: ACTIVE,
      attentionEnabled: true,
    });
    expect(plan.updates).toEqual([]);

    await applyNeedsInputNotifications(plan);

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
      trigger: { channelId: 'needs-input' },
    });
  });

  it('alerts again once the raise was dismissed and comes back', async () => {
    const raise = makeCached({ id: 'ses_1', title: 'Fix the bug', status: 'question' });
    const first = planNeedsInputNotifications({
      previous: [],
      next: [raise],
      pathname: AWAY,
      appState: ACTIVE,
      attentionEnabled: true,
    });
    await applyNeedsInputNotifications(first);
    await applyNeedsInputNotifications(
      planNeedsInputNotifications({
        previous: first.publish,
        next: [],
        pathname: AWAY,
        appState: ACTIVE,
        attentionEnabled: true,
      })
    );
    const back = planNeedsInputNotifications({
      previous: [],
      next: [raise],
      pathname: AWAY,
      appState: ACTIVE,
      attentionEnabled: true,
    });

    expect(back.updates).toEqual([]);
    await applyNeedsInputNotifications(back);

    expect(mocks.scheduleNotificationAsync).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ content: expect.not.objectContaining({ sound: false }) })
    );
  });

  it('reports and swallows a rejected schedule so the mount never crashes', async () => {
    const events: TelemetryEvent[] = [];
    setTelemetrySink(event => {
      events.push(event);
    });
    mocks.scheduleNotificationAsync.mockRejectedValue(new Error('permission revoked'));

    await expect(
      applyNeedsInputNotifications({ publish: [notifiedRow()], dismiss: [], updates: [] })
    ).resolves.toEqual({ published: [], dismissed: [] });
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
      applyNeedsInputNotifications({ publish: [], dismiss: ['needs-input:ses_1'], updates: [] })
    ).resolves.toEqual({ published: [], dismissed: [] });
    expect(events).toHaveLength(1);
    expect(events[0]?.tags?.['error.operation']).toBe('needs_input_dismiss');
  });

  it('names only the operations that actually landed', async () => {
    const row = notifiedRow();
    mocks.scheduleNotificationAsync.mockResolvedValue(undefined);
    mocks.dismissNotificationAsync.mockRejectedValue(new Error('no presenter'));

    await expect(
      applyNeedsInputNotifications({
        publish: [row],
        dismiss: ['needs-input:ses_old'],
        updates: [],
      })
    ).resolves.toEqual({ published: [row], dismissed: [] });
  });
});

describe('reconcileNotifiedAfterApply', () => {
  it('keeps a failed dismissal so the next plan retries it', () => {
    const row = notifiedRow();
    const plan = { publish: [], dismiss: [notificationIdentifierForSession(row.sessionId)] };
    // The optimistic commit already removed the row.
    expect(
      reconcileNotifiedAfterApply([], {
        plan,
        dropped: [row],
        result: { published: [], dismissed: [] },
      })
    ).toEqual([row]);
  });

  it('drops a failed post so the next plan re-posts it', () => {
    const row = notifiedRow();
    const plan = { publish: [row], dismiss: [] };
    // The optimistic commit already added the row.
    expect(
      reconcileNotifiedAfterApply([row], {
        plan,
        dropped: [],
        result: { published: [], dismissed: [] },
      })
    ).toEqual([]);
  });

  it('keeps a successful post and a successful dismissal', () => {
    const posted = notifiedRow();
    const dismissed = notifiedRow({ sessionId: 'ses_old' });
    const plan = {
      publish: [posted],
      dismiss: [notificationIdentifierForSession(dismissed.sessionId)],
    };
    expect(
      reconcileNotifiedAfterApply([posted], {
        plan,
        dropped: [dismissed],
        result: {
          published: [posted],
          dismissed: [notificationIdentifierForSession(dismissed.sessionId)],
        },
      })
    ).toEqual([posted]);
  });

  it('restores the replaced row when its re-publish failed', () => {
    const previous = notifiedRow({ prUrl: null });
    const replacement = notifiedRow({ prUrl: 'https://github.com/org/repo/pull/7' });
    const plan = { publish: [replacement], dismiss: [] };
    // The optimistic commit replaced the old row with the new shape, which then
    // failed to post; the old notification still carries the session's
    // identifier, so the previous row must stay dismissible in the memory.
    expect(
      reconcileNotifiedAfterApply([replacement], {
        plan,
        dropped: [previous],
        result: { published: [], dismissed: [] },
      })
    ).toEqual([previous]);
  });

  it('does not restore a replaced row whose dismissal landed and post did not', () => {
    const previous = notifiedRow({ prUrl: null });
    const replacement = notifiedRow({ prUrl: 'https://github.com/org/repo/pull/7' });
    const identifier = notificationIdentifierForSession(previous.sessionId);
    const plan = { publish: [replacement], dismiss: [identifier] };
    // The dismissal removed the old notification; the failed replacement post
    // left nothing on screen, so nothing is remembered.
    expect(
      reconcileNotifiedAfterApply([replacement], {
        plan,
        dropped: [previous],
        result: { published: [], dismissed: [identifier] },
      })
    ).toEqual([]);
  });
});
