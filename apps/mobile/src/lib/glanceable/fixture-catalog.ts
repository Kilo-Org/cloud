import { type GlanceableAgentsSnapshotStatus } from '@kilocode/app-shared/glanceable-agents-snapshot';

import { type GlanceableActionFeedback } from './surface-extras';

/**
 * Dev-only named visual states for the glanceable surfaces. A fixture is tray
 * rows plus surface extras; the harness (`fixture-harness.ts`) runs them
 * through the production snapshot builder, the newest-session rule, and the
 * waiting-ask selection, so no widget props are ever built by hand. Times are
 * relative to the apply moment so relative copy ("28 min") looks real.
 *
 * `apps/mobile/scripts/glanceable-fixtures.json` lists the names and
 * descriptions; `fixture-catalog.test.ts` keeps the two in sync.
 */

export type GlanceableFixtureRow = {
  /** Tray status: `permission`/`question` (needs input), `busy`, `scheduled`, `idle`. */
  status: string;
  /** Minutes since the status changed. */
  ago: number;
  title: string;
  /** ISO wake time; scheduled rows only. */
  scheduledAt?: string;
};

export type GlanceableFixture = {
  description: string;
  /** Overrides the happy/empty derivation, exactly as the publisher does. */
  status?: Exclude<GlanceableAgentsSnapshotStatus, 'happy' | 'empty'>;
  rows?: (now: number) => GlanceableFixtureRow[];
  actionFeedback?: Exclude<GlanceableActionFeedback, null>;
};

const MINUTE_MS = 60_000;

/** `count` rows of one status, the newest `ago` minutes back, each a minute older. */
function many(
  spec: Omit<GlanceableFixtureRow, 'title'> & { count: number }
): GlanceableFixtureRow[] {
  const { count, ago, ...rest } = spec;
  return Array.from({ length: count }, (_, index) => ({
    ...rest,
    ago: ago + index,
    title: `Agent ${spec.status} ${index + 1}`,
  }));
}

/**
 * A wake on a round clock time at least two hours out, so the scheduled row
 * reads like a real schedule ("14:30") rather than an odd minute.
 */
function roundWake(now: number): string {
  const wake = new Date(now + 120 * MINUTE_MS);
  wake.setMinutes(wake.getMinutes() <= 30 ? 30 : 60, 0, 0);
  return wake.toISOString();
}

const APPROVAL_ROWS = (): GlanceableFixtureRow[] => [
  { status: 'permission', ago: 28, title: 'Migrate the billing webhooks' },
  { status: 'permission', ago: 9, title: 'Bump the Expo SDK' },
  { status: 'question', ago: 3, title: 'Fix the flaky login test' },
];

/** All four kinds; `newest` picks which kind changed last (the large footer). */
function mixedRows(
  now: number,
  newest: 'needsInput' | 'running' | 'scheduled' | 'idle'
): GlanceableFixtureRow[] {
  const ago = (kind: typeof newest, otherwise: number): number => (kind === newest ? 1 : otherwise);
  return [
    { status: 'permission', ago: ago('needsInput', 28), title: 'Migrate the billing webhooks' },
    { status: 'question', ago: 31, title: 'Pick a color for the badge' },
    { status: 'busy', ago: ago('running', 6), title: 'Fix the flaky login test' },
    { status: 'busy', ago: 14, title: 'Write the release notes' },
    { status: 'busy', ago: 22, title: 'Profile the session list' },
    {
      status: 'scheduled',
      ago: ago('scheduled', 40),
      title: 'Nightly dependency audit',
      scheduledAt: roundWake(now),
    },
    { status: 'idle', ago: ago('idle', 55), title: 'Review the onboarding copy' },
    { status: 'idle', ago: 70, title: 'Triage new issues' },
  ];
}

