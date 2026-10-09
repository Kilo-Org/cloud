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
 * Both platforms draw widget actions with their own mechanism (App Intents on
 * iOS, a headless task on Android), so the two props builders must agree on
 * what the user sees: status, counts, the action feedback line, offered
 * actions, and the spoken label. Numeric/string count formatting differs by
 * platform and is normalized below.
 */

const NOW = 1_750_000_000_000;

const COPY: Record<string, string> = {
  'glanceable.needsInput': 'Needs input',
  'common.idle': 'Idle',
  'common.working': 'Working',
  'common.scheduled': 'Scheduled',
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
  'glanceable.couldNotApprove': 'Could not approve',
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
    feedbackLine: [ios.actionLine, android.homeCopy?.detail ?? null],
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
    ['scheduled', snapshotFor([{ status: 'scheduled' }])],
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

  const FEEDBACK: { label: string; feedback: GlanceableActionFeedback; expected: string }[] = [
    { label: 'approving', feedback: 'approving', expected: 'Approving…' },
    { label: 'could not approve', feedback: 'couldNotApprove', expected: 'Could not approve' },
  ];

  it.each(FEEDBACK)('draws the same action feedback for $label', ({ feedback, expected }) => {
    setSurfaceExtras({ newestSessionTitle: 'Fix the flaky test', actionFeedback: feedback });
    const seen = visible(snapshotFor([{ status: 'busy' }, { status: 'idle' }]));
    expect(seen.feedbackLine).toEqual([expected, expected]);
  });
});
