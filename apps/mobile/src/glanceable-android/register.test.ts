/* eslint-disable max-lines -- one cohesive headless widget-task suite; comments carry the layout reasoning */
import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  collectText,
  NOW,
  runWidgetClickTask,
  runWidgetTask,
  secureStore,
  snapshotFor,
  store,
} from './register.test-helpers';

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
      // The sink's restart adoption reads the durable posted-channel marker;
      // this suite never posts a card, so the marker is absent.
      getPostedChannel: () => null,
      end: vi.fn(),
    },
    getDeadline: () => deadline,
    resetNativeState: () => {
      snapshot = null;
      deadline = 0;
    },
    language: { value: 'en' },
    runWidgetAction: vi.fn(),
    linking: { openURL: vi.fn().mockResolvedValue(undefined) },
  };
});

// The action core is native (tRPC, SecureStore, drafts); this suite covers the
// headless dispatch and the redraw around it. The two pure feedback mappers ride
// along so the dispatch reads them, and `lib/glanceable/widget-actions.test.ts`
// proves the real pair.
vi.mock('@/lib/glanceable/widget-actions', () => ({
  runWidgetAction: mocks.runWidgetAction,
  runningFeedback: (action: string) => (action === 'approve' ? 'approving' : 'starting'),
  failureFeedback: (action: string) => (action === 'approve' ? 'couldNotApprove' : 'couldNotStart'),
}));

