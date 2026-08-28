/* eslint-disable max-lines -- one cohesive sink suite sharing the native + widget mock harness */
import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setGlanceableDelivery } from '@/lib/glanceable/sink-registry';

import {
  _resetAndroidSinkForTests,
  androidSink,
  getCurrentWidgetProps,
  handleAppStateActive,
} from './android-sink';
import { _setPermissionReaderForTests, type NotificationPermissionStatus } from './permission';
import { _resetAndroidPermissionAlertForTests } from './permission-alert';

const mocks = vi.hoisted(() => ({
  native: {
    isPromotionCapable: vi.fn(() => true),
    start: vi.fn(),
    update: vi.fn(),
    end: vi.fn(),
  },
  requestWidgetUpdate: vi.fn(),
  alert: vi.fn(),
}));

vi.mock('expo', () => ({
  requireOptionalNativeModule: () => mocks.native,
}));

// permission-alert statically imports react-native; stub it so the pure
// node test graph never parses react-native's Flow sources.
vi.mock('react-native', () => ({
  Alert: { alert: (...args: unknown[]) => mocks.alert(...args) },
  Linking: { openSettings: (): void => undefined },
}));

// The sink imports the widget layout, whose primitives are unreachable under
// vitest; stub them so only the sink logic runs.
vi.mock('react-native-android-widget', () => ({
  FlexWidget: () => null,
  TextWidget: () => null,
  requestWidgetUpdate: (...args: unknown[]) => mocks.requestWidgetUpdate(...args),
}));

const NOW = 1_750_000_000_000;
const CTX = { organizationId: null, userId: 'u1' };

const delivery = {
  registerTokens: vi.fn(),
  unregisterTokens: vi.fn().mockResolvedValue({ ok: true, tokens: [] }),
};

