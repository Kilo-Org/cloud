/* eslint-disable max-lines -- one cohesive headless widget-task suite; comments carry the layout reasoning */
// Dynamic imports deliberately exercise fresh JS process/module-loading boundaries.
import { type GlanceableAgentsSnapshot } from '@kilocode/app-shared/glanceable-agents-snapshot';
import { EMPTY_HOME_WIDGET_DETAILS } from '@kilocode/app-shared/home-widget';
import { type JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  collectControls,
  collectText,
  NOW,
  runWidgetClickTask,
  runWidgetTask,
  secureStore,
  snapshotFor,
  store,
} from './register.test-helpers';
vi.mock('expo-localization', () => ({
  getLocales: () => [{ languageTag: 'en-US' }],
  getCalendars: () => [{ uses24hourClock: false }],
}));

const mocks = vi.hoisted(() => {
  let snapshot: string | null = null;
  let deadline = 0;
  return {
    native: {
      setWidgetSnapshot: (next: string, expiresAt: number) => {
        snapshot = next;
        deadline = expiresAt;
      },
      getWidgetSnapshot: () => snapshot,
      getPostedChannel: () => null,
      end: vi.fn(),
      startOrUpdate: vi.fn(),
      update: vi.fn(),
    },
    getDeadline: () => deadline,
    resetNativeState: () => {
      snapshot = null;
      deadline = 0;
    },
    language: { value: 'en' },
    runWidgetApprove: vi.fn(),
    linking: { openURL: vi.fn().mockResolvedValue(undefined) },
    applyResponse: vi.fn(),
    refresh: { widgetsChanged: vi.fn(), isCurrent: vi.fn() },
    registerHeadlessTask: vi.fn(),
    getWidgetInfo: vi.fn(),
    requestById: vi.fn(),
  };
});

