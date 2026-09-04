import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  'glanceable.running': 'Working',
  'glanceable.waiting': 'Waiting for agents',
  'glanceable.empty': 'No work in progress',
  'glanceable.stale': 'Updates delayed',
  'glanceable.expired': 'Status expired',
  'glanceable.signedOut': 'Sign in to see agents',
  'glanceable.privacy': 'Open Kilo to see agents',
  'glanceable.openAgents': 'Open agents',
};
const translate = (key: string): string => COPY[key] ?? key;

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
      ['empty', [], 'No work in progress', 0, false],
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
      'countLines',
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
    ['empty', 'No work in progress'],
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
    ['waiting', 'Waiting for agents'],
    ['empty', 'No work in progress'],
    ['expired', 'Status expired'],
    ['signed_out', 'Sign in to see agents'],
    ['privacy', 'Open Kilo to see agents'],
  ] as const)('hides counts on every Android surface for %s', (status, expected) => {
    const snapshot = { ...MIXED, status };
    const props = buildAndroidWidgetProps(snapshot, {}, translate);
    expect(props.statusLine).toBe(expected);
    expect(props.countLines).toEqual([]);
    expect(props.primaryLabel).toBeNull();
    expect(buildOngoingNotificationText(snapshot, {}, translate)).toBe(expected);
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
