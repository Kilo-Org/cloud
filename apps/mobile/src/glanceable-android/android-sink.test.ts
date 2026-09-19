/* eslint-disable max-lines -- one cohesive sink suite sharing the native + widget mock harness */
import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GlanceablePublisher } from '@/lib/glanceable/publisher';
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
    approveLabel: string | null;
    compactText: string | null;
    channelId: string;
    alerting: boolean;
    promotion: boolean;
  } | null = null;

  // Capture the requested bridge timeout, not Android's alarm cancellation behavior.
  let notificationDeadline: number | null = null;
  let widgetSnapshot: string | null = null;
  let widgetDeadline = 0;
  // The native module mirrors the channel its posted card carries and removes
  // the mirror on dismiss; the sink reads it to adopt the kind after a restart.
  let postedChannel: string | null = null;

  // eslint-disable-next-line max-params -- the fake models the native bridge arguments
  function post(
    title: string,
    text: string,
    _openAgentsLabel: string,
    approveLabel: string | null,
    compactText: string | null,
    channelId: string,
    alerting: boolean,
    promotion: boolean,
    timeoutMs = 0
  ): void {
    notification = { title, text, approveLabel, compactText, channelId, alerting, promotion };
    notificationDeadline = timeoutMs > 0 ? Date.now() + timeoutMs : null;
    postedChannel = channelId;
  }

  const isPromotionCapable = vi.fn(() => true);

  // The native `update` spends its eighth bridge slot on the terminal timeout,
  // so it applies the promotion gate from the capability check it re-runs
  // instead of a JS flag.
  // eslint-disable-next-line max-params -- the fake models the native update bridge arguments
  function postUpdate(
    title: string,
    text: string,
    openAgentsLabel: string,
    approveLabel: string | null,
    compactText: string | null,
    channelId: string,
    alerting: boolean,
    timeoutMs = 0
  ): void {
    post(
      title,
      text,
      openAgentsLabel,
      approveLabel,
      compactText,
      channelId,
      alerting,
      isPromotionCapable(),
      timeoutMs
    );
  }

  return {
    native: {
      isPromotionCapable,
      start: vi.fn(post),
      update: vi.fn(postUpdate),
      end: vi.fn(() => {
        notification = null;
        notificationDeadline = null;
        postedChannel = null;
      }),
      setWidgetSnapshot: vi.fn((snapshot: string, deadline: number) => {
        widgetSnapshot = snapshot;
        widgetDeadline = deadline;
      }),
      getWidgetSnapshot: () => widgetSnapshot,
      getPostedChannel: () => postedChannel,
    },
    // Test control for the durable native marker a previous process left behind.
    setPostedChannel: (channelId: string | null) => {
      postedChannel = channelId;
    },
    // The sink owns only the ensure call; channel creation lives in @/lib/notifications.
    // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
    ensureAndroidNotificationChannels: vi.fn(() => Promise.resolve()),
    getNotification: () => notification,
    getRequestedNotificationDeadline: () => notificationDeadline,
    getWidgetDeadline: () => widgetDeadline,
    requestWidgetUpdate: vi.fn(),
    alert: vi.fn(),
  };
});

vi.mock('expo', () => ({
  requireOptionalNativeModule: () => mocks.native,
}));

// The sink resolves `@/lib/notifications` lazily so the widget headless entry
// and the pure suites never load the native notifications graph; this mock is
// what the sink's dynamic import resolves to here.
vi.mock('@/lib/notifications', () => ({
  ensureAndroidNotificationChannels: mocks.ensureAndroidNotificationChannels,
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
  ImageWidget: () => null,
  requestWidgetUpdate: (...args: unknown[]) => mocks.requestWidgetUpdate(...args),
}));

const NOW = 1_750_000_000_000;
const CTX = { organizationId: null, userId: 'u1' };

