/* eslint-disable max-lines -- the two builders share one snapshot/extra matrix */
import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { afterEach, describe, expect, it } from 'vitest';

import { buildAndroidWidgetProps } from '@/glanceable-android/widget-props';
import { buildGlanceableViewProps } from '@/glanceable-ios/view-props';

import { type GlanceableActionFeedback, setSurfaceExtras } from './surface-extras';

/**
 * The request builds the widget actions on iOS and on Android with each
 * platform's own mechanism (App Intents on iOS, a headless task on Android),
 * so the two props builders must agree on everything the user sees: the status
 * line, the counts, the reserved newest/feedback line, which action is
 * offered, and the spoken label. This pins that parity from one input matrix,
 * so a change to either builder that forks the *visible* behaviour — as opposed
 * to the drawing mechanism — fails here instead of on a device.
 *
 * The builders differ where the platform's surface does: iOS carries a numeric
 * count and a compact primary for the Lock Screen accessory families, Android
 * carries a formatted string. The comparison below normalizes those and ignores
 * the mechanism-only fields.
 */

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

afterEach(() => {
  setSurfaceExtras({ newestSessionTitle: null, actionFeedback: null });
});

function snapshotFor(
  sessions: { status: string }[],
  status?: GlanceableAgentsSnapshot['status']
): GlanceableAgentsSnapshot {
  return buildGlanceableSnapshot({
    sessions,
    userId: 'u1',
    organizationId: null,
    now: NOW,
    previousRevision: 0,
    ...(status === undefined ? {} : { status }),
  });
}

/** The state the user sees, as both builders describe it. */
function visible(snapshot: GlanceableAgentsSnapshot) {
  const ios = buildGlanceableViewProps(snapshot, {}, translate);
  const android = buildAndroidWidgetProps(snapshot, {}, translate);
  return {
    statusLine: [ios.statusLine, android.statusLine],
    countLines: [
      ios.countLines.map(line => ({ ...line, count: String(line.count) })),
      android.countLines,
    ],
    primaryLabel: [ios.primaryLabel, android.primaryLabel],
    newestLine: [ios.newestTitle, android.newestLine],
    actions: [
      { approve: ios.actions.approve, newAgent: ios.actions.newAgent },
      { approve: android.actions.approve, newAgent: android.actions.newAgent },
    ],
    spoken: [ios.accessibilityLabel, android.accessibilityLabel],
  };
}

describe('iOS and Android widget props parity', () => {
  const MATRIX: [string, GlanceableAgentsSnapshot][] = [
    [
      'happy with counts',
      snapshotFor([{ status: 'busy' }, { status: 'permission' }, { status: 'idle' }]),
    ],
    ['idle-only', snapshotFor([{ status: 'idle' }])],
    ['empty', snapshotFor([], 'empty')],
    ['waiting', snapshotFor([], 'waiting')],
    ['stale', snapshotFor([{ status: 'busy' }], 'stale')],
    ['expired', snapshotFor([], 'expired')],
    ['signed out', snapshotFor([], 'signed_out')],
    ['privacy', snapshotFor([], 'privacy')],
  ];

  it.each(MATRIX)('draws the same status, counts, and actions for %s', (_label, snapshot) => {
    const seen = visible(snapshot);
    expect(seen.statusLine[1]).toBe(seen.statusLine[0]);
    expect(seen.countLines[1]).toEqual(seen.countLines[0]);
    expect(seen.actions[1]).toEqual(seen.actions[0]);
    expect(seen.spoken[1]).toBe(seen.spoken[0]);
  });

  it.each(MATRIX)('shows the same compact primary count for %s', (_label, snapshot) => {
    const seen = visible(snapshot);
    expect(seen.primaryLabel[1]).toBe(seen.primaryLabel[0]);
  });

  const EXTRAS: {
    label: string;
    feedback: GlanceableActionFeedback | null;
    title: string | null;
    expected: string;
  }[] = [
    {
      label: 'newest title',
      feedback: null,
      title: 'Fix the flaky test',
      expected: 'Newest: Fix the flaky test',
    },
    {
      label: 'approving',
      feedback: 'approving',
      title: 'Fix the flaky test',
      expected: 'Approving…',
    },
    {
      label: 'starting',
      feedback: 'starting',
      title: 'Fix the flaky test',
      expected: 'Starting…',
    },
    {
      label: 'could not approve',
      feedback: 'couldNotApprove',
      title: 'Fix the flaky test',
      expected: 'Could not approve',
    },
    {
      label: 'could not start',
      feedback: 'couldNotStart',
      title: 'Fix the flaky test',
      expected: 'Could not start',
    },
  ];

  it.each(EXTRAS)('draws the same reserved line for $label', ({ feedback, title, expected }) => {
    setSurfaceExtras({ newestSessionTitle: title, actionFeedback: feedback });
    const seen = visible(snapshotFor([{ status: 'busy' }, { status: 'idle' }]));
    expect(seen.newestLine[0]).toBe(expected);
    expect(seen.newestLine[1]).toBe(expected);
  });

  it('offers the same reserved line on the empty surface, where New agent lives', () => {
    setSurfaceExtras({ newestSessionTitle: 'Fix the flaky test', actionFeedback: 'couldNotStart' });
    const seen = visible(snapshotFor([], 'empty'));
    expect(seen.newestLine[0]).toBe('Could not start');
    expect(seen.newestLine[1]).toBe('Could not start');
    expect(seen.actions[0]).toEqual({ approve: false, newAgent: true });
    expect(seen.actions[1]).toEqual({ approve: false, newAgent: true });
  });
});