vi.mock('expo', () => ({ requireOptionalNativeModule: () => mocks.native }));
// The widget task resolves the language itself; the real store needs natives.
vi.mock('@/lib/hooks/use-language-preference', () => ({
  getResolvedLanguage: () => mocks.language.value,
  whenLanguagePreferenceLoaded: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('react-native', () => ({
  AppState: { addEventListener: vi.fn() },
  Alert: { alert: vi.fn() },
  Linking: { openSettings: vi.fn(), openURL: mocks.linking.openURL },
}));
vi.mock('react-native-android-widget', () => ({
  requestWidgetUpdate: vi.fn().mockResolvedValue(undefined),
  FlexWidget: () => null,
  TextWidget: () => null,
  ImageWidget: () => null,
}));

async function registerAfterRestart(snapshot: GlanceableAgentsSnapshot | null) {
  const persist = await import('@/lib/glanceable/persist');
  persist._setSecureStoreForTests(secureStore);
  if (snapshot !== null) {
    persist.persistGlanceableSink.publish(snapshot);
  }

  // Keep only native storage across the simulated JS process restart.
  vi.resetModules();
  const freshPersist = await import('@/lib/glanceable/persist');
  freshPersist._setSecureStoreForTests(secureStore);
  const { handleWidgetTask } = await import('./register');
  return handleWidgetTask;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.resetNativeState();
  store.clear();
  secureStore.getItemAsync.mockReset().mockImplementation(async key => {
    await Promise.resolve();
    return store.get(key) ?? null;
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

// A widget redraw runs headless: nothing else applies the language.
it('applies the resolved language before it renders', async () => {
  mocks.language.value = 'ar';
  const handler = await registerAfterRestart(snapshotFor());
  const { i18n } = await import('@/i18n');

  await runWidgetTask(handler, 250);
  mocks.language.value = 'en';

  expect(i18n.language).toBe('ar');
});

describe.each([120, 250])('registered widget handler at %d dp', width => {
  it('restores unexpired persisted counts after a fresh process starts', async () => {
    const handler = await registerAfterRestart(snapshotFor());
    const rendered = await runWidgetTask(handler, width);
    // Two agents wait, so the widget offers the in-place approval under the
    // counts (and in its reserved newest line, which is empty here).
    const expected = ['2', 'Needs input', '2', 'Working', '0', 'Scheduled', '0', 'Idle', 'Approve'];

    expect(collectText(rendered.light)).toEqual(expected);
    expect(collectText(rendered.dark)).toEqual(expected);
    expect(rendered.light.props).toMatchObject({
      clickAction: 'OPEN_URI',
      clickActionData: { uri: 'kiloapp:///cloud/sessions' },
    });
  });

  it.each([
    ['happy', 0],
    ['happy', 1],
    ['stale', 0],
    ['stale', 1],
  ] as const)('hides %s counts %d ms after expiry', async (status, elapsed) => {
    const stored = snapshotFor(undefined, status);
    const handler = await registerAfterRestart(stored);
    vi.setSystemTime(Date.parse(stored.expiresAt) + elapsed);

    const rendered = await runWidgetTask(handler, width);

    expect(collectText(rendered.light)).toEqual(['Status expired']);
    expect(collectText(rendered.dark)).toEqual(['Status expired']);
  });

  it('renders the existing placeholder when no snapshot is persisted', async () => {
    const handler = await registerAfterRestart(null);

    const rendered = await runWidgetTask(handler, width);

    expect(collectText(rendered.light)).toEqual(['No work in progress']);
    expect(collectText(rendered.dark)).toEqual(['No work in progress']);
  });

  it('renders the existing placeholder when native storage cannot be read', async () => {
    const handler = await registerAfterRestart(snapshotFor());
    secureStore.getItemAsync.mockRejectedValueOnce(new Error('SecureStore unavailable'));

    const rendered = await runWidgetTask(handler, width);

    expect(collectText(rendered.light)).toEqual(['No work in progress']);
    expect(collectText(rendered.dark)).toEqual(['No work in progress']);
  });

  it.each([
    ['privacy', 'Open Kilo to see agents'],
    ['signed_out', 'Sign in to see agents'],
  ] as const)('preserves the %s blank even after expiry', async (status, copy) => {
    const stored = snapshotFor([], status);
    const handler = await registerAfterRestart(stored);
    vi.setSystemTime(Date.parse(stored.expiresAt) + 1);

    const rendered = await runWidgetTask(handler, width);

    expect(collectText(rendered.light)).toEqual([copy]);
    expect(collectText(rendered.dark)).toEqual([copy]);
  });

  it('prefers newer live widget props to the persisted snapshot', async () => {
    const stored = snapshotFor();
    const handler = await registerAfterRestart(stored);
    const { androidSink } = await import('./android-sink');
    androidSink.publish({
      ...snapshotFor([{ status: 'busy' }]),
      revision: stored.revision + 1,
    });

    const rendered = await runWidgetTask(handler, width);
    const expected = ['0', 'Needs input', '1', 'Working', '0', 'Scheduled', '0', 'Idle'];

    expect(collectText(rendered.light)).toEqual(expected);
    expect(collectText(rendered.dark)).toEqual(expected);
  });

  it('re-reads native state when an old expiry task reaches newer work', async () => {
    const old = snapshotFor();
    const handler = await registerAfterRestart(old);
    const { androidSink } = await import('./android-sink');
    androidSink.publish(old);
    const newer = buildGlanceableSnapshot({
      sessions: [{ status: 'busy' }],
      userId: 'u2',
      organizationId: null,
      now: NOW + 60_000,
      previousRevision: old.revision,
    });
    mocks.native.setWidgetSnapshot(JSON.stringify(newer), Date.parse(newer.expiresAt));
    vi.setSystemTime(Date.parse(old.expiresAt));

    const rendered = await runWidgetTask(handler, width);
    const expected = ['0', 'Needs input', '1', 'Working', '0', 'Scheduled', '0', 'Idle'];
    expect(collectText(rendered.light)).toEqual(expected);
    expect(collectText(rendered.dark)).toEqual(expected);
  });

  it.each([
    ['privacy', 'Open Kilo to see agents'],
    ['signed_out', 'Sign in to see agents'],
  ] as const)('reads a native %s blank instead of stale legacy storage', async (status, copy) => {
    const old = snapshotFor();
    const handler = await registerAfterRestart(old);
    mocks.native.setWidgetSnapshot(JSON.stringify(snapshotFor([], status)), 0);
    vi.setSystemTime(Date.parse(old.expiresAt));

    const rendered = await runWidgetTask(handler, width);
    expect(collectText(rendered.light)).toEqual([copy]);
    expect(collectText(rendered.dark)).toEqual([copy]);
    expect(mocks.getDeadline()).toBe(0);
  });

  it.each(['happy', 'stale'] as const)(
    'renders native %s state after a JS reload without extending its expiry',
    async status => {
      const snapshot = snapshotFor(undefined, status);
      const expiresAt = Date.parse(snapshot.expiresAt);
      mocks.native.setWidgetSnapshot(JSON.stringify(snapshot), expiresAt);
      vi.setSystemTime(NOW + 7_200_000);
      const handler = await registerAfterRestart(null);

      const current = await runWidgetTask(handler, width);
      expect(collectText(current.light)).toEqual(expect.arrayContaining(['2', 'Needs input']));
      expect(collectText(current.dark)).toEqual(expect.arrayContaining(['2', 'Needs input']));
      expect(mocks.getDeadline()).toBe(expiresAt);

      vi.setSystemTime(expiresAt);
      const reloaded = await registerAfterRestart(null);
      const expired = await runWidgetTask(reloaded, width);
      expect(collectText(expired.light)).toEqual(['Status expired']);
      expect(collectText(expired.dark)).toEqual(['Status expired']);
    }
  );

  it('expires counts in an already-running handler without a JavaScript timer', async () => {
    const snapshot = snapshotFor();
    const handler = await registerAfterRestart(snapshot);
    await runWidgetTask(handler, width);
    expect(mocks.getDeadline()).toBe(Date.parse(snapshot.expiresAt));
    vi.setSystemTime(Date.parse(snapshot.expiresAt));

    const rendered = await runWidgetTask(handler, width);
    expect(collectText(rendered.light)).toEqual(['Status expired']);
    expect(collectText(rendered.dark)).toEqual(['Status expired']);
  });

  it.each([
    ['invalid JSON', '{'],
    ['missing fields', JSON.stringify({ status: 'happy' })],
    ['negative counts', JSON.stringify({ ...snapshotFor(), running: -1 })],
  ])('rejects a native snapshot with %s', async (_reason, raw) => {
    const handler = await registerAfterRestart(null);
    mocks.native.setWidgetSnapshot(raw, 0);

    const rendered = await runWidgetTask(handler, width);
    expect(collectText(rendered.light)).toEqual(['No work in progress']);
    expect(collectText(rendered.dark)).toEqual(['No work in progress']);
  });

  it('keeps live widget props published while restoration is pending', async () => {
    const stored = snapshotFor();
    const handler = await registerAfterRestart(stored);
    const { androidSink } = await import('./android-sink');
    const read = Promise.withResolvers<string | null>();
    secureStore.getItemAsync.mockReturnValueOnce(read.promise);

    const rendering = runWidgetTask(handler, width);
    androidSink.publish({
      ...snapshotFor([{ status: 'busy' }]),
      revision: stored.revision + 1,
    });
    read.resolve(JSON.stringify(stored));
    const rendered = await rendering;
    const expected = ['0', 'Needs input', '1', 'Working', '0', 'Scheduled', '0', 'Idle'];

    expect(collectText(rendered.light)).toEqual(expected);
    expect(collectText(rendered.dark)).toEqual(expected);
  });

  it('runs the approve action headlessly and redraws around it', async () => {
    mocks.runWidgetAction.mockResolvedValue({ kind: 'approved' });
    const handler = await registerAfterRestart(snapshotFor());

    const renders = await runWidgetClickTask(handler, width, 'approve');

    expect(mocks.runWidgetAction).toHaveBeenCalledWith('approve');
    expect(renders).toHaveLength(2);
    const [inFlight, settledRender] = renders;
    // The request goes out with the progress line already drawn...
    expect(collectText(inFlight?.light)).toContain('Approving…');
    // ...and the redraw after it drops the line without moving the rows.
    const settled = collectText(settledRender?.light);
    expect(settled).not.toContain('Approving…');
    expect(settled).toEqual([
      '2',
      'Needs input',
      '2',
      'Working',
      '0',
      'Scheduled',
      '0',
      'Idle',
      'Approve',
    ]);
    expect(settledRender?.light.props).toMatchObject({
      clickAction: 'OPEN_URI',
      clickActionData: { uri: 'kiloapp:///cloud/sessions' },
    });
  });

  it('redraws the republished counts after a successful approve', async () => {
    // A successful action republishes the tray through the sink, which writes
    // the new snapshot to native storage; the redraw must read that instead of
    // the snapshot this task started with.
    const approved = buildGlanceableSnapshot({
      sessions: [{ status: 'busy' }],
      userId: 'u1',
      organizationId: null,
      now: NOW,
      previousRevision: 2,
    });
    mocks.runWidgetAction.mockImplementation(async () => {
      await Promise.resolve();
      mocks.native.setWidgetSnapshot(JSON.stringify(approved), Date.parse(approved.expiresAt));
      return { kind: 'approved' };
    });
    const handler = await registerAfterRestart(snapshotFor());

    const renders = await runWidgetClickTask(handler, width, 'approve');

    expect(collectText(renders.at(-1)?.light)).toEqual([
      '0',
      'Needs input',
      '1',
      'Working',
      '0',
      'Scheduled',
      '0',
      'Idle',
    ]);
  });

  it('runs the new-agent action headlessly, from the progress line to the counts', async () => {
    // A successful create republishes the tray through the sink, which writes
    // the new snapshot to native storage; the settled redraw reads that instead
    // of the empty snapshot this task started with.
    const created = buildGlanceableSnapshot({
      sessions: [{ status: 'busy' }],
      userId: 'u1',
      organizationId: null,
      now: NOW,
      previousRevision: 2,
    });
    mocks.runWidgetAction.mockImplementation(async () => {
      await Promise.resolve();
      mocks.native.setWidgetSnapshot(JSON.stringify(created), Date.parse(created.expiresAt));
      return { kind: 'created' };
    });
    const handler = await registerAfterRestart(snapshotFor([], 'empty'));

    const renders = await runWidgetClickTask(handler, width, 'new-agent');

    expect(mocks.runWidgetAction).toHaveBeenCalledWith('new-agent');
    // The request goes out with the create's progress line already drawn...
    expect(collectText(renders[0]?.light)).toContain('Starting…');
    // ...and the settled redraw drops it for the republished counts.
    expect(collectText(renders.at(-1)?.light)).toEqual([
      '0',
      'Needs input',
      '1',
      'Working',
      '0',
      'Scheduled',
      '0',
      'Idle',
    ]);
  });

  it('keeps New agent offered and says so when the create fails', async () => {
    mocks.runWidgetAction.mockResolvedValue({ kind: 'failed' });
    const handler = await registerAfterRestart(snapshotFor([], 'empty'));

    const renders = await runWidgetClickTask(handler, width, 'new-agent');

    expect(collectText(renders[0]?.light)).toContain('Starting…');
    // The empty surface is the one that offers the create, so its reserved slot
    // owns the failure and the row stays offered as the retry.
    expect(collectText(renders.at(-1)?.light)).toEqual([
      'No agents waiting',
      'Could not start',
      'New agent',
    ]);
    // A failure stays on the widget, whose retry row and body tap remain.
    expect(mocks.linking.openURL).not.toHaveBeenCalled();
  });

  it('keeps Approve offered and says so when the approve call fails', async () => {
    mocks.runWidgetAction.mockResolvedValue({ kind: 'failed' });
    const handler = await registerAfterRestart(snapshotFor());

    const renders = await runWidgetClickTask(handler, width, 'approve');

    expect(collectText(renders.at(-1)?.light)).toEqual([
      '2',
      'Needs input',
      '2',
      'Working',
      '0',
      'Scheduled',
      '0',
      'Idle',
      'Could not approve',
      'Approve',
    ]);
    // A failure stays on the widget, whose retry row and body tap remain.
    expect(mocks.linking.openURL).not.toHaveBeenCalled();
  });

  it.each([
    ['none', 'kiloapp:///cloud/sessions'],
    ['no-permission', 'kiloapp:///cloud/sessions'],
  ] as const)(
    'opens the agents list when approve cannot answer (%s)',
    async (kind, expectedUri) => {
      mocks.runWidgetAction.mockResolvedValue({ kind });
      const handler = await registerAfterRestart(snapshotFor());

      await runWidgetClickTask(handler, width, 'approve');

      expect(mocks.linking.openURL).toHaveBeenCalledWith(expectedUri);
    }
  );

  it('opens the new-session screen when the create has nothing to start from', async () => {
    mocks.runWidgetAction.mockResolvedValue({ kind: 'none' });
    const handler = await registerAfterRestart(snapshotFor([], 'empty'));

    const renders = await runWidgetClickTask(handler, width, 'new-agent');

    // The create ran from its progress line, and `none` is not a failure: the
    // widget leaves no error copy behind while it hands the user to the app.
    expect(collectText(renders[0]?.light)).toContain('Starting…');
    expect(collectText(renders.at(-1)?.light)).toEqual(['No agents waiting', 'New agent']);
    expect(mocks.linking.openURL).toHaveBeenCalledWith('kiloapp://agent-chat/new');
  });

  it.each(['approved', 'created'] as const)(
    'never opens the app after a completed action (%s)',
    async kind => {
      mocks.runWidgetAction.mockResolvedValue({ kind });
      const handler = await registerAfterRestart(
        kind === 'approved' ? snapshotFor() : snapshotFor([], 'empty')
      );

      await runWidgetClickTask(handler, width, kind === 'approved' ? 'approve' : 'new-agent');

      expect(mocks.linking.openURL).not.toHaveBeenCalled();
    }
  );

  it('renders normally when a click action belongs to no widget row', async () => {
    const handler = await registerAfterRestart(snapshotFor());

    const renders = await runWidgetClickTask(handler, width, 'OPEN_URI');

    expect(mocks.runWidgetAction).not.toHaveBeenCalled();
    expect(renders).toHaveLength(1);
    expect(collectText(renders[0]?.light)).toContain('Needs input');
  });
});
