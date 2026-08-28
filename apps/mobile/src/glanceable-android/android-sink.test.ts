/* eslint-disable max-lines -- one cohesive sink suite sharing the native + widget mock harness */
import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setGlanceableDelivery } from '@/lib/glanceable/sink-registry';
import { i18n } from '@/i18n';

import {
  _resetAndroidSinkForTests,
  androidSink,
  getCurrentWidgetProps,
  handleAppStateActive,
} from './android-sink';
import { _setPermissionReaderForTests, type NotificationPermissionStatus } from './permission';
import { _resetAndroidPermissionAlertForTests } from './permission-alert';

const mocks = vi.hoisted(() => {
  let notification: {
    title: string;
    text: string;
    compactText: string | null;
    promotion: boolean;
  } | null = null;

  // eslint-disable-next-line max-params -- the fake mirrors the native bridge arguments
  function post(
    title: string,
    text: string,
    _openAgentsLabel: string,
    compactText: string | null,
    promotion: boolean
  ): void {
    notification = { title, text, compactText, promotion };
  }

  return {
    native: {
      isPromotionCapable: vi.fn(() => true),
      start: vi.fn(post),
      update: vi.fn(post),
      end: vi.fn(() => {
        notification = null;
      }),
    },
    getNotification: () => notification,
    requestWidgetUpdate: vi.fn(),
    alert: vi.fn(),
  };
});

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

const MIXED = {
  ...snapshotFor([], 0, 'happy'),
  needsInput: 2,
  reconnecting: 3,
  running: 4,
};

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
  mocks.native.end();
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
  it('forwards the ranked compact number and all counts on start and update', async () => {
    androidSink.startOrUpdate(MIXED, CTX);
    await flushAsync();
    expect(mocks.getNotification()).toEqual({
      title: 'Active agents',
      text: '2 Needs input, 3 Reconnecting, 4 Running',
      compactText: '2',
      promotion: true,
    });

    androidSink.startOrUpdate({ ...MIXED, revision: 2, needsInput: 0 }, CTX);
    await flushAsync();
    expect(mocks.getNotification()).toEqual({
      title: 'Active agents',
      text: '3 Reconnecting, 4 Running',
      compactText: '3',
      promotion: true,
    });

    androidSink.startOrUpdate({ ...MIXED, revision: 3, needsInput: 0, reconnecting: 0 }, CTX);
    await flushAsync();
    expect(mocks.getNotification()).toEqual({
      title: 'Active agents',
      text: '4 Running',
      compactText: '4',
      promotion: true,
    });
    expect(mocks.native.start).toHaveBeenCalledTimes(1);
    expect(mocks.native.update).toHaveBeenCalledTimes(2);
    expect(mocks.native.start).toHaveBeenCalledWith(
      'Active agents',
      '2 Needs input, 3 Reconnecting, 4 Running',
      'Open agents',
      '2',
      true
    );
    expect(mocks.native.update).toHaveBeenLastCalledWith(
      'Active agents',
      '4 Running',
      'Open agents',
      '4',
      true
    );
  });

  it('keeps the full summary when the device cannot promote', async () => {
    mocks.native.isPromotionCapable.mockReturnValue(false);
    androidSink.startOrUpdate(MIXED, CTX);
    await flushAsync();

    expect(mocks.getNotification()).toEqual({
      title: 'Active agents',
      text: '2 Needs input, 3 Reconnecting, 4 Running',
      compactText: '2',
      promotion: false,
    });
  });

  it('forwards compact text when concurrent permission checks start then update', async () => {
    const deferred = deferredPermission();
    // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
    _setPermissionReaderForTests(() => deferred.promise);
    androidSink.startOrUpdate(MIXED, CTX);
    androidSink.startOrUpdate({ ...MIXED, revision: 2, needsInput: 0 }, CTX);
    deferred.resolve('granted');
    await flushAsync();

    expect(mocks.getNotification()).toEqual({
      title: 'Active agents',
      text: '3 Reconnecting, 4 Running',
      compactText: '3',
      promotion: true,
    });
    expect(mocks.native.start).toHaveBeenCalledTimes(1);
    expect(mocks.native.update).toHaveBeenCalledTimes(1);
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

  it.each(['waiting', 'empty', 'expired', 'signed_out', 'privacy'] as const)(
    'never starts for a %s snapshot without eligible work',
    async status => {
      androidSink.startOrUpdate(snapshotFor([], 0, status), CTX);
      await flushAsync();

      expect(mocks.getNotification()).toBeNull();
      expect(mocks.native.start).not.toHaveBeenCalled();
      expect(mocks.native.update).not.toHaveBeenCalled();
    }
  );

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

  it('publishes the stale warning and retained counts through the native bridge', async () => {
    androidSink.startOrUpdate(MIXED, CTX);
    await flushAsync();
    androidSink.publish({ ...MIXED, revision: 2, status: 'stale' });

    const notification = mocks.getNotification();
    expect(notification?.text).toContain(i18n.t('glanceable.stale'));
    expect(notification?.text).toContain('2 Needs input, 3 Reconnecting, 4 Running');
    expect(notification?.compactText).toBe('2');
    expect(getCurrentWidgetProps()?.accessibilityLabel).toContain(
      '2 Needs input, 3 Reconnecting, 4 Running, Open agents'
    );
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
      null,
      true
    );
    expect(mocks.getNotification()).toEqual({
      title: 'Active agents',
      text: 'Agents hidden',
      compactText: null,
      promotion: true,
    });

    androidSink.endImmediate();
    expect(mocks.getNotification()).toBeNull();
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

  it('forwards the pending compact number when permission is granted on foreground', async () => {
    // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
    _setPermissionReaderForTests(() => Promise.resolve('denied'));
    androidSink.startOrUpdate(MIXED, CTX);
    await flushAsync();
    expect(mocks.getNotification()).toBeNull();

    // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
    _setPermissionReaderForTests(() => Promise.resolve('granted'));
    await handleAppStateActive();
    expect(mocks.getNotification()).toEqual({
      title: 'Active agents',
      text: '2 Needs input, 3 Reconnecting, 4 Running',
      compactText: '2',
      promotion: true,
    });
    expect(mocks.alert).not.toHaveBeenCalled();
  });
});
