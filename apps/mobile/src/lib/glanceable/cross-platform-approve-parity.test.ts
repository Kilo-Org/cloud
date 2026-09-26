/* eslint-disable max-lines -- one parity table covering both platform entry points end to end */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { type SupportedLanguage } from '@/i18n/languages';
import { type GlanceableApproveResult } from '@/lib/glanceable/approve-ask';
import { type WaitingAsk } from '@/lib/glanceable/waiting-ask';

/**
 * Cross-platform parity for the activity Approve action.
 *
 * The two glanceable surfaces are different native transports — iOS renders an
 * ActivityKit Live Activity through `expo-widgets`, Android renders the Live
 * Update notification through its local Expo module and boots the answer as
 * headless JS — so the press arrives through two platform entry points:
 * `@/glanceable-ios/interaction` and `@/glanceable-android/approve-task`.
 *
 * This suite drives both entry points with the same recorded ask and the same
 * shared result, and pins that the user-visible outcome is the same on both:
 * one shared answer body (`runGlanceableApprove`), the same translated retry
 * line with the record kept for a second tap, the same silent drop once the
 * permission was answered elsewhere, and no failure line on a success or a
 * non-approvable ask. A change that forks the behavior per platform fails here
 * rather than only on one device.
 */

const ASK: WaitingAsk = {
  kiloSessionId: 'ses_1',
  status: 'permission',
  isCloudAgent: true,
  scopeKey: 'scope-key',
  organizationId: 'org_1',
  userId: 'u1',
  recordedAt: 1_750_000_000_000,
};

/** The ActivityKit id the Live Activity's press reports as its source. */
const ACTIVITY_ID = 'activity-1';

const mocks = vi.hoisted(() => ({
  readWaitingAsk: vi.fn<() => Promise<WaitingAsk | null>>(),
  recordWaitingAsk: vi.fn<(ask: WaitingAsk | null) => void>(),
  restorePersistedGlanceable: vi.fn<() => Promise<void>>(),
  runGlanceableApprove: vi.fn<() => Promise<GlanceableApproveResult>>(),
  refreshGlanceableSnapshot: vi.fn<() => Promise<void>>(),
  language: {
    whenLanguagePreferenceLoaded: vi.fn<() => Promise<void>>(),
    getResolvedLanguage: vi.fn<() => SupportedLanguage>(),
  },
  getInstances: vi.fn(),
  toastError: vi.fn(),
  setPendingDeepLink: vi.fn(),
  iosNotice: vi.fn<(notice: string | null) => void>(),
  iosRender: vi.fn<() => void | Promise<void>>(),
  androidNotice: vi.fn<(notice: string | null) => void>(),
  androidRender:
    vi.fn<(ctx: { userId: string; organizationId: string | null }) => void | Promise<void>>(),
  registerHeadlessTask: vi.fn(),
}));

vi.mock('@/lib/glanceable/waiting-ask', () => ({
  readWaitingAsk: mocks.readWaitingAsk,
  recordWaitingAsk: mocks.recordWaitingAsk,
}));

// Both headless presses restore the persisted glanceable before reading the
// mirrored ask (the fence's scope key); the real store needs the native module.
vi.mock('@/lib/glanceable/persist', () => ({
  restorePersistedGlanceable: mocks.restorePersistedGlanceable,
}));

vi.mock('@/lib/glanceable/approve-ask', () => ({
  runGlanceableApprove: mocks.runGlanceableApprove,
  refreshGlanceableSnapshot: mocks.refreshGlanceableSnapshot,
}));

// Both presses resolve the stored language themselves; the real store needs the
// native SecureStore module, which this suite does not load.
vi.mock('@/lib/hooks/use-language-preference', () => ({
  whenLanguagePreferenceLoaded: mocks.language.whenLanguagePreferenceLoaded,
  getResolvedLanguage: mocks.language.getResolvedLanguage,
}));

