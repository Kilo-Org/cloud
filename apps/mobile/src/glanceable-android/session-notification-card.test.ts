import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SESSION_CARD_QUIET_AFTER_MS,
  type SessionLiveActivityContentState,
} from '@kilocode/notifications';

import { i18n } from '@/i18n';

import { formatGlanceableClock } from './count-format';
import { buildSessionNotificationCard } from './session-notification-card';

vi.mock('expo-localization', () => ({ getCalendars: () => [{ uses24hourClock: true }] }));

const NOW = Date.parse('2026-10-12T10:20:00.000Z');

function content(
  overrides: Partial<SessionLiveActivityContentState>
): SessionLiveActivityContentState {
  return {
    sessionId: 'session-1',
    title: 'Migrate the billing webhooks',
    statusKind: 'running',
    statusSince: '2026-10-12T10:00:00.000Z',
    scheduledAt: null,
    awaitingPermission: false,
    approvalKey: null,
    updatedAt: '2026-10-12T10:00:00.000Z',
    ...overrides,
  };
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('buildSessionNotificationCard', () => {
  it('names the stop reason and the stop time on a failed card', () => {
    const card = buildSessionNotificationCard(
      content({ statusKind: 'failed', failure: { kind: 'provider' } }),
      null,
      NOW
    );

    expect(card.text).toBe(
      `${i18n.t('glanceable.failure.provider')} ${formatGlanceableClock('2026-10-12T10:00:00.000Z')}`
    );
    expect(card.text).not.toContain(i18n.t('common.failed'));
  });

  it('falls back to the plain stop reason when the failure has no class', () => {
    const card = buildSessionNotificationCard(content({ statusKind: 'failed' }), null, NOW);

    expect(card.text.startsWith(i18n.t('glanceable.failure.other'))).toBe(true);
  });

  it('shows the quiet warning once the quiet window has passed, timed from the last activity', () => {
    const lastActivityAt = new Date(NOW - SESSION_CARD_QUIET_AFTER_MS - 60_000).toISOString();
    const card = buildSessionNotificationCard(content({ lastActivityAt }), null, NOW);

    expect(card.text).toBe(`${i18n.t('common.working')} · ${i18n.t('glanceable.noActivityFor')}`);
    expect(card).toMatchObject({
      chronometer: true,
      whenMs: Date.parse(lastActivityAt),
      quietAtMs: 0,
      quietText: null,
    });
  });

  it('arms the quiet form for the native side while the window is still open', () => {
    const lastActivityAt = new Date(NOW - 60_000).toISOString();
    const card = buildSessionNotificationCard(content({ lastActivityAt }), null, NOW);

    expect(card).toMatchObject({
      text: i18n.t('common.working'),
      chronometer: true,
      whenMs: Date.parse('2026-10-12T10:00:00.000Z'),
      quietAtMs: Date.parse(lastActivityAt) + SESSION_CARD_QUIET_AFTER_MS,
      quietWhenMs: Date.parse(lastActivityAt),
      quietText: `${i18n.t('common.working')} · ${i18n.t('glanceable.noActivityFor')}`,
    });
  });

  it('arms no quiet form for a Working card with no known activity', () => {
    const card = buildSessionNotificationCard(content({}), null, NOW);

    expect(card).toMatchObject({ text: i18n.t('common.working'), quietAtMs: 0, quietText: null });
  });

  it('names the absolute wait time on a Needs input card and draws no system time', () => {
    const card = buildSessionNotificationCard(
      content({
        statusKind: 'needsInput',
        statusSince: '2026-10-12T10:16:00.000Z',
        awaitingPermission: true,
        approvalKey: 'a'.repeat(64),
        permissionCommand: 'pnpm test',
      }),
      null,
      NOW
    );

    expect(card.text).toBe(
      `${i18n.t('glanceable.needsInput')} ${formatGlanceableClock('2026-10-12T10:16:00.000Z')} · pnpm test`
    );
    // No relative age: the native side hides the system time of every card
    // that is not counting up.
    expect(card.chronometer).toBe(false);
    expect(card.text).not.toMatch(/\dm\b/u);
  });

  it('draws the plan count and the cost in the app language digits', async () => {
    // Persian: the test runtime's ICU writes its own digits for it, as Hermes
    // does for Arabic on a device.
    await i18n.changeLanguage('fa');

    const plan = buildSessionNotificationCard(
      content({ plan: { done: 3, total: 7, current: null } }),
      null,
      NOW
    );
    const cost = buildSessionNotificationCard(
      content({ statusKind: 'idle', costMicrodollars: 840_000 }),
      null,
      NOW
    );

    expect(plan.subText).toBe(`۳ ${i18n.t('glanceable.planOf')} ۷`);
    expect(cost.subText).toMatch(/[۰-۹]/u);
    expect(cost.subText).not.toMatch(/[0-9]/u);
  });
});
