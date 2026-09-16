/* eslint-disable max-lines -- one suite covering every builder and the locked-copy matrix */
import {
  buildGlanceableSnapshot,
  GLANCEABLE_STALE_MS,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildAndroidWidgetProps,
  buildCompactNotificationText,
  buildCurrentWidgetProps,
  buildOngoingNotificationText,
} from './widget-props';
import widgetConfig from './widget-config.json';

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
  'glanceable.newestResult': 'Newest result',
};
const translate = (key: string): string => COPY[key] ?? key;

/**
 * The two formatters the app injects. The builder stays free of i18n and of
 * `Intl`, so the suite hands it the same shapes `count-format.ts` supplies.
 */
const AGO = '3 min ago';
const formatAgo = (): string => AGO;

function snapshotFor(
  sessions: { status: string; statusUpdatedAt?: string }[],
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

const NEWEST_AT = new Date(NOW - 180_000).toISOString();

describe('buildAndroidWidgetProps', () => {
  it('ranks the compact primary count and keeps all expanded numeric counts', () => {
    const props = buildAndroidWidgetProps(MIXED, {}, translate, String, formatAgo);
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
      const props = buildAndroidWidgetProps({ ...MIXED, status }, {}, translate, String, formatAgo);
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
      const props = buildAndroidWidgetProps(
        snapshotFor(sessions, 0, status),
        {},
        translate,
        String,
        formatAgo
      );
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

    const props = buildAndroidWidgetProps(snapshot, {}, translate, String, formatAgo);
    const json = JSON.stringify(props);

    expect(Object.keys(props).toSorted()).toEqual([
      'accessibilityLabel',
      'countLines',
      'newestResultAgo',
      'newestResultKind',
      'newestResultLabel',
      'newestResultTitle',
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

describe('newest-result props', () => {
  it('carries the ranked kind, the matching row label, and the injected age', () => {
    const props = buildAndroidWidgetProps(
      snapshotFor([{ status: 'busy', statusUpdatedAt: NEWEST_AT }], 0),
      {},
      translate,
      String,
      formatAgo
    );

    expect(props.newestResultKind).toBe('running');
    expect(props.newestResultTitle).toBe('Newest result');
    expect(props.newestResultLabel).toBe('Working');
    expect(props.newestResultAgo).toBe(AGO);
  });

  it('reads the label from the same count line the rows draw', () => {
    const props = buildAndroidWidgetProps(
      { ...MIXED, newestResultKind: 'idle', newestResultAt: NEWEST_AT },
      {},
      translate,
      String,
      formatAgo
    );

    const idle = props.countLines.find(line => line.kind === 'idle');
    expect(props.newestResultLabel).toBe(idle?.label);
    expect(props.newestResultLabel).toBe('Idle');
  });

  // A locked frame carries one fact: no counts, so no third fact either.
  it.each(['waiting', 'empty', 'expired', 'signed_out', 'privacy'] as const)(
    'blanks the caption and the newest-result fields on %s',
    status => {
      const props = buildAndroidWidgetProps(
        { ...MIXED, status, newestResultKind: 'running', newestResultAt: NEWEST_AT },
        {},
        translate,
        String,
        formatAgo
      );

      expect(props.newestResultKind).toBeNull();
      expect(props.newestResultTitle).toBeNull();
      expect(props.newestResultLabel).toBeNull();
      expect(props.newestResultAgo).toBeNull();
    }
  );

  // Stale keeps its counts, so the third fact stays in the payload; the large
  // cell is what swaps the footer for the warning.
  it('keeps the newest result beside the stale timestamp', () => {
    const props = buildAndroidWidgetProps(
      { ...MIXED, status: 'stale', newestResultKind: 'needsInput', newestResultAt: NEWEST_AT },
      {},
      translate,
      String,
      formatAgo
    );

    expect(props.statusLine).toBe('Updates delayed');
    expect(props.countLines).toHaveLength(3);
    expect(props.newestResultTitle).toBe('Newest result');
    expect(props.newestResultLabel).toBe('Needs input');
    expect(props.newestResultAgo).toBe(AGO);
  });

  it('carries no newest result when no row had a status timestamp', () => {
    const props = buildAndroidWidgetProps(MIXED, {}, translate, String, formatAgo);

    // The caption belongs to the footer, not to the result: it is there
    // whenever the rows are, and the cell has nothing to put under it.
    expect(props.newestResultTitle).toBe('Newest result');
    expect(props.newestResultKind).toBeNull();
    expect(props.newestResultLabel).toBeNull();
    expect(props.newestResultAgo).toBeNull();
  });
});

describe('current widget deadline rendering', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['happy', 'stale'] as const)('hides expired %s counts', status => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 28_800_000);
    const props = buildCurrentWidgetProps({ ...MIXED, status }, translate, String, formatAgo);
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
    const props = buildCurrentWidgetProps({ ...MIXED, status }, translate, String, formatAgo);
    expect(props.statusLine).toBe(expected);
    expect(props.accessibilityLabel).toBe(`${expected}, Open agents`);
    expect(props.countLines).toEqual([]);
  });

  it('hides counts when the stored expiry is not a valid date', () => {
    const props = buildCurrentWidgetProps(
      { ...MIXED, expiresAt: 'invalid' },
      translate,
      String,
      formatAgo
    );
    expect(props.statusLine).toBe('Status expired');
    expect(props.countLines).toEqual([]);
  });

  it('drops the newest result with the counts at the deadline', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 28_800_000);
    const props = buildCurrentWidgetProps(
      { ...MIXED, newestResultKind: 'running', newestResultAt: NEWEST_AT },
      translate,
      String,
      formatAgo
    );
    expect(props.newestResultTitle).toBeNull();
    expect(props.newestResultLabel).toBeNull();
    expect(props.newestResultAgo).toBeNull();
    expect(props.countLines).toEqual([]);
  });
});

describe('current widget lapsed frame', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // The Android twin of the iOS stale timeline frame: a redraw a whole stale
  // window after the snapshot was taken stops asserting the counts are current.
  it.each([
    ['exactly at the window', GLANCEABLE_STALE_MS],
    ['past the window', 31 * 60_000],
  ])('swaps the age for the delayed copy %s', (_label, elapsed) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW + elapsed);
    const props = buildCurrentWidgetProps(
      { ...MIXED, newestResultKind: 'running', newestResultAt: NEWEST_AT },
      translate,
      String,
      formatAgo
    );

    expect(props.statusLine).toBe('Updates delayed');
    // The counts stay: they are still the last thing the device knew, and the
    // expiry frame is not yet due at 31 minutes.
    expect(props.countLines).toEqual([
      { label: 'Needs input', kind: 'needsInput', count: '2' },
      { label: 'Working', kind: 'running', count: '4' },
      { label: 'Idle', kind: 'idle', count: '3' },
    ]);
    expect(props.primaryLabel).toBe('Needs input');
    expect(props.newestResultTitle).toBe('Newest result');
  });

  it('keeps the happy frame inside the stale window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 29 * 60_000);
    const props = buildCurrentWidgetProps(
      { ...MIXED, newestResultKind: 'running', newestResultAt: NEWEST_AT },
      translate,
      String,
      formatAgo
    );

    expect(props.statusLine).toBeNull();
    expect(props.newestResultAgo).toBe(AGO);
    expect(props.countLines).toHaveLength(3);
  });

  // The deadline keeps its precedence: a lapsed snapshot past `expiresAt` still
  // draws the expired frame, never the delayed one behind it.
  it('prefers the expired frame past the data deadline', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 28_800_000);
    const props = buildCurrentWidgetProps(
      { ...MIXED, newestResultKind: 'running', newestResultAt: NEWEST_AT },
      translate,
      String,
      formatAgo
    );

    expect(props.statusLine).toBe('Status expired');
    expect(props.countLines).toEqual([]);
    expect(props.newestResultTitle).toBeNull();
  });

  // A locked frame asserts nothing that can lapse, so the lapsed branch skips it.
  it.each(['waiting', 'empty', 'signed_out', 'privacy'] as const)(
    'leaves %s copy alone past the stale window',
    status => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW + 31 * 60_000);
      const props = buildCurrentWidgetProps({ ...MIXED, status }, translate, String, formatAgo);
      expect(props.statusLine).not.toBe('Updates delayed');
      expect(props.countLines).toEqual([]);
    }
  );
});

describe('widget config', () => {
  /**
   * The age and the delayed frame are time facts: a surface that redraws only
   * when an update is delivered keeps asserting both forever. The platform's
   * own periodic redraw is what recomputes them, so the declared period must
   * not be longer than the stale window it exists to catch. 30 minutes is
   * Android's floor and exactly `GLANCEABLE_STALE_MS`.
   */
  it('declares a periodic redraw no longer than the stale window', () => {
    const widget = widgetConfig.widgets.find(entry => entry.name === 'ActiveAgentsWidget');

    expect(widget?.updatePeriodMillis).toBeGreaterThanOrEqual(GLANCEABLE_STALE_MS);
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
    const props = buildAndroidWidgetProps(snapshot, {}, translate, String, formatAgo);
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
    const props = buildAndroidWidgetProps(snapshot, flags, translate, String, formatAgo);
    expect(props.statusLine).toBe(expected);
    expect(props.countLines).toEqual([]);
    expect(props.primaryLabel).toBeNull();
    expect(buildOngoingNotificationText(snapshot, flags, translate)).toBe(expected);
    expect(buildCompactNotificationText(snapshot, flags)).toBeNull();
  });
});
