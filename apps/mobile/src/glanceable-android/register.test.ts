import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { isValidElement, type ReactNode } from 'react';
import { type WidgetRepresentation, type WidgetTaskHandler } from 'react-native-android-widget';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  let snapshot: string | null = null;
  let deadline = 0;
  return {
    registerWidgetTaskHandler: vi.fn<(handler: WidgetTaskHandler) => void>(),
    native: {
      setWidgetSnapshot: (next: string, expiresAt: number) => {
        snapshot = next;
        deadline = expiresAt;
      },
      getWidgetSnapshot: () => snapshot,
      end: vi.fn(),
    },
    getDeadline: () => deadline,
    resetNativeState: () => {
      snapshot = null;
      deadline = 0;
    },
  };
});

vi.mock('expo', () => ({ requireOptionalNativeModule: () => mocks.native }));
vi.mock('react-native', () => ({
  AppState: { addEventListener: vi.fn() },
  Alert: { alert: vi.fn() },
  Linking: { openSettings: vi.fn() },
}));
vi.mock('react-native-android-widget', () => ({
  registerWidgetTaskHandler: mocks.registerWidgetTaskHandler,
  requestWidgetUpdate: vi.fn().mockResolvedValue(undefined),
  FlexWidget: () => null,
  TextWidget: () => null,
}));

const NOW = 1_750_000_000_000;
const store = new Map<string, string>();
const secureStore = {
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
    await Promise.resolve();
  }),
  getItemAsync: vi.fn<(key: string) => Promise<string | null>>(),
};

function snapshotFor(
  sessions: { status: string }[] = [
    { status: 'question' },
    { status: 'retry' },
    { status: 'busy' },
    { status: 'busy' },
  ],
  status: GlanceableAgentsSnapshot['status'] = 'happy'
): GlanceableAgentsSnapshot {
  return buildGlanceableSnapshot({
    sessions,
    status,
    userId: 'u1',
    organizationId: null,
    now: NOW,
  });
}

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
  await import('./register');
  const handler = mocks.registerWidgetTaskHandler.mock.lastCall?.[0];
  if (handler === undefined) {
    throw new Error('The widget task handler was not registered');
  }
  return handler;
}

async function runWidgetTask(handler: WidgetTaskHandler, width: number) {
  const renders: WidgetRepresentation[] = [];
  await handler({
    widgetAction: 'WIDGET_UPDATE',
    widgetInfo: {
      widgetName: 'ActiveAgentsWidget',
      widgetId: 1,
      width,
      height: 100,
      screenInfo: { screenWidthDp: 400, screenHeightDp: 800, density: 2, densityDpi: 320 },
    },
    renderWidget: widget => {
      renders.push(widget);
    },
  });
  const [rendered] = renders;
  if (rendered === undefined || !('light' in rendered)) {
    throw new Error('The widget task did not render its themed layouts');
  }
  return rendered;
}

function collectText(node: ReactNode): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((child: ReactNode) => collectText(child));
  }
  if (!isValidElement<{ text?: string; children?: ReactNode }>(node)) {
    return [];
  }
  const text = node.props.text === undefined ? [] : [node.props.text];
  return [...text, ...collectText(node.props.children)];
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

describe.each([120, 250])('registered widget handler at %d dp', width => {
  it('restores unexpired persisted counts after a fresh process starts', async () => {
    const handler = await registerAfterRestart(snapshotFor());
    const rendered = await runWidgetTask(handler, width);
    const expected =
      width === 120
        ? ['1 Needs input']
        : ['1 Needs input', '1 Reconnecting', '2 Running', 'Open agents'];

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
    ['privacy', 'Agents hidden'],
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
    androidSink.publish({ ...snapshotFor([{ status: 'busy' }]), revision: stored.revision + 1 });

    const rendered = await runWidgetTask(handler, width);
    const expected = width === 120 ? ['1 Running'] : ['1 Running', 'Open agents'];

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
    const expected = width === 120 ? ['1 Running'] : ['1 Running', 'Open agents'];
    expect(collectText(rendered.light)).toEqual(expected);
    expect(collectText(rendered.dark)).toEqual(expected);
  });

  it.each([
    ['privacy', 'Agents hidden'],
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
      expect(collectText(current.light)).toContain('1 Needs input');
      expect(collectText(current.dark)).toContain('1 Needs input');
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
    androidSink.publish({ ...snapshotFor([{ status: 'busy' }]), revision: stored.revision + 1 });
    read.resolve(JSON.stringify(stored));
    const rendered = await rendering;
    const expected = width === 120 ? ['1 Running'] : ['1 Running', 'Open agents'];

    expect(collectText(rendered.light)).toEqual(expected);
    expect(collectText(rendered.dark)).toEqual(expected);
  });
});