vi.mock('@/glanceable-ios/ios-sink', () => ({
  setGlanceableActionNotice: mocks.iosNotice,
  renderStoredSnapshotWithNotice: mocks.iosRender,
}));
vi.mock('@/glanceable-ios/active-agents-live-activity', () => ({
  LIVE_ACTIVITY_NAME: 'ActiveAgentsLiveActivity',
  OPEN_AGENTS_URL: 'kiloapp:///cloud/sessions',
  ActiveAgentsLiveActivity: { getInstances: mocks.getInstances },
}));

vi.mock('@/glanceable-android/android-sink', () => ({
  androidSink: { publish: vi.fn(), endImmediate: vi.fn(), startOrUpdate: vi.fn() },
  setGlanceableActionNotice: mocks.androidNotice,
  renderStoredSnapshotWithNotice: mocks.androidRender,
}));

// The Android card's Approve retires the raise's app-owned needs-input
// notification; the real module loads expo-notifications, which this suite
// cannot.
vi.mock('@/lib/needs-input-notification', () => ({
  dismissNeedsInputNotification: vi.fn(),
}));

vi.mock('sonner-native', () => ({ toast: { error: mocks.toastError } }));
vi.mock('@/lib/deep-link-launch', () => ({ setPendingDeepLink: mocks.setPendingDeepLink }));

// The Android task runs with no Activity and no rendered tree: AppRegistry is
// the only React Native surface reachable from it.
vi.mock('react-native', () => ({
  AppRegistry: { registerHeadlessTask: mocks.registerHeadlessTask },
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios },
}));

const { handleGlanceableInteraction } = await import('@/glanceable-ios/interaction');
const { handleApproveTask } = await import('@/glanceable-android/approve-task');

/** One platform's press, and the surface that reports the failure line. */
type PlatformHarness = {
  readonly platform: 'ios' | 'android';
  press(): Promise<unknown>;
  readonly notice: typeof mocks.iosNotice | typeof mocks.androidNotice;
  readonly render: typeof mocks.iosRender | typeof mocks.androidRender;
};

const PLATFORMS: readonly PlatformHarness[] = [
  {
    platform: 'ios',
    press: async () => {
      await handleGlanceableInteraction({
        source: ACTIVITY_ID,
        target: 'approve',
        timestamp: 1_750_000_000_000,
        type: 'ExpoWidgetsUserInteraction',
      });
    },
    notice: mocks.iosNotice,
    render: mocks.iosRender,
  },
  {
    platform: 'android',
    press: async () => {
      await handleApproveTask();
    },
    notice: mocks.androidNotice,
    render: mocks.androidRender,
  },
];

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.language.whenLanguagePreferenceLoaded.mockResolvedValue(undefined);
  mocks.language.getResolvedLanguage.mockReturnValue('en');
  mocks.getInstances.mockReturnValue([{ getId: () => ACTIVITY_ID }]);
  mocks.readWaitingAsk.mockResolvedValue(ASK);
  mocks.runGlanceableApprove.mockResolvedValue({ kind: 'approved' });
  mocks.refreshGlanceableSnapshot.mockResolvedValue(undefined);
  mocks.restorePersistedGlanceable.mockResolvedValue(undefined);
  mocks.iosRender.mockResolvedValue(undefined);
  mocks.androidRender.mockResolvedValue(undefined);
  // Each case starts from English so the German case below is a real switch.
  await i18n.changeLanguage('en');
});