const subscriptions = new Set<string>();
const delivery = {
  registerScopeTokens: vi.fn(() => subscriptions.add('scope')),
  registerTokens: vi.fn(() => subscriptions.add('scope')),
  cleanupTokens: vi.fn((lifetime: 'scope' | 'activity') => {
    if (lifetime === 'scope') {
      subscriptions.clear();
    }
  }),
  unregisterTokens: vi.fn().mockImplementation(async () => {
    await Promise.resolve();
    subscriptions.clear();
    return { ok: true, tokens: [] };
  }),
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
  idle: 3,
  running: 4,
};

async function flushAsync(): Promise<void> {
  // The channel ensurer resolves `@/lib/notifications` through a dynamic
  // import, so a start settles over more turns than a direct call: advance the
  // timer queue the import promise rides on, then drain the microtasks.
  await vi.advanceTimersByTimeAsync(0);
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
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.native.setWidgetSnapshot('', 0);
  _resetAndroidSinkForTests();
  _resetAndroidPermissionAlertForTests();
  // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
  _setPermissionReaderForTests(() => Promise.resolve('granted'));
  setGlanceableDelivery(delivery);
  subscriptions.clear();
  delivery.registerScopeTokens.mockClear();
  delivery.registerTokens.mockClear();
  delivery.cleanupTokens.mockClear();
  delivery.unregisterTokens.mockClear();
  mocks.native.isPromotionCapable.mockReturnValue(true);
  mocks.native.end();
  mocks.native.start.mockClear();
  mocks.native.update.mockClear();
  mocks.native.end.mockClear();
  mocks.ensureAndroidNotificationChannels.mockClear();
  mocks.requestWidgetUpdate.mockClear();
  mocks.alert.mockClear();
});

afterEach(() => {
  _setPermissionReaderForTests(null);
  vi.useRealTimers();
});

