import { type UserInteractionEvent } from 'expo-widgets';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type WaitingAsk } from '@/lib/glanceable/waiting-ask';

import {
  GLANCEABLE_APPROVE_TARGET,
  GLANCEABLE_OPEN_TARGET,
  handleGlanceableInteraction,
} from './interaction';

const mocks = vi.hoisted(() => ({
  getInstances: vi.fn(),
  toastError: vi.fn(),
  runGlanceableApprove: vi.fn(),
  refreshGlanceableSnapshot: vi.fn(),
  readWaitingAsk: vi.fn(),
  recordWaitingAsk: vi.fn(),
  restorePersistedGlanceable: vi.fn(),
  setPendingDeepLink: vi.fn(),
  setGlanceableActionNotice: vi.fn(),
  renderStoredSnapshotWithNotice: vi.fn(),
  changeLanguage: vi.fn(),
  language: {
    whenLanguagePreferenceLoaded: vi.fn<() => Promise<void>>(),
    getResolvedLanguage: vi.fn(() => 'de'),
  },
}));

vi.mock('./active-agents-live-activity', () => ({
  LIVE_ACTIVITY_NAME: 'ActiveAgentsLiveActivity',
  OPEN_AGENTS_URL: 'kiloapp:///cloud/sessions',
  ActiveAgentsLiveActivity: { getInstances: mocks.getInstances },
}));
vi.mock('./ios-sink', () => ({
  setGlanceableActionNotice: mocks.setGlanceableActionNotice,
  renderStoredSnapshotWithNotice: mocks.renderStoredSnapshotWithNotice,
}));
vi.mock('sonner-native', () => ({ toast: { error: mocks.toastError } }));
vi.mock('@/i18n', () => ({
  i18n: { t: (key: string) => key, language: 'en', changeLanguage: mocks.changeLanguage },
}));
// The press resolves the stored language itself; the real store needs the
// native SecureStore module, which this test does not load.
vi.mock('@/lib/hooks/use-language-preference', () => ({
  whenLanguagePreferenceLoaded: mocks.language.whenLanguagePreferenceLoaded,
  getResolvedLanguage: mocks.language.getResolvedLanguage,
}));
vi.mock('@/lib/glanceable/approve-ask', () => ({
  runGlanceableApprove: mocks.runGlanceableApprove,
  refreshGlanceableSnapshot: mocks.refreshGlanceableSnapshot,
}));
vi.mock('@/lib/glanceable/waiting-ask', () => ({
  readWaitingAsk: mocks.readWaitingAsk,
  recordWaitingAsk: mocks.recordWaitingAsk,
}));
// The persisted glanceable holds the scope key the mirrored ask is fenced
// against; the real store needs the native SecureStore module.
vi.mock('@/lib/glanceable/persist', () => ({
  restorePersistedGlanceable: mocks.restorePersistedGlanceable,
}));
vi.mock('@/lib/deep-link-launch', () => ({ setPendingDeepLink: mocks.setPendingDeepLink }));

/** The ActivityKit id expo-widgets renders a Live Activity's content under. */
const ACTIVITY_ID = 'activity-1';

/** Another surface: the home-screen widget reports its widget name. */
const FOREIGN_SOURCE = 'ActiveAgentsWidget';

const ASK: WaitingAsk = {
  kiloSessionId: 'session-7',
  status: 'permission',
  isCloudAgent: true,
  scopeKey: 'scope-1',
  organizationId: 'org-1',
  userId: 'user-1',
  recordedAt: 1_750_000_000_000,
};

function event(source: string, target: string): UserInteractionEvent {
  return { source, target, timestamp: 1_750_000_000_000, type: 'ExpoWidgetsUserInteraction' };
}

const fromCard = (target: string) => event(ACTIVITY_ID, target);

/** When a mock was called, relative to every other mock; fails when never called. */
function callOrder(mock: { mock: { invocationCallOrder: number[] } }): number {
  const order = mock.mock.invocationCallOrder[0];
  if (order === undefined) {
    throw new Error('expected the mock to have been called');
  }
  return order;
}

