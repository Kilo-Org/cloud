/* eslint-disable max-lines, eslint-plugin-import/no-nodejs-modules, eslint-plugin-unicorn/prefer-module -- one cohesive approve-task suite, and the entry, the Kotlin worker and the Kotlin service are sources: running/reading them from disk is the only way to see the registered keys */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { type SupportedLanguage } from '@/i18n/languages';
import { type GlanceableApproveResult } from '@/lib/glanceable/approve-ask';
import { getGlanceableSinks } from '@/lib/glanceable/sink-registry';
import { type WaitingAsk } from '@/lib/glanceable/waiting-ask';

import { type ApproveRunner } from './approve-task';

const ASK: WaitingAsk = {
  kiloSessionId: 'ses_1',
  status: 'permission',
  isCloudAgent: true,
  scopeKey: 'scope-key',
  organizationId: 'org_1',
  userId: 'u1',
  recordedAt: 1_750_000_000_000,
};

const mocks = vi.hoisted(() => {
  const order: string[] = [];
  const tasks = new Map<string, () => Promise<void>>();
  return {
    readWaitingAsk: vi.fn<() => Promise<WaitingAsk | null>>(),
    recordWaitingAsk: vi.fn<(ask: WaitingAsk | null) => void>(),
    runGlanceableApprove: vi.fn<() => Promise<GlanceableApproveResult>>(),
    refreshGlanceableSnapshot: vi.fn<() => Promise<void>>(),
    setGlanceableActionNotice: vi.fn<(notice: string | null) => void>(),
    renderStoredSnapshotWithNotice:
      vi.fn<(ctx: { userId: string; organizationId: string | null }) => void | Promise<void>>(),
    language: {
      whenLanguagePreferenceLoaded: vi.fn<() => Promise<void>>(),
      getResolvedLanguage: vi.fn<() => SupportedLanguage>(),
    },
    sink: {
      publish: vi.fn(),
      endImmediate: vi.fn(),
      startOrUpdate: vi.fn(),
    },
    order,
    tasks,
    applyWidgetLanguage: vi.fn(async () => {
      await Promise.resolve();
      order.push('language');
    }),
    approveFrontAgent: vi.fn(async () => {
      await Promise.resolve();
      order.push('approve');
    }),
    registerHeadlessTask: vi.fn((key: string, provider: () => () => Promise<void>) => {
      tasks.set(key, provider());
    }),
  };
});

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

// The task must run with no Activity and no rendered tree: AppRegistry is the
// only React Native surface reachable here, so a renderer dependency would fail
// this suite.
vi.mock('react-native', () => ({
  AppRegistry: { registerHeadlessTask: mocks.registerHeadlessTask },
}));

// The widget slice's language step is imported on task fire; stub it so the
// headless flow is observed without loading the widget sink.
vi.mock('./register', () => ({ applyWidgetLanguage: mocks.applyWidgetLanguage }));
vi.mock('@/lib/glanceable/approve-front-agent', () => ({
  approveFrontAgent: mocks.approveFrontAgent,
}));

const {
  APPROVE_AGENT_TASK_KEY,
  APPROVE_HEADLESS_TASK_KEY,
  handleApproveTask,
  registerApproveTask,
  runApproveTask,
} = await import('./approve-task');

/** The catalog key for the retryable line, and the copy this slice must show. */
const APPROVE_FAILED_KEY = 'glanceable.approveFailed';
const APPROVE_FAILED = "Couldn't approve. Tap Approve to try again.";
const NATIVE_SOURCE_DIR = join(
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
  'activeagentsliveupdate'
);
const WORKER_SOURCE = readFileSync(join(NATIVE_SOURCE_DIR, 'ActiveAgentsApproveWorker.kt'), 'utf8');
const SERVICE_SOURCE = readFileSync(
  join(NATIVE_SOURCE_DIR, 'ActiveAgentsApproveTaskService.kt'),
  'utf8'
);
const ENTRY_SOURCE = readFileSync(join(__dirname, '..', '..', 'index.js'), 'utf8');

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  mocks.tasks.clear();
  mocks.language.whenLanguagePreferenceLoaded.mockResolvedValue(undefined);
  mocks.language.getResolvedLanguage.mockReturnValue('en');
  mocks.readWaitingAsk.mockResolvedValue(ASK);
  mocks.runGlanceableApprove.mockResolvedValue({ kind: 'approved' });
  mocks.refreshGlanceableSnapshot.mockResolvedValue(undefined);
  // The language case switches the shared instance; every other case is English.
  await i18n.changeLanguage('en');
});