describe('activity Approve parity across platforms', () => {
  it.each(PLATFORMS)(
    'answers one press through the one shared flow on $platform',
    async harness => {
      await harness.press();

      expect(mocks.runGlanceableApprove).toHaveBeenCalledTimes(1);
      expect(mocks.refreshGlanceableSnapshot).toHaveBeenCalledWith({
        userId: 'u1',
        organizationId: 'org_1',
        answeredKiloSessionId: 'ses_1',
        askEnded: true,
      });
      expect(harness.notice).not.toHaveBeenCalled();
    }
  );

  it.each(PLATFORMS)(
    'keeps the ask and shows the translated retry line on $platform',
    async harness => {
      mocks.runGlanceableApprove.mockResolvedValue({ kind: 'retryable' });

      await harness.press();

      // The retry line is catalog copy, never an English literal: the press
      // applies the stored language before it translates, and the Android
      // headless run and the iOS background run both have no mounted app root.
      expect(harness.notice).toHaveBeenCalledWith(i18n.t('glanceable.approveFailed'));
      expect(harness.render).toHaveBeenCalled();
      // The record stays, so the surface keeps its Approve action for a second tap.
      expect(mocks.recordWaitingAsk).not.toHaveBeenCalled();
    }
  );

  it.each(PLATFORMS)(
    'drops an answered-elsewhere ask with no error line on $platform',
    async harness => {
      mocks.runGlanceableApprove.mockResolvedValue({ kind: 'gone' });

      await harness.press();

      expect(mocks.recordWaitingAsk).toHaveBeenCalledWith(null);
      expect(harness.notice).not.toHaveBeenCalled();
      expect(harness.render).not.toHaveBeenCalled();
    }
  );

  it.each(PLATFORMS)('reports no failure on a completed answer on $platform', async harness => {
    mocks.runGlanceableApprove.mockResolvedValue({ kind: 'approved' });

    await harness.press();

    expect(mocks.recordWaitingAsk).not.toHaveBeenCalled();
    expect(harness.notice).not.toHaveBeenCalled();
    expect(harness.render).not.toHaveBeenCalled();
  });

  it.each(PLATFORMS)(
    'reports no failure when nothing is approvable on $platform',
    async harness => {
      mocks.runGlanceableApprove.mockResolvedValue({ kind: 'none' });

      await harness.press();

      expect(mocks.recordWaitingAsk).not.toHaveBeenCalled();
      expect(harness.notice).not.toHaveBeenCalled();
      expect(harness.render).not.toHaveBeenCalled();
    }
  );

  it.each(PLATFORMS)('does nothing on a press with no recorded ask on $platform', async harness => {
    mocks.readWaitingAsk.mockResolvedValue(null);
    // `runGlanceableApprove` reads the record itself; with none recorded it
    // answers `none`, which is what the mock returns here.
    mocks.runGlanceableApprove.mockResolvedValue({ kind: 'none' });

    await harness.press();

    // The Android task returns before the shared call for a null record while
    // the iOS press still enters it; the outcome the user sees is the same
    // either way: no line, no republish, and no action removed.
    expect(mocks.recordWaitingAsk).not.toHaveBeenCalled();
    expect(mocks.refreshGlanceableSnapshot).not.toHaveBeenCalled();
    expect(harness.notice).not.toHaveBeenCalled();
    expect(harness.render).not.toHaveBeenCalled();
  });

  it.each(PLATFORMS)(
    'settles the press when the republish itself fails on $platform',
    async harness => {
      mocks.runGlanceableApprove.mockResolvedValue({ kind: 'gone' });
      mocks.refreshGlanceableSnapshot.mockRejectedValue(new Error('tray unavailable'));

      // Awaiting outside an assertion: a rejection here fails the case. The
      // shared republish swallows the tray failure, so the press settles on
      // both platforms instead of leaving the surface half-updated.
      await harness.press();

      expect(mocks.recordWaitingAsk).toHaveBeenCalledWith(null);
      expect(harness.notice).not.toHaveBeenCalled();
    }
  );

  it.each(PLATFORMS)(
    'fences the mirrored ask behind the restored scope on $platform',
    async harness => {
      await harness.press();

      // Both presses can launch the process headless, where the persisted
      // glanceable holds the scope key the mirrored ask is fenced against.
      // Reading the ask first would accept one that belongs to another scope.
      expect(mocks.restorePersistedGlanceable).toHaveBeenCalledTimes(1);
      expect(mocks.restorePersistedGlanceable.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.readWaitingAsk.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
      );
    }
  );

  it.each(PLATFORMS)(
    'answers a press in the language the user stored on $platform',
    async harness => {
      mocks.runGlanceableApprove.mockResolvedValue({ kind: 'retryable' });
      const english = i18n.t('glanceable.approveFailed');
      mocks.language.getResolvedLanguage.mockReturnValue('de');

      await harness.press();

      const german = i18n.t('glanceable.approveFailed');
      expect(german).not.toBe(english);
      expect(harness.notice).toHaveBeenCalledWith(german);
    }
  );
});