function snapshotFor(
  sessions: { status: string }[],
  revision = 0,
  status?: GlanceableAgentsSnapshot['status']
): GlanceableAgentsSnapshot {
  return buildGlanceableSnapshot({
    sessions,
    userId: 'u1',
    organizationId: null,
    now: NOW,
    previousRevision: revision,
    ...(status === undefined ? {} : { status }),
  });
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** A permission reader whose resolution the test controls by hand. */
function deferredPermission(): {
  promise: Promise<NotificationPermissionStatus>;
  resolve: (status: NotificationPermissionStatus) => void;
} {
  let storedResolve: ((status: NotificationPermissionStatus) => void) | undefined = undefined;
  const promise = new Promise<NotificationPermissionStatus>(resolve => {
    storedResolve = resolve;
  });
  return {
    promise,
    resolve: status => {
      storedResolve?.(status);
    },
  };
}

beforeEach(() => {
  _resetAndroidSinkForTests();
  _resetAndroidPermissionAlertForTests();
  // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
  _setPermissionReaderForTests(() => Promise.resolve('granted'));
  setGlanceableDelivery(delivery);
  delivery.registerTokens.mockClear();
  delivery.unregisterTokens.mockClear();
  mocks.native.isPromotionCapable.mockReturnValue(true);
  mocks.native.start.mockClear();
  mocks.native.update.mockClear();
  mocks.native.end.mockClear();
  mocks.requestWidgetUpdate.mockClear();
  mocks.alert.mockClear();
});

afterEach(() => {
  _setPermissionReaderForTests(null);
  vi.useRealTimers();
});

describe('androidSink start and update', () => {
  it('starts once and updates the same notification id on a newer revision with promotion', async () => {
    androidSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);
    await flushAsync();
    androidSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 1), CTX);
    await flushAsync();

    expect(mocks.native.start).toHaveBeenCalledTimes(1);
    expect(mocks.native.update).toHaveBeenCalledTimes(1);
    expect(mocks.native.start).toHaveBeenCalledWith(
      'Active agents',
      '1 Running',
      'Open agents',
      true
    );
    expect(mocks.native.update).toHaveBeenCalledWith(
      'Active agents',
      '1 Running',
      'Open agents',
      true
    );
  });

  it('passes promotion false when the device is not capable', async () => {
    mocks.native.isPromotionCapable.mockReturnValue(false);
    androidSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);
    await flushAsync();

    expect(mocks.native.start).toHaveBeenCalledTimes(1);
    expect(mocks.native.start).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      false
    );
  });

  it('does not start ongoing when notification permission is denied', async () => {
    // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
    _setPermissionReaderForTests(() => Promise.resolve('denied'));
    androidSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);
    await flushAsync();

    expect(mocks.native.start).not.toHaveBeenCalled();
    expect(mocks.native.update).not.toHaveBeenCalled();
  });

  it('does not post after endImmediate during an in-flight permission check', async () => {
    const deferred = deferredPermission();
    // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
    _setPermissionReaderForTests(() => deferred.promise);

    androidSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);
    await flushAsync();
    androidSink.endImmediate();
    deferred.resolve('granted');
    await flushAsync();

    expect(mocks.native.start).not.toHaveBeenCalled();
    expect(mocks.native.update).not.toHaveBeenCalled();
  });

  it('starts once permission is later granted for eligible work', async () => {
    // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
    _setPermissionReaderForTests(() => Promise.resolve('denied'));
    androidSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);
    await flushAsync();
    expect(mocks.native.start).not.toHaveBeenCalled();

    // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
    _setPermissionReaderForTests(() => Promise.resolve('granted'));
    androidSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 1), CTX);
    await flushAsync();
    expect(mocks.native.start).toHaveBeenCalledTimes(1);
  });

  it('discards an older revision without overwriting the latest', async () => {
    androidSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 4), CTX);
    await flushAsync();
    androidSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 5), CTX);
    await flushAsync();
    expect(mocks.native.start).toHaveBeenCalledTimes(1);
    expect(mocks.native.update).toHaveBeenCalledTimes(1);

    androidSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 4), CTX);
    await flushAsync();
    expect(mocks.native.update).toHaveBeenCalledTimes(1);
  });

  it('never starts for a waiting snapshot', async () => {
    androidSink.startOrUpdate(snapshotFor([], 0, 'waiting'), CTX);
    await flushAsync();

    expect(mocks.native.start).not.toHaveBeenCalled();
    expect(mocks.native.update).not.toHaveBeenCalled();
  });

  it('registers the android_ongoing token on a successful start', async () => {
    const snapshot = snapshotFor([{ status: 'busy' }], 0);
    androidSink.startOrUpdate(snapshot, CTX);
    await flushAsync();

    expect(delivery.registerTokens).toHaveBeenCalledTimes(1);
    expect(delivery.registerTokens).toHaveBeenCalledWith(snapshot, CTX.organizationId, CTX.userId);
    expect(delivery.unregisterTokens).not.toHaveBeenCalled();
  });

  it('does not register tokens when permission is denied', async () => {
    // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
    _setPermissionReaderForTests(() => Promise.resolve('denied'));
    androidSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);
    await flushAsync();

    expect(delivery.registerTokens).not.toHaveBeenCalled();
  });
});

describe('androidSink app-state retry', () => {
  it('restarts pending work and registers tokens once permission is granted', async () => {
    // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
    _setPermissionReaderForTests(() => Promise.resolve('denied'));
    const snapshot = snapshotFor([{ status: 'busy' }], 0);
    androidSink.startOrUpdate(snapshot, CTX);
    await flushAsync();
    expect(mocks.native.start).not.toHaveBeenCalled();

    // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
    _setPermissionReaderForTests(() => Promise.resolve('granted'));
    await handleAppStateActive();

    expect(mocks.native.start).toHaveBeenCalledTimes(1);
    expect(delivery.registerTokens).toHaveBeenCalledWith(snapshot, CTX.organizationId, CTX.userId);
  });

  it('does not restart pending work while permission is still denied', async () => {
    // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
    _setPermissionReaderForTests(() => Promise.resolve('denied'));
    androidSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);
    await flushAsync();

    await handleAppStateActive();

    expect(mocks.native.start).not.toHaveBeenCalled();
    expect(delivery.registerTokens).not.toHaveBeenCalled();
  });
});