export const GLANCEABLE_FIXTURES = {
  'signed-out': {
    description: 'Signed out: the sign-in copy, no counts, no actions.',
    status: 'signed_out',
  },
  waiting: {
    description: 'First load: no snapshot yet, the waiting copy.',
    status: 'waiting',
  },
  empty: {
    description: 'Signed in, no agents: the empty copy with New agent.',
  },
  privacy: {
    description: 'Locked (org switch/privacy): the open-Kilo copy, no counts.',
    status: 'privacy',
  },
  expired: {
    description: 'Expired: counts dropped, the expired copy.',
    status: 'expired',
  },
  stale: {
    description: 'Delayed: the mixed counts under the updates-delayed copy.',
    status: 'stale',
    rows: now => mixedRows(now, 'running'),
  },
  'needs-approval': {
    description: 'Only needs input, 2 of 3 approvable (waiting 28 min): Approve shows.',
    rows: APPROVAL_ROWS,
  },
  'needs-input-question': {
    description: 'Only needs input, questions only (waiting 12 min): no Approve.',
    rows: () => [
      { status: 'question', ago: 12, title: 'Pick a color for the badge' },
      { status: 'question', ago: 4, title: 'Choose the migration strategy' },
    ],
  },
  'running-only': {
    description: 'Only running: three agents working.',
    rows: () => [
      { status: 'busy', ago: 2, title: 'Fix the flaky login test' },
      { status: 'busy', ago: 11, title: 'Write the release notes' },
      { status: 'busy', ago: 19, title: 'Profile the session list' },
    ],
  },
  'scheduled-only': {
    description: 'Only scheduled: two agents, the soonest wake on a round clock time.',
    rows: now => [
      {
        status: 'scheduled',
        ago: 5,
        title: 'Nightly dependency audit',
        scheduledAt: roundWake(now),
      },
      {
        status: 'scheduled',
        ago: 30,
        title: 'Weekly usage report',
        scheduledAt: roundWake(now + 180 * MINUTE_MS),
      },
    ],
  },
  'idle-only': {
    description: 'Only idle: two connected agents doing nothing, New agent offered.',
    rows: () => [
      { status: 'idle', ago: 8, title: 'Review the onboarding copy' },
      { status: 'idle', ago: 47, title: 'Triage new issues' },
    ],
  },
  mixed: {
    description:
      'All four kinds (2 needs input, 3 running, 1 scheduled, 2 idle); newest is running.',
    rows: now => mixedRows(now, 'running'),
  },
  'large-counts': {
    description: 'Width stress: 128 needs input, 1,234 running, 56 scheduled, 999 idle.',
    rows: now => [
      ...many({ status: 'permission', count: 64, ago: 30 }),
      ...many({ status: 'question', count: 64, ago: 30 }),
      ...many({ status: 'busy', count: 1234, ago: 1 }),
      ...many({ status: 'scheduled', count: 56, ago: 10, scheduledAt: roundWake(now) }),
      ...many({ status: 'idle', count: 999, ago: 60 }),
    ],
  },
  'long-title': {
    description: 'Mixed counts with a very long newest-session title.',
    rows: () => [
      { status: 'permission', ago: 17, title: 'Migrate the billing webhooks' },
      {
        status: 'busy',
        ago: 1,
        title:
          'Refactor the authentication middleware so expired refresh tokens rotate before the websocket reconnects on flaky networks',
      },
      { status: 'busy', ago: 9, title: 'Write the release notes' },
      { status: 'idle', ago: 33, title: 'Triage new issues' },
    ],
  },
  approving: {
    description: 'Needs approval while the in-place Approve runs: the Approving line.',
    rows: APPROVAL_ROWS,
    actionFeedback: 'approving',
  },
  'could-not-approve': {
    description: 'Needs approval after Approve failed: the Could-not-approve line.',
    rows: APPROVAL_ROWS,
    actionFeedback: 'couldNotApprove',
  },
  'newest-needs-input': {
    description: 'Mixed counts; newest change is needs input (large footer).',
    rows: now => mixedRows(now, 'needsInput'),
  },
  'newest-scheduled': {
    description: 'Mixed counts; newest change is scheduled (large footer).',
    rows: now => mixedRows(now, 'scheduled'),
  },
  'newest-idle': {
    description: 'Mixed counts; newest change is idle (large footer).',
    rows: now => mixedRows(now, 'idle'),
  },
} satisfies Record<string, GlanceableFixture>;

export type GlanceableFixtureName = keyof typeof GLANCEABLE_FIXTURES;

export function isGlanceableFixtureName(name: string): name is GlanceableFixtureName {
  return Object.hasOwn(GLANCEABLE_FIXTURES, name);
}
