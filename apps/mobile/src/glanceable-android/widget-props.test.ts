import {
  buildHomeWidgetData,
  type HomeWidgetData,
  type HomeWidgetSessionRow,
} from '@kilocode/app-shared/home-widget';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetHomeWidgetDataForTests } from '@/lib/glanceable/home-widget-data';

import { setSurfaceExtras } from '@/lib/glanceable/surface-extras';

import {
  buildAndroidWidgetProps,
  buildCurrentWidgetProps,
  buildGenericWidgetProps,
} from './widget-props';

const NOW = 1_750_000_000_000;
const WAKE = new Date(NOW + 7_200_000).toISOString();
const COPY: Record<string, string> = {
  'glanceable.needsInput': 'Needs input',
  'common.working': 'Working',
  'common.scheduled': 'Scheduled',
  'common.idle': 'Idle',
  'glanceable.waiting': 'Waiting for agents',
  'glanceable.empty': 'No work in progress',
  'glanceable.stale': 'Updates delayed',
  'glanceable.expired': 'Status expired',
  'glanceable.signedOut': 'Sign in to see agents',
  'glanceable.privacy': 'Open Kilo to see agents',
  'glanceable.openAgents': 'Open agents',
  'glanceable.newAgent': 'New agent',
  'common.approve': 'Approve',
  'glanceable.checked': 'Checked',
  'glanceable.lastKnown': 'Last known',
  'glanceable.nextRun': 'Next run',
  'glanceable.awaitingUpdate': 'Awaiting update',
  'common.agent': 'Agent',
  'glanceable.approving': 'Approving…',
  'glanceable.couldNotApprove': 'Could not approve',
  'agentChat.permissionCard.title': 'Permission required',
  'glanceable.answerNeeded': 'Answer needed',
  'glanceable.waitingToRetry': 'Waiting to retry',
  'glanceable.scheduledWakes': 'wakes {{time}}',
};
const translate = (key: string) => COPY[key] ?? key;
const clock = (at: string) => `clock:${at}`;
function dataFor(sessions: HomeWidgetSessionRow[], status?: HomeWidgetData['snapshot']['status']) {
  return buildHomeWidgetData({
    sessions,
    userId: 'user-private-id',
    organizationId: 'org-private-id',
    now: NOW,
    ...(status ? { status } : {}),
  });
}
function propsFor(data: HomeWidgetData) {
  return buildAndroidWidgetProps(data.snapshot, {}, translate, String, String, clock, data);
}

beforeEach(() => {
  _resetHomeWidgetDataForTests();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  setSurfaceExtras({ newestSessionTitle: null, actionFeedback: null });
});

const MIXED = dataFor([
  { status: 'permission', title: 'Permission title', approvalKey: 'a'.repeat(64) },
  { status: 'question', title: 'Question title' },
  { status: 'busy', title: 'Running title' },
  { status: 'scheduled', title: 'Schedule title', scheduledAt: WAKE },
  { status: 'idle', title: 'Idle title' },
]);