/** A promise a case releases by hand, so a task's await on it is observable. */
function deferredRender(): { promise: Promise<void>; release: () => void } {
  let storedResolve: (() => void) | undefined = undefined;
  const promise = new Promise<void>(resolve => {
    storedResolve = resolve;
  });
  return {
    promise,
    release: () => {
      storedResolve?.();
    },
  };
}

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

  it('waits for the failure line before it republishes and finishes', async () => {
    mocks.runGlanceableApprove.mockResolvedValue({ kind: 'retryable' });
    const firstRender = deferredRender();
    mocks.renderStoredSnapshotWithNotice.mockImplementationOnce(async () => {
      await firstRender.promise;
    });

    const pending = handleApproveTask();
    // The task must not republish, let alone resolve, while the first draw is
    // still in flight: the headless process would exit with the line unshown.
    await vi.waitFor(() => {
      expect(mocks.renderStoredSnapshotWithNotice).toHaveBeenCalledTimes(1);
    });
    expect(mocks.refreshGlanceableSnapshot).not.toHaveBeenCalled();

    firstRender.release();
    await pending;

    expect(mocks.refreshGlanceableSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.renderStoredSnapshotWithNotice).toHaveBeenCalledTimes(2);
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

/** The injected approval: resolved or rejected, never reaching the outcome. */
const approveThatResolves = (): ApproveRunner => vi.fn().mockResolvedValue(undefined);

describe('runApproveTask', () => {
  it('applies the stored language before it approves', async () => {
    const approve = vi.fn(async () => {
      await Promise.resolve();
      mocks.order.push('approve');
    });

    await runApproveTask(approve);

    expect(mocks.order).toEqual(['language', 'approve']);
  });

  it('finishes the task when the approval fails', async () => {
    const approve = vi.fn().mockRejectedValue(new Error('permission response rejected'));

    await expect(runApproveTask(approve)).resolves.toBeUndefined();
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it('still approves when the language cannot be applied', async () => {
    mocks.applyWidgetLanguage.mockRejectedValueOnce(new Error('SecureStore unavailable'));
    const approve = approveThatResolves();

    await expect(runApproveTask(approve)).resolves.toBeUndefined();
    expect(approve).toHaveBeenCalledTimes(1);
  });
});

describe('registerApproveTask', () => {
  it('registers the task under the key the Kotlin service starts', async () => {
    registerApproveTask();

    expect(mocks.registerHeadlessTask).toHaveBeenCalledTimes(1);
    expect(mocks.registerHeadlessTask.mock.calls[0]?.[0]).toBe(APPROVE_AGENT_TASK_KEY);

    await mocks.tasks.get(APPROVE_AGENT_TASK_KEY)?.();

    expect(mocks.order).toEqual(['language', 'approve']);
    expect(mocks.approveFrontAgent).toHaveBeenCalledTimes(1);
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
        return {
          APPROVE_HEADLESS_TASK_KEY,
          APPROVE_AGENT_TASK_KEY,
          handleApproveTask,
          // The entry registers the task-service chain through this call; the
          // stub records the key it would register.
          registerApproveTask: (): void => {
            registrations.push({ key: APPROVE_AGENT_TASK_KEY, factory: () => undefined });
          },
        };
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

describe('the headless task keys', () => {
  it('registers both Approve tasks when the platform is android', () => {
    expect(APPROVE_HEADLESS_TASK_KEY).toBe('KiloActiveAgentsApprove');
    // Only the string crosses into Kotlin; the worker's `TASK_NAME` and the
    // entry's literal must name the same task.
    expect(WORKER_SOURCE).toContain(`TASK_NAME = "${APPROVE_HEADLESS_TASK_KEY}"`);

    const android = evaluateEntry('android');

    expect(android.registrations.map(registration => registration.key)).toEqual([
      APPROVE_HEADLESS_TASK_KEY,
      APPROVE_AGENT_TASK_KEY,
    ]);
    const [workerRegistration] = android.registrations;
    expect(workerRegistration?.factory()).toBe(handleApproveTask);
    // `registerApproveTask` requires the module at entry, so the widget-style
    // `require` inside the factory above is not what loads it; the entry always
    // has it loaded by the time a task fires.
    expect(android.required).toContain('./src/glanceable-android/approve-task');
  });

  it('names the key the headless task service starts', () => {
    expect(APPROVE_AGENT_TASK_KEY).toBe('ActiveAgentsApprove');
    expect(SERVICE_SOURCE).toContain(`TASK_KEY = "${APPROVE_AGENT_TASK_KEY}"`);
  });

  it('registers no headless task off Android', () => {
    const ios = evaluateEntry('ios');

    expect(ios.registrations).toEqual([]);
    expect(ios.required).not.toContain('./src/glanceable-android/approve-task');
  });
});

/** One member's source, so a lifecycle claim is asserted where it lives. */
function workerMember(header: string): string {
  const escaped = header.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  return new RegExp(`${escaped}[\\s\\S]*?\\n  \\}`).exec(WORKER_SOURCE)?.[0] ?? '';
}

describe('the headless worker lifecycle', () => {
  it('resolves the worker and detaches its listener when it is stopped', () => {
    const onStopped = workerMember('override fun onStopped()');

    // WorkManager must not be left with a future that never completes: a stop
    // can land before the ReactContext initializes, or before the task finishes.
    expect(onStopped).toContain('completer?.set(Result.failure())');
    // The ReactHost is shared and outlives the worker, so the stop path has to
    // remove the pending listener it added.
    expect(onStopped).toContain('detachReactInstanceListener()');
    expect(WORKER_SOURCE).toContain('host.removeReactInstanceEventListener(listener)');
  });

  it('holds the listener it attaches so a stop can detach it', () => {
    const startTask = workerMember('private fun startTask(reactHost: ReactHost)');

    expect(startTask).toContain('pendingReactHost = reactHost');
    expect(startTask).toContain('pendingListener = listener');
    expect(startTask).toContain('reactHost.addReactInstanceEventListener(listener)');
  });

  it('matches a task finish only against an id this worker started', () => {
    // `HeadlessJsTaskContext` numbers from 1, so 0 was never a real id and could
    // not tell "no task started" apart from a finish event.
    expect(WORKER_SOURCE).toContain('private const val NO_TASK_ID = -1');
    expect(WORKER_SOURCE).toContain('private var taskId = NO_TASK_ID');
    expect(WORKER_SOURCE).toContain('this.taskId != NO_TASK_ID && this.taskId == taskId');
  });
});
