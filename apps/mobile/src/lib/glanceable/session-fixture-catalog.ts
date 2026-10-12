import { type GlanceableFixture } from './fixture-catalog';

/**
 * Dev-only fixtures for the iOS session card (`.specs/mobile-session-live-activity.md`).
 * Each one follows one tray row through `followSession`, the path the Follow
 * control takes, so the card is started, counted out of the aggregate card,
 * and updated by production code. Open one with
 * `kiloapp:///dev/glanceable-fixture/<name>`; `.../release` ends the card.
 *
 * The same fixtures drive Android, where the session card is an ongoing
 * notification instead of a Live Activity. The harness follows the fixture's
 * row through the platform's own `followSession`, so both platforms exercise
 * production code.
 */

const MINUTE_MS = 60_000;

export const SESSION_CARD_FIXTURES = {
  'session-card-running': {
    description:
      'Session card: Working, with the step, the plan progress and the elapsed time since the last change.',
    rows: () => [{ status: 'busy', ago: 12, title: 'Migrate the billing webhooks' }],
    follow: {
      index: 0,
      card: {
        step: { verb: 'editing', target: 'auth.ts' },
        plan: { done: 3, total: 7, current: 'Write tests' },
        changes: { files: 4, added: 120, removed: 30 },
        activityAgo: 1,
        costMicrodollars: 84_000,
        startedAgo: 38,
      },
    },
  },
  'session-card-quiet': {
    description:
      'Session card: Working with no activity past the quiet window, so it shows the quiet warning.',
    rows: () => [{ status: 'busy', ago: 21, title: 'Refactor the settle path' }],
    follow: {
      index: 0,
      card: {
        step: { verb: 'searching', target: 'settle' },
        activityAgo: 9,
        startedAgo: 25,
      },
    },
  },
  'session-card-question': {
    description: 'Session card: Waiting for an answer, with the step count and Open.',
    rows: () => [{ status: 'question', ago: 6, title: 'Pick the migration order' }],
    follow: {
      index: 0,
      card: { plan: { done: 2, total: 5, current: null }, activityAgo: 6 },
    },
  },
  'session-card-failed': {
    description:
      'Session card: a finished turn that failed, with the stop reason and the files changed.',
    rows: () => [{ status: 'idle', ago: 1, title: 'Ship the release build' }],
    follow: {
      index: 0,
      finish: true,
      card: {
        failure: 'provider',
        changes: { files: 3, added: 12, removed: 4 },
        plan: { done: 2, total: 5, current: null },
        activityAgo: 1,
      },
    },
  },
  'session-card-permission': {
    description:
      'Session card: Needs input on a permission, with Approve and Open (the key matches no live request).',
    rows: () => [{ status: 'permission', ago: 4, title: 'Bump the Expo SDK' }],
    follow: { index: 0, approvalKey: true },
  },
  'session-card-scheduled': {
    description: 'Session card: Scheduled, with the wake time.',
    rows: now => [
      {
        status: 'scheduled',
        ago: 30,
        title: 'Nightly dependency audit',
        scheduledAt: new Date(now + 90 * MINUTE_MS).toISOString(),
      },
    ],
    follow: { index: 0 },
  },
  'session-card-finished': {
    description:
      'Session card: followed while Working, then Finished with the finish time; it leaves the Lock Screen after 15 minutes.',
    rows: () => [{ status: 'idle', ago: 0, title: 'Write the release notes' }],
    follow: { index: 0, finish: true },
  },
  'session-card-rtl-title': {
    description:
      'Session card: Working with a right-to-left title. Launch the app in Arabic to mirror the card.',
    rows: () => [{ status: 'busy', ago: 7, title: 'ترحيل خطافات الفوترة' }],
    follow: { index: 0 },
  },
  // Android-only twins: the Android session card is an ongoing notification,
  // so the states the notification has and the Live Activity does not need
  // their own names. The rows are the same facts.
  'session-card-android-working': {
    description:
      'Android session notification: Working, with the system counting-up timer since the last change.',
    rows: () => [{ status: 'busy', ago: 12, title: 'Migrate the billing webhooks' }],
    follow: { index: 0 },
  },
  'session-card-android-permission': {
    description:
      'Android session notification: Needs approval, with the command and Approve (the key matches no live request).',
    rows: () => [{ status: 'permission', ago: 4, title: 'Bump the Expo SDK' }],
    follow: { index: 0, approvalKey: true },
  },
  'session-card-android-scheduled': {
    description: 'Android session notification: Scheduled, with the wake time.',
    rows: now => [
      {
        status: 'scheduled',
        ago: 30,
        title: 'Nightly dependency audit',
        scheduledAt: new Date(now + 90 * MINUTE_MS).toISOString(),
      },
    ],
    follow: { index: 0 },
  },
  'session-card-android-finished': {
    description:
      'Android session notification: followed while Working, then Finished with the finish time; it leaves the shade after 15 minutes.',
    rows: () => [{ status: 'idle', ago: 0, title: 'Write the release notes' }],
    follow: { index: 0, finish: true },
  },
} satisfies Record<string, GlanceableFixture>;