describe('shared Home presentation localization', () => {
  it('shows the ranked primary and only nonzero supporting counts, with checkedAt', () => {
    const props = propsFor(MIXED);
    expect(props.home).toMatchObject({
      primaryKind: 'needsInput',
      primaryCount: 2,
      canCreate: true,
      canApprove: true,
    });
    expect(props.homeCopy).toMatchObject({
      primaryCount: '2',
      primaryLabel: 'Needs input',
      title: 'Permission title',
      footer: `Checked clock:${MIXED.snapshot.updatedAt}`,
    });
    expect(props.homeCopy?.secondaryCounts).toEqual([
      { kind: 'running', count: '1', label: 'Working' },
      { kind: 'scheduled', count: '1', label: 'Scheduled' },
      { kind: 'idle', count: '1', label: 'Idle' },
    ]);
    expect(propsFor(dataFor([{ status: 'busy' }])).homeCopy?.secondaryCounts).toEqual([]);
  });

  it('localizes numbers for the hero, supporting rows and accessibility together', () => {
    const props = buildAndroidWidgetProps(
      MIXED.snapshot,
      {},
      translate,
      value => `digit:${value}`,
      String,
      clock,
      MIXED
    );
    expect(props.homeCopy?.primaryCount).toBe('digit:2');
    expect(props.homeCopy?.secondaryCounts.every(line => line.count === 'digit:1')).toBe(true);
    expect(props.homeCopy?.accessibilityLabel).toContain('digit:2 Needs input');
    expect(props.homeCopy?.accessibilityLabel).toContain('Checked');
  });

  it('retains counts, action visibility and the confirmed timestamp beyond activity expiry', () => {
    vi.setSystemTime(Date.parse(MIXED.snapshot.expiresAt) + 1);
    const props = buildCurrentWidgetProps(MIXED.snapshot, translate, String, String, clock, MIXED);
    expect(props.home).toMatchObject({
      primaryCount: 2,
      stale: true,
      checkedAt: MIXED.snapshot.updatedAt,
      canCreate: true,
      canApprove: true,
    });
    expect(props.homeCopy?.footer).toBe(`Last known · clock:${MIXED.snapshot.updatedAt}`);
    expect(props.homeCopy?.accessibilityLabel).toContain('Last known');
    // Activity expiry still wins for the counts-only props used by notification lifetime.
    expect(props.statusLine).toBe('Status expired');
    expect(props.countLines).toEqual([]);
  });

  it('reads scoped retained Home data rather than the zero-count expired activity snapshot', () => {
    const expired = {
      ...MIXED.snapshot,
      status: 'expired' as const,
      running: 0,
      needsInput: 0,
      scheduled: 0,
      idle: 0,
    };
    const props = buildCurrentWidgetProps(expired, translate, String, String, clock, MIXED);
    expect(props.home?.primaryCount).toBe(2);
    const noRetained = buildCurrentWidgetProps(expired, translate, String, String, clock);
    expect(noRetained.home?.primaryCount).toBe(0);
    expect(noRetained.home?.status).toBe('unavailable');
  });

  it.each(['signed_out', 'privacy'] as const)(
    'never allows retained titles/counts to override %s',
    status => {
      const props = buildAndroidWidgetProps(
        { ...MIXED.snapshot, status },
        {},
        translate,
        String,
        String,
        clock,
        MIXED
      );
      expect(props.home).toMatchObject({
        status,
        primaryCount: 0,
        primaryTitle: null,
        waitingAgents: [],
        scheduledAgents: [],
        canCreate: false,
        canApprove: false,
      });
      expect(props.homeCopy?.secondaryCounts).toEqual([]);
      expect(props.homeCopy?.footer).toBeNull();
      expect(props.homeCopy?.title).toBeNull();
      expect(JSON.stringify(props)).not.toContain('Permission title');
    }
  );

  it.each([{ signedOut: true }, { orgInvalid: true }])(
    'honors a direct auth/scope blank flag %j',
    flags => {
      const props = buildAndroidWidgetProps(
        MIXED.snapshot,
        flags,
        translate,
        String,
        String,
        clock,
        MIXED
      );
      expect(props.home?.primaryCount).toBe(0);
      expect(props.home?.primaryTitle).toBeNull();
    }
  );

  it('carries authorized bounded Home titles but no account/session scope identifiers', () => {
    const serialized = JSON.stringify(propsFor(MIXED));
    expect(serialized).toContain('Permission title');
    expect(serialized).not.toContain('user-private-id');
    expect(serialized).not.toContain('org-private-id');
    expect(serialized).not.toContain(MIXED.snapshot.scopeKey);
  });

  it('uses the earliest scheduled wake ahead of idle details and does not invent overdue running', () => {
    const data = dataFor([
      { status: 'scheduled', title: 'Wake', scheduledAt: WAKE },
      { status: 'idle' },
    ]);
    expect(propsFor(data).homeCopy).toMatchObject({
      wake: `Next run clock:${WAKE}`,
      title: 'Wake',
    });
    vi.setSystemTime(Date.parse(WAKE));
    const props = propsFor(data);
    expect(props.homeCopy).toMatchObject({ wake: 'Awaiting update', wakeOverdue: true });
    expect(props.home?.primaryKind).toBe('scheduled');
    expect(props.home?.primaryCount).toBe(1);
  });

  it('keeps unknown wake times absent while retaining the scheduled count', () => {
    const props = propsFor(dataFor([{ status: 'scheduled' }]));
    expect(props.home?.primaryKind).toBe('scheduled');
    expect(props.homeCopy).toMatchObject({ wake: null, title: 'Agent' });
    expect(props.home?.scheduledAt).toBeNull();
    expect(props.home?.awaitingUpdate).toBe(false);
  });

  it('localizes missing titles generically and carries each waiting reason', () => {
    const data = dataFor([{ status: 'permission' }, { status: 'question' }, { status: 'retry' }]);
    expect(propsFor(data).homeCopy?.waitingAgents).toEqual([
      { title: 'Agent', reason: 'Permission required' },
      { title: 'Agent', reason: 'Answer needed' },
      { title: 'Agent', reason: 'Waiting to retry' },
    ]);
  });

  it('carries approve feedback beside the title without claiming that title was approved', () => {
    setSurfaceExtras({ newestSessionTitle: 'not Home data', actionFeedback: 'approving' });
    expect(propsFor(MIXED).homeCopy).toMatchObject({
      actionLine: 'Approving…',
      title: 'Permission title',
    });
    setSurfaceExtras({ newestSessionTitle: 'not Home data', actionFeedback: 'couldNotApprove' });
    expect(propsFor(MIXED).homeCopy?.accessibilityLabel).toContain('Could not approve');
    expect(propsFor(dataFor([], 'privacy')).homeCopy?.actionLine).toBeNull();
  });

  it('does not attach private titles to the generic no-account fallback', () => {
    const props = buildGenericWidgetProps(translate);
    expect(props.statusLine).toBe('Sign in to see agents');
    expect(props.countLines).toEqual([]);
    expect(props.actions.approve).toBe(false);
    expect(props.actions.newAgent).toBe(false);
  });
});