vi.mock('@/lib/glanceable/widget-actions', () => ({ runWidgetApprove: mocks.runWidgetApprove }));
vi.mock('@/lib/glanceable/home-widget-refresh', () => ({
  HomeWidgetRefresh: mocks.refresh,
  applyHomeWidgetResponse: mocks.applyResponse,
  restoreNativeHomeWidgetData: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('expo', () => ({ requireOptionalNativeModule: () => mocks.native }));
vi.mock('@/lib/hooks/use-language-preference', () => ({
  getResolvedLanguage: () => mocks.language.value,
  whenLanguagePreferenceLoaded: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('react-native', () => ({
  AppRegistry: { registerHeadlessTask: mocks.registerHeadlessTask },
  AppState: { addEventListener: vi.fn() },
  Alert: { alert: vi.fn() },
  Linking: { openSettings: vi.fn(), openURL: mocks.linking.openURL },
}));
vi.mock('react-native-android-widget', () => ({
  requestWidgetUpdate: vi.fn().mockResolvedValue(undefined),
  requestWidgetUpdateById: mocks.requestById,
  getWidgetInfo: mocks.getWidgetInfo,
  FlexWidget: () => null,
  ImageWidget: () => null,
  OverlapWidget: () => null,
  TextWidget: () => null,
}));

async function registerAfterRestart(snapshot: GlanceableAgentsSnapshot | null) {
  const persist = await import('@/lib/glanceable/persist');
  const home = await import('@/lib/glanceable/home-widget-data');
  persist._setSecureStoreForTests(secureStore);
  home._setHomeWidgetStoreForTests(secureStore);
  if (snapshot !== null) {
    persist.persistGlanceableSink.publish(snapshot);
    home.rememberHomeWidgetData({
      snapshot,
      details: { ...EMPTY_HOME_WIDGET_DETAILS, approvalKey: 'a'.repeat(64) },
    });
    await Promise.resolve();
  }
  vi.resetModules();
  const freshPersist = await import('@/lib/glanceable/persist');
  const freshHome = await import('@/lib/glanceable/home-widget-data');
  freshPersist._setSecureStoreForTests(secureStore);
  freshHome._setHomeWidgetStoreForTests(secureStore);
  return import('./register');
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.resetNativeState();
  store.clear();
  mocks.language.value = 'en';
  mocks.applyResponse.mockReset().mockResolvedValue(false);
  mocks.refresh.isCurrent.mockReset().mockResolvedValue(true);
  mocks.refresh.widgetsChanged.mockReset().mockResolvedValue(undefined);
  mocks.getWidgetInfo.mockReset().mockResolvedValue([]);
  mocks.requestById.mockReset().mockResolvedValue(undefined);
  mocks.runWidgetApprove.mockReset();
  // eslint-disable-next-line require-await -- mock returning a resolved promise
  secureStore.getItemAsync.mockReset().mockImplementation(async key => store.get(key) ?? null);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe.each([172, 360])('headless Home widget at %d dp', width => {
  it('restores counts and Home timestamps after a process restart', async () => {
    const { handleWidgetTask } = await registerAfterRestart(snapshotFor());
    const rendered = await runWidgetTask(handleWidgetTask, width);
    const text = collectText(rendered.light);
    expect(text).toEqual(expect.arrayContaining(['Kilo', '2', 'Needs input']));
    expect(collectControls(rendered.light)).toEqual(['Approve', 'New agent']);
    expect(text).not.toContain('0');
    expect(text.some(line => line.startsWith('Checked'))).toBe(true);
    expect(rendered.light.props).toMatchObject({
      clickActionData: { uri: 'kiloapp:///cloud/sessions' },
    });
  });

  it('retains counts beyond activity expiry without extending the original deadline', async () => {
    const stored = snapshotFor();
    mocks.native.setWidgetSnapshot(JSON.stringify(stored), Date.parse(stored.expiresAt));
    const { handleWidgetTask } = await registerAfterRestart(stored);
    vi.setSystemTime(Date.parse(stored.expiresAt) + 1);
    const rendered = await runWidgetTask(handleWidgetTask, width);
    expect(collectText(rendered.light)).toEqual(expect.arrayContaining(['2', 'Needs input']));
    expect(collectControls(rendered.light)).toContain('New agent');
    expect(collectText(rendered.light)).not.toContain('Status expired');
    expect(mocks.getDeadline()).toBe(Date.parse(stored.expiresAt));
  });

  it.each(['privacy', 'signed_out'] as const)(
    'prefers a native %s fence to older private storage',
    async status => {
      const old = snapshotFor();
      const { handleWidgetTask } = await registerAfterRestart(old);
      mocks.native.setWidgetSnapshot(JSON.stringify(snapshotFor([], status)), 0);
      const rendered = await runWidgetTask(handleWidgetTask, width);
      expect(collectText(rendered.light)).toContain(
        status === 'privacy' ? 'Open Kilo to see agents' : 'Sign in to see agents'
      );
      expect(collectText(rendered.light)).not.toContain('2');
      expect(collectControls(rendered.light)).toEqual([]);
    }
  );

  it.each(['{', JSON.stringify({ status: 'happy' })])(
    'rejects malformed native storage %s',
    async raw => {
      const { handleWidgetTask } = await registerAfterRestart(null);
      mocks.native.setWidgetSnapshot(raw, 0);
      const rendered = await runWidgetTask(handleWidgetTask, width);
      expect(collectText(rendered.light)).toContain('Sign in to see agents');
      expect(collectText(rendered.light)).not.toContain('2');
    }
  );

  it('rereads newer native data after an old alarm queues a task', async () => {
    const old = snapshotFor();
    const { handleWidgetTask } = await registerAfterRestart(old);
    const newer = {
      ...snapshotFor([{ status: 'busy' }]),
      updatedAt: new Date(NOW + 60_000).toISOString(),
      revision: old.revision + 1,
    };
    mocks.native.setWidgetSnapshot(JSON.stringify(newer), Date.parse(newer.expiresAt));
    const rendered = await runWidgetTask(handleWidgetTask, width);
    expect(collectText(rendered.light)).toEqual(expect.arrayContaining(['1', 'Working']));
    expect(collectText(rendered.light)).not.toContain('Needs input');
  });

  it('draws progress before approving and settles without opening an Activity', async () => {
    mocks.runWidgetApprove.mockResolvedValue({ kind: 'approved' });
    const { handleWidgetTask } = await registerAfterRestart(snapshotFor());
    const renders = await runWidgetClickTask(handleWidgetTask, width, 'approve');
    expect(mocks.runWidgetApprove).toHaveBeenCalledTimes(1);
    expect(renders).toHaveLength(2);
    // Small shows the in-flight dots in the Approve slot; Medium's pill reads "Approving…".
    if (width >= 266) {
      expect(collectText(renders[0]?.light)).toContain('Approving…');
    }
    expect(collectControls(renders[0]?.light)).not.toContain('Approve');
    expect(collectControls(renders[1]?.light)).toContain('Approve');
    expect(mocks.linking.openURL).not.toHaveBeenCalled();
  });

  it('keeps a retry control and failure copy when approval fails', async () => {
    mocks.runWidgetApprove.mockResolvedValue({ kind: 'failed' });
    const { handleWidgetTask } = await registerAfterRestart(snapshotFor());
    const renders = await runWidgetClickTask(handleWidgetTask, width, 'approve');
    const last = renders.at(-1)?.light;
    expect(collectText(last)).toContain(
      width >= 266 ? "Couldn't approve. Tap Approve to try again." : 'Could not approve'
    );
    expect(collectControls(last)).toEqual(['Approve', 'New agent']);
    expect(mocks.linking.openURL).not.toHaveBeenCalled();
  });

  it.each(['none', 'no-permission'])('opens agents when approval cannot answer %s', async kind => {
    mocks.runWidgetApprove.mockResolvedValue({ kind });
    const { handleWidgetTask } = await registerAfterRestart(snapshotFor());
    await runWidgetClickTask(handleWidgetTask, width, 'approve');
    expect(mocks.linking.openURL).toHaveBeenCalledWith('kiloapp:///cloud/sessions');
  });
});

it('applies the selected language before a headless render', async () => {
  mocks.language.value = 'ar';
  const { handleWidgetTask } = await registerAfterRestart(snapshotFor());
  await runWidgetTask(handleWidgetTask, 172);
  const { i18n } = await import('@/i18n');
  expect(i18n.language).toBe('ar');
});

const WIDGET = {
  widgetName: 'ActiveAgentsWidget',
  widgetId: 1,
  width: 172,
  height: 224,
  screenInfo: { screenWidthDp: 400, screenHeightDp: 800, density: 2, densityDpi: 320 },
};
const CONTEXT = {
  scopeKey: snapshotFor().scopeKey,
  accountEpoch: 1,
  generation: 'fence-generation',
};

describe('WorkManager Home-only refresh', () => {
  it('does not redraw a response rejected by the authenticated generation gate', async () => {
    const { handleHomeWidgetRefresh } = await registerAfterRestart(null);
    await handleHomeWidgetRefresh({ response: {}, ...CONTEXT });
    expect(mocks.getWidgetInfo).not.toHaveBeenCalled();
    expect(mocks.requestById).not.toHaveBeenCalled();
  });

  it('awaits each actual widget draw without starting an ongoing notification', async () => {
    const { handleHomeWidgetRefresh } = await registerAfterRestart(snapshotFor());
    const home = await import('@/lib/glanceable/home-widget-data');
    home.rememberHomeWidgetData({ snapshot: snapshotFor(), details: EMPTY_HOME_WIDGET_DETAILS });
    mocks.applyResponse.mockResolvedValue(true);
    mocks.getWidgetInfo.mockResolvedValue([WIDGET, { ...WIDGET, widgetId: 2 }]);
    const drawn: unknown[] = [];
    mocks.requestById.mockImplementation(
      async ({ renderWidget }: { renderWidget: (info: typeof WIDGET) => Promise<unknown> }) => {
        drawn.push(await renderWidget(WIDGET));
      }
    );
    await handleHomeWidgetRefresh({ response: {}, ...CONTEXT });
    expect(drawn).toHaveLength(2);
    expect(mocks.refresh.isCurrent).toHaveBeenCalledTimes(4);
    expect(mocks.native.startOrUpdate).not.toHaveBeenCalled();
    expect(mocks.native.update).not.toHaveBeenCalled();
  });

  it('checks the native generation again after widget enumeration', async () => {
    const { handleHomeWidgetRefresh } = await registerAfterRestart(snapshotFor());
    const home = await import('@/lib/glanceable/home-widget-data');
    home.rememberHomeWidgetData({ snapshot: snapshotFor(), details: EMPTY_HOME_WIDGET_DETAILS });
    mocks.applyResponse.mockResolvedValue(true);
    mocks.getWidgetInfo.mockResolvedValue([WIDGET]);
    mocks.refresh.isCurrent.mockResolvedValue(false);
    await handleHomeWidgetRefresh({ response: {}, ...CONTEXT });
    expect(mocks.requestById).not.toHaveBeenCalled();
  });

  it('cancels native scheduling when no widget remains', async () => {
    const { handleHomeWidgetRefresh } = await registerAfterRestart(snapshotFor());
    const home = await import('@/lib/glanceable/home-widget-data');
    home.rememberHomeWidgetData({ snapshot: snapshotFor(), details: EMPTY_HOME_WIDGET_DETAILS });
    mocks.applyResponse.mockResolvedValue(true);
    await handleHomeWidgetRefresh({ response: {}, ...CONTEXT });
    expect(mocks.refresh.widgetsChanged).toHaveBeenCalledOnce();
  });

  it('draws a neutral privacy refusal with no server response or private counts', async () => {
    const { handleHomeWidgetRefresh } = await registerAfterRestart(null);
    mocks.applyResponse.mockResolvedValue(true);
    mocks.getWidgetInfo.mockResolvedValue([WIDGET]);
    const rendered: string[] = [];
    mocks.requestById.mockImplementation(
      async ({
        renderWidget,
      }: {
        renderWidget: (info: typeof WIDGET) => Promise<{ light: JSX.Element }>;
      }) => {
        const representation = await renderWidget(WIDGET);
        rendered.push(...collectText(representation.light));
      }
    );
    await handleHomeWidgetRefresh({ terminal: 'privacy', ...CONTEXT });
    expect(mocks.applyResponse).toHaveBeenCalledWith({ terminal: 'privacy' }, CONTEXT);
    expect(rendered).toContain('Open Kilo to see agents');
    expect(rendered).not.toContain('2');
    expect(rendered).not.toContain('New agent');
  });
});

it('renders an authorized native/Home-only record even without any activity snapshot', async () => {
  const { handleWidgetTask } = await registerAfterRestart(null);
  const home = await import('@/lib/glanceable/home-widget-data');
  home.rememberHomeWidgetData({
    snapshot: snapshotFor([{ status: 'busy' }]),
    details: EMPTY_HOME_WIDGET_DETAILS,
  });
  const rendered = await runWidgetTask(handleWidgetTask, 172);
  expect(collectText(rendered.light)).toEqual(expect.arrayContaining(['1', 'Working']));
  expect(collectControls(rendered.light)).toEqual(['New agent']);
  expect(mocks.native.startOrUpdate).not.toHaveBeenCalled();
});

it('aborts an obsolete generation inside the final draw callback without an unhandled task failure', async () => {
  const { handleHomeWidgetRefresh } = await registerAfterRestart(null);
  const home = await import('@/lib/glanceable/home-widget-data');
  home.rememberHomeWidgetData({ snapshot: snapshotFor(), details: EMPTY_HOME_WIDGET_DETAILS });
  mocks.applyResponse.mockResolvedValue(true);
  mocks.getWidgetInfo.mockResolvedValue([WIDGET]);
  mocks.refresh.isCurrent.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  const drawn: unknown[] = [];
  mocks.requestById.mockImplementation(
    async ({ renderWidget }: { renderWidget: (info: typeof WIDGET) => Promise<unknown> }) => {
      drawn.push(await renderWidget(WIDGET));
    }
  );
  await handleHomeWidgetRefresh({ response: {}, ...CONTEXT });
  expect(drawn).toEqual([]);
  expect(mocks.refresh.isCurrent).toHaveBeenCalledTimes(2);
});

it('updates native widget membership without trying to draw a deleted widget', async () => {
  const { handleWidgetTask } = await registerAfterRestart(null);
  const renderWidget = vi.fn<(widgetComponent: unknown) => void>();
  await handleWidgetTask({ widgetInfo: WIDGET, widgetAction: 'WIDGET_DELETED', renderWidget });
  expect(mocks.refresh.widgetsChanged).toHaveBeenCalledOnce();
  expect(renderWidget).not.toHaveBeenCalled();
});

it('rereads the newly published tray after approval instead of reusing the tapped snapshot', async () => {
  const { handleWidgetTask } = await registerAfterRestart(snapshotFor());
  const home = await import('@/lib/glanceable/home-widget-data');
  const { androidSink } = await import('./android-sink');
  const approved = { ...snapshotFor([{ status: 'busy' }]), revision: 2 };
  // eslint-disable-next-line require-await -- mock returning a resolved promise
  mocks.runWidgetApprove.mockImplementation(async () => {
    home.rememberHomeWidgetSnapshot(approved);
    androidSink.publish(approved);
    return { kind: 'approved' };
  });
  const renders = await runWidgetClickTask(handleWidgetTask, 172, 'approve');
  expect(collectText(renders.at(-1)?.light)).toEqual(expect.arrayContaining(['1', 'Working']));
  expect(collectText(renders.at(-1)?.light)).not.toContain('Needs input');
  expect(collectControls(renders.at(-1)?.light)).not.toContain('Approve');
});
