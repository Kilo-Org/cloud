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
  idle: 0,
  updatedAt: '2026-08-27T10:00:00.000Z',
  expiresAt: '2026-08-27T18:00:00.000Z',
  needsInputSince: '2026-08-27T09:00:00.000Z',
};

function fakeDeps(overrides: Partial<GlanceableDeliveryDeps> = {}): {
  deps: GlanceableDeliveryDeps;
  calls: { iosSends: unknown[][]; expoSends: ExpoPushMessage[][] };
} {
  const calls = { iosSends: [] as unknown[][], expoSends: [] as ExpoPushMessage[][] };

  const deps: GlanceableDeliveryDeps = {
    buildSnapshot: vi.fn(async () => snapshot),
    listIosActivityTokens: vi.fn(async () => []),
    sendIosLiveActivity: vi.fn(async (_tokens, _contentState, _startAlert) => {
      calls.iosSends.push([_tokens, _contentState, _startAlert]);
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
    token: string;
    aps: {
      event: string;
      timestamp: number;
      'dismissal-date'?: number;
      'content-state': GlanceableApnsContentState;
    };
  };

  function setupService(
    options: {
      deniedOrganizationId?: string;
      failedOrganizationId?: string;
      response?: (scope: Scope) => Response | Promise<Response>;
      beforeIosTokens?: () => Promise<void>;
      iosTokenKind?: IosActivityToken['kind'];
      iosTokens?: Array<IosActivityToken & Partial<Scope>>;
      privateKey?: () => Promise<string>;
      beforeApnsDelivery?: (token: string) => Promise<void>;
      beforeApnsResponse?: (token: string) => Promise<void>;
      apnsStatus?: (token: string) => number;
      expoAccessToken?: () => Promise<string>;
    } = {}
  ) {
    const messages: ExpoPushMessage[] = [];
    const apns: ApnsPayload[] = [];
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const requestedScopes: Scope[] = [];
    const activityRows = new Map<
      string,
      Partial<Scope> & { id: string; kind: IosActivityToken['kind']; updated_at: string }
    >(
      (
        options.iosTokens ??
        (options.privateKey
          ? [{ token: 'activity-token', kind: options.iosTokenKind ?? 'ios_activity' }]
          : [])
      ).map(({ token, kind, ...scope }, index) => [
        token,
        {
          ...scope,
          id: `row-${index}`,
          kind,
          updated_at: '2026-08-27 10:00:00+00',
        },
      ])
    );
    const activities = new Map(
      [...activityRows]
        .filter(([, row]) => row.kind === 'ios_activity')
        .map(([token]) => [
          token,
          { ended: false, timestamp: 0, contentState: toGlanceableContentState(snapshot) },
        ])
    );
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
      // Honor the emitted predicates, including absent guards, rather than
      // making the fake protect rows that the real query would expose or delete.
      const matches = (column: string, value: string | null) => {
        if (sql.includes(`"${column}" is null`)) return value === null;
        const predicate = sql.match(new RegExp(`"${column}" = \\$(\\d+)`));
        return predicate === null || params[Number(predicate[1]) - 1] === value;
      };
      if (sql.startsWith('delete from "user_activity_tokens"')) {
        for (const [key, row] of activityRows) {
          if (
            matches('id', row.id) &&
            matches('token', key) &&
            matches('kind', row.kind) &&
            matches('updated_at', row.updated_at)
          ) {
            activityRows.delete(key);
          }
        }
        return { rows: [] };
      }
      if (sql.includes('from "user_activity_tokens"')) {
        if (params.includes('android_ongoing')) return { rows: [['subscription']] };
        await options.beforeIosTokens?.();
        return {
          rows: [...activityRows]
            .filter(
              ([, row]) =>
                matches('user_id', row.userId ?? 'usr_1') &&
                matches('organization_id', row.organizationId ?? null)
            )
            .map(([token, row]) => [token, row.kind, row.id, row.updated_at]),
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
      const apnsPrefix = 'https://api.push.apple.com/3/device/';
      if (url.startsWith(apnsPrefix)) {
        const token = url.slice(apnsPrefix.length);
        const request = { ...(JSON.parse(init.body) as ApnsPayload), token };
        const status = options.apnsStatus?.(token) ?? 200;
        await options.beforeApnsDelivery?.(token);
        apns.push(request);
        if (status === 200) {
          if (request.aps.event === 'start') {
            activities.set(`started-${apns.length}`, {
              ended: false,
              timestamp: request.aps.timestamp,
              contentState: request.aps['content-state'],
            });
          } else {
            const activity = activities.get(token);
            // ActivityKit never revives an ended activity, even with a newer timestamp.
            if (activity && !activity.ended && request.aps.timestamp > activity.timestamp) {
              activity.ended = request.aps.event === 'end';
              activity.timestamp = request.aps.timestamp;
              activity.contentState = request.aps['content-state'];
            }
          }
        }
        await options.beforeApnsResponse?.(token);
        return new Response(null, { status });
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
    return {
      service: createService(),
      createService,
      messages,
      apns,
      queries,
      requestedScopes,
      activityRows,
      activities,
      liveActivityProps: () =>
        [...activities.values()]
          .filter(activity => !activity.ended)
          .map(activity => JSON.parse(activity.contentState.props) as Record<string, unknown>),
    };
  }

  function freshSnapshot(overrides: Partial<ActiveAgentsGlanceable> = {}): ActiveAgentsGlanceable {
    return {
      ...snapshot,
      needsInput: 0,
      updatedAt: new Date(Date.now()).toISOString(),
      expiresAt: new Date(Date.now() + 28_800_000).toISOString(),
      needsInputSince: new Date(Date.now()).toISOString(),
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
    current = freshSnapshot({ status: 'empty', running: 0, needsInputSince: null });
    await createService().refreshGlanceableSessions(personalRefresh);
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-08-27T10:01:00.000Z'));
    release.resolve();
    await busy;
    expect(messages.map(message => message.data)).toMatchObject([
      {
        status: 'empty',
        running: 0,
        needsInputSince: null,
        updatedAt: '2026-08-27T10:00:01.000Z',
      },
      {
        status: 'empty',
        running: 0,
        needsInputSince: null,
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
    current = freshSnapshot({ status: 'empty', running: 0, needsInputSince: null });
    await createService().refreshGlanceableSessions(personalRefresh);
    release.resolve();
    await busy;
    expect(messages.map(message => message.data)).toMatchObject([
      { status: 'empty', running: 0, needsInputSince: null },
      { status: 'empty', running: 0, needsInputSince: null },
    ]);
  });

  it('keeps the revision monotonic across retry and reconstructed worker and DO instances', async () => {
    let current = freshSnapshot();
    const { service, createService, messages } = setupService({
      response: () => Response.json(current),
    });
    await service.refreshGlanceableSessions(personalRefresh);
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-08-27T10:10:00.000Z'));
    current = freshSnapshot({ running: 0, idle: 1 });
    await createService().refreshGlanceableSessions(personalRefresh);
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-08-27T10:20:00.000Z'));
    current = freshSnapshot({ running: 0, needsInput: 1 });
    await createService().refreshGlanceableSessions(personalRefresh);
    expect(
      messages
        .filter(message => message.to === 'ExponentPushToken[ios]')
        .map(message => message.data)
    ).toMatchObject([
      { running: 2, needsInputSince: '2026-08-27T10:00:00.000Z', revision: 1 },
      // The wait is read from the rows on every build, so each delivery carries
      // its own snapshot's value instead of one latched at the first emit.
      { idle: 1, needsInputSince: '2026-08-27T10:10:00.000Z', revision: 2 },
      { needsInput: 1, needsInputSince: '2026-08-27T10:20:00.000Z', revision: 3 },
    ]);
  });

  it('fences an older empty read behind the newer authoritative reads', async () => {
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
    current = freshSnapshot({ status: 'empty', running: 0, needsInputSince: null });
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
    current = freshSnapshot({ running: 0, idle: 1 });
    await createService().refreshGlanceableSessions(personalRefresh);
    expect(
      messages
        .filter(message => message.to === 'ExponentPushToken[ios]')
        .map(message => message.data)
    ).toMatchObject([
      { status: 'happy', needsInputSince: '2026-08-27T10:00:00.000Z' },
      { status: 'empty', needsInputSince: null },
      { status: 'happy', needsInputSince: '2026-08-27T10:10:00.000Z' },
      { idle: 1, needsInputSince: '2026-08-27T10:20:00.000Z' },
    ]);
  });

  it('keeps user and organization scopes separate while another scope has a deferred read', async () => {
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
      { scopeKey: 'usr_1:org-1', needsInputSince: '2026-08-27T10:01:00.000Z' },
      { scopeKey: 'usr_1:org-2', needsInputSince: '2026-08-27T10:02:00.000Z' },
      { scopeKey: 'usr_2:personal', needsInputSince: '2026-08-27T10:03:00.000Z' },
      { scopeKey: 'usr_1:personal', needsInputSince: '2026-08-27T10:00:00.000Z' },
      { scopeKey: 'usr_1:personal', needsInputSince: '2026-08-27T10:04:00.000Z' },
    ]);
  });

  it('recovers delivery after snapshot and delivery failures', async () => {
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
    current = freshSnapshot({ running: 0, idle: 1 });
    vi.mocked(sendPushNotifications).mockRejectedValueOnce(new Error('Expo unavailable'));
    await createService().refreshGlanceableSessions(personalRefresh);
    await createService().refreshGlanceableSessions(personalRefresh);
    expect(
      messages
        .filter(message => message.to === 'ExponentPushToken[ios]')
        .map(message => message.data)
    ).toMatchObject([
      { running: 2, needsInputSince: '2026-08-27T10:00:00.000Z' },
      { idle: 1, needsInputSince: '2026-08-27T10:10:00.000Z' },
    ]);
  });

  it('delivers nothing from a non-authoritative zero-count response', async () => {
    let current = freshSnapshot();
    const { createService, messages } = setupService({ response: () => Response.json(current) });
    await createService().refreshGlanceableSessions(personalRefresh);
    current = freshSnapshot({ status: 'stale', running: 0, needsInputSince: null });
    await createService().refreshGlanceableSessions(personalRefresh);
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-08-27T10:10:00.000Z'));
    current = freshSnapshot({ running: 0, idle: 1 });
    await createService().refreshGlanceableSessions(personalRefresh);
    expect(
      messages
        .filter(message => message.to === 'ExponentPushToken[ios]')
        .map(message => message.data)
    ).toMatchObject([
      { running: 2, needsInputSince: '2026-08-27T10:00:00.000Z' },
      { idle: 1, needsInputSince: '2026-08-27T10:10:00.000Z' },
    ]);
  });

  async function generateTestPrivateKeyPem(): Promise<string> {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    // `exportKey` types the return as ArrayBuffer | JsonWebKey; 'pkcs8' always yields the buffer.
    const der = new Uint8Array(
      (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer
    );
    return `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
  }

  it('ends empty work and starts later eligible work without mobile token cleanup', async () => {
    const pem = await generateTestPrivateKeyPem();
    let current = freshSnapshot({ status: 'empty', running: 0, needsInputSince: null });
    const { createService, apns, activityRows } = setupService({
      privateKey: async () => pem,
      iosTokens: [
        { token: 'scope-token', kind: 'ios_push_to_start' },
        { token: 'old-activity', kind: 'ios_activity' },
      ],
      response: () => Response.json(current),
    });
    await createService().refreshGlanceableSessions(personalRefresh);
    expect([...activityRows.keys()]).toEqual(['scope-token']);
    expect(apns[0]).toMatchObject({
      token: 'old-activity',
      aps: { event: 'end', 'dismissal-date': Date.parse('2026-08-27T10:00:08.000Z') / 1000 },
    });
    expect(JSON.parse(apns[0].aps['content-state'].props)).toEqual({
      status: 'empty',
      running: 0,
      needsInput: 0,
      idle: 0,
      needsInputSince: null,
    });

    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-08-27T10:00:01.000Z'));
    current = freshSnapshot({ running: 0, idle: 1 });
    await createService().refreshGlanceableSessions(personalRefresh);
    expect(apns.map(({ token, aps }) => [token, aps.event])).toEqual([
      ['old-activity', 'end'],
      ['scope-token', 'start'],
    ]);
    expect(JSON.parse(apns[1].aps['content-state'].props)).toMatchObject({
      idle: 1,
      needsInputSince: '2026-08-27T10:00:01.000Z',
    });
    expect([...activityRows.keys()]).toEqual(['scope-token']);
  });

  it('retires only successful ends and preserves failed targets and scope subscriptions', async () => {
    const pem = await generateTestPrivateKeyPem();
    const { service, activityRows } = setupService({
      privateKey: async () => pem,
      iosTokens: [
        { token: 'scope-token', kind: 'ios_push_to_start' },
        { token: 'ended-token', kind: 'ios_activity' },
        { token: 'failed-token', kind: 'ios_activity' },
      ],
      apnsStatus: token => (token === 'failed-token' ? 503 : 200),
      response: () =>
        Response.json(freshSnapshot({ status: 'empty', running: 0, needsInputSince: null })),
    });
    await service.refreshGlanceableSessions(personalRefresh);
    expect([...activityRows.keys()]).toEqual(['scope-token', 'failed-token']);
  });

  it.each(['identity', 'version'] as const)(
    'preserves a renewed registration %s and unrelated targets after delayed cleanup',
    async renewal => {
      const pem = await generateTestPrivateKeyPem();
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let first = true;
      let current = freshSnapshot({ status: 'empty', running: 0, needsInputSince: null });
      const { createService, activityRows, activities, liveActivityProps } = setupService({
        privateKey: async () => pem,
        iosTokens: [
          { token: 'scope-token', kind: 'ios_push_to_start' },
          { token: 'activity-token', kind: 'ios_activity' },
        ],
        beforeApnsDelivery: async () => {
          if (!first) return;
          first = false;
          started.resolve();
          await release.promise;
        },
        response: () => Response.json(current),
      });
      const ending = createService().refreshGlanceableSessions(personalRefresh);
      await started.promise;
      try {
        activityRows.set('activity-token', {
          id: renewal === 'identity' ? 'renewed-row' : 'row-1',
          kind: 'ios_activity',
          updated_at: renewal === 'version' ? '2026-08-27 10:00:01+00' : '2026-08-27 10:00:00+00',
        });
        activityRows.set('new-activity', {
          id: 'new-row',
          kind: 'ios_activity',
          updated_at: '2026-08-27 10:00:01+00',
        });
        activities.set('new-activity', {
          ended: false,
          timestamp: 0,
          contentState: toGlanceableContentState(snapshot),
        });
        vi.mocked(Date.now).mockReturnValue(Date.parse('2026-08-27T10:00:01.000Z'));
        current = freshSnapshot({ running: 0, needsInput: 1 });
        await createService().refreshGlanceableSessions(personalRefresh);
      } finally {
        release.resolve();
        await ending;
      }
      expect([...activityRows.keys()]).toEqual(['scope-token', 'activity-token', 'new-activity']);
      expect(activities.get('activity-token')?.ended).toBe(true);
      expect(liveActivityProps()).toMatchObject([{ running: 0, needsInput: 1 }]);
    }
  );

  it.each([
    ['identity', true],
    ['version', true],
    ['reregistration', true],
    ['identity', false],
    ['version', false],
    ['reregistration', false],
  ] as const)(
    'keeps the same native token retired after %s and an end-first delayed response (push-to-start: %s)',
    async (renewal, withPushToStart) => {
      const pem = await generateTestPrivateKeyPem();
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let first = true;
      let current = freshSnapshot({ status: 'empty', running: 0, needsInputSince: null });
      const renewedRow = {
        id: renewal === 'version' ? `row-${withPushToStart ? 1 : 0}` : 'renewed-row',
        kind: 'ios_activity' as const,
        updated_at: renewal === 'identity' ? '2026-08-27 10:00:00+00' : '2026-08-27 10:00:01+00',
      };
      const iosTokens: IosActivityToken[] = [];
      if (withPushToStart) iosTokens.push({ token: 'scope-token', kind: 'ios_push_to_start' });
      iosTokens.push({ token: 'old-activity', kind: 'ios_activity' });
      const { createService, apns, activityRows, activities, liveActivityProps } = setupService({
        privateKey: async () => pem,
        iosTokens,
        response: () => Response.json(current),
        beforeApnsDelivery: async token => {
          // The same native token renews after selection, before ActivityKit ends it.
          if (token === 'old-activity') activityRows.set(token, renewedRow);
        },
        beforeApnsResponse: async token => {
          if (token !== 'old-activity' || !first) return;
          first = false;
          started.resolve();
          await release.promise;
        },
      });
      const ending = createService().refreshGlanceableSessions(personalRefresh);
      await started.promise;
      try {
        expect(liveActivityProps()).toEqual([]);
        if (renewal === 'reregistration') {
          activityRows.delete('old-activity');
          await createService().refreshGlanceableSessions(personalRefresh);
          activityRows.set('old-activity', renewedRow);
        }
        if (!withPushToStart) {
          activityRows.set('live-activity', { ...renewedRow, id: 'live-row' });
          activities.set('live-activity', {
            ended: false,
            timestamp: 0,
            contentState: toGlanceableContentState(snapshot),
          });
        }
        vi.mocked(Date.now).mockReturnValue(Date.parse('2026-08-27T10:00:01.000Z'));
        current = freshSnapshot({ running: 0, needsInput: 1 });
        await createService().refreshGlanceableSessions(personalRefresh);
        expect(liveActivityProps()).toMatchObject([{ running: 0, needsInput: 1 }]);
        for (const [token, activity] of activities) {
          if (!activity.ended) {
            activityRows.set(token, { ...renewedRow, id: 'live-row' });
          }
        }
      } finally {
        release.resolve();
        await ending;
      }
      expect(activityRows.get('old-activity')).toEqual(renewedRow);
      vi.mocked(Date.now).mockReturnValue(Date.parse('2026-08-27T10:00:02.000Z'));
      current = freshSnapshot({ running: 0, idle: 1 });
      await createService().refreshGlanceableSessions(personalRefresh);
      expect(liveActivityProps()).toMatchObject([
        {
          running: 0,
          needsInput: 0,
          idle: 1,
          // Forwarded from this refresh's snapshot, not latched at the earlier one.
          needsInputSince: '2026-08-27T10:00:02.000Z',
        },
      ]);
      const liveToken = withPushToStart ? 'started-2' : 'live-activity';
      expect(apns.map(({ token, aps }) => [token, aps.event])).toEqual([
        ['old-activity', 'end'],
        withPushToStart ? ['scope-token', 'start'] : [liveToken, 'update'],
        [liveToken, 'update'],
      ]);
      expect([...activityRows.keys()]).toEqual(
        withPushToStart ? ['scope-token', 'old-activity', liveToken] : ['old-activity', liveToken]
      );
    }
  );

  it.each(['end-first', 'start-first'] as const)(
    'keeps fresh work on a live activity with %s delivery and a delayed end response',
    async arrivalOrder => {
      const pem = await generateTestPrivateKeyPem();
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let delayed = false;
      const delayEnd = async (token: string) => {
        if (token !== 'old-activity' || delayed) return;
        delayed = true;
        started.resolve();
        await release.promise;
      };
      let current = freshSnapshot({ status: 'empty', running: 0, needsInputSince: null });
      const { createService, apns, activityRows, liveActivityProps, messages } = setupService({
        privateKey: async () => pem,
        iosTokens: [
          { token: 'scope-token', kind: 'ios_push_to_start' },
          { token: 'old-activity', kind: 'ios_activity' },
        ],
        response: () => Response.json(current),
        beforeApnsDelivery: arrivalOrder === 'start-first' ? delayEnd : undefined,
        beforeApnsResponse: arrivalOrder === 'end-first' ? delayEnd : undefined,
      });
      const ending = createService().refreshGlanceableSessions(personalRefresh);
      await started.promise;
      try {
        vi.mocked(Date.now).mockReturnValue(Date.parse('2026-08-27T10:00:01.000Z'));
        current = freshSnapshot({ running: 0, needsInput: 1 });
        await createService().refreshGlanceableSessions(personalRefresh);
      } finally {
        release.resolve();
        await ending;
      }
      expect(liveActivityProps()).toEqual([
        {
          status: 'happy',
          running: 0,
          needsInput: 1,
          idle: 0,
          needsInputSince: '2026-08-27T10:00:01.000Z',
        },
      ]);
      expect([...activityRows.keys()]).toEqual(['scope-token']);
      expect(apns.map(request => request.aps.event)).toEqual(
        arrivalOrder === 'end-first' ? ['end', 'start'] : ['start', 'end']
      );
      expect(messages.map(message => message.data)).toMatchObject([
        { status: 'happy', needsInput: 1 },
        { status: 'happy', needsInput: 1 },
      ]);
    }
  );

  it('keeps other users and organizations live while a personal end response is delayed', async () => {
    const pem = await generateTestPrivateKeyPem();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let first = true;
    let current = freshSnapshot({ status: 'empty', running: 0, needsInputSince: null });
    const { createService, apns, activityRows, liveActivityProps } = setupService({
      privateKey: async () => pem,
      iosTokens: [
        { token: 'scope-token', kind: 'ios_push_to_start' },
        { token: 'old-activity', kind: 'ios_activity' },
        { token: 'org-scope', kind: 'ios_push_to_start', organizationId: 'org-1' },
        { token: 'org-activity', kind: 'ios_activity', organizationId: 'org-1' },
        { token: 'other-scope', kind: 'ios_push_to_start', userId: 'usr_2' },
        { token: 'other-activity', kind: 'ios_activity', userId: 'usr_2' },
      ],
      response: scope =>
        Response.json(
          scope.userId === 'usr_2'
            ? freshSnapshot({ running: 3 })
            : scope.organizationId === 'org-1'
              ? freshSnapshot({ running: 7, organizationBound: true })
              : current
        ),
      beforeApnsResponse: async token => {
        if (token !== 'old-activity' || !first) return;
        first = false;
        started.resolve();
        await release.promise;
      },
    });
    const ending = createService().refreshGlanceableSessions(personalRefresh);
    await started.promise;
    try {
      await createService().refreshGlanceableSessions({
        userId: 'usr_1',
        cliSessionIds: ['org-a'],
      });
      await createService().refreshGlanceableSessions({
        userId: 'usr_2',
        cliSessionIds: ['other-personal'],
      });
      current = freshSnapshot({ running: 0, needsInput: 1 });
      await createService().refreshGlanceableSessions(personalRefresh);
    } finally {
      release.resolve();
      await ending;
    }
    expect(apns.map(({ token, aps }) => [token, aps.event])).toEqual([
      ['old-activity', 'end'],
      ['org-activity', 'update'],
      ['other-activity', 'update'],
      ['scope-token', 'start'],
    ]);
    expect([...activityRows.keys()]).toEqual([
      'scope-token',
      'org-scope',
      'org-activity',
      'other-scope',
      'other-activity',
    ]);
    expect(liveActivityProps().map(props => [props.running, props.needsInput])).toEqual([
      [7, 0],
      [3, 0],
      [0, 1],
    ]);
  });

  it.each(['', 'invalid-key'])(
    'leaves a live target usable when end credentials are unusable (%s)',
    async unusableKey => {
      const pem = await generateTestPrivateKeyPem();
      let configured = false;
      let current = freshSnapshot({ status: 'empty', running: 0, needsInputSince: null });
      const { createService, apns, activityRows, liveActivityProps } = setupService({
        privateKey: async () => (configured ? pem : unusableKey),
        iosTokens: [
          { token: 'scope-token', kind: 'ios_push_to_start' },
          { token: 'activity-token', kind: 'ios_activity' },
        ],
        response: () => Response.json(current),
      });
      await createService().refreshGlanceableSessions(personalRefresh);
      expect(apns).toEqual([]);
      expect([...activityRows.keys()]).toEqual(['scope-token', 'activity-token']);
      configured = true;
      current = freshSnapshot({ running: 0, needsInput: 1 });
      await createService().refreshGlanceableSessions(personalRefresh);
      expect(liveActivityProps()).toMatchObject([{ running: 0, needsInput: 1 }]);
      expect(apns.map(({ token, aps }) => [token, aps.event])).toEqual([
        ['activity-token', 'update'],
      ]);
    }
  );

  it('recovers after a delivered end loses its HTTP response across coordinator reconstruction', async () => {
    const pem = await generateTestPrivateKeyPem();
    let current = freshSnapshot({ status: 'empty', running: 0, needsInputSince: null });
    const { createService, apns, activityRows, activities, liveActivityProps } = setupService({
      privateKey: async () => pem,
      iosTokens: [
        { token: 'scope-token', kind: 'ios_push_to_start' },
        { token: 'old-activity', kind: 'ios_activity' },
      ],
      response: () => Response.json(current),
      beforeApnsResponse: async token => {
        if (token === 'old-activity') throw new Error('Connection lost after delivery');
      },
    });
    await createService().refreshGlanceableSessions(personalRefresh);
    expect([...activityRows.keys()]).toEqual(['scope-token', 'old-activity']);
    expect(liveActivityProps()).toEqual([]);

    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-08-27T10:00:01.000Z'));
    current = freshSnapshot({ running: 0, needsInput: 1 });
    await createService().refreshGlanceableSessions(personalRefresh);
    expect(liveActivityProps()).toMatchObject([{ running: 0, needsInput: 1 }]);
    // Simulate the new activity's token registration, not cleanup of the dead token.
    for (const [token, activity] of activities) {
      if (activity.ended) continue;
      activityRows.set(token, {
        id: 'new-row',
        kind: 'ios_activity',
        updated_at: '2026-08-27 10:00:01+00',
      });
    }
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-08-27T10:00:02.000Z'));
    current = freshSnapshot({ running: 0, idle: 1 });
    await createService().refreshGlanceableSessions(personalRefresh);
    expect(liveActivityProps()).toMatchObject([
      { running: 0, needsInput: 0, idle: 1, needsInputSince: '2026-08-27T10:00:02.000Z' },
    ]);
    expect(apns.map(({ token, aps }) => [token, aps.event])).toEqual([
      ['old-activity', 'end'],
      ['scope-token', 'start'],
      ['started-2', 'update'],
    ]);
  });

  it.each([false, true])(
    'updates the live target directly after a rejected end (push-to-start: %s)',
    async withPushToStart => {
      const pem = await generateTestPrivateKeyPem();
      let rejected = true;
      let current = freshSnapshot({ status: 'empty', running: 0, needsInputSince: null });
      const iosTokens: IosActivityToken[] = [{ token: 'old-activity', kind: 'ios_activity' }];
      if (withPushToStart) iosTokens.push({ token: 'scope-token', kind: 'ios_push_to_start' });
      const { createService, apns, activityRows, liveActivityProps } = setupService({
        privateKey: async () => pem,
        iosTokens,
        response: () => Response.json(current),
        apnsStatus: () => (rejected ? 503 : 200),
      });
      await createService().refreshGlanceableSessions(personalRefresh);
      rejected = false;
      vi.mocked(Date.now).mockReturnValue(Date.parse('2026-08-27T10:00:01.000Z'));
      current = freshSnapshot({ running: 0, needsInput: 1 });
      await createService().refreshGlanceableSessions(personalRefresh);
      expect(liveActivityProps()).toMatchObject([
        { running: 0, needsInput: 1, needsInputSince: '2026-08-27T10:00:01.000Z' },
      ]);
      expect(apns.map(({ token, aps }) => [token, aps.event])).toEqual([
        ['old-activity', 'end'],
        ['old-activity', 'update'],
      ]);
      expect([...activityRows.keys()]).toEqual(iosTokens.map(({ token }) => token));
    }
  );

  it('starts fresh work after an unregistered end target across reconstruction', async () => {
    const pem = await generateTestPrivateKeyPem();
    let current = freshSnapshot({ status: 'empty', running: 0, needsInputSince: null });
    const { createService, apns, activityRows, activities, liveActivityProps } = setupService({
      privateKey: async () => pem,
      iosTokens: [
        { token: 'scope-token', kind: 'ios_push_to_start' },
        { token: 'old-activity', kind: 'ios_activity' },
      ],
      response: () => Response.json(current),
      apnsStatus: token => (token === 'old-activity' ? 410 : 200),
    });
    const oldActivity = activities.get('old-activity');
    if (!oldActivity) throw new Error('Missing native activity fixture');
    oldActivity.ended = true;
    await createService().refreshGlanceableSessions(personalRefresh);

    expect([...activityRows.keys()]).toEqual(['scope-token']);
    // A delayed registration retry cannot make the same inactive native token live.
    activityRows.set('old-activity', {
      id: 'renewed-row',
      kind: 'ios_activity',
      updated_at: '2026-08-27 10:00:01+00',
    });
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-08-27T10:00:01.000Z'));
    current = freshSnapshot({ running: 0, needsInput: 1 });
    await createService().refreshGlanceableSessions(personalRefresh);
    expect(liveActivityProps()).toMatchObject([{ running: 0, needsInput: 1 }]);
    expect(apns.map(({ token, aps }) => [token, aps.event])).toEqual([
      ['old-activity', 'end'],
      ['scope-token', 'start'],
    ]);
  });

  it.each([
    ['older', 'lost'],
    ['older', 'accepted'],
    ['newer', 'lost'],
    ['newer', 'accepted'],
  ] as const)(
    'keeps the other end obligation when the %s attempt rejects (%s response)',
    async (rejectedAttempt, otherResponse) => {
      const pem = await generateTestPrivateKeyPem();
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const rejectedIndex = rejectedAttempt === 'older' ? 1 : 2;
      let requests = 0;
      let responses = 0;
      let current = freshSnapshot({ status: 'empty', running: 0, needsInputSince: null });
      const { createService, apns, activityRows, activities, liveActivityProps } = setupService({
        privateKey: async () => pem,
        iosTokens: [
          { token: 'scope-token', kind: 'ios_push_to_start' },
          { token: 'old-activity', kind: 'ios_activity' },
        ],
        response: () => Response.json(current),
        apnsStatus: token => {
          if (token !== 'old-activity') return 200;
          requests += 1;
          return requests === rejectedIndex ? 503 : 200;
        },
        beforeApnsResponse: async token => {
          if (token !== 'old-activity') return;
          const response = ++responses;
          if (response === 1) {
            started.resolve();
            await release.promise;
          }
          if (response !== rejectedIndex) {
            if (otherResponse === 'lost') throw new Error('Connection lost after delivery');
            // Keep the same token registered after successful version-guarded cleanup.
            activityRows.set(token, {
              id: 'renewed-row',
              kind: 'ios_activity',
              updated_at: '2026-08-27 10:00:01+00',
            });
          }
        },
      });
      const firstEnd = createService().refreshGlanceableSessions(personalRefresh);
      await started.promise;
      try {
        await createService().refreshGlanceableSessions(personalRefresh);
        if (rejectedAttempt === 'older') {
          release.resolve();
          await firstEnd;
        }
        current = freshSnapshot({ running: 0, needsInput: 1 });
        await createService().refreshGlanceableSessions(personalRefresh);
        expect(liveActivityProps()).toMatchObject([{ running: 0, needsInput: 1 }]);
      } finally {
        release.resolve();
        await firstEnd;
      }
      expect(activityRows.has('old-activity')).toBe(true);
      for (const [token, activity] of activities) {
        if (!activity.ended) {
          activityRows.set(token, {
            id: 'live-row',
            kind: 'ios_activity',
            updated_at: '2026-08-27 10:00:01+00',
          });
        }
      }
      current = freshSnapshot({ running: 0, idle: 1 });
      await createService().refreshGlanceableSessions(personalRefresh);
      expect(liveActivityProps()).toMatchObject([{ running: 0, needsInput: 0, idle: 1 }]);
      expect(apns.map(({ token, aps }) => [token, aps.event])).toEqual([
        ['old-activity', 'end'],
        ['old-activity', 'end'],
        ['scope-token', 'start'],
        ['started-3', 'update'],
      ]);
    }
  );

  it('releases both rejected end attempts when the older response completes last', async () => {
    const pem = await generateTestPrivateKeyPem();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let first = true;
    let rejected = true;
    let current = freshSnapshot({ status: 'empty', running: 0, needsInputSince: null });
    const { createService, apns, liveActivityProps } = setupService({
      privateKey: async () => pem,
      iosTokens: [
        { token: 'scope-token', kind: 'ios_push_to_start' },
        { token: 'old-activity', kind: 'ios_activity' },
      ],
      response: () => Response.json(current),
      apnsStatus: () => (rejected ? 503 : 200),
      beforeApnsResponse: async () => {
        if (!first) return;
        first = false;
        started.resolve();
        await release.promise;
      },
    });
    const firstEnd = createService().refreshGlanceableSessions(personalRefresh);
    await started.promise;
    try {
      await createService().refreshGlanceableSessions(personalRefresh);
    } finally {
      release.resolve();
      await firstEnd;
    }
    rejected = false;
    current = freshSnapshot({ running: 0, needsInput: 1 });
    await createService().refreshGlanceableSessions(personalRefresh);
    expect(liveActivityProps()).toMatchObject([{ running: 0, needsInput: 1 }]);
    expect(apns.map(request => request.aps.event)).toEqual(['end', 'end', 'update']);
  });

  it('keeps a native end obligation across scope renewal and a rejected attempt', async () => {
    const pem = await generateTestPrivateKeyPem();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let first = true;
    let rejected = false;
    let current = freshSnapshot({ status: 'empty', running: 0, needsInputSince: null });
    const { createService, apns, activityRows, liveActivityProps } = setupService({
      privateKey: async () => pem,
      iosTokens: [
        { token: 'old-activity', kind: 'ios_activity' },
        { token: 'org-scope', kind: 'ios_push_to_start', organizationId: 'org-1' },
      ],
      response: scope =>
        Response.json({
          ...current,
          scopeKey: scope.organizationId ?? 'personal',
          organizationBound: scope.organizationId !== null,
        }),
      apnsStatus: () => (rejected ? 503 : 200),
      beforeApnsResponse: async () => {
        if (!first) return;
        first = false;
        started.resolve();
        await release.promise;
      },
    });
    const firstEnd = createService().refreshGlanceableSessions(personalRefresh);
    await started.promise;
    try {
      activityRows.set('old-activity', {
        id: 'row-0',
        kind: 'ios_activity',
        organizationId: 'org-1',
        updated_at: '2026-08-27 10:00:01+00',
      });
      rejected = true;
      // Both scopes use revision 1. Rejection in one must not release the other's end.
      await createService().refreshGlanceableSessions({
        userId: 'usr_1',
        cliSessionIds: ['org-a'],
      });
      rejected = false;
      current = freshSnapshot({ running: 0, needsInput: 1 });
      await createService().refreshGlanceableSessions({
        userId: 'usr_1',
        cliSessionIds: ['org-a'],
      });
      expect(liveActivityProps()).toMatchObject([{ running: 0, needsInput: 1 }]);
    } finally {
      release.resolve();
      await firstEnd;
    }
    expect([...activityRows.keys()]).toEqual(['old-activity', 'org-scope']);
    expect(apns.map(({ token, aps }) => [token, aps.event])).toEqual([
      ['old-activity', 'end'],
      ['old-activity', 'end'],
      ['org-scope', 'start'],
    ]);
  });

  it('retries a rejected end without starting an empty activity', async () => {
    const pem = await generateTestPrivateKeyPem();
    let rejected = true;
    let current = freshSnapshot({ status: 'empty', running: 0, needsInputSince: null });
    const { createService, apns, activityRows, liveActivityProps } = setupService({
      privateKey: async () => pem,
      iosTokens: [
        { token: 'scope-token', kind: 'ios_push_to_start' },
        { token: 'old-activity', kind: 'ios_activity' },
      ],
      response: () => Response.json(current),
      apnsStatus: () => (rejected ? 503 : 200),
    });
    await createService().refreshGlanceableSessions(personalRefresh);
    expect([...activityRows.keys()]).toEqual(['scope-token', 'old-activity']);
    rejected = false;
    await createService().refreshGlanceableSessions(personalRefresh);
    expect(liveActivityProps()).toEqual([]);
    expect([...activityRows.keys()]).toEqual(['scope-token']);
    current = freshSnapshot({ running: 0, needsInput: 1 });
    await createService().refreshGlanceableSessions(personalRefresh);
    expect(liveActivityProps()).toMatchObject([{ running: 0, needsInput: 1 }]);
    expect(apns.map(request => request.aps.event)).toEqual(['end', 'end', 'start']);
  });

  it('fences a terminal send delayed during credentials after fresh work arrives', async () => {
    const pem = await generateTestPrivateKeyPem();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let first = true;
    let current = freshSnapshot({ status: 'empty', running: 0, needsInputSince: null });
    const { createService, apns, activityRows } = setupService({
      response: () => Response.json(current),
      privateKey: async () => {
        if (first) {
          first = false;
          started.resolve();
          await release.promise;
        }
        return pem;
      },
    });
    const ending = createService().refreshGlanceableSessions(personalRefresh);
    await started.promise;
    current = freshSnapshot({ running: 0, needsInput: 1 });
    await createService().refreshGlanceableSessions(personalRefresh);
    release.resolve();
    await ending;
    expect(apns.map(request => request.aps.event)).toEqual(['update']);
    expect(JSON.parse(apns[0].aps['content-state'].props)).toMatchObject({
      status: 'happy',
      needsInput: 1,
    });
    expect([...activityRows.keys()]).toEqual(['activity-token']);
  });

  it('keeps an in-flight update timestamp below idle when the older request finishes last', async () => {
    const pem = await generateTestPrivateKeyPem();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let first = true;
    let current = freshSnapshot();
    const { createService, messages, apns } = setupService({
      response: () => Response.json(current),
      privateKey: async () => pem,
      beforeApnsDelivery: async () => {
        if (first) {
          first = false;
          started.resolve();
          await release.promise;
        }
      },
    });
    const busy = createService().refreshGlanceableSessions(personalRefresh);
    await started.promise;
    current = freshSnapshot({ status: 'empty', running: 0, needsInputSince: null });
    await createService().refreshGlanceableSessions(personalRefresh);
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-08-27T10:10:00.000Z'));
    release.resolve();
    await busy;
    expect(apns.map(request => request.aps.event)).toEqual(['end', 'update']);
    expect(apns.map(request => JSON.parse(request.aps['content-state'].props))).toMatchObject([
      { status: 'empty', running: 0, needsInputSince: null },
      { status: 'happy', running: 2 },
    ]);
    expect(apns[1].aps.timestamp).toBeLessThan(apns[0].aps.timestamp);
    expect(messages.map(message => message.data)).toMatchObject([
      { status: 'empty', running: 0 },
      { status: 'empty', running: 0 },
    ]);
  });

  it.each([
    ['ios_push_to_start', 'credentials', null],
    ['ios_push_to_start', 'signing', null],
    ['ios_activity', 'credentials', 'end'],
    ['ios_activity', 'signing', 'end'],
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
    current = freshSnapshot({ status: 'empty', running: 0, needsInputSince: null });
    await createService().refreshGlanceableSessions(personalRefresh);
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-08-27T10:10:00.000Z'));
    release.resolve();
    await busy;

    expect(
      apns.map(request => ({
        event: request.aps.event,
        props: JSON.parse(request.aps['content-state'].props),
      }))
    ).toEqual(
      event === null
        ? []
        : [
            {
              event,
              props: {
                status: 'empty',
                running: 0,
                needsInput: 0,
                idle: 0,
                needsInputSince: null,
              },
            },
          ]
    );
    expect(messages.map(message => message.data)).toMatchObject([
      { status: 'empty', running: 0, needsInputSince: null },
      { status: 'empty', running: 0, needsInputSince: null },
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
      current = freshSnapshot({ status: 'empty', running: 0, needsInputSince: null });
      await createService().refreshGlanceableSessions(personalRefresh);
      release.resolve();
      await busy;

      expect(
        messages
          .filter(message => message.to === `ExponentPushToken[${platform}]`)
          .map(message => message.data)
      ).toMatchObject([{ status: 'empty', running: 0, needsInputSince: null }]);
    }
  );

  it('delivers distinct personal and organization scopes without attention preferences or presence', async () => {
    const { service, messages, queries, requestedScopes } = setupService();
    await service.refreshGlanceableSessions({
      userId: 'usr_1',
      cliSessionIds: ['personal', 'org-a', 'org-b', 'foreign'],
    });
    // The two scopes are independent surfaces and fan out concurrently, so
    // assert the set, never the completion order.
    expect(requestedScopes).toHaveLength(2);
    expect(requestedScopes).toEqual(
      expect.arrayContaining([
        { userId: 'usr_1', organizationId: null },
        { userId: 'usr_1', organizationId: 'org-1' },
      ])
    );
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
    () => Response.json({ ...snapshot, needsInputSince: 'invalid-date' }),
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
      { running: 2, needsInputSince: '2026-08-27T09:00:00.000Z' },
      { running: 2, needsInputSince: '2026-08-27T09:00:00.000Z' },
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
      apnsSendsForTokens(
        [
          { token: 'ptt-token', kind: 'ios_push_to_start' },
          { token: 'activity-token', kind: 'ios_activity' },
        ],
        true
      )
    ).toEqual([{ token: 'activity-token', event: 'update' }]);
  });

  it('sends start to the push-to-start token when no activity token exists', () => {
    expect(apnsSendsForTokens([{ token: 'ptt-token', kind: 'ios_push_to_start' }], true)).toEqual([
      { token: 'ptt-token', event: 'start' },
    ]);
  });

  it.each([
    [true, 'update'],
    [false, 'end'],
  ] as const)(
    'sends the eligible=%s event to every activity without starting another',
    (eligible, event) => {
      expect(
        apnsSendsForTokens(
          [
            { token: 'ptt-token', kind: 'ios_push_to_start' },
            { token: 'activity-token-1', kind: 'ios_activity' },
            { token: 'activity-token-2', kind: 'ios_activity' },
          ],
          eligible
        )
      ).toEqual([
        { token: 'activity-token-1', event },
        { token: 'activity-token-2', event },
      ]);
    }
  );

  it('does not start an activity for empty work', () => {
    expect(apnsSendsForTokens([{ token: 'ptt-token', kind: 'ios_push_to_start' }], false)).toEqual(
      []
    );
    expect(apnsSendsForTokens([], true)).toEqual([]);
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
      idle: 0,
      needsInputSince: '2026-08-27T09:00:00.000Z',
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
  it.each([0, 1, 3])(
    'emits badge %i in one data-only, collapsed message per Expo token',
    needsInput => {
      const messages = buildGlanceableExpoMessages(
        [
          { token: 'ExponentPushToken[aaa]', locale: null },
          { token: 'ExponentPushToken[bbb]', locale: 'es' },
        ],
        { ...snapshot, needsInput }
      );

      expect(messages).toHaveLength(2);
      for (const message of messages) {
        expect(message.data).toEqual({ ...snapshot, needsInput });
        expect(message.badge).toBe(needsInput);
        expect(message._contentAvailable).toBe(true);
        expect(message.title).toBeUndefined();
        expect(message.body).toBeUndefined();
        expect(message.sound).toBeNull();
        expect(message.priority).toBe('default');
        expect(message.channelId).toBe('active-agents');
        expect(message.tag).toBe('deadbeef');
        expect(message.collapseId).toBe('deadbeef');
      }
      expect(messages.map(m => m.to)).toEqual(['ExponentPushToken[aaa]', 'ExponentPushToken[bbb]']);
    }
  );
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

  it('keeps the badge unchanged after transport failure and sends the latest count on retry', async () => {
    const latestSnapshot = { ...snapshot, needsInput: 4 };
    const delivered: ExpoPushMessage[] = [];
    const { deps } = fakeDeps({
      buildSnapshot: vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValueOnce(latestSnapshot),
      listIosExpoTokens: vi.fn(async () => [{ token: 'ExponentPushToken[aaa]', locale: null }]),
      sendExpoPush: vi
        .fn()
        .mockRejectedValueOnce(new Error('transport down'))
        .mockImplementationOnce(async messages => {
          delivered.push(...messages);
        }),
    });

    await expect(
      deliverGlanceableSnapshot({ userId: 'u1', organizationId: null }, deps)
    ).rejects.toThrow('transport down');
    expect(delivered).toHaveLength(0);

    await deliverGlanceableSnapshot({ userId: 'u1', organizationId: null }, deps);
    expect(delivered.map(message => message.badge)).toEqual([4]);
    expect(vi.mocked(deps.sendExpoPush).mock.calls[1][0][0].badge).toBe(4);
  });

  it('sends update only to the activity tokens when both kinds are registered', async () => {
    const iosTokens: IosActivityToken[] = [
      { token: 'ptt-token', kind: 'ios_push_to_start' },
      { token: 'activity-token', kind: 'ios_activity' },
    ];
    const { deps, calls } = fakeDeps({
      listIosActivityTokens: vi.fn(async () =>
        iosTokens.map((token, index) => ({
          ...token,
          id: `row-${index}`,
          updated_at: snapshot.updatedAt,
        }))
      ),
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
    expect(props.idle).toBe(0);
    expect(props).not.toHaveProperty('type');
    expect(props).not.toHaveProperty('accountEpoch');
    expect(props).not.toHaveProperty('scopeKey');
    expect(calls.expoSends).toHaveLength(0);
  });

  it('sends start to the push-to-start token when no activity token exists', async () => {
    const iosTokens: IosActivityToken[] = [{ token: 'ptt-token', kind: 'ios_push_to_start' }];
    const { deps, calls } = fakeDeps({
      listIosActivityTokens: vi.fn(async () =>
        iosTokens.map((token, index) => ({
          ...token,
          id: `row-${index}`,
          updated_at: snapshot.updatedAt,
        }))
      ),
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

  it('translates the push-to-start alert with the locale on the iOS Expo rows', async () => {
    const { deps, calls } = fakeDeps({
      listIosActivityTokens: vi.fn(async () => [
        {
          token: 'start-token',
          kind: 'ios_push_to_start' as const,
          id: 'row-0',
          updated_at: '2026-08-27 10:00:00+00',
        },
      ]),
      listIosExpoTokens: vi.fn(async () => [
        { token: 'ExponentPushToken[a]', locale: null },
        { token: 'ExponentPushToken[b]', locale: 'de' },
      ]),
    });

    await deliverGlanceableSnapshot({ userId: 'u1', organizationId: null }, deps);

    expect(calls.iosSends[0][2]).toEqual({
      title: 'Kilo',
      body: 'Aktive Agenten haben ein Update',
    });
  });

  it('falls back to English when no iOS Expo row carries a locale', async () => {
    const { deps, calls } = fakeDeps({
      listIosActivityTokens: vi.fn(async () => [
        {
          token: 'start-token',
          kind: 'ios_push_to_start' as const,
          id: 'row-0',
          updated_at: '2026-08-27 10:00:00+00',
        },
      ]),
      listIosExpoTokens: vi.fn(async () => [{ token: 'ExponentPushToken[a]', locale: null }]),
    });

    await deliverGlanceableSnapshot({ userId: 'u1', organizationId: null }, deps);

    expect(calls.iosSends[0][2]).toEqual({
      title: 'Kilo',
      body: 'Active agents have an update',
    });
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
