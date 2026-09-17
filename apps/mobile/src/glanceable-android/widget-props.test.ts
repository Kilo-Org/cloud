/* eslint-disable max-lines -- one cohesive props-builder suite sharing the copy-map translator */
import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setSurfaceExtras } from '@/lib/glanceable/surface-extras';

import {
  buildAndroidWidgetProps,
  buildCompactNotificationText,
  buildCurrentWidgetProps,
  buildOngoingNotificationText,
} from './widget-props';

const NOW = 1_750_000_000_000;

const COPY: Record<string, string> = {
  'glanceable.needsInput': 'Needs input',
  'common.idle': 'Idle',
  'common.working': 'Working',
  'glanceable.waiting': 'Waiting for agents',
  'glanceable.empty': 'No work in progress',
  'glanceable.stale': 'Updates delayed',
  'glanceable.expired': 'Status expired',
  'glanceable.signedOut': 'Sign in to see agents',
  'glanceable.privacy': 'Open Kilo to see agents',
  'glanceable.openAgents': 'Open agents',
  'glanceable.noneWaiting': 'No agents waiting',
  'glanceable.newAgent': 'New agent',
  'glanceable.approving': 'Approving…',
  'common.starting': 'Starting…',
  'glanceable.couldNotApprove': 'Could not approve',
  'glanceable.couldNotStart': 'Could not start',
  'glanceable.newestSession': 'Newest: {{title}}',
  'common.approve': 'Approve',
};
const translate = (key: string): string => COPY[key] ?? key;

// The extras are module state shared by the publisher and every surface; a
// case that sets them resets them here so it cannot colour the next one.
afterEach(() => {
  setSurfaceExtras({ newestSessionTitle: null, actionFeedback: null });
});

function snapshotFor(
  sessions: { status: string }[],
  revision = 0,
  status?: GlanceableAgentsSnapshot['status']
): GlanceableAgentsSnapshot {
  return buildGlanceableSnapshot({
    sessions,
    userId: 'u1',
    organizationId: null,
    now: NOW,
    previousRevision: revision,
    ...(status === undefined ? {} : { status }),
  });
}

// A snapshot from an older producer: it carries the counts but omits
// `needsApproval`, which is what the Approve gate reads. Action cases that need
// an approvable tray add the field explicitly.
const MIXED = {
  ...snapshotFor([], 0, 'happy'),
  needsInput: 2,
  idle: 3,
  running: 4,
};

describe('buildAndroidWidgetProps', () => {
  it('ranks the compact primary count and keeps all expanded numeric counts', () => {
    const props = buildAndroidWidgetProps(MIXED, {}, translate);
    expect(props.primaryLabel).toBe('Needs input');
    expect(props.countLines).toEqual([
      { label: 'Needs input', kind: 'needsInput', count: '2' },
      { label: 'Working', kind: 'running', count: '4' },
      { label: 'Idle', kind: 'idle', count: '3' },
    ]);
  });

  it.each([
    ['happy', '2 Needs input, 4 Working, 3 Idle, Open agents'],
    ['stale', 'Updates delayed, 2 Needs input, 4 Working, 3 Idle, Open agents'],
  ] as const)(
    'includes numeric counts and the action in the %s spoken label',
    (status, expected) => {
      const props = buildAndroidWidgetProps({ ...MIXED, status }, {}, translate);
      expect(props.accessibilityLabel).toBe(expected);
    }
  );

  it('applies the locked copy matrix per status', () => {
    const cases: [
      GlanceableAgentsSnapshot['status'],
      { status: string }[],
      string,
      number,
      boolean,
    ][] = [
      ['waiting', [], 'Waiting for agents', 0, false],
      // Android's empty state is the one that offers New agent, so it says
      // what that action is about instead of the generic no-work copy.
      ['empty', [], 'No agents waiting', 0, false],
      // Counts show for stale, and all three rows draw whenever they show, so
      // the widget's rows never reflow as work moves between states.
      ['stale', [{ status: 'busy' }], 'Updates delayed', 3, true],
      ['expired', [], 'Status expired', 0, false],
      ['signed_out', [], 'Sign in to see agents', 0, false],
      ['privacy', [], 'Open Kilo to see agents', 0, false],
    ];
    for (const [status, sessions, statusLine, counts] of cases) {
      const props = buildAndroidWidgetProps(snapshotFor(sessions, 0, status), {}, translate);
      expect(props.statusLine).toBe(statusLine);
      expect(props.countLines).toHaveLength(counts);
    }
  });

  it('carries no title, organization name, or raw id into the widget payload', () => {
    const snapshot = buildGlanceableSnapshot({
      sessions: [{ status: 'question', statusUpdatedAt: new Date(NOW - 60_000).toISOString() }],
      userId: 'user-9f3a-leak',
      organizationId: 'org-acme-7-leak',
      now: NOW,
    });

    const props = buildAndroidWidgetProps(snapshot, {}, translate);
    const json = JSON.stringify(props);

    expect(Object.keys(props).toSorted()).toEqual([
      'accessibilityLabel',
      'actions',
      'countLines',
      'newestLine',
      'primaryLabel',
      'statusLine',
    ]);
    expect(json).not.toContain('user-9f3a-leak');
    expect(json).not.toContain('org-acme-7-leak');
    expect(json).not.toContain(snapshot.scopeKey);
    expect(json).not.toContain(snapshot.updatedAt);
    expect(json).not.toContain('revision');
    expect(json).not.toContain('title');
  });
});

