import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createExecutionContext,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { getWorkerDb } from '@kilocode/db/client';
import type { DispatchPushInput } from '@kilocode/notifications';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { NotificationChannelDO, NotificationsService } from '../index';
import { sendPushNotifications, type ExpoPushMessage } from './expo-push';
import type * as ExpoPushModule from './expo-push';

vi.mock('@kilocode/db/client', () => ({ getWorkerDb: vi.fn() }));
vi.mock('./expo-push', async importOriginal => ({
  ...(await importOriginal<typeof ExpoPushModule>()),
  sendPushNotifications: vi.fn(),
}));
import {
  apnsSendsForTokens,
  buildGlanceableExpoMessages,
  deliverGlanceableSnapshot,
  toGlanceableContentState,
  type ActiveAgentsGlanceable,
  type GlanceableApnsContentState,
  type GlanceableDeliveryDeps,
  type IosActivityToken,
} from './glanceable-delivery';

const snapshot: ActiveAgentsGlanceable = {
  type: 'active_agents_glanceable',
  schemaVersion: 1,
  revision: 3,
  scopeKey: 'deadbeef',
  organizationBound: false,
  status: 'happy',
  running: 2,
  needsInput: 1,
  reconnecting: 0,
  updatedAt: '2026-08-27T10:00:00.000Z',
  expiresAt: '2026-08-27T18:00:00.000Z',
  eligibleStartedAt: '2026-08-27T09:00:00.000Z',
};

function fakeDeps(overrides: Partial<GlanceableDeliveryDeps> = {}): {
  deps: GlanceableDeliveryDeps;
  calls: { iosSends: unknown[][]; expoSends: ExpoPushMessage[][] };
} {
  const calls = { iosSends: [] as unknown[][], expoSends: [] as ExpoPushMessage[][] };

  const deps: GlanceableDeliveryDeps = {
    buildSnapshot: vi.fn(async () => snapshot),
    listIosActivityTokens: vi.fn(async () => [] as IosActivityToken[]),
    sendIosLiveActivity: vi.fn(async (_tokens, _contentState) => {
      calls.iosSends.push([_tokens, _contentState]);
    }),
    listIosExpoTokens: vi.fn(async () => []),
    listAndroidExpoTokens: vi.fn(async () => []),
    hasAndroidOngoingToken: vi.fn(async () => false),
    sendExpoPush: vi.fn(async messages => {
      calls.expoSends.push(messages);
    }),
    ...overrides,
  };

  return { deps, calls };
}

