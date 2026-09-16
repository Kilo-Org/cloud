/* eslint-disable eslint-plugin-import/no-nodejs-modules, eslint-plugin-unicorn/prefer-module -- the entry and the Kotlin worker are sources; running/reading them from disk is the only way to see the registered key */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { type SupportedLanguage } from '@/i18n/languages';
import { type GlanceableApproveResult } from '@/lib/glanceable/approve-ask';
import { getGlanceableSinks } from '@/lib/glanceable/sink-registry';
import { type WaitingAsk } from '@/lib/glanceable/waiting-ask';

const ASK: WaitingAsk = {
  kiloSessionId: 'ses_1',
  status: 'permission',
  isCloudAgent: true,
  scopeKey: 'scope-key',
  organizationId: 'org_1',
  userId: 'u1',
  recordedAt: 1_750_000_000_000,
};

const mocks = vi.hoisted(() => ({
  readWaitingAsk: vi.fn<() => Promise<WaitingAsk | null>>(),
  recordWaitingAsk: vi.fn<(ask: WaitingAsk | null) => void>(),
  runGlanceableApprove: vi.fn<() => Promise<GlanceableApproveResult>>(),
  refreshGlanceableSnapshot: vi.fn<() => Promise<void>>(),
  setGlanceableActionNotice: vi.fn<(notice: string | null) => void>(),
  renderStoredSnapshotWithNotice:
    vi.fn<(ctx: { userId: string; organizationId: string | null }) => void>(),
  language: {
    whenLanguagePreferenceLoaded: vi.fn<() => Promise<void>>(),
    getResolvedLanguage: vi.fn<() => SupportedLanguage>(),
  },
  sink: {
    publish: vi.fn(),
    endImmediate: vi.fn(),
    startOrUpdate: vi.fn(),
  },
}));

vi.mock('@/lib/glanceable/waiting-ask', () => ({
  readWaitingAsk: mocks.readWaitingAsk,
  recordWaitingAsk: mocks.recordWaitingAsk,
}));

vi.mock('@/lib/glanceable/approve-ask', () => ({
  runGlanceableApprove: mocks.runGlanceableApprove,
  refreshGlanceableSnapshot: mocks.refreshGlanceableSnapshot,
}));

// The headless task resolves the stored language itself; the real store needs
// the native SecureStore module, which this test does not load.
vi.mock('@/lib/hooks/use-language-preference', () => ({
  whenLanguagePreferenceLoaded: mocks.language.whenLanguagePreferenceLoaded,
  getResolvedLanguage: mocks.language.getResolvedLanguage,
}));

vi.mock('./android-sink', () => ({
  androidSink: mocks.sink,
  setGlanceableActionNotice: mocks.setGlanceableActionNotice,
  renderStoredSnapshotWithNotice: mocks.renderStoredSnapshotWithNotice,
}));

const { APPROVE_HEADLESS_TASK_KEY, handleApproveTask } = await import('./approve-task');

/** The catalog key for the retryable line, and the copy this slice must show. */
const APPROVE_FAILED_KEY = 'glanceable.approveFailed';
const APPROVE_FAILED = "Couldn't approve. Tap Approve to try again.";
const WORKER_SOURCE = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    'modules',
    'active-agents-live-update',
    'android',
    'src',
    'main',
    'java',
    'com',
    'kilocode',
    'activeagentsliveupdate',
    'ActiveAgentsApproveWorker.kt'
  ),
  'utf8'
);
const ENTRY_SOURCE = readFileSync(join(__dirname, '..', '..', 'index.js'), 'utf8');

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.language.whenLanguagePreferenceLoaded.mockResolvedValue(undefined);
  mocks.language.getResolvedLanguage.mockReturnValue('en');
  mocks.readWaitingAsk.mockResolvedValue(ASK);
  mocks.runGlanceableApprove.mockResolvedValue({ kind: 'approved' });
  mocks.refreshGlanceableSnapshot.mockResolvedValue(undefined);
  // The language case switches the shared instance; every other case is English.
  await i18n.changeLanguage('en');
});