describe('androidSink start and update', () => {
  it('keeps scope delivery available before and after work arrives in the background', async () => {
    const publisher = new GlanceablePublisher({ sinks: [androidSink], now: () => NOW });
    publisher.handleSessions([], CTX);
    await flushAsync();
    expect(mocks.getNotification()).toBeNull();
    expect(getCurrentWidgetProps()?.statusLine).toBe('No agents waiting');
    expect(subscriptions).toEqual(new Set(['scope']));

    publisher.applySnapshot(snapshotFor([{ status: 'busy' }], 1), CTX);
    await flushAsync();
    expect(mocks.getNotification()?.text).toBe('1 Working');

    publisher.handleSessions([], CTX);
    await vi.advanceTimersByTimeAsync(8000);
    expect(mocks.getNotification()).toBeNull();
    expect(subscriptions).toEqual(new Set(['scope']));
    publisher.dispose();
  });

  it('forwards the ranked compact number and all counts on start and update', async () => {
    androidSink.startOrUpdate(MIXED, CTX);
    await flushAsync();
    expect(mocks.getNotification()).toEqual({
      title: 'Active agents',
      text: '2 Needs input, 4 Working, 3 Idle',
      approveLabel: null,
      compactText: '2',
      channelId: 'needs-input',
      alerting: true,
      promotion: true,
    });

    androidSink.startOrUpdate({ ...MIXED, revision: 2, needsInput: 0 }, CTX);
    await flushAsync();
    expect(mocks.getNotification()).toEqual({
      title: 'Active agents',
      text: '4 Working, 3 Idle',
      approveLabel: null,
      compactText: '4',
      channelId: 'agent-progress',
      alerting: false,
      promotion: true,
    });

    androidSink.startOrUpdate({ ...MIXED, revision: 3, needsInput: 0, idle: 0 }, CTX);
    await flushAsync();
    expect(mocks.getNotification()).toEqual({
      title: 'Active agents',
      text: '4 Working',
      approveLabel: null,
      compactText: '4',
      channelId: 'agent-progress',
      alerting: false,
      promotion: true,
    });
    expect(mocks.native.start).toHaveBeenCalledTimes(1);
    expect(mocks.native.update).toHaveBeenCalledTimes(2);
    expect(mocks.native.start).toHaveBeenCalledWith(
      'Active agents',
      '2 Needs input, 4 Working, 3 Idle',
      'Open agents',
      null,
      '2',
      'needs-input',
      true,
      true
    );
    expect(mocks.native.update).toHaveBeenLastCalledWith(
      'Active agents',
      '4 Working',
      'Open agents',
      null,
      '4',
      'agent-progress',
      false,
      0
    );
  });

  it('carries needs-input on entry and does not re-alert on a later update in that kind', async () => {
    const needsInput = { ...MIXED, needsInput: 1 };
    androidSink.startOrUpdate(needsInput, CTX);
    await flushAsync();
    expect(mocks.getNotification()).toMatchObject({ channelId: 'needs-input', alerting: true });

    androidSink.startOrUpdate({ ...needsInput, revision: 2 }, CTX);
    await flushAsync();
    expect(mocks.native.update).toHaveBeenLastCalledWith(
      'Active agents',
      expect.any(String),
      'Open agents',
      null,
      expect.any(String),
      'needs-input',
      false,
      0
    );
  });

  it('stays on the silent progress channel while no work needs input', async () => {
    androidSink.startOrUpdate({ ...MIXED, needsInput: 0 }, CTX);
    await flushAsync();

    expect(mocks.getNotification()).toMatchObject({ channelId: 'agent-progress', alerting: false });
    expect(mocks.native.start).toHaveBeenCalledWith(
      'Active agents',
      expect.any(String),
      'Open agents',
      null,
      expect.any(String),
      'agent-progress',
      false,
      true
    );
  });

  it('never starts an ongoing card for idle-only work, while the widget keeps it', async () => {
    const idleOnly = snapshotFor([{ status: 'idle' }], 0);
    androidSink.publish(idleOnly);
    androidSink.startOrUpdate(idleOnly, CTX);
    await flushAsync();

    // No card: only work that is running or waiting on the user is worth an
    // ongoing notification, because the card has no opt-in the way a placed
    // widget does.
    expect(mocks.native.start).not.toHaveBeenCalled();
    expect(mocks.getNotification()).toBeNull();
    // The widget is the surface that keeps showing idle work.
    expect(getCurrentWidgetProps()?.countLines.find(line => line.kind === 'idle')?.count).toBe('1');
  });

  it('alerts again when a progress card re-enters the needs-input kind', async () => {
    androidSink.startOrUpdate({ ...MIXED, needsInput: 0 }, CTX);
    await flushAsync();
    androidSink.startOrUpdate({ ...MIXED, revision: 2, needsInput: 1 }, CTX);
    await flushAsync();

    expect(mocks.native.update).toHaveBeenLastCalledWith(
      'Active agents',
      expect.any(String),
      'Open agents',
      null,
      expect.any(String),
      'needs-input',
      true,
      0
    );
  });

  it('does not re-alert a needs-input card a previous process left in the shade', async () => {
    const needsInput = { ...MIXED, needsInput: 1 };
    // The previous JS process posted this card; the native posted-channel
    // marker survives the restart and still describes the card in the shade.
    mocks.setPostedChannel('needs-input');
    mocks.native.setWidgetSnapshot(JSON.stringify(needsInput), Date.parse(needsInput.expiresAt));
    _resetAndroidSinkForTests();
    const next = { ...needsInput, revision: needsInput.revision + 1 };

    androidSink.publish(next);
    androidSink.startOrUpdate(next, CTX);
    await flushAsync();

    expect(mocks.native.start).toHaveBeenCalledWith(
      'Active agents',
      expect.any(String),
      'Open agents',
      null,
      expect.any(String),
      'needs-input',
      false,
      true
    );
  });

  it('alerts a needs-input entry after a restart that left a progress card', async () => {
    const progress = { ...MIXED, needsInput: 0 };
    mocks.setPostedChannel('agent-progress');
    mocks.native.setWidgetSnapshot(JSON.stringify(progress), 0);
    _resetAndroidSinkForTests();
    const next = { ...MIXED, needsInput: 1, revision: progress.revision + 1 };

    androidSink.publish(next);
    androidSink.startOrUpdate(next, CTX);
    await flushAsync();

    expect(mocks.native.start).toHaveBeenCalledWith(
      'Active agents',
      expect.any(String),
      'Open agents',
      null,
      expect.any(String),
      'needs-input',
      true,
      true
    );
  });

  it('alerts the first needs-input post after a restart that never posted', async () => {
    const needsInput = { ...MIXED, needsInput: 1 };
    // Permission was denied, so a widget snapshot was stored without a card:
    // the native marker is absent and must not be read as a posted card.
    mocks.native.setWidgetSnapshot(JSON.stringify(needsInput), Date.parse(needsInput.expiresAt));
    _resetAndroidSinkForTests();
    // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
    _setPermissionReaderForTests(() => Promise.resolve('denied'));
    const next = { ...needsInput, revision: needsInput.revision + 1 };

    androidSink.publish(next);
    androidSink.startOrUpdate(next, CTX);
    await flushAsync();
    expect(mocks.native.start).not.toHaveBeenCalled();

    // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
    _setPermissionReaderForTests(() => Promise.resolve('granted'));
    await handleAppStateActive();

    expect(mocks.native.start).toHaveBeenCalledWith(
      'Active agents',
      expect.any(String),
      'Open agents',
      null,
      expect.any(String),
      'needs-input',
      true,
      true
    );
  });

  it('alerts the first needs-input post after the previous card was dismissed', async () => {
    const needsInput = { ...MIXED, needsInput: 1 };
    // A previous process posted the card and stored its widget snapshot.
    mocks.setPostedChannel('needs-input');
    mocks.native.setWidgetSnapshot(JSON.stringify(needsInput), Date.parse(needsInput.expiresAt));
    // The card then ended: a native dismiss clears the posted marker.
    mocks.native.end();
    _resetAndroidSinkForTests();
    const next = { ...needsInput, revision: needsInput.revision + 1 };

    androidSink.publish(next);
    androidSink.startOrUpdate(next, CTX);
    await flushAsync();

    expect(mocks.native.start).toHaveBeenCalledWith(
      'Active agents',
      expect.any(String),
      'Open agents',
      null,
      expect.any(String),
      'needs-input',
      true,
      true
    );
  });

  it('ensures the Android channels before the first native start', async () => {
    androidSink.startOrUpdate(MIXED, CTX);
    await flushAsync();

    expect(mocks.ensureAndroidNotificationChannels).toHaveBeenCalledTimes(1);
    expect(mocks.ensureAndroidNotificationChannels.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.native.start.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
  });

  it('keeps the full summary when the device cannot promote', async () => {
    mocks.native.isPromotionCapable.mockReturnValue(false);
    androidSink.startOrUpdate(MIXED, CTX);
    await flushAsync();

    expect(mocks.getNotification()).toEqual({
      title: 'Active agents',
      text: '2 Needs input, 4 Working, 3 Idle',
      approveLabel: null,
      compactText: '2',
      channelId: 'needs-input',
      alerting: true,
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
      text: '4 Working, 3 Idle',
      approveLabel: null,
      compactText: '4',
      channelId: 'agent-progress',
      alerting: false,
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

describe('androidSink approve action', () => {
  const PERMISSION = snapshotFor([{ status: 'permission' }], 0);

  it('passes the Approve label while a permission waits and drops it once answered', async () => {
    androidSink.startOrUpdate(PERMISSION, CTX);
    await flushAsync();
    expect(mocks.getNotification()?.approveLabel).toBe('Approve');
    expect(mocks.native.start).toHaveBeenCalledWith(
      'Active agents',
      '1 Needs input',
      'Open agents',
      'Approve',
      '1',
      'needs-input',
      true,
      true
    );

    androidSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 1), CTX);
    await flushAsync();
    expect(mocks.getNotification()?.approveLabel).toBeNull();
    expect(mocks.native.update).toHaveBeenLastCalledWith(
      'Active agents',
      '1 Working',
      'Open agents',
      null,
      '1',
      'agent-progress',
      false,
      0
    );
  });

  it('passes the Approve label when the pending start is retried at foreground', async () => {
    // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
    _setPermissionReaderForTests(() => Promise.resolve('denied'));
    androidSink.startOrUpdate(PERMISSION, CTX);
    await flushAsync();
    expect(mocks.native.start).not.toHaveBeenCalled();

    // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
    _setPermissionReaderForTests(() => Promise.resolve('granted'));
    await handleAppStateActive();

    expect(mocks.native.start).toHaveBeenCalledWith(
      'Active agents',
      '1 Needs input',
      'Open agents',
      'Approve',
      '1',
      'needs-input',
      true,
      true
    );
  });

  it('passes no Approve label for a question-only wait or no wait', async () => {
    androidSink.startOrUpdate(snapshotFor([{ status: 'question' }], 0), CTX);
    await flushAsync();
    expect(mocks.getNotification()?.approveLabel).toBeNull();
    expect(mocks.native.start).toHaveBeenCalledWith(
      'Active agents',
      '1 Needs input',
      'Open agents',
      null,
      '1',
      'needs-input',
      true,
      true
    );

    androidSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 1), CTX);
    await flushAsync();
    expect(mocks.getNotification()?.approveLabel).toBeNull();
  });

  it('adds the label through the publish path once the notification is up', async () => {
    androidSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);
    await flushAsync();
    expect(mocks.getNotification()?.approveLabel).toBeNull();

    androidSink.publish(snapshotFor([{ status: 'permission' }], 1));
    expect(mocks.getNotification()?.approveLabel).toBe('Approve');
    expect(mocks.native.update).toHaveBeenLastCalledWith(
      'Active agents',
      '1 Needs input',
      'Open agents',
      'Approve',
      '1',
      'needs-input',
      true,
      0
    );
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

/** The working row's count — the rows always carry all three states in order. */
function runningCount(): string | undefined {
  return getCurrentWidgetProps()?.countLines.find(line => line.kind === 'running')?.count;
}

describe('androidSink widget publish and end', () => {
  it('publishes the widget snapshot on every publish', () => {
    androidSink.publish(snapshotFor([{ status: 'busy' }], 0));

    expect(mocks.requestWidgetUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.requestWidgetUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ widgetName: 'ActiveAgentsWidget' })
    );
    expect(getCurrentWidgetProps()?.statusLine).toBeNull();
    expect(runningCount()).toBe('1');
  });

  it('publishes the stale warning and retained counts through the native bridge', async () => {
    androidSink.startOrUpdate(MIXED, CTX);
    await flushAsync();
    androidSink.publish({ ...MIXED, revision: 2, status: 'stale' });

    const notification = mocks.getNotification();
    expect(notification?.text).toContain(i18n.t('glanceable.stale'));
    expect(notification?.text).toContain('2 Needs input, 4 Working, 3 Idle');
    expect(notification?.compactText).toBe('2');
    expect(getCurrentWidgetProps()?.accessibilityLabel).toContain(
      '2 Needs input, 4 Working, 3 Idle, Open agents'
    );
  });

  it.each([
    ['privacy', 'Open Kilo to see agents'],
    ['signed_out', 'Sign in to see agents'],
  ] as const)('cancels both deadlines immediately for %s', async (status, copy) => {
    androidSink.publish(MIXED);
    androidSink.startOrUpdate(MIXED, CTX);
    await flushAsync();
    androidSink.publish(snapshotFor([], 1, 'empty'));
    expect(mocks.getRequestedNotificationDeadline()).toBe(NOW + 8000);

    androidSink.publish(snapshotFor([], 2, status));
    expect(mocks.getNotification()).toBeNull();
    expect(mocks.getRequestedNotificationDeadline()).toBeNull();
    expect(mocks.getWidgetDeadline()).toBe(0);
    vi.setSystemTime(NOW + 28_800_001);
    expect(getCurrentWidgetProps()?.statusLine).toBe(copy);
    expect(getCurrentWidgetProps()?.countLines).toEqual([]);
    androidSink.endImmediate();
    expect(mocks.getNotification()).toBeNull();
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

  it('dismisses a leftover native card when only idle work remains after a restart', () => {
    // A previous JS process posted the card; the fresh process has no
    // notificationActive flag, so publish must cancel the native record.
    androidSink.publish(snapshotFor([{ status: 'idle' }], 0));

    expect(mocks.native.end).toHaveBeenCalledTimes(1);
  });

  it('ends the ongoing card when the last agent goes idle and keeps the widget', async () => {
    androidSink.startOrUpdate(MIXED, CTX);
    await flushAsync();
    expect(mocks.getNotification()).not.toBeNull();

    androidSink.publish(snapshotFor([{ status: 'idle' }], MIXED.revision));
    expect(mocks.getNotification()).toMatchObject({
      text: i18n.t('glanceable.empty'),
      compactText: null,
    });
    expect(mocks.getRequestedNotificationDeadline()).toBe(NOW + 8000);

    vi.setSystemTime(NOW + 8000);
    androidSink.publish(snapshotFor([{ status: 'idle' }], MIXED.revision + 1));
    expect(mocks.getNotification()).toBeNull();
    expect(getCurrentWidgetProps()?.countLines.find(line => line.kind === 'idle')?.count).toBe('1');
  });

  it('keeps the widget truthful after end', () => {
    androidSink.publish(snapshotFor([{ status: 'busy' }], 0));
    expect(getCurrentWidgetProps()).not.toBeNull();

    androidSink.endImmediate();
    expect(mocks.native.end).toHaveBeenCalledTimes(1);
    expect(getCurrentWidgetProps()).not.toBeNull();
    expect(runningCount()).toBe('1');
  });

  it('ends the ongoing notification without removing widget delivery', async () => {
    androidSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);
    await flushAsync();
    expect(mocks.getNotification()).not.toBeNull();

    androidSink.endImmediate();
    await flushAsync();
    expect(mocks.getNotification()).toBeNull();
    expect(subscriptions).toEqual(new Set(['scope']));
  });

  it.each(['happy', 'stale'] as const)(
    'hands Android the original %s expiry without a JS timer',
    status => {
      const snapshot = snapshotFor([{ status: 'busy' }], 0, status);
      androidSink.publish(snapshot);
      expect(mocks.getWidgetDeadline()).toBe(NOW + 28_800_000);
      expect(vi.getTimerCount()).toBe(0);

      vi.setSystemTime(NOW + 28_799_999);
      expect(runningCount()).toBe('1');
      vi.setSystemTime(NOW + 28_800_000);
      expect(getCurrentWidgetProps()?.statusLine).toBe('Status expired');
      expect(getCurrentWidgetProps()?.countLines).toEqual([]);
    }
  );

  it('replaces the old widget deadline and keeps it when only the notification ends', () => {
    androidSink.publish(MIXED);
    const newer = buildGlanceableSnapshot({
      sessions: [{ status: 'busy' }],
      userId: 'u1',
      organizationId: null,
      now: NOW + 60_000,
      previousRevision: MIXED.revision,
    });
    androidSink.publish(newer);
    androidSink.endImmediate();
    expect(mocks.getWidgetDeadline()).toBe(NOW + 28_860_000);
    vi.setSystemTime(NOW + 28_800_000);
    expect(runningCount()).toBe('1');
    expect(mocks.getNotification()).toBeNull();
  });

  it('does not extend the successful deadline when stale data is published later', () => {
    androidSink.publish(MIXED);
    vi.setSystemTime(NOW + 60_000);
    androidSink.publish({ ...MIXED, status: 'stale', revision: 2 });
    expect(mocks.getWidgetDeadline()).toBe(NOW + 28_800_000);
    expect(getCurrentWidgetProps()?.countLines.at(0)?.count).toBe('2');
    vi.setSystemTime(NOW + 28_800_000);
    expect(getCurrentWidgetProps()?.countLines).toEqual([]);
  });

  it('passes an eight-second terminal timeout that survives clearing JS state', async () => {
    androidSink.startOrUpdate(MIXED, CTX);
    await flushAsync();
    androidSink.publish(snapshotFor([], 1, 'empty'));
    _resetAndroidSinkForTests();

    expect(mocks.getNotification()).toMatchObject({
      text: 'No agents waiting',
      compactText: null,
    });
    expect(mocks.getRequestedNotificationDeadline()).toBe(NOW + 8000);
    expect(mocks.getWidgetDeadline()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the first terminal deadline across later empty updates', async () => {
    androidSink.startOrUpdate(MIXED, CTX);
    await flushAsync();
    androidSink.publish(snapshotFor([], 1, 'empty'));
    vi.setSystemTime(NOW + 4000);
    androidSink.publish(snapshotFor([], 2, 'empty'));
    expect(mocks.getRequestedNotificationDeadline()).toBe(NOW + 8000);
    vi.setSystemTime(NOW + 8000);
    androidSink.publish(snapshotFor([], 3, 'empty'));
    expect(mocks.getNotification()).toBeNull();
  });

  it('allows the same terminal revision to retry after a native post rejects', async () => {
    androidSink.startOrUpdate(MIXED, CTX);
    await flushAsync();
    const empty = snapshotFor([], 1, 'empty');
    mocks.native.update.mockImplementationOnce(() => {
      throw new Error('Cannot persist the active agents notification timeout');
    });

    expect(() => {
      androidSink.publish(empty);
    }).toThrow('Cannot persist the active agents notification timeout');
    expect(mocks.getNotification()?.text).toBe('2 Needs input, 4 Working, 3 Idle');
    expect(mocks.getRequestedNotificationDeadline()).toBeNull();

    vi.setSystemTime(NOW + 3000);
    androidSink.publish(empty);
    expect(mocks.getNotification()).toMatchObject({
      text: 'No agents waiting',
      compactText: null,
    });
    expect(mocks.getRequestedNotificationDeadline()).toBe(NOW + 8000);
  });

  it.each(['publish', 'startOrUpdate', 'JS reload'] as const)(
    'requests untimed eligible work through %s after terminal copy',
    async method => {
      androidSink.publish(MIXED);
      androidSink.startOrUpdate(MIXED, CTX);
      await flushAsync();
      androidSink.publish(snapshotFor([], 1, 'empty'));
      expect(mocks.getRequestedNotificationDeadline()).toBe(NOW + 8000);
      vi.setSystemTime(NOW + 4000);
      if (method === 'JS reload') {
        _resetAndroidSinkForTests();
      }
      const newer = { ...MIXED, revision: 3 };
      if (method === 'publish') {
        androidSink.publish(newer);
      } else {
        androidSink.startOrUpdate(newer, CTX);
        await flushAsync();
      }

      expect(mocks.getRequestedNotificationDeadline()).toBeNull();
      expect(mocks.getNotification()).toMatchObject({
        text: '2 Needs input, 4 Working, 3 Idle',
        compactText: '2',
      });
      expect(mocks.getWidgetDeadline()).toBe(method === 'publish' ? NOW + 28_800_000 : 0);
    }
  );

  it('rejects a pending start when its successful snapshot expires', async () => {
    const deferred = deferredPermission();
    // eslint-disable-next-line promise-function-async, prefer-await-to-then -- the test controls permission resolution
    _setPermissionReaderForTests(() => deferred.promise);
    androidSink.startOrUpdate(MIXED, CTX);
    vi.setSystemTime(NOW + 28_800_000);
    deferred.resolve('granted');
    await flushAsync();

    expect(mocks.getNotification()).toBeNull();
  });

  it('rejects a pending start after an empty snapshot cancels the work', async () => {
    const deferred = deferredPermission();
    // eslint-disable-next-line promise-function-async, prefer-await-to-then -- the test controls permission resolution
    _setPermissionReaderForTests(() => deferred.promise);
    androidSink.startOrUpdate(MIXED, CTX);
    androidSink.publish(snapshotFor([], 1, 'empty'));
    deferred.resolve('granted');
    await flushAsync();

    expect(mocks.getNotification()).toBeNull();
    expect(mocks.getWidgetDeadline()).toBe(0);
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
      text: '2 Needs input, 4 Working, 3 Idle',
      approveLabel: null,
      compactText: '2',
      channelId: 'needs-input',
      alerting: true,
      promotion: true,
    });
    expect(mocks.alert).not.toHaveBeenCalled();
  });
});