describe('current widget deadline rendering', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['happy', 'stale'] as const)('hides expired %s counts', status => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 28_800_000);
    const props = buildCurrentWidgetProps({ ...MIXED, status }, translate);
    expect(props.statusLine).toBe('Status expired');
    expect(props.countLines).toEqual([]);
    expect(props.accessibilityLabel).toBe('Status expired, Open agents');
  });

  it.each([
    ['privacy', 'Open Kilo to see agents'],
    ['signed_out', 'Sign in to see agents'],
    ['empty', 'No agents waiting'],
    ['waiting', 'Waiting for agents'],
  ] as const)('preserves %s copy beyond an old deadline', (status, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 28_800_001);
    const props = buildCurrentWidgetProps({ ...MIXED, status }, translate);
    expect(props.statusLine).toBe(expected);
    expect(props.accessibilityLabel).toBe(`${expected}, Open agents`);
    expect(props.countLines).toEqual([]);
  });

  it('hides counts when the stored expiry is not a valid date', () => {
    const props = buildCurrentWidgetProps({ ...MIXED, expiresAt: 'invalid' }, translate);
    expect(props.statusLine).toBe('Status expired');
    expect(props.countLines).toEqual([]);
  });
});

describe('buildOngoingNotificationText', () => {
  it('lists every ranked numeric count for happy work', () => {
    expect(buildOngoingNotificationText(MIXED, {}, translate)).toBe(
      '2 Needs input, 4 Working, 3 Idle'
    );
  });

  it('adds the translated stale warning without losing eligible counts', () => {
    expect(buildOngoingNotificationText({ ...MIXED, status: 'stale' }, {}, translate)).toBe(
      'Updates delayed, 2 Needs input, 4 Working, 3 Idle'
    );
  });

  it('keeps stale copy when there are no retained counts', () => {
    expect(buildOngoingNotificationText(snapshotFor([], 0, 'stale'), {}, translate)).toBe(
      'Updates delayed'
    );
  });

  it('uses empty copy when there is no eligible work', () => {
    expect(buildOngoingNotificationText(snapshotFor([]), {}, translate)).toBe(
      'No work in progress'
    );
  });

  it('prefixes a pending action notice to the counts', () => {
    expect(buildOngoingNotificationText(MIXED, {}, translate, String, 'Approval failed')).toBe(
      'Approval failed 2 Needs input, 4 Working, 3 Idle'
    );
  });

  it('prefixes the notice to the stale warning and to the locked copy', () => {
    expect(
      buildOngoingNotificationText(
        { ...MIXED, status: 'stale' },
        {},
        translate,
        String,
        'Approval failed'
      )
    ).toBe('Approval failed Updates delayed, 2 Needs input, 4 Working, 3 Idle');
    expect(
      buildOngoingNotificationText(snapshotFor([]), {}, translate, String, 'Approval failed')
    ).toBe('Approval failed No work in progress');
  });
});

describe('buildCompactNotificationText', () => {
  it.each([
    { needsInput: 2, idle: 3, running: 4, expected: '2' },
    { needsInput: 0, idle: 3, running: 4, expected: '4' },
    { needsInput: 0, idle: 3, running: 0, expected: '3' },
    { needsInput: 0, idle: 0, running: 0, expected: null },
  ])('uses the ranked primary number $expected, not the total or full summary', counts => {
    const snapshot = { ...MIXED, ...counts };
    expect(buildCompactNotificationText(snapshot, {})).toBe(counts.expected);
    expect(buildCompactNotificationText({ ...snapshot, status: 'stale' }, {})).toBe(
      counts.expected
    );
  });
});