describe('handleApproveTask', () => {
  it('republishes once with the answered session and leaves no notice on approval', async () => {
    mocks.runGlanceableApprove.mockResolvedValue({ kind: 'approved' });

    await handleApproveTask();

    expect(mocks.runGlanceableApprove).toHaveBeenCalledTimes(1);
    // s3 clears the record inside the shared approve flow; the task must not
    // clear it again, and an approval is not a failure to report.
    expect(mocks.recordWaitingAsk).not.toHaveBeenCalled();
    expect(mocks.setGlanceableActionNotice).not.toHaveBeenCalled();
    expect(mocks.renderStoredSnapshotWithNotice).not.toHaveBeenCalled();
    expect(mocks.refreshGlanceableSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.refreshGlanceableSnapshot).toHaveBeenCalledWith({
      userId: 'u1',
      organizationId: 'org_1',
      answeredKiloSessionId: 'ses_1',
    });
  });

  it('shows the catalog copy for the retryable key', () => {
    expect(i18n.t(APPROVE_FAILED_KEY)).toBe(APPROVE_FAILED);
  });

  it('keeps the ask, shows the failure line and republishes on a retryable failure', async () => {
    mocks.runGlanceableApprove.mockResolvedValue({ kind: 'retryable' });

    await handleApproveTask();

    expect(mocks.recordWaitingAsk).not.toHaveBeenCalled();
    expect(mocks.setGlanceableActionNotice).toHaveBeenCalledTimes(2);
    expect(mocks.setGlanceableActionNotice).toHaveBeenNthCalledWith(1, APPROVE_FAILED);
    expect(mocks.setGlanceableActionNotice).toHaveBeenNthCalledWith(2, APPROVE_FAILED);
    expect(mocks.renderStoredSnapshotWithNotice).toHaveBeenCalledTimes(2);
    expect(mocks.renderStoredSnapshotWithNotice).toHaveBeenNthCalledWith(1, {
      userId: 'u1',
      organizationId: 'org_1',
    });
    expect(mocks.renderStoredSnapshotWithNotice).toHaveBeenNthCalledWith(2, {
      userId: 'u1',
      organizationId: 'org_1',
    });
    // The failure line reaches the notification twice: once immediately, so the
    // user does not wait out the refresh's poll budget, and once after the
    // republish, which writes the notification again and re-selects the ask from
    // the tray — a line drawn only first could be pruned by that render.
    const firstNotice = mocks.setGlanceableActionNotice.mock.invocationCallOrder[0];
    const firstRender = mocks.renderStoredSnapshotWithNotice.mock.invocationCallOrder[0];
    const refreshOrder = mocks.refreshGlanceableSnapshot.mock.invocationCallOrder[0];
    const lastNotice = mocks.setGlanceableActionNotice.mock.invocationCallOrder[1];
    const lastRender = mocks.renderStoredSnapshotWithNotice.mock.invocationCallOrder[1];
    expect(firstNotice).toBeLessThan(firstRender ?? Number.POSITIVE_INFINITY);
    expect(firstRender).toBeLessThan(refreshOrder ?? Number.POSITIVE_INFINITY);
    expect(refreshOrder).toBeLessThan(lastNotice ?? Number.POSITIVE_INFINITY);
    expect(lastNotice).toBeLessThan(lastRender ?? Number.POSITIVE_INFINITY);
    expect(mocks.refreshGlanceableSnapshot).toHaveBeenCalledTimes(1);
  });

  it('renders the failure line from the stored snapshot when the republish rejects', async () => {
    // The retryable failure's trigger is a backend that is not answering, so
    // the republish that would render the line can fail as well: the sink had
    // to render it before that, from the snapshot the app stored.
    mocks.runGlanceableApprove.mockResolvedValue({ kind: 'retryable' });
    mocks.refreshGlanceableSnapshot.mockRejectedValue(new Error('offline'));

    await expect(handleApproveTask()).resolves.toBeUndefined();

    expect(mocks.setGlanceableActionNotice).toHaveBeenCalledWith(APPROVE_FAILED);
    expect(mocks.renderStoredSnapshotWithNotice).toHaveBeenCalledWith({
      userId: 'u1',
      organizationId: 'org_1',
    });
  });

  // The worker boots headless with no Activity, so the app root never applies
  // the language: without this the failure line and the notification the
  // republish renders come out English for a user who chose another language.
  it('applies the stored language before it translates or republishes', async () => {
    mocks.language.getResolvedLanguage.mockReturnValue('ar');
    mocks.runGlanceableApprove.mockResolvedValue({ kind: 'retryable' });

    await handleApproveTask();

    expect(mocks.language.whenLanguagePreferenceLoaded).toHaveBeenCalledTimes(1);
    expect(i18n.language).toBe('ar');
    // The rendered line is the other language's copy, not the English one: the
    // switch happened before this task translated.
    const storedCopy = i18n.t(APPROVE_FAILED_KEY);
    expect(storedCopy).not.toBe(APPROVE_FAILED);
    expect(mocks.setGlanceableActionNotice).toHaveBeenCalledWith(storedCopy);
    // The republish renders the notification's title and action labels through
    // the same instance, so the switch precedes it too.
    const languageOrder = mocks.language.whenLanguagePreferenceLoaded.mock.invocationCallOrder[0];
    const noticeOrder = mocks.setGlanceableActionNotice.mock.invocationCallOrder[0];
    const refreshOrder = mocks.refreshGlanceableSnapshot.mock.invocationCallOrder[0];
    expect(languageOrder).toBeLessThan(noticeOrder ?? Number.POSITIVE_INFINITY);
    expect(languageOrder).toBeLessThan(refreshOrder ?? Number.POSITIVE_INFINITY);
  });

  it('clears the record and republishes when the ask is already gone', async () => {
    mocks.runGlanceableApprove.mockResolvedValue({ kind: 'gone' });

    await handleApproveTask();

    expect(mocks.recordWaitingAsk).toHaveBeenCalledTimes(1);
    expect(mocks.recordWaitingAsk).toHaveBeenCalledWith(null);
    expect(mocks.setGlanceableActionNotice).not.toHaveBeenCalled();
    expect(mocks.renderStoredSnapshotWithNotice).not.toHaveBeenCalled();
    expect(mocks.refreshGlanceableSnapshot).toHaveBeenCalledTimes(1);
  });

  it('republishes with no notice when there is no approvable ask', async () => {
    mocks.runGlanceableApprove.mockResolvedValue({ kind: 'none' });

    await handleApproveTask();

    expect(mocks.recordWaitingAsk).not.toHaveBeenCalled();
    expect(mocks.setGlanceableActionNotice).not.toHaveBeenCalled();
    expect(mocks.renderStoredSnapshotWithNotice).not.toHaveBeenCalled();
    expect(mocks.refreshGlanceableSnapshot).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no ask is recorded', async () => {
    mocks.readWaitingAsk.mockResolvedValue(null);

    await expect(handleApproveTask()).resolves.toBeUndefined();

    expect(mocks.runGlanceableApprove).not.toHaveBeenCalled();
    expect(mocks.refreshGlanceableSnapshot).not.toHaveBeenCalled();
  });

  it('treats a thrown approve error as retryable', async () => {
    mocks.runGlanceableApprove.mockRejectedValue(new Error('offline'));

    await expect(handleApproveTask()).resolves.toBeUndefined();

    expect(mocks.recordWaitingAsk).not.toHaveBeenCalled();
    expect(mocks.setGlanceableActionNotice).toHaveBeenCalledWith(APPROVE_FAILED);
    expect(mocks.renderStoredSnapshotWithNotice).toHaveBeenCalledWith({
      userId: 'u1',
      organizationId: 'org_1',
    });
    expect(mocks.refreshGlanceableSnapshot).toHaveBeenCalledTimes(1);
  });

  it('resolves without republishing when the record read itself throws', async () => {
    mocks.readWaitingAsk.mockRejectedValue(new Error('store unavailable'));

    await expect(handleApproveTask()).resolves.toBeUndefined();

    // No ask means no ids to render with and no Approve left to keep.
    expect(mocks.renderStoredSnapshotWithNotice).not.toHaveBeenCalled();
    expect(mocks.refreshGlanceableSnapshot).not.toHaveBeenCalled();
  });

  it('resolves when the republish itself fails', async () => {
    mocks.refreshGlanceableSnapshot.mockRejectedValue(new Error('offline'));

    await expect(handleApproveTask()).resolves.toBeUndefined();
  });

  it('registers the Android sink so the republish reaches the notification', () => {
    expect(getGlanceableSinks()).toContain(mocks.sink);
  });
});