describe('handleGlanceableInteraction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getInstances.mockReturnValue([{ getId: () => ACTIVITY_ID }]);
    mocks.readWaitingAsk.mockResolvedValue(ASK);
    mocks.runGlanceableApprove.mockResolvedValue({ kind: 'approved' });
    mocks.refreshGlanceableSnapshot.mockResolvedValue(undefined);
    mocks.renderStoredSnapshotWithNotice.mockResolvedValue(undefined);
    mocks.restorePersistedGlanceable.mockResolvedValue(undefined);
    mocks.changeLanguage.mockResolvedValue(undefined);
    mocks.language.whenLanguagePreferenceLoaded.mockResolvedValue(undefined);
  });

  it('ignores a press from another layout', async () => {
    await expect(
      handleGlanceableInteraction(event(FOREIGN_SOURCE, GLANCEABLE_OPEN_TARGET))
    ).resolves.toEqual({
      kind: 'ignored',
    });

    expect(mocks.runGlanceableApprove).not.toHaveBeenCalled();
    expect(mocks.setPendingDeepLink).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('ignores a press whose source is an activity this app is not running', async () => {
    await expect(
      handleGlanceableInteraction(event('activity-9', GLANCEABLE_OPEN_TARGET))
    ).resolves.toEqual({
      kind: 'ignored',
    });

    expect(mocks.setPendingDeepLink).not.toHaveBeenCalled();
  });

  it('accepts a press from an ended-but-visible card', async () => {
    // A terminal card stays on screen until ActivityKit dismisses it, and the
    // layout keeps drawing Open on it for that whole window, so the press has
    // to route: `getInstances()` omits ended instances unless it is asked for
    // them. A dismissed card is still no press source.
    mocks.getInstances.mockImplementation((includeEnded?: boolean) =>
      includeEnded === true ? [{ getId: () => ACTIVITY_ID }] : []
    );

    await expect(handleGlanceableInteraction(fromCard(GLANCEABLE_OPEN_TARGET))).resolves.toEqual({
      kind: 'opened',
      href: '/(app)/agent-chat/session-7',
    });

    expect(mocks.getInstances).toHaveBeenCalledWith(true);
    expect(mocks.setPendingDeepLink).toHaveBeenCalledWith(
      '/(app)/agent-chat/session-7',
      'universal-link'
    );
  });

  it('ignores a press when the running activities cannot be read', async () => {
    mocks.getInstances.mockImplementation(() => {
      throw new Error('ActivityKit unavailable');
    });

    await expect(handleGlanceableInteraction(fromCard(GLANCEABLE_OPEN_TARGET))).resolves.toEqual({
      kind: 'ignored',
    });

    expect(mocks.setPendingDeepLink).not.toHaveBeenCalled();
  });

  it('accepts the registered name as this surface too', async () => {
    await expect(
      handleGlanceableInteraction(event('ActiveAgentsLiveActivity', GLANCEABLE_OPEN_TARGET))
    ).resolves.toEqual({ kind: 'opened', href: '/(app)/agent-chat/session-7' });
  });

  it('ignores a target no button declares', async () => {
    await expect(handleGlanceableInteraction(fromCard('dismiss'))).resolves.toEqual({
      kind: 'unhandled',
    });

    expect(mocks.runGlanceableApprove).not.toHaveBeenCalled();
    expect(mocks.setPendingDeepLink).not.toHaveBeenCalled();
  });

  it('routes Approve through the shared flow and republishes the tray', async () => {
    await expect(handleGlanceableInteraction(fromCard(GLANCEABLE_APPROVE_TARGET))).resolves.toEqual(
      {
        kind: 'approved',
      }
    );

    expect(mocks.runGlanceableApprove).toHaveBeenCalledTimes(1);
    expect(mocks.refreshGlanceableSnapshot).toHaveBeenCalledWith({
      userId: 'user-1',
      organizationId: 'org-1',
      answeredKiloSessionId: 'session-7',
      askEnded: true,
    });
    expect(mocks.recordWaitingAsk).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('surfaces the retryable copy and leaves Approve in place', async () => {
    mocks.runGlanceableApprove.mockResolvedValue({ kind: 'retryable' });

    await expect(handleGlanceableInteraction(fromCard(GLANCEABLE_APPROVE_TARGET))).resolves.toEqual(
      {
        kind: 'retryable',
      }
    );

    expect(mocks.toastError).toHaveBeenCalledWith('glanceable.approveFailed');
    // The card itself carries the failure line: the toast is only on screen
    // with the app up, and this press can arrive with it closed.
    expect(mocks.setGlanceableActionNotice).toHaveBeenCalledWith('glanceable.approveFailed');
    expect(mocks.renderStoredSnapshotWithNotice).toHaveBeenCalledTimes(1);
    // The record stays, and the card is not republished as if it had changed.
    expect(mocks.recordWaitingAsk).not.toHaveBeenCalled();
    expect(mocks.refreshGlanceableSnapshot).not.toHaveBeenCalled();
  });

  it('applies the stored language before the press translates anything', async () => {
    mocks.runGlanceableApprove.mockResolvedValue({ kind: 'retryable' });

    await handleGlanceableInteraction(fromCard(GLANCEABLE_APPROVE_TARGET));

    // A press can launch this process in the background, where nothing has
    // applied the stored language yet: the same wait the Android headless task
    // performs. Both the toast and the card's notice are translated after it,
    // so a non-English user never reads the English copy.
    expect(mocks.language.whenLanguagePreferenceLoaded).toHaveBeenCalledTimes(1);
    expect(mocks.changeLanguage).toHaveBeenCalledWith('de');
    expect(callOrder(mocks.changeLanguage)).toBeLessThan(callOrder(mocks.toastError));
    expect(callOrder(mocks.changeLanguage)).toBeLessThan(
      callOrder(mocks.setGlanceableActionNotice)
    );
  });

  it('keeps the retryable press when the card cannot be re-rendered', async () => {
    mocks.runGlanceableApprove.mockResolvedValue({ kind: 'retryable' });
    mocks.renderStoredSnapshotWithNotice.mockRejectedValue(new Error('surface unavailable'));

    await expect(handleGlanceableInteraction(fromCard(GLANCEABLE_APPROVE_TARGET))).resolves.toEqual(
      {
        kind: 'retryable',
      }
    );

    // The notice was still offered to the sink, and the record still stands for
    // another tap: a failed re-render is not a second failure the user sees.
    expect(mocks.setGlanceableActionNotice).toHaveBeenCalledWith('glanceable.approveFailed');
    expect(mocks.recordWaitingAsk).not.toHaveBeenCalled();
  });

  it('drops an answered-elsewhere ask and still refreshes', async () => {
    mocks.runGlanceableApprove.mockResolvedValue({ kind: 'gone' });

    await expect(handleGlanceableInteraction(fromCard(GLANCEABLE_APPROVE_TARGET))).resolves.toEqual(
      {
        kind: 'gone',
      }
    );

    expect(mocks.recordWaitingAsk).toHaveBeenCalledWith(null);
    expect(mocks.refreshGlanceableSnapshot).toHaveBeenCalledTimes(1);
    // Gone ends the ask, so its stale tray row is skipped like an answered one.
    expect(mocks.refreshGlanceableSnapshot).toHaveBeenCalledWith({
      userId: 'user-1',
      organizationId: 'org-1',
      answeredKiloSessionId: 'session-7',
      askEnded: true,
    });
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('refreshes without touching the record when nothing is approvable', async () => {
    mocks.runGlanceableApprove.mockResolvedValue({ kind: 'none' });

    await expect(handleGlanceableInteraction(fromCard(GLANCEABLE_APPROVE_TARGET))).resolves.toEqual(
      {
        kind: 'none',
      }
    );

    expect(mocks.recordWaitingAsk).not.toHaveBeenCalled();
    expect(mocks.refreshGlanceableSnapshot).toHaveBeenCalledTimes(1);
    // `none` leaves the ask as it is, so the republish re-selects that row: the
    // session Open names has to survive a press that answered nothing.
    expect(mocks.refreshGlanceableSnapshot).toHaveBeenCalledWith({
      userId: 'user-1',
      organizationId: 'org-1',
      answeredKiloSessionId: 'session-7',
      askEnded: false,
    });
  });

  it('does nothing on Approve without a record', async () => {
    mocks.readWaitingAsk.mockResolvedValue(null);
    mocks.runGlanceableApprove.mockResolvedValue({ kind: 'none' });

    await expect(handleGlanceableInteraction(fromCard(GLANCEABLE_APPROVE_TARGET))).resolves.toEqual(
      {
        kind: 'none',
      }
    );

    expect(mocks.refreshGlanceableSnapshot).not.toHaveBeenCalled();
    expect(mocks.recordWaitingAsk).not.toHaveBeenCalled();
  });

  it.each(['session-7', 'ses_1/2 3', 'ses_1?tab=2', 'ses_1#part', 'ses_%2F'])(
    'routes Open to the entire recorded session id %s',
    async kiloSessionId => {
      mocks.readWaitingAsk.mockResolvedValue({ ...ASK, kiloSessionId });
      const href = `/(app)/agent-chat/${encodeURIComponent(kiloSessionId)}`;
      await expect(handleGlanceableInteraction(fromCard(GLANCEABLE_OPEN_TARGET))).resolves.toEqual({
        kind: 'opened',
        href,
      });

      expect(mocks.setPendingDeepLink).toHaveBeenCalledWith(href, 'universal-link');
      expect(mocks.runGlanceableApprove).not.toHaveBeenCalled();
    }
  );

  it('restores the persisted scope before Approve reads the mirrored ask', async () => {
    await handleGlanceableInteraction(fromCard(GLANCEABLE_APPROVE_TARGET));

    // A press can launch this process in the background, before any app root
    // restores the persisted glanceable — and the mirrored ask's cross-scope
    // fence compares against the scope key that restore fills. Reading the ask
    // first would accept an ask left by a signed-out account or another org.
    expect(mocks.restorePersistedGlanceable).toHaveBeenCalledTimes(1);
    expect(callOrder(mocks.restorePersistedGlanceable)).toBeLessThan(
      callOrder(mocks.readWaitingAsk)
    );
  });

  it('restores the persisted scope before Open reads the mirrored ask', async () => {
    await handleGlanceableInteraction(fromCard(GLANCEABLE_OPEN_TARGET));

    // The same stored scope: Open names the recorded session, so a foreign ask
    // must not become the deep link either.
    expect(callOrder(mocks.restorePersistedGlanceable)).toBeLessThan(
      callOrder(mocks.readWaitingAsk)
    );
  });

  it('lands on the Agents tab when Open has no recorded session', async () => {
    mocks.readWaitingAsk.mockResolvedValue(null);

    await expect(handleGlanceableInteraction(fromCard(GLANCEABLE_OPEN_TARGET))).resolves.toEqual({
      kind: 'opened',
      href: '/(app)/(tabs)/(2_agents)',
    });

    // The button carries no URL of its own: with nothing recorded there is no
    // session to open, and a press that stashes nothing is a dead control. The
    // Agents tab is the destination the card's body deep-links to and the one
    // Android's notification already falls back to.
    expect(mocks.setPendingDeepLink).toHaveBeenCalledWith(
      '/(app)/(tabs)/(2_agents)',
      'universal-link'
    );
    expect(mocks.runGlanceableApprove).not.toHaveBeenCalled();
  });

  it('turns an escaping failure into a retryable press', async () => {
    mocks.readWaitingAsk.mockRejectedValue(new Error('storage unavailable'));

    await expect(handleGlanceableInteraction(fromCard(GLANCEABLE_APPROVE_TARGET))).resolves.toEqual(
      {
        kind: 'retryable',
      }
    );

    // With no readable ask there is nothing to name and no approvable action to
    // promise, so the card carries no notice either.
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.setGlanceableActionNotice).not.toHaveBeenCalled();
    expect(mocks.renderStoredSnapshotWithNotice).not.toHaveBeenCalled();
  });
});
