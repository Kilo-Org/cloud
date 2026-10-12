import { type GlanceableFixture } from './fixture-catalog';

/**
 * Dev-only fixtures for the iOS session card (`.specs/mobile-session-live-activity.md`).
 * Each one follows one tray row through `followSession`, the path the Follow
 * control takes, so the card is started, counted out of the aggregate card,
 * and updated by production code. Open one with
 * `kiloapp:///dev/glanceable-fixture/<name>`; `.../release` ends the card.
 *
 * Android draws no session card, so these fixtures show only the Home widget
 * and the ongoing notification there.
 */

const MINUTE_MS = 60_000;

export const SESSION_CARD_FIXTURES = {
  'session-card-running': {
    description: 'Session card: Working, with the elapsed time since the last change.',
    rows: () => [{ status: 'busy', ago: 12, title: 'Migrate the billing webhooks' }],
    follow: { index: 0 },
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
} satisfies Record<string, GlanceableFixture>;
