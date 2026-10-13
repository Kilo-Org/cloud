/**
 * The shared tray rows the glanceable fixtures compose, split out of
 * `fixture-catalog.ts` so each module stays inside the line budget. Times are
 * relative to the apply moment, so relative copy looks real.
 */

import { type GlanceableFixtureRow } from './fixture-catalog';

const MINUTE_MS = 60_000;

/** `count` rows of one status, the newest `ago` minutes back, each a minute older. */
export function many(
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
export function roundWake(now: number): string {
  const wake = new Date(now + 120 * MINUTE_MS);
  wake.setMinutes(wake.getMinutes() <= 30 ? 30 : 60, 0, 0);
  return wake.toISOString();
}

export const APPROVAL_ROWS = (): GlanceableFixtureRow[] => [
  { status: 'permission', ago: 28, title: 'Migrate the billing webhooks' },
  { status: 'permission', ago: 9, title: 'Bump the Expo SDK' },
  { status: 'question', ago: 3, title: 'Fix the flaky login test' },
];

/** All four kinds; `newest` picks which kind changed last (the large footer). */
export function mixedRows(
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

export function combinationRows(
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