type Registration = { key: string; factory: () => unknown };

/**
 * Run the app entry with a stub `require`, so what it registered and when it
 * loaded the task module are observable without loading the native graph.
 */
function evaluateEntry(platform: string): {
  registrations: Registration[];
  required: string[];
} {
  const required: string[] = [];
  const registrations: Registration[] = [];
  const requireFn = (id: string): unknown => {
    required.push(id);
    switch (id) {
      case 'react-native': {
        return {
          Platform: { OS: platform },
          AppRegistry: {
            registerHeadlessTask: (key: string, factory: () => unknown): void => {
              registrations.push({ key, factory });
            },
          },
        };
      }
      case 'react-native-android-widget': {
        return { registerWidgetTaskHandler: (): void => undefined };
      }
      case './src/glanceable-android/register': {
        return { handleWidgetTask: (): void => undefined };
      }
      case './src/glanceable-android/approve-task': {
        return { APPROVE_HEADLESS_TASK_KEY, handleApproveTask };
      }
      case 'expo-router/entry': {
        return {};
      }
      default: {
        throw new Error(`The entry required an unexpected module: ${id}`);
      }
    }
  };
  runInNewContext(ENTRY_SOURCE, { require: requireFn });
  return { registrations, required };
}

describe('the headless task key', () => {
  it('is the key the entry registers and the worker starts, and loads the task only when it fires', () => {
    expect(APPROVE_HEADLESS_TASK_KEY).toBe('KiloActiveAgentsApprove');
    // Only the string crosses into Kotlin; the worker's `TASK_NAME` and the
    // entry's literal must name the same task.
    expect(WORKER_SOURCE).toContain(`TASK_NAME = "${APPROVE_HEADLESS_TASK_KEY}"`);

    const android = evaluateEntry('android');

    expect(android.registrations.map(registration => registration.key)).toEqual([
      APPROVE_HEADLESS_TASK_KEY,
    ]);
    // The module stays out of the entry graph, like the widget slice: loading it
    // at entry would start i18n before `expo-router/entry`.
    expect(android.required).not.toContain('./src/glanceable-android/approve-task');

    const [registration] = android.registrations;
    expect(registration).toBeDefined();
    expect(registration?.factory()).toBe(handleApproveTask);
    expect(android.required).toContain('./src/glanceable-android/approve-task');
  });

  it('registers no headless task off Android', () => {
    const ios = evaluateEntry('ios');

    expect(ios.registrations).toEqual([]);
    expect(ios.required).not.toContain('./src/glanceable-android/approve-task');
  });
});