describe('androidSink widget publish and end', () => {
  it('publishes the widget snapshot on every publish', () => {
    androidSink.publish(snapshotFor([{ status: 'busy' }], 0));

    expect(mocks.requestWidgetUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.requestWidgetUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ widgetName: 'ActiveAgentsWidget' })
    );
    expect(getCurrentWidgetProps()?.statusLine).toBeNull();
    expect(getCurrentWidgetProps()?.primaryCount).toBe(1);
  });

  it('blanks with privacy copy and dismisses the notification on end', async () => {
    androidSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);
    await flushAsync();
    expect(mocks.native.start).toHaveBeenCalledTimes(1);

    androidSink.publish(snapshotFor([], 1, 'privacy'));
    expect(getCurrentWidgetProps()?.statusLine).toBe('Agents hidden');
    expect(getCurrentWidgetProps()?.countLines).toEqual([]);
    expect(mocks.native.update).toHaveBeenCalledWith(
      'Active agents',
      'Agents hidden',
      'Open agents',
      true
    );

    androidSink.endImmediate();
    expect(mocks.native.end).toHaveBeenCalledTimes(1);
  });

  it('does not update the notification from publish before it has started', () => {
    androidSink.publish(snapshotFor([], 1, 'empty'));

    expect(mocks.native.start).not.toHaveBeenCalled();
    expect(mocks.native.update).not.toHaveBeenCalled();
  });

  it('dismisses a leftover native notification for an ineligible snapshot', () => {
    androidSink.publish(snapshotFor([], 1, 'empty'));

    expect(mocks.native.end).toHaveBeenCalledTimes(1);
  });

  it('keeps the widget truthful after end', () => {
    androidSink.publish(snapshotFor([{ status: 'busy' }], 0));
    expect(getCurrentWidgetProps()).not.toBeNull();

    androidSink.endImmediate();
    expect(mocks.native.end).toHaveBeenCalledTimes(1);
    expect(getCurrentWidgetProps()).not.toBeNull();
    expect(getCurrentWidgetProps()?.primaryCount).toBe(1);
  });

  it('unregisters the token on endImmediate', async () => {
    androidSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);
    await flushAsync();
    expect(delivery.registerTokens).toHaveBeenCalledTimes(1);

    androidSink.endImmediate();
    expect(delivery.unregisterTokens).toHaveBeenCalledTimes(1);
  });

  it('schedules a single future redraw at expiresAt with expired copy', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const snapshot = snapshotFor([{ status: 'busy' }], 0);

    androidSink.publish(snapshot);
    expect(mocks.requestWidgetUpdate).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(28_800_000);
    expect(mocks.requestWidgetUpdate).toHaveBeenCalledTimes(2);

    const secondCall = mocks.requestWidgetUpdate.mock.calls[1]?.[0] as
      | { renderWidget?: unknown }
      | undefined;
    expect(typeof secondCall?.renderWidget).toBe('function');

    expect(getCurrentWidgetProps()?.statusLine).toBe('Status expired');
    expect(getCurrentWidgetProps()?.countLines).toEqual([]);
    expect(getCurrentWidgetProps()?.primaryCount).toBe(0);
    expect(getCurrentWidgetProps()?.showOpenAgents).toBe(false);
  });
});

describe('handleAppStateActive permission alert', () => {
  it('shows the permission alert once for denied work when the app foregrounds', async () => {
    // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
    _setPermissionReaderForTests(() => Promise.resolve('denied'));
    androidSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);
    await flushAsync();
    expect(mocks.native.start).not.toHaveBeenCalled();

    await handleAppStateActive();
    expect(mocks.alert).toHaveBeenCalledTimes(1);

    await handleAppStateActive();
    expect(mocks.alert).toHaveBeenCalledTimes(1);
  });

  it('retries the pending start when permission is granted on foreground', async () => {
    // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
    _setPermissionReaderForTests(() => Promise.resolve('denied'));
    androidSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);
    await flushAsync();
    expect(mocks.native.start).not.toHaveBeenCalled();

    // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
    _setPermissionReaderForTests(() => Promise.resolve('granted'));
    await handleAppStateActive();
    expect(mocks.native.start).toHaveBeenCalledTimes(1);
    expect(mocks.alert).not.toHaveBeenCalled();
  });
});