describe('status precedence and count hiding', () => {
  it.each([
    ['waiting', 'Waiting for agents', 'Waiting for agents'],
    // The widget and the ongoing notification read the same status line;
    // `buildOngoingNotificationText`'s own empty fallback only ever renders
    // for eligible work, so it keeps the shared no-work copy.
    ['empty', 'No agents waiting', 'No work in progress'],
    ['expired', 'Status expired', 'Status expired'],
    ['signed_out', 'Sign in to see agents', 'Sign in to see agents'],
    ['privacy', 'Open Kilo to see agents', 'Open Kilo to see agents'],
  ] as const)('hides counts on every Android surface for %s', (status, expected, notification) => {
    const snapshot = { ...MIXED, status };
    const props = buildAndroidWidgetProps(snapshot, {}, translate);
    expect(props.statusLine).toBe(expected);
    expect(props.countLines).toEqual([]);
    expect(props.primaryLabel).toBeNull();
    expect(buildOngoingNotificationText(snapshot, {}, translate)).toBe(notification);
    expect(buildCompactNotificationText(snapshot, {})).toBeNull();
  });

  it.each([
    [{ signedOut: true, orgInvalid: true }, 'Sign in to see agents'],
    [{ orgInvalid: true }, 'Open Kilo to see agents'],
  ] as const)('honors auth overrides before stale counts: %j', (flags, expected) => {
    const snapshot = { ...MIXED, status: 'stale' as const };
    const props = buildAndroidWidgetProps(snapshot, flags, translate);
    expect(props.statusLine).toBe(expected);
    expect(props.countLines).toEqual([]);
    expect(props.primaryLabel).toBeNull();
    expect(buildOngoingNotificationText(snapshot, flags, translate)).toBe(expected);
    expect(buildCompactNotificationText(snapshot, flags)).toBeNull();
  });
});

