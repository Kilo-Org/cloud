import type { SessionLiveActivityContentState } from '@kilocode/notifications';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sendLiveActivityApns } from './apns-live-activity';
import type * as ApnsLiveActivityModule from './apns-live-activity';
import { sendWidgetApns } from './apns-widget';
import type * as ApnsWidgetModule from './apns-widget';
import { sendPushNotifications, type ExpoPushMessage } from './expo-push';
import type * as ExpoPushModule from './expo-push';
import { glanceableDeliveryDeps } from './glanceable-delivery-deps';
import type { AndroidSessionSend, SessionCardSend } from './session-card-delivery';

// Every registration read finds no row; only the provider gate is under test.
vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: () => ({ select: () => ({ from: () => ({ where: async () => [] }) }) }),
}));
vi.mock('./expo-push', async importOriginal => ({
  ...(await importOriginal<typeof ExpoPushModule>()),
  sendPushNotifications: vi.fn(),
}));
vi.mock('./apns-live-activity', async importOriginal => ({
  ...(await importOriginal<typeof ApnsLiveActivityModule>()),
  sendLiveActivityApns: vi.fn(),
}));
vi.mock('./apns-widget', async importOriginal => ({
  ...(await importOriginal<typeof ApnsWidgetModule>()),
  sendWidgetApns: vi.fn(),
}));

const APNS_TS = 1_800_000_000;
const EXPO_TOKEN = 'expo-test-token';
const CONTENT = { name: 'Agents', props: '{}' };
const ALERT = { title: 'Agents', body: 'Working' };
const IOS_TOKENS = [{ token: 'ios-activity-token', event: 'update' as const }];
const EXPO_MESSAGE: ExpoPushMessage = { to: 'ExponentPushToken[device]' };
const IOS_SESSION_SEND: SessionCardSend = {
  token: 'ios-session-token',
  event: 'update',
  content: CONTENT,
  priority: 10,
  relevanceScore: 0.5,
};
// Only the gate reads this send, so its content is never built into a message.
const ANDROID_SESSION_SEND: AndroidSessionSend = {
  token: 'ExponentPushToken[android]',
  sessionId: 'ses_1',
  event: 'update',
  content: {} as SessionLiveActivityContentState,
};
const OPEN_GATES: [string, { WORKER_ENV: string; NOTIFICATIONS_PUSH_ENABLED: string }][] = [
  ['staging, switch true', { WORKER_ENV: 'staging', NOTIFICATIONS_PUSH_ENABLED: 'true' }],
  ['production, switch false', { WORKER_ENV: 'production', NOTIFICATIONS_PUSH_ENABLED: 'false' }],
];

function fakeEnv(vars: Record<string, unknown>) {
  const expoGet = vi.fn(async () => EXPO_TOKEN);
  const apnsGet = vi.fn(async () => 'apns-test-key');
  const getBundle = vi.fn();
  const env = {
    HYPERDRIVE: { connectionString: 'postgres://test' },
    EXPO_ACCESS_TOKEN: { get: expoGet },
    APNS_PRIVATE_KEY: { get: apnsGet },
    APNS_TEAM_ID: 'TEAMID',
    APNS_KEY_ID: 'KEYID',
    APNS_TOPIC: 'com.example.app',
    STS: { getBundle },
    ...vars,
  } as unknown as Env;
  return { env, expoGet, apnsGet, getBundle };
}

describe('glanceableDeliveryDeps staging push gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sendPushNotifications).mockResolvedValue({
      ticketTokenPairs: [{ ticketId: 'ticket-1', token: 'ExponentPushToken[device]' }],
      staleTokens: [],
      ticketErrors: [],
    });
    vi.mocked(sendLiveActivityApns).mockResolvedValue({ attempted: 1, ok: 1, failed: 0 });
    vi.mocked(sendWidgetApns).mockResolvedValue(undefined);
  });

  it.each([
    ['absent', {}],
    ['false', { NOTIFICATIONS_PUSH_ENABLED: 'false' }],
    ['absent under the STS source', { SECRETS_SOURCE: 'sts' }],
  ])('sends nothing in staging when the switch is %s', async (_label, vars) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { env, expoGet, apnsGet, getBundle } = fakeEnv({ WORKER_ENV: 'staging', ...vars });
    const deps = glanceableDeliveryDeps(env, { waitUntil: vi.fn() });

    const expo = await deps.sendExpoPush([EXPO_MESSAGE]);
    const androidSession = await deps.sendAndroidSessionLiveUpdate?.(ANDROID_SESSION_SEND);
    const iosAggregate = await deps.sendIosLiveActivity(IOS_TOKENS, CONTENT, ALERT, APNS_TS);
    const iosSession = await deps.sendIosSessionLiveActivity?.(IOS_SESSION_SEND, APNS_TS);
    const widget = await deps.sendIosWidgetHints?.('user-1', null);

    expect({ expo, androidSession, iosAggregate, iosSession, widget }).toEqual({
      expo: undefined,
      androidSession: false,
      iosAggregate: undefined,
      iosSession: false,
      widget: undefined,
    });
    expect(expoGet).not.toHaveBeenCalled();
    expect(apnsGet).not.toHaveBeenCalled();
    expect(getBundle).not.toHaveBeenCalled();
    expect(sendPushNotifications).not.toHaveBeenCalled();
    expect(sendLiveActivityApns).not.toHaveBeenCalled();
    expect(sendWidgetApns).not.toHaveBeenCalled();
    expect(log.mock.calls).toEqual([
      ['notifications_push_disabled', { surface: 'expo_push' }],
      ['notifications_push_disabled', { surface: 'expo_push' }],
      ['notifications_push_disabled', { surface: 'apns' }],
      ['notifications_push_disabled', { surface: 'apns' }],
      ['notifications_push_disabled', { surface: 'apns' }],
    ]);
    // An intentional skip is not reported as a missing credential.
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(OPEN_GATES)('keeps every provider send in %s', async (_label, vars) => {
    const { env, expoGet, apnsGet } = fakeEnv(vars);
    const deps = glanceableDeliveryDeps(env, { waitUntil: vi.fn() });

    await deps.sendExpoPush([EXPO_MESSAGE]);
    await deps.sendIosLiveActivity(IOS_TOKENS, CONTENT, ALERT, APNS_TS);
    const iosSession = await deps.sendIosSessionLiveActivity?.(IOS_SESSION_SEND, APNS_TS);
    await deps.sendIosWidgetHints?.('user-1', null);

    const credentials = {
      teamId: 'TEAMID',
      keyId: 'KEYID',
      topic: 'com.example.app',
      privateKeyPem: 'apns-test-key',
    };
    expect(iosSession).toBe(true);
    expect(expoGet).toHaveBeenCalledOnce();
    expect(sendPushNotifications).toHaveBeenCalledWith([EXPO_MESSAGE], EXPO_TOKEN, undefined);
    expect(apnsGet).toHaveBeenCalledTimes(3);
    expect(sendLiveActivityApns).toHaveBeenCalledTimes(2);
    for (const [params] of vi.mocked(sendLiveActivityApns).mock.calls) {
      expect(params.credentials).toEqual(credentials);
    }
    expect(sendWidgetApns).toHaveBeenCalledOnce();
    expect(vi.mocked(sendWidgetApns).mock.calls[0]?.[0].credentials).toEqual(credentials);
  });
});
