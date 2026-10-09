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
 * descriptions for capture scripts; regenerate it after a catalog change.
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
  /** Minutes since the last successful confirmation. */
  checkedAgo?: number;
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

const COMBINATION_STATUS = {
  needsInput: 'permission',
  running: 'busy',
  scheduled: 'scheduled',
  idle: 'idle',
} as const;

function combinationRows(
  kinds: readonly (keyof typeof COMBINATION_STATUS)[]
): (now: number) => GlanceableFixtureRow[] {
  return now =>
    kinds.map(kind => ({
      status: COMBINATION_STATUS[kind],
      ago: 12,
      title: kind === 'scheduled' ? 'Nightly dependency audit' : 'Review authentication changes',
      ...(kind === 'scheduled' ? { scheduledAt: roundWake(now) } : {}),
    }));
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
    description: 'Expired activity: the Home widget retains last-known mixed work.',
    status: 'expired',
    checkedAgo: 600,
    rows: now => mixedRows(now, 'running'),
  },
  stale: {
    description: 'Delayed: mixed work retains its last successful confirmation time.',
    status: 'stale',
    checkedAgo: 31,
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
  'scheduled-no-time': {
    description: 'Scheduled agents without a usable wake time.',
    rows: () => [
      { status: 'scheduled', ago: 12, title: 'Dependency audit' },
      { status: 'scheduled', ago: 30, title: 'Usage report' },
    ],
  },
  'scheduled-overdue': {
    description: 'The earliest scheduled wake passed without confirmation; never invent working.',
    rows: now => [
      {
        status: 'scheduled',
        ago: 35,
        title: 'Dependency audit',
        scheduledAt: new Date(now - 15 * MINUTE_MS).toISOString(),
      },
      { status: 'idle', ago: 50, title: 'Review documentation' },
    ],
  },
  'scheduled-tomorrow': {
    description: 'Three future runs show non-today local dates and times.',
    rows: now =>
      [1, 2, 3].map(day => ({
        status: 'scheduled',
        ago: 20,
        title:
          ['Nightly dependency audit', 'Weekly usage report', 'Release readiness review'][
            day - 1
          ] ?? '',
        scheduledAt: roundWake(now + day * 24 * 60 * MINUTE_MS),
      })),
  },
  'retry-only': {
    description: 'Needs input from provider retry states, with no permission to approve.',
    rows: () => [{ status: 'retry', ago: 15, title: 'Recover the interrupted build' }],
  },
  untitled: {
    description: 'Waiting and scheduled rows without titles use a localized generic label.',
    rows: now => [
      { status: 'question', ago: 5, title: '' },
      { status: 'scheduled', ago: 8, title: '', scheduledAt: roundWake(now) },
    ],
  },
  'stale-idle': {
    description: 'Old idle work remains useful without claiming current confirmation.',
    checkedAgo: 600,
    status: 'stale',
    rows: () => [{ status: 'idle', ago: 30, title: 'Review the onboarding copy' }],
  },
  'stale-empty': {
    description: 'A last-known empty state retains creation and an honest timestamp.',
    checkedAgo: 180,
    status: 'stale',
  },
  'mix-input-running': {
    description: 'Needs input and working.',
    rows: combinationRows(['needsInput', 'running']),
  },
  'mix-input-scheduled': {
    description: 'Needs input and scheduled.',
    rows: combinationRows(['needsInput', 'scheduled']),
  },
  'mix-input-idle': {
    description: 'Needs input and idle.',
    rows: combinationRows(['needsInput', 'idle']),
  },
  'mix-running-scheduled': {
    description: 'Working and scheduled.',
    rows: combinationRows(['running', 'scheduled']),
  },
  'mix-running-idle': {
    description: 'Working and idle.',
    rows: combinationRows(['running', 'idle']),
  },
  'mix-scheduled-idle': {
    description: 'Scheduled and idle; the wake time takes priority over idle details.',
    rows: combinationRows(['scheduled', 'idle']),
  },
  'mix-input-running-scheduled': {
    description: 'Needs input, working, and scheduled.',
    rows: combinationRows(['needsInput', 'running', 'scheduled']),
  },
  'mix-input-running-idle': {
    description: 'Needs input, working, and idle.',
    rows: combinationRows(['needsInput', 'running', 'idle']),
  },
  'mix-input-scheduled-idle': {
    description: 'Needs input, scheduled, and idle.',
    rows: combinationRows(['needsInput', 'scheduled', 'idle']),
  },
  'mix-running-scheduled-idle': {
    description: 'Working, scheduled, and idle.',
    rows: combinationRows(['running', 'scheduled', 'idle']),
  },
} satisfies Record<string, GlanceableFixture>;

export type GlanceableFixtureName = keyof typeof GLANCEABLE_FIXTURES;

export function isGlanceableFixtureName(name: string): name is GlanceableFixtureName {
  return Object.hasOwn(GLANCEABLE_FIXTURES, name);
}