describe('NotificationsService.refreshGlanceableSessions', () => {
  beforeEach(() => {
    vi.mocked(getWorkerDb).mockReset();
    vi.mocked(sendPushNotifications).mockReset();
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(snapshot.updatedAt));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  type Scope = { userId: string; organizationId: string | null };
  type ApnsPayload = {
    aps: { event: string; timestamp: number; 'content-state': GlanceableApnsContentState };
  };

  function setupService(
    options: {
      deniedOrganizationId?: string;
      failedOrganizationId?: string;
      response?: (scope: Scope) => Response | Promise<Response>;
      beforeIosTokens?: () => Promise<void>;
      iosTokenKind?: IosActivityToken['kind'];
      privateKey?: () => Promise<string>;
      beforeApnsResponse?: () => Promise<void>;
      expoAccessToken?: () => Promise<string>;
    } = {}
  ) {
    const messages: ExpoPushMessage[] = [];
    const apns: ApnsPayload[] = [];
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const requestedScopes: Scope[] = [];
    const sessions = [
      { id: 'personal', userId: 'usr_1', organizationId: null },
      { id: 'org-a', userId: 'usr_1', organizationId: 'org-1' },
      { id: 'org-b', userId: 'usr_1', organizationId: 'org-1' },
      { id: 'org-c', userId: 'usr_1', organizationId: 'org-2' },
      { id: 'other-personal', userId: 'usr_2', organizationId: null },
      { id: 'foreign', userId: 'usr_2', organizationId: 'org-2' },
    ];
    const db = drizzle(async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('from "cli_sessions_v2"')) {
        return {
          rows: sessions
            .filter(session => params.includes(session.id))
            .map(session => [session.id, session.userId, session.organizationId]),
        };
      }
      if (sql.includes('from "user_push_tokens"')) {
        return {
          rows: [
            [
              params.includes('android') ? 'ExponentPushToken[android]' : 'ExponentPushToken[ios]',
              null,
            ],
          ],
        };
      }
      if (sql.includes('from "user_activity_tokens"')) {
        if (params.includes('android_ongoing')) return { rows: [['subscription']] };
        await options.beforeIosTokens?.();
        return {
          rows: options.privateKey
            ? [['activity-token', options.iosTokenKind ?? 'ios_activity']]
            : [],
        };
      }
      if (sql.includes('from "user_notification_preferences"')) {
        return { rows: [[false, false, false, false, false, false, false]] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    vi.mocked(sendPushNotifications).mockImplementation(async incoming => {
      messages.push(...incoming);
      return { ticketTokenPairs: [], staleTokens: [], ticketErrors: [] };
    });
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (typeof init.body !== 'string') throw new Error('Expected a JSON request body');
      if (url === 'https://api.push.apple.com/3/device/activity-token') {
        await options.beforeApnsResponse?.();
        apns.push(JSON.parse(init.body) as ApnsPayload);
        return new Response(null, { status: 200 });
      }
      expect(url).toBe('https://snapshot.test/api/internal/glanceable-agents-snapshot');
      expect(new Headers(init.headers).get('accept')).toBe('application/json');
      const scope = JSON.parse(init.body) as Scope;
      requestedScopes.push(scope);
      if (scope.organizationId === options.deniedOrganizationId)
        return new Response(null, { status: 403 });
      if (scope.organizationId === options.failedOrganizationId)
        throw new Error('snapshot unavailable');
      return (
        options.response?.(scope) ??
        Response.json({
          ...snapshot,
          scopeKey: scope.organizationId ?? 'personal',
          organizationBound: scope.organizationId !== null,
          running: scope.organizationId === null ? 2 : 7,
        })
      );
    });
    const objectPrefix = crypto.randomUUID();
    const serviceEnv = {
      HYPERDRIVE: { connectionString: 'postgres://unused' },
      KILO_WEB_API_BASE_URL: 'https://snapshot.test',
      INTERNAL_API_SECRET: { get: async () => 'test-internal-secret' },
      EXPO_ACCESS_TOKEN: { get: options.expoAccessToken ?? (async () => 'test-expo-token') },
      APNS_TEAM_ID: 'test-team',
      APNS_KEY_ID: 'test-key',
      APNS_TOPIC: 'test.topic',
      APNS_PRIVATE_KEY: { get: options.privateKey },
      NOTIFICATION_CHANNEL_DO: {
        idFromName: (userId: string) =>
          env.NOTIFICATION_CHANNEL_DO.idFromName(`${objectPrefix}:${userId}`),
        get: (id: DurableObjectId) => ({
          refreshGlanceableSnapshot: (scope: Scope) =>
            runInDurableObject(env.NOTIFICATION_CHANNEL_DO.get(id), async (_instance, state) => {
              // Reconstruct the real class on real durable storage on every call.
              await new NotificationChannelDO(state, serviceEnv as never).refreshGlanceableSnapshot(
                scope
              );
            }),
        }),
      },
    };
    const createService = () =>
      new NotificationsService(createExecutionContext(), serviceEnv as never);
    return { service: createService(), createService, messages, apns, queries, requestedScopes };
  }

  function freshSnapshot(overrides: Partial<ActiveAgentsGlanceable> = {}): ActiveAgentsGlanceable {
    return {
      ...snapshot,
      needsInput: 0,
      updatedAt: new Date(Date.now()).toISOString(),
      expiresAt: new Date(Date.now() + 28_800_000).toISOString(),
      eligibleStartedAt: new Date(Date.now()).toISOString(),
      ...overrides,
    };
  }

  const personalRefresh = { userId: 'usr_1', cliSessionIds: ['personal'] };

  it('fences a deferred busy read after idle from another entrypoint and reconstructed DO', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let current = freshSnapshot();
    let first = true;
    const { service, createService, messages } = setupService({
      response: async () => {
        const captured = current;
        if (first) {
          first = false;
          started.resolve();
          await release.promise;
        }
        return Response.json({ ...captured, updatedAt: new Date(Date.now()).toISOString() });
      },
    });
    const busy = service.refreshGlanceableSessions(personalRefresh);
    await started.promise;
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-08-27T10:00:01.000Z'));
    current = freshSnapshot({ status: 'empty', running: 0, eligibleStartedAt: null });
    await createService().refreshGlanceableSessions(personalRefresh);
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-08-27T10:01:00.000Z'));
    release.resolve();
    await busy;
    expect(messages.map(message => message.data)).toMatchObject([
      {
        status: 'empty',
        running: 0,
        eligibleStartedAt: null,
        updatedAt: '2026-08-27T10:00:01.000Z',
      },
      {
        status: 'empty',
        running: 0,
        eligibleStartedAt: null,
        updatedAt: '2026-08-27T10:00:01.000Z',
      },
    ]);
  });

  it('anchors freshness before a delayed snapshot read instead of extending it at completion', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { service, messages } = setupService({
      response: async () => {
        started.resolve();
        await release.promise;
        return Response.json(freshSnapshot());
      },
    });
    const pending = service.refreshGlanceableSessions(personalRefresh);
    await started.promise;
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-08-27T10:10:00.000Z'));
    release.resolve();
    await pending;
    expect(messages.map(message => message.data)).toMatchObject([
      { updatedAt: '2026-08-27T10:00:00.000Z', expiresAt: '2026-08-27T18:00:00.000Z' },
      { updatedAt: '2026-08-27T10:00:00.000Z', expiresAt: '2026-08-27T18:00:00.000Z' },
    ]);
  });

  it('fences a busy delivery delayed during token lookup after a newer idle delivery', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let first = true;
    let current = freshSnapshot();
    const { service, createService, messages } = setupService({
      response: () => Response.json(current),
      beforeIosTokens: async () => {
        if (!first) return;
        first = false;
        started.resolve();
        await release.promise;
      },
    });
    const busy = service.refreshGlanceableSessions(personalRefresh);
    await started.promise;
    current = freshSnapshot({ status: 'empty', running: 0, eligibleStartedAt: null });
    await createService().refreshGlanceableSessions(personalRefresh);
    release.resolve();
    await busy;
    expect(messages.map(message => message.data)).toMatchObject([
      { status: 'empty', running: 0, eligibleStartedAt: null },
      { status: 'empty', running: 0, eligibleStartedAt: null },
    ]);
  });

  it('retains the eligible start through retry and reconstructed worker and DO instances', async () => {
    let current = freshSnapshot();
    const { service, createService, messages } = setupService({
      response: () => Response.json(current),
    });
    await service.refreshGlanceableSessions(personalRefresh);
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-08-27T10:10:00.000Z'));
    current = freshSnapshot({ running: 0, reconnecting: 1 });
    await createService().refreshGlanceableSessions(personalRefresh);
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-08-27T10:20:00.000Z'));
    current = freshSnapshot({ running: 0, needsInput: 1 });
    await createService().refreshGlanceableSessions(personalRefresh);
    expect(
      messages
        .filter(message => message.to === 'ExponentPushToken[ios]')
        .map(message => message.data)
    ).toMatchObject([
      { running: 2, eligibleStartedAt: '2026-08-27T10:00:00.000Z', revision: 1 },
      { reconnecting: 1, eligibleStartedAt: '2026-08-27T10:00:00.000Z', revision: 2 },
      { needsInput: 1, eligibleStartedAt: '2026-08-27T10:00:00.000Z', revision: 3 },
    ]);
  });

  it('clears on authoritative empty and prevents an older empty read resetting the new interval', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let current = freshSnapshot();
    let deferNext = false;
    const { createService, messages } = setupService({
      response: async () => {
        const captured = current;
        if (deferNext) {
          deferNext = false;
          started.resolve();
          await release.promise;
        }
        return Response.json(captured);
      },
    });
    await createService().refreshGlanceableSessions(personalRefresh);
    current = freshSnapshot({ status: 'empty', running: 0, eligibleStartedAt: null });
    deferNext = true;
    const oldIdle = createService().refreshGlanceableSessions(personalRefresh);
    await started.promise;
    await createService().refreshGlanceableSessions(personalRefresh);
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-08-27T10:10:00.000Z'));
    current = freshSnapshot();
    await createService().refreshGlanceableSessions(personalRefresh);
    release.resolve();
    await oldIdle;
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-08-27T10:20:00.000Z'));
    current = freshSnapshot({ running: 0, reconnecting: 1 });
    await createService().refreshGlanceableSessions(personalRefresh);
    expect(
      messages
        .filter(message => message.to === 'ExponentPushToken[ios]')
        .map(message => message.data)
    ).toMatchObject([
      { status: 'happy', eligibleStartedAt: '2026-08-27T10:00:00.000Z' },
      { status: 'empty', eligibleStartedAt: null },
      { status: 'happy', eligibleStartedAt: '2026-08-27T10:10:00.000Z' },
      { reconnecting: 1, eligibleStartedAt: '2026-08-27T10:10:00.000Z' },
    ]);
  });

  it('keeps user and organization intervals separate while another scope has a deferred read', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let first = true;
    const { createService, messages } = setupService({
      response: async scope => {
        const captured = freshSnapshot({
          scopeKey: `${scope.userId}:${scope.organizationId ?? 'personal'}`,
          organizationBound: scope.organizationId !== null,
        });
        if (first) {
          first = false;
          started.resolve();
          await release.promise;
        }
        return Response.json(captured);
      },
    });
    const personal = createService().refreshGlanceableSessions(personalRefresh);
    await started.promise;
    for (const [userId, cliSessionId, time] of [
      ['usr_1', 'org-a', '2026-08-27T10:01:00.000Z'],
      ['usr_1', 'org-c', '2026-08-27T10:02:00.000Z'],
      ['usr_2', 'other-personal', '2026-08-27T10:03:00.000Z'],
    ]) {
      vi.mocked(Date.now).mockReturnValue(Date.parse(time));
      await createService().refreshGlanceableSessions({ userId, cliSessionIds: [cliSessionId] });
    }
    release.resolve();
    await personal;
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-08-27T10:04:00.000Z'));
    await createService().refreshGlanceableSessions(personalRefresh);
    expect(
      messages
        .filter(message => message.to === 'ExponentPushToken[ios]')
        .map(message => message.data)
    ).toMatchObject([
      { scopeKey: 'usr_1:org-1', eligibleStartedAt: '2026-08-27T10:01:00.000Z' },
      { scopeKey: 'usr_1:org-2', eligibleStartedAt: '2026-08-27T10:02:00.000Z' },
      { scopeKey: 'usr_2:personal', eligibleStartedAt: '2026-08-27T10:03:00.000Z' },
      { scopeKey: 'usr_1:personal', eligibleStartedAt: '2026-08-27T10:00:00.000Z' },
      { scopeKey: 'usr_1:personal', eligibleStartedAt: '2026-08-27T10:00:00.000Z' },
    ]);
  });

  it('preserves the interval after snapshot and delivery failures instead of clearing or replacing it', async () => {
    let current = freshSnapshot();
    let unavailable = false;
    const { createService, messages } = setupService({
      response: () => (unavailable ? new Response(null, { status: 503 }) : Response.json(current)),
    });
    await createService().refreshGlanceableSessions(personalRefresh);
    unavailable = true;
    await createService().refreshGlanceableSessions(personalRefresh);
    unavailable = false;
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-08-27T10:10:00.000Z'));
    current = freshSnapshot({ running: 0, reconnecting: 1 });
    vi.mocked(sendPushNotifications).mockRejectedValueOnce(new Error('Expo unavailable'));
    await createService().refreshGlanceableSessions(personalRefresh);
    await createService().refreshGlanceableSessions(personalRefresh);
    expect(
      messages
        .filter(message => message.to === 'ExponentPushToken[ios]')
        .map(message => message.data)
    ).toMatchObject([
      { running: 2, eligibleStartedAt: '2026-08-27T10:00:00.000Z' },
      { reconnecting: 1, eligibleStartedAt: '2026-08-27T10:00:00.000Z' },
    ]);
  });

  it('does not clear an interval from a non-authoritative zero-count response', async () => {
    let current = freshSnapshot();
    const { createService, messages } = setupService({ response: () => Response.json(current) });
    await createService().refreshGlanceableSessions(personalRefresh);
    current = freshSnapshot({ status: 'stale', running: 0, eligibleStartedAt: null });
    await createService().refreshGlanceableSessions(personalRefresh);
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-08-27T10:10:00.000Z'));
    current = freshSnapshot({ running: 0, reconnecting: 1 });
    await createService().refreshGlanceableSessions(personalRefresh);
    expect(
      messages
        .filter(message => message.to === 'ExponentPushToken[ios]')
        .map(message => message.data)
    ).toMatchObject([
      { running: 2, eligibleStartedAt: '2026-08-27T10:00:00.000Z' },
      { reconnecting: 1, eligibleStartedAt: '2026-08-27T10:00:00.000Z' },
    ]);
  });

  async function generateTestPrivateKeyPem(): Promise<string> {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    return `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
  }

  it('keeps an in-flight update timestamp below idle when the older request finishes last', async () => {
    const pem = await generateTestPrivateKeyPem();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let first = true;
    let current = freshSnapshot();
    const { createService, messages, apns } = setupService({
      response: () => Response.json(current),
      privateKey: async () => pem,
      beforeApnsResponse: async () => {
        if (first) {
          first = false;
          started.resolve();
          await release.promise;
        }
      },
    });
    const busy = createService().refreshGlanceableSessions(personalRefresh);
    await started.promise;
    current = freshSnapshot({ status: 'empty', running: 0, eligibleStartedAt: null });
    await createService().refreshGlanceableSessions(personalRefresh);
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-08-27T10:10:00.000Z'));
    release.resolve();
    await busy;
    expect(apns.map(request => request.aps.event)).toEqual(['update', 'update']);
    expect(apns.map(request => JSON.parse(request.aps['content-state'].props))).toMatchObject([
      { status: 'empty', running: 0, eligibleStartedAt: null },
      { status: 'happy', running: 2 },
    ]);
    expect(apns[1].aps.timestamp).toBeLessThan(apns[0].aps.timestamp);
    expect(messages.map(message => message.data)).toMatchObject([
      { status: 'empty', running: 0 },
      { status: 'empty', running: 0 },
    ]);
  });

  it.each([
    ['ios_push_to_start', 'credentials', 'start'],
    ['ios_push_to_start', 'signing', 'start'],
    ['ios_activity', 'credentials', 'update'],
    ['ios_activity', 'signing', 'update'],
  ] as const)('fences superseded %s delivery after delayed %s', async (kind, delayed, event) => {
    const pem = await generateTestPrivateKeyPem();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    if (delayed === 'signing') {
      const sign = crypto.subtle.sign.bind(crypto.subtle);
      vi.spyOn(crypto.subtle, 'sign').mockImplementationOnce(async (...args) => {
        started.resolve();
        await release.promise;
        return sign(...args);
      });
    }
    let first = true;
    let current = freshSnapshot();
    const { createService, messages, apns } = setupService({
      response: () => Response.json(current),
      iosTokenKind: kind,
      privateKey: async () => {
        if (delayed === 'credentials' && first) {
          first = false;
          started.resolve();
          await release.promise;
        }
        return pem;
      },
    });
    const busy = createService().refreshGlanceableSessions(personalRefresh);
    await started.promise;
    current = freshSnapshot({ status: 'empty', running: 0, eligibleStartedAt: null });
    await createService().refreshGlanceableSessions(personalRefresh);
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-08-27T10:10:00.000Z'));
    release.resolve();
    await busy;

    expect(
      apns.map(request => ({
        event: request.aps.event,
        props: JSON.parse(request.aps['content-state'].props),
      }))
    ).toEqual([
      {
        event,
        props: {
          status: 'empty',
          running: 0,
          needsInput: 0,
          reconnecting: 0,
          eligibleStartedAt: null,
        },
      },
    ]);
    expect(messages.map(message => message.data)).toMatchObject([
      { status: 'empty', running: 0, eligibleStartedAt: null },
      { status: 'empty', running: 0, eligibleStartedAt: null },
    ]);
  });

  it.each([
    ['ios', 1],
    ['android', 2],
  ] as const)(
    'fences superseded %s delivery after delayed Expo credentials',
    async (platform, delayedRead) => {
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let reads = 0;
      let current = freshSnapshot();
      const { createService, messages } = setupService({
        response: () => Response.json(current),
        expoAccessToken: async () => {
          reads += 1;
          if (reads === delayedRead) {
            started.resolve();
            await release.promise;
          }
          return 'test-expo-token';
        },
      });
      const busy = createService().refreshGlanceableSessions(personalRefresh);
      await started.promise;
      current = freshSnapshot({ status: 'empty', running: 0, eligibleStartedAt: null });
      await createService().refreshGlanceableSessions(personalRefresh);
      release.resolve();
      await busy;

      expect(
        messages
          .filter(message => message.to === `ExponentPushToken[${platform}]`)
          .map(message => message.data)
      ).toMatchObject([{ status: 'empty', running: 0, eligibleStartedAt: null }]);
    }
  );

  it('delivers distinct personal and organization scopes without attention preferences or presence', async () => {
    const { service, messages, queries, requestedScopes } = setupService();
    await service.refreshGlanceableSessions({
      userId: 'usr_1',
      cliSessionIds: ['personal', 'org-a', 'org-b', 'foreign'],
    });
    expect(requestedScopes).toEqual([
      { userId: 'usr_1', organizationId: null },
      { userId: 'usr_1', organizationId: 'org-1' },
    ]);
    expect(queries[0].sql).toContain('select "session_id", "kilo_user_id", "organization_id"');
    expect(queries[0].sql).toContain('"cli_sessions_v2"."session_id" in');
    expect(messages).toHaveLength(4);
    expect(
      messages
        .filter(message => message.to === 'ExponentPushToken[android]')
        .map(message => message.data)
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scopeKey: 'personal', organizationBound: false, running: 2 }),
        expect.objectContaining({ scopeKey: 'org-1', organizationBound: true, running: 7 }),
      ])
    );
    expect(
      messages.every(
        message => message._contentAvailable && message.sound === null && !message.body
      )
    ).toBe(true);
  });

  it('delivers the personal aggregate for a rowless session without adopting a foreign scope', async () => {
    const { service, messages, requestedScopes } = setupService();
    await service.refreshGlanceableSessions({
      userId: 'usr_1',
      cliSessionIds: ['missing', 'foreign'],
    });
    expect(requestedScopes).toEqual([{ userId: 'usr_1', organizationId: null }]);
    expect(messages.map(message => message.data)).toMatchObject([
      { scopeKey: 'personal', organizationBound: false, running: 2 },
      { scopeKey: 'personal', organizationBound: false, running: 2 },
    ]);
  });

  it('does not treat a foreign-owned row as rowless personal work', async () => {
    const { service, messages, requestedScopes } = setupService();
    await service.refreshGlanceableSessions({ userId: 'usr_1', cliSessionIds: ['foreign'] });
    expect(requestedScopes).toEqual([]);
    expect(messages).toEqual([]);
  });

  it('delivers no private counts when the snapshot route rejects revoked organization access', async () => {
    const { service, messages } = setupService({ deniedOrganizationId: 'org-1' });
    await service.refreshGlanceableSessions({
      userId: 'usr_1',
      cliSessionIds: ['personal', 'org-a'],
    });
    expect(messages).toHaveLength(2);
    expect(messages.map(message => message.data)).toEqual([
      expect.objectContaining({ scopeKey: 'personal', organizationBound: false }),
      expect.objectContaining({ scopeKey: 'personal', organizationBound: false }),
    ]);
  });

  it('does not let a failed scope suppress a successful scope', async () => {
    const { service, messages } = setupService({ failedOrganizationId: 'org-1' });
    await service.refreshGlanceableSessions({
      userId: 'usr_1',
      cliSessionIds: ['org-a', 'personal'],
    });
    expect(messages).toHaveLength(2);
    expect(messages.every(message => message.data?.scopeKey === 'personal')).toBe(true);
  });

  it('keeps a transient snapshot failure best-effort and permits the next refresh', async () => {
    let failed = true;
    const { service, messages } = setupService({
      response: () => (failed ? new Response(null, { status: 503 }) : Response.json(snapshot)),
    });
    await service.refreshGlanceableSessions({ userId: 'usr_1', cliSessionIds: ['personal'] });
    expect(messages).toEqual([]);
    failed = false;
    await service.refreshGlanceableSessions({ userId: 'usr_1', cliSessionIds: ['personal'] });
    const expected = {
      ...snapshot,
      revision: 2,
      updatedAt: '2026-08-27T10:00:00.001Z',
      expiresAt: '2026-08-27T18:00:00.001Z',
    };
    expect(messages.map(message => message.data)).toEqual([expected, expected]);
  });

  it.each([
    () => new Response(JSON.stringify(snapshot), { headers: { 'content-type': 'text/html' } }),
    () => Response.json({ ...snapshot, running: -1 }),
    () => Response.json({ ...snapshot, updatedAt: 'invalid-date' }),
    () => Response.json({ ...snapshot, expiresAt: 'invalid-date' }),
    () => Response.json({ ...snapshot, eligibleStartedAt: 'invalid-date' }),
  ])('rejects an unusable snapshot without poisoning the next refresh', async response => {
    let currentResponse = response;
    const { service, createService, messages } = setupService({
      response: () => currentResponse(),
    });
    await service.refreshGlanceableSessions(personalRefresh);
    expect(messages).toEqual([]);
    currentResponse = () => Response.json(snapshot);
    await createService().refreshGlanceableSessions(personalRefresh);
    expect(messages.map(message => message.data)).toMatchObject([
      { running: 2, eligibleStartedAt: '2026-08-27T09:00:00.000Z' },
      { running: 2, eligibleStartedAt: '2026-08-27T09:00:00.000Z' },
    ]);
  });

  it.each([true, false])(
    'preserves ordinary attention dispatch without an early aggregate (preference: %s)',
    async enabled => {
      const { messages, requestedScopes } = setupService();
      const attention: DispatchPushInput[] = [];
      vi.mocked(getWorkerDb).mockReturnValue(
        drizzle(async sql => ({
          rows: sql.includes('from "user_notification_preferences"')
            ? [[enabled, enabled, enabled, enabled, enabled, enabled, enabled]]
            : [['Attention session', null]],
        })) as never
      );
      const ctx = createExecutionContext();
      const service = new NotificationsService(ctx, {
        HYPERDRIVE: { connectionString: 'postgres://unused' },
        KILO_WEB_API_BASE_URL: 'https://snapshot.test',
        INTERNAL_API_SECRET: { get: async () => 'test-internal-secret' },
        EXPO_ACCESS_TOKEN: { get: async () => 'test-expo-token' },
        NOTIFICATION_CHANNEL_DO: {
          idFromName: (userId: string) => userId,
          get: () => ({
            dispatchPush: async (input: DispatchPushInput) => {
              attention.push(input);
              return { kind: 'delivered', tokenCount: 1 };
            },
          }),
        },
      } as never);
      const result = await service.sendCloudAgentSessionNotification({
        userId: 'usr_1',
        cliSessionId: 'personal',
        executionId: 'exec-1',
        status: 'completed',
        category: 'attention',
        body: 'Needs input',
        suppressIfViewingSession: true,
      });
      await waitOnExecutionContext(ctx);
      expect(result).toEqual(
        enabled ? { dispatched: true } : { dispatched: false, reason: 'suppressed_preference' }
      );
      expect(attention).toMatchObject(
        enabled
          ? [
              {
                presenceContext: '/presence/cli-session/personal',
                push: {
                  title: 'Attention session',
                  body: 'Needs input',
                  data: { type: 'cloud_agent_session', category: 'attention' },
                },
              },
            ]
          : []
      );
      expect(requestedScopes).toEqual([]);
      expect(messages).toEqual([]);
    }
  );

  it('rejects invalid RPC identity before any database or delivery work', async () => {
    const { service, messages, queries } = setupService();
    await expect(
      service.refreshGlanceableSessions({ userId: '', cliSessionIds: ['personal'] })
    ).rejects.toThrow();
    expect(queries).toEqual([]);
    expect(messages).toEqual([]);
  });
});

describe('apnsSendsForTokens', () => {
  it('sends update only to the activity tokens when one exists, never start to push-to-start', () => {
    expect(
      apnsSendsForTokens([
        { token: 'ptt-token', kind: 'ios_push_to_start' },
        { token: 'activity-token', kind: 'ios_activity' },
      ])
    ).toEqual([{ token: 'activity-token', event: 'update' }]);
  });

  it('sends start to the push-to-start token when no activity token exists', () => {
    expect(apnsSendsForTokens([{ token: 'ptt-token', kind: 'ios_push_to_start' }])).toEqual([
      { token: 'ptt-token', event: 'start' },
    ]);
  });

  it('sends update to every activity token when several are registered', () => {
    expect(
      apnsSendsForTokens([
        { token: 'ptt-token', kind: 'ios_push_to_start' },
        { token: 'activity-token-1', kind: 'ios_activity' },
        { token: 'activity-token-2', kind: 'ios_activity' },
      ])
    ).toEqual([
      { token: 'activity-token-1', event: 'update' },
      { token: 'activity-token-2', event: 'update' },
    ]);
  });

  it('sends nothing when no iOS token exists', () => {
    expect(apnsSendsForTokens([])).toEqual([]);
  });
});

describe('toGlanceableContentState', () => {
  it('wraps the renderable counts + status in the expo-widgets name/props envelope', () => {
    const contentState = toGlanceableContentState(snapshot);
    expect(contentState.name).toBe('ActiveAgentsLiveActivity');
    const props = JSON.parse(contentState.props) as Record<string, unknown>;
    expect(props).toEqual({
      status: 'happy',
      running: 2,
      needsInput: 1,
      reconnecting: 0,
      eligibleStartedAt: '2026-08-27T09:00:00.000Z',
    });
  });

  it('never leaks snapshot bookkeeping, ids, or titles into the pushed content-state', () => {
    const contentState = toGlanceableContentState(snapshot);
    const raw = JSON.stringify(contentState);
    expect(raw).not.toContain('schemaVersion');
    expect(raw).not.toContain('revision');
    expect(raw).not.toContain('scopeKey');
    expect(raw).not.toContain('deadbeef');
    expect(raw).not.toContain('organizationBound');
    expect(raw).not.toContain('updatedAt');
    expect(raw).not.toContain('expiresAt');
    expect(raw).not.toContain('accountEpoch');
    expect(raw).not.toContain('title');
  });
});

describe('buildGlanceableExpoMessages', () => {
  it('emits one data-only, tag-collapsed message per Expo token', () => {
    const messages = buildGlanceableExpoMessages(
      [
        { token: 'ExponentPushToken[aaa]', locale: null },
        { token: 'ExponentPushToken[bbb]', locale: 'es' },
      ],
      snapshot
    );

    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message.data).toEqual(snapshot);
      expect(message._contentAvailable).toBe(true);
      expect(message.title).toBeUndefined();
      expect(message.body).toBeUndefined();
      expect(message.sound).toBeNull();
      expect(message.priority).toBe('default');
      expect(message.channelId).toBe('active-agents');
      expect(message.tag).toBe('deadbeef');
    }
    expect(messages.map(m => m.to)).toEqual(['ExponentPushToken[aaa]', 'ExponentPushToken[bbb]']);
  });
});

describe('deliverGlanceableSnapshot', () => {
  it('skips all delivery when the snapshot cannot be built', async () => {
    const { deps, calls } = fakeDeps({ buildSnapshot: vi.fn(async () => null) });

    await deliverGlanceableSnapshot({ userId: 'u1', organizationId: null }, deps);

    expect(deps.listIosActivityTokens).not.toHaveBeenCalled();
    expect(deps.listIosExpoTokens).not.toHaveBeenCalled();
    expect(deps.hasAndroidOngoingToken).not.toHaveBeenCalled();
    expect(calls.iosSends).toHaveLength(0);
    expect(calls.expoSends).toHaveLength(0);
  });

  it('sends update only to the activity tokens when both kinds are registered', async () => {
    const iosTokens: IosActivityToken[] = [
      { token: 'ptt-token', kind: 'ios_push_to_start' },
      { token: 'activity-token', kind: 'ios_activity' },
    ];
    const { deps, calls } = fakeDeps({
      listIosActivityTokens: vi.fn(async () => iosTokens),
    });

    await deliverGlanceableSnapshot({ userId: 'u1', organizationId: 'org-1' }, deps);

    expect(calls.iosSends).toHaveLength(1);
    const [tokens, contentState] = calls.iosSends[0] as [
      { token: string; event: string }[],
      GlanceableApnsContentState,
    ];
    expect(tokens).toEqual([{ token: 'activity-token', event: 'update' }]);
    expect(contentState.name).toBe('ActiveAgentsLiveActivity');
    const props = JSON.parse(contentState.props) as Record<string, unknown>;
    expect(props.status).toBe('happy');
    expect(props.running).toBe(2);
    expect(props.needsInput).toBe(1);
    expect(props.reconnecting).toBe(0);
    expect(props).not.toHaveProperty('type');
    expect(props).not.toHaveProperty('accountEpoch');
    expect(props).not.toHaveProperty('scopeKey');
    expect(calls.expoSends).toHaveLength(0);
  });

  it('sends start to the push-to-start token when no activity token exists', async () => {
    const iosTokens: IosActivityToken[] = [{ token: 'ptt-token', kind: 'ios_push_to_start' }];
    const { deps, calls } = fakeDeps({
      listIosActivityTokens: vi.fn(async () => iosTokens),
    });

    await deliverGlanceableSnapshot({ userId: 'u1', organizationId: 'org-1' }, deps);

    expect(calls.iosSends).toHaveLength(1);
    const [tokens] = calls.iosSends[0] as [
      { token: string; event: string }[],
      GlanceableApnsContentState,
    ];
    expect(tokens).toEqual([{ token: 'ptt-token', event: 'start' }]);
    expect(calls.expoSends).toHaveLength(0);
  });

  it('skips Android when no android_ongoing activity token exists', async () => {
    const { deps, calls } = fakeDeps({
      hasAndroidOngoingToken: vi.fn(async () => false),
      listAndroidExpoTokens: vi.fn(async () => [{ token: 'ExponentPushToken[aaa]', locale: null }]),
    });

    await deliverGlanceableSnapshot({ userId: 'u1', organizationId: null }, deps);

    expect(deps.listAndroidExpoTokens).not.toHaveBeenCalled();
    expect(calls.expoSends).toHaveLength(0);
  });

  it('sends the Android Expo push only when an ongoing token and Expo tokens both exist', async () => {
    const { deps, calls } = fakeDeps({
      hasAndroidOngoingToken: vi.fn(async () => true),
      listAndroidExpoTokens: vi.fn(async () => [{ token: 'ExponentPushToken[aaa]', locale: null }]),
    });

    await deliverGlanceableSnapshot({ userId: 'u1', organizationId: null }, deps);

    expect(calls.expoSends).toHaveLength(1);
    expect(calls.expoSends[0]).toHaveLength(1);
    expect(calls.expoSends[0][0].to).toBe('ExponentPushToken[aaa]');
    expect(calls.expoSends[0][0].tag).toBe('deadbeef');
    expect(calls.expoSends[0][0]._contentAvailable).toBe(true);
  });

  it('sends nothing on Android when the user has no Expo tokens even with an ongoing token', async () => {
    const { deps, calls } = fakeDeps({
      hasAndroidOngoingToken: vi.fn(async () => true),
      listAndroidExpoTokens: vi.fn(async () => []),
    });

    await deliverGlanceableSnapshot({ userId: 'u1', organizationId: null }, deps);

    expect(deps.sendExpoPush).not.toHaveBeenCalled();
    expect(calls.expoSends).toHaveLength(0);
  });

  it('sends the data-only iOS Expo push regardless of the android_ongoing token', async () => {
    const { deps, calls } = fakeDeps({
      hasAndroidOngoingToken: vi.fn(async () => false),
      listIosExpoTokens: vi.fn(async () => [{ token: 'ExponentPushToken[ios]', locale: null }]),
    });

    await deliverGlanceableSnapshot({ userId: 'u1', organizationId: null }, deps);

    expect(deps.listIosExpoTokens).toHaveBeenCalledWith('u1', null);
    expect(calls.expoSends).toHaveLength(1);
    expect(calls.expoSends[0]).toHaveLength(1);
    expect(calls.expoSends[0][0].to).toBe('ExponentPushToken[ios]');
    expect(calls.expoSends[0][0]._contentAvailable).toBe(true);
    expect(calls.expoSends[0][0].title).toBeUndefined();
    expect(calls.expoSends[0][0].body).toBeUndefined();
  });
});