describe('widget actions and the newest line', () => {
  it('offers Approve while a permission waits, and New agent only then', () => {
    const props = buildAndroidWidgetProps({ ...MIXED, needsApproval: 2 }, {}, translate);
    expect(props.actions).toEqual({
      approve: true,
      newAgent: false,
      approveLabel: 'Approve',
      newAgentLabel: 'New agent',
    });
  });

  it.each(['question', 'retry'])(
    'offers no Approve for a %s wait the action cannot answer',
    status => {
      // `needsInput` folds in questions and retries: a question needs an answer
      // and a retry needs the provider back, so neither may draw a button whose
      // press only finds nothing to approve and opens the app instead.
      const props = buildAndroidWidgetProps(snapshotFor([{ status }]), {}, translate);
      expect(props.actions.approve).toBe(false);
      expect(props.actions.newAgent).toBe(false);
    }
  );

  it('offers Approve for a permission wait even beside a question', () => {
    const props = buildAndroidWidgetProps(
      snapshotFor([{ status: 'question' }, { status: 'permission' }]),
      {},
      translate
    );
    expect(props.actions.approve).toBe(true);
  });

  it('offers New agent when every connected agent is idle and nothing waits', () => {
    // The idle-only tray has status happy: it keeps a card alive, and nothing
    // waiting means the only action the surface can offer is a new agent. The
    // counts stay, so the rows do not reflow as work moves between states.
    const props = buildAndroidWidgetProps(snapshotFor([{ status: 'idle' }]), {}, translate);
    expect(props.actions).toEqual({
      approve: false,
      newAgent: true,
      approveLabel: 'Approve',
      newAgentLabel: 'New agent',
    });
    expect(props.statusLine).toBeNull();
    expect(props.countLines).toHaveLength(3);
  });

  it('offers New agent when nothing is eligible, instead of Approve', () => {
    const props = buildAndroidWidgetProps(snapshotFor([], 0, 'empty'), {}, translate);
    expect(props.actions).toEqual({
      approve: false,
      newAgent: true,
      approveLabel: 'Approve',
      newAgentLabel: 'New agent',
    });
    expect(props.statusLine).toBe('No agents waiting');
  });

  it('offers neither action while the first fetch is still in flight', () => {
    const props = buildAndroidWidgetProps(snapshotFor([], 0, 'waiting'), {}, translate);
    expect(props.actions.approve).toBe(false);
    expect(props.actions.newAgent).toBe(false);
  });

  it.each(['expired', 'signed_out', 'privacy'] as const)(
    'offers no action for %s, where there is nothing to trust yet',
    status => {
      const props = buildAndroidWidgetProps({ ...MIXED, status }, {}, translate);
      expect(props.actions.approve).toBe(false);
      expect(props.actions.newAgent).toBe(false);
    }
  );

  it('offers no action to a signed-out widget even with retained counts', () => {
    const props = buildAndroidWidgetProps(
      { ...MIXED, status: 'stale' },
      { signedOut: true },
      translate
    );
    expect(props.actions.approve).toBe(false);
    expect(props.actions.newAgent).toBe(false);
    expect(props.statusLine).toBe('Sign in to see agents');
  });

  it('draws the newest session line from the surface extras', () => {
    setSurfaceExtras({ newestSessionTitle: 'Fix the flaky test', actionFeedback: null });
    expect(buildAndroidWidgetProps(MIXED, {}, translate).newestLine).toBe(
      'Newest: Fix the flaky test'
    );
  });

  it('inserts a title containing a replacement pattern literally', () => {
    setSurfaceExtras({ newestSessionTitle: 'Fix $& the build', actionFeedback: null });
    expect(buildAndroidWidgetProps(MIXED, {}, translate).newestLine).toBe(
      'Newest: Fix $& the build'
    );
  });

  it('keeps the reserved line empty when nothing is stored', () => {
    expect(buildAndroidWidgetProps(MIXED, {}, translate).newestLine).toBeNull();
  });

  it('shows the action state ahead of the newest session', () => {
    setSurfaceExtras({ newestSessionTitle: 'Fix the flaky test', actionFeedback: 'approving' });
    expect(buildAndroidWidgetProps(MIXED, {}, translate).newestLine).toBe('Approving…');

    setSurfaceExtras({
      newestSessionTitle: 'Fix the flaky test',
      actionFeedback: 'couldNotApprove',
    });
    expect(buildAndroidWidgetProps(MIXED, {}, translate).newestLine).toBe('Could not approve');

    // The create's own progress and failure lines, on a surface that shows the
    // newest session too: the action owns the slot while it runs or failed.
    setSurfaceExtras({ newestSessionTitle: 'Fix the flaky test', actionFeedback: 'starting' });
    expect(buildAndroidWidgetProps(MIXED, {}, translate).newestLine).toBe('Starting…');

    setSurfaceExtras({ newestSessionTitle: 'Fix the flaky test', actionFeedback: 'couldNotStart' });
    expect(buildAndroidWidgetProps(MIXED, {}, translate).newestLine).toBe('Could not start');
  });

  it('draws a create’s progress and failure in the empty surface’s reserved line', () => {
    const empty = snapshotFor([], 0, 'empty');

    setSurfaceExtras({ newestSessionTitle: 'Fix the flaky test', actionFeedback: 'starting' });
    const running = buildAndroidWidgetProps(empty, {}, translate);
    expect(running.newestLine).toBe('Starting…');
    // The empty surface is the one that offers New agent, so it keeps that row
    // as the retry while no counts draw.
    expect(running.actions).toEqual({
      approve: false,
      newAgent: true,
      approveLabel: 'Approve',
      newAgentLabel: 'New agent',
    });

    setSurfaceExtras({ newestSessionTitle: 'Fix the flaky test', actionFeedback: 'couldNotStart' });
    const failed = buildAndroidWidgetProps(empty, {}, translate);
    expect(failed.newestLine).toBe('Could not start');
    expect(failed.countLines).toEqual([]);
    expect(failed.actions.newAgent).toBe(true);
  });

  it('never shows the newest-session title on the empty surface', () => {
    // Empty offers the create, so the slot carries the create's feedback; with
    // none in flight the slot is blank rather than a stale title.
    setSurfaceExtras({ newestSessionTitle: 'Fix the flaky test', actionFeedback: null });
    expect(
      buildAndroidWidgetProps(snapshotFor([], 0, 'empty'), {}, translate).newestLine
    ).toBeNull();
  });

  it('keeps the failure line and the offered action on a retryable surface', () => {
    setSurfaceExtras({ newestSessionTitle: null, actionFeedback: 'couldNotApprove' });
    const props = buildAndroidWidgetProps(
      { ...MIXED, needsApproval: 1, status: 'stale' },
      {},
      translate
    );
    expect(props.newestLine).toBe('Could not approve');
    expect(props.actions.approve).toBe(true);
    expect(props.countLines).toHaveLength(3);
  });

  it('draws the reserved line only where an action is offered', () => {
    setSurfaceExtras({ newestSessionTitle: 'Fix the flaky test', actionFeedback: 'couldNotStart' });
    expect(
      buildAndroidWidgetProps(snapshotFor([], 0, 'signed_out'), {}, translate).newestLine
    ).toBeNull();
    expect(
      buildAndroidWidgetProps(snapshotFor([], 0, 'expired'), {}, translate).newestLine
    ).toBeNull();
    expect(
      buildAndroidWidgetProps(snapshotFor([], 0, 'waiting'), {}, translate).newestLine
    ).toBeNull();
    // The empty surface is the one that offers New agent, so its reserved slot
    // carries that action's feedback even though no counts draw.
    expect(buildAndroidWidgetProps(snapshotFor([], 0, 'empty'), {}, translate).newestLine).toBe(
      'Could not start'
    );
  });
});
