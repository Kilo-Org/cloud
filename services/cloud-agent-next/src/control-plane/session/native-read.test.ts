import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));
vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    ctx: unknown;
    env: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import type {
  ControlPlaneControlResult,
  ControlPlaneKiloRequestInput,
} from '../../shared/control-plane-protocol.js';
import {
  SandboxSessionV2,
  CONTROL_PLANE_NATIVE_SNAPSHOT_MAX_BYTES,
  type NativeSnapshotCursor,
} from './session-do.js';
import type { EventQueryFilters } from '../../session/queries/events.js';
import { createNativeEventOutbox } from './native-outbox.js';
import {
  NATIVE_DELIVERY_LIMITS,
  toNativePublicEvent,
} from '../../kilo-facade/native-event-source.js';

const SESSION_ID = 'workspace_11111111-1111-4111-8111-111111111111';
const SANDBOX_ID = 'ses-11111111111141118111111111111111';
const KILO_SESSION_ID = 'ses_12345678901234567890123456';

type NativeRequestUnit = {
  initialized: Promise<void>;
  sessionId: string;
  registration: unknown;
  route: unknown;
  metadata?: { repository: { upstreamBranch?: string } };
  sandboxPeer: () => unknown;
  sandboxPeerFor?: (sandboxId: string) => unknown;
  kiloRequest: (operation: { name: string }) => Promise<ControlPlaneControlResult>;
};

/**
 * Unit-level seam test for the Session DO native read. The route identity must
 * come from the DO's own registration and a stopped route must never prepare.
 */
function unit(overrides: { routeState?: 'ready' | 'unknown' | 'failed'; peer?: unknown }) {
  const session = Object.create(SandboxSessionV2.prototype) as NativeRequestUnit;
  session.initialized = Promise.resolve();
  session.sessionId = SESSION_ID;
  session.registration = {
    sandboxId: SANDBOX_ID,
    spec: {
      kiloSessionId: KILO_SESSION_ID,
      directory: '/workspace/private/root',
    },
  };
  session.route = { state: overrides.routeState ?? 'ready', attemptId: 'attempt_1' };
  session.sandboxPeer = () => overrides.peer ?? null;
  return session;
}

describe('SandboxSessionV2.kiloRequest', () => {
  it('forwards an allowlisted read using the registered route identity', async () => {
    const kiloRequest = vi.fn(
      async (_input: ControlPlaneKiloRequestInput): Promise<ControlPlaneControlResult> => ({
        ok: true,
        result: [{ id: 'todo_1', content: 'x', status: 'pending', priority: 'low' }],
      })
    );
    const session = unit({ peer: { kiloRequest } });
    await expect(session.kiloRequest({ name: 'session.todo' })).resolves.toMatchObject({
      ok: true,
    });
    // The caller names only the operation. Neither a session id, directory, nor
    // URL is accepted, so a caller cannot reach a sibling route.
    expect(kiloRequest).toHaveBeenCalledWith({
      session: {
        sessionId: SESSION_ID,
        kiloSessionId: KILO_SESSION_ID,
        directory: '/workspace/private/root',
      },
      operation: { name: 'session.todo' },
    });
  });

  it('returns not_ready for a stopped route without waking compute', async () => {
    const kiloRequest = vi.fn();
    const session = unit({ routeState: 'unknown', peer: { kiloRequest } });
    await expect(session.kiloRequest({ name: 'session.status' })).resolves.toEqual({
      ok: false,
      error: { code: 'not_ready', message: 'Live runtime is not ready', retryable: true },
    });
    expect(kiloRequest).not.toHaveBeenCalled();
  });

  it('derives the diff base from stored repository metadata rather than the caller', async () => {
    const kiloRequest = vi.fn(async () => ({ ok: true, result: [] }));
    const session = unit({ peer: { kiloRequest } });
    session.metadata = { repository: { upstreamBranch: 'main' } };
    await session.kiloRequest({ name: 'session.diff', baseRef: 'refs/heads/untrusted' } as never);
    expect(kiloRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: { name: 'session.diff', baseRef: 'refs/remotes/origin/main' },
      })
    );
  });

  it.each(['refs/pull/123/head', 'refs/merge-requests/99/head', 'refs/heads/main'])(
    'uses the default remote diff base for a full-ref upstream %s',
    async upstreamBranch => {
      const kiloRequest = vi.fn(async () => ({ ok: true, result: [] }));
      const session = unit({ peer: { kiloRequest } });
      session.metadata = { repository: { upstreamBranch } };
      await session.kiloRequest({ name: 'session.diff', baseRef: 'refs/heads/untrusted' } as never);
      expect(kiloRequest).toHaveBeenCalledWith(
        expect.objectContaining({ operation: { name: 'session.diff' } })
      );
    }
  );

  it('returns not_found without a registration', async () => {
    const session = unit({});
    session.registration = null;
    await expect(session.kiloRequest({ name: 'session.get' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });

  it('rejects an operation outside the allowlist', async () => {
    const kiloRequest = vi.fn();
    const session = unit({ peer: { kiloRequest } });
    await expect(session.kiloRequest({ name: 'shell.exec' } as never)).rejects.toBeTruthy();
    expect(kiloRequest).not.toHaveBeenCalled();
  });
});

describe('native durable attachment', () => {
  function attachmentUnit() {
    const session = Object.create(SandboxSessionV2.prototype) as Pick<
      SandboxSessionV2,
      'nativeSnapshot' | 'subscribeNativeEvents' | 'releaseNativeEvents'
    > & {
      initialized: Promise<void>;
      registration: unknown;
      nativeOutbox: ReturnType<typeof createNativeEventOutbox>;
      nativeDeliveryGeneration: number;
      eventQueries: unknown;
      sessionId: string;
      deriveSessionStatus: () => unknown;
      clearSessionInMemoryState: () => void;
      preparationRecorders: Map<string, unknown>;
    };
    Object.assign(session, {
      initialized: Promise.resolve(),
      registration: { spec: { kiloSessionId: KILO_SESSION_ID } },
      sessionId: SESSION_ID,
      nativeDeliveryGeneration: 1,
      nativeOutbox: createNativeEventOutbox({
        identity: () => ({
          kiloUserId: 'owner',
          cloudAgentSessionId: SESSION_ID,
          kiloSessionId: KILO_SESSION_ID,
        }),
        generation: () => 1,
        send: async () => undefined,
        waitUntil: vi.fn(),
        diagnostic: vi.fn(),
      }),
      deriveSessionStatus: () => ({ type: 'idle' }),
      preparationRecorders: new Map(),
    });
    return session;
  }

  afterEach(() => vi.useRealTimers());

  it('closes queued native transport before teardown clears its identity and supports fresh registration', async () => {
    vi.useFakeTimers();
    const session = attachmentUnit();
    const send = vi.fn(async () => undefined);
    const work: Promise<void>[] = [];
    const identity = vi.fn(() => {
      if (session.registration === null) throw new Error('identity disappeared');
      return {
        kiloUserId: 'owner',
        cloudAgentSessionId: SESSION_ID,
        kiloSessionId: KILO_SESSION_ID,
      };
    });
    session.nativeOutbox = createNativeEventOutbox({
      identity,
      generation: () => 1,
      send,
      waitUntil: promise => work.push(promise),
      diagnostic: vi.fn(),
    });
    session.nativeOutbox.subscribe('deleted');
    session.nativeOutbox.enqueue({
      eventId: 1,
      event: { type: 'message.updated', properties: {} },
    });
    session.clearSessionInMemoryState();
    expect(session.registration).toBeNull();
    expect(session.nativeOutbox.snapshot()).toMatchObject({ count: 0, bytes: 0, subscriptions: 0 });
    expect(vi.getTimerCount()).toBe(0);
    await expect(Promise.all(work)).resolves.toEqual([undefined]);
    expect(identity).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    session.registration = { spec: { kiloSessionId: KILO_SESSION_ID } };
    session.eventQueries = { getLatestEventId: () => 0 };
    await session.subscribeNativeEvents({ kiloSessionId: KILO_SESSION_ID, attachmentId: 'fresh' });
    session.nativeOutbox.enqueue({
      eventId: 2,
      event: { type: 'message.updated', properties: {} },
    });
    await vi.runAllTimersAsync();
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([70, 128, 240])(
    'replays a %s KiB durable native event without a resnapshot loop',
    async kib => {
      const session = attachmentUnit();
      const row = {
        id: 1,
        session_id: SESSION_ID,
        execution_id: 'execution',
        stream_event_type: 'kilocode',
        timestamp: 1700000000000,
        payload: JSON.stringify({
          event: 'message.part.updated',
          properties: { text: '\u00e9'.repeat((kib * 1024) / 2) },
        }),
      };
      session.eventQueries = {
        getLatestEventId: () => 1,
        *iterateByFilters(filters: EventQueryFilters) {
          if (filters.materialized === undefined && (filters.fromId ?? 0) < 1) yield row;
        },
      };
      const page = await session.nativeSnapshot({});
      expect(page.oversized).toBe(false);
      expect(page.continuation).toBeUndefined();
      expect(page.events).toHaveLength(1);
      const event = page.events[0];
      if (event === undefined) throw new Error('expected snapshot event');
      expect(toNativePublicEvent(event, KILO_SESSION_ID)?.properties.text).toBe(
        '\u00e9'.repeat((kib * 1024) / 2)
      );
      expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(
        NATIVE_DELIVERY_LIMITS.batchBytes
      );
    }
  );

  it('permits a maximum-sized public event despite the larger escaped storage envelope', async () => {
    const session = attachmentUnit();
    const payload = { event: 'message.part.updated', properties: { text: '' } };
    const overhead = new TextEncoder().encode(
      JSON.stringify(toNativePublicEvent({ data: payload }, KILO_SESSION_ID))
    ).byteLength;
    payload.properties.text = '\n'.repeat(
      Math.floor((NATIVE_DELIVERY_LIMITS.eventBytes - overhead) / 2)
    );
    const remaining =
      NATIVE_DELIVERY_LIMITS.eventBytes -
      new TextEncoder().encode(
        JSON.stringify(toNativePublicEvent({ data: payload }, KILO_SESSION_ID))
      ).byteLength;
    payload.properties.text += 'x'.repeat(remaining);
    expect(
      new TextEncoder().encode(
        JSON.stringify(toNativePublicEvent({ data: payload }, KILO_SESSION_ID))
      ).byteLength
    ).toBe(NATIVE_DELIVERY_LIMITS.eventBytes);
    const row = {
      id: 1,
      session_id: SESSION_ID,
      execution_id: 'execution',
      stream_event_type: 'kilocode',
      timestamp: 1700000000000,
      payload: JSON.stringify(payload),
    };
    session.eventQueries = {
      getLatestEventId: () => 1,
      *iterateByFilters(filters: EventQueryFilters) {
        if (filters.materialized === undefined) yield row;
      },
    };
    const page = await session.nativeSnapshot({});
    expect(page.oversized).toBe(false);
    expect(page.events).toHaveLength(1);
    expect(new TextEncoder().encode(JSON.stringify(page.events[0])).byteLength).toBeGreaterThan(
      CONTROL_PLANE_NATIVE_SNAPSHOT_MAX_BYTES
    );
    expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(
      NATIVE_DELIVERY_LIMITS.batchBytes
    );
    row.payload = JSON.stringify({
      ...payload,
      properties: { text: payload.properties.text + 'x' },
    });
    await expect(session.nativeSnapshot({})).resolves.toEqual({
      oversized: true,
      fence: 1,
      events: [],
    });
  });

  it('returns the existing typed oversized snapshot outcome above the event maximum without truncation', async () => {
    const session = attachmentUnit();
    const row = {
      id: 1,
      session_id: SESSION_ID,
      execution_id: 'execution',
      stream_event_type: 'kilocode',
      timestamp: 1700000000000,
      payload: JSON.stringify({
        event: 'message.part.updated',
        properties: { text: 'x'.repeat(NATIVE_DELIVERY_LIMITS.eventBytes) },
      }),
    };
    session.eventQueries = {
      getLatestEventId: () => 1,
      *iterateByFilters() {
        yield row;
      },
    };
    await expect(session.nativeSnapshot({})).resolves.toEqual({
      oversized: true,
      fence: 1,
      events: [],
    });
  });

  it('distinguishes missing registration from an empty log and fences stale releases', async () => {
    const session = attachmentUnit();
    Object.assign(session, { eventQueries: { getLatestEventId: () => null } });
    expect(
      await session.subscribeNativeEvents({ kiloSessionId: KILO_SESSION_ID, attachmentId: 'old' })
    ).toMatchObject({ registered: true, fence: null });
    await session.subscribeNativeEvents({ kiloSessionId: KILO_SESSION_ID, attachmentId: 'new' });
    await session.releaseNativeEvents({ attachmentId: 'old' });
    expect(session.nativeOutbox.snapshot().subscriptions).toBe(1);
    await session.releaseNativeEvents({ attachmentId: 'old' });
    expect(session.nativeOutbox.snapshot().subscriptions).toBe(1);
    await session.releaseNativeEvents({ attachmentId: 'new' });
    expect(session.nativeOutbox.snapshot().subscriptions).toBe(0);
    Object.assign(session, { registration: null });
    expect(
      await session.subscribeNativeEvents({
        kiloSessionId: KILO_SESSION_ID,
        attachmentId: 'missing',
      })
    ).toMatchObject({ registered: false });
  });

  it('paginates UTF-8 bytes through log, updates and removals with independent exclusive positions', async () => {
    const session = attachmentUnit();
    const rows = Array.from({ length: 6 }, (_, index) => ({
      id: index + 1,
      session_id: SESSION_ID,
      execution_id: 'execution',
      stream_event_type: 'kilocode',
      timestamp: 1700000000000,
      payload: JSON.stringify({
        event: index < 4 ? 'message.updated' : 'message.removed',
        properties: { text: '\u00e9'.repeat(60000) },
      }),
    }));
    const filtersSeen: EventQueryFilters[] = [];
    Object.assign(session, {
      eventQueries: {
        getLatestEventId: () => 6,
        *iterateByFilters(filters: EventQueryFilters) {
          filtersSeen.push(filters);
          yield* rows.filter(
            row =>
              row.id > (filters.fromId ?? 0) &&
              row.id <= (filters.toId ?? Infinity) &&
              (filters.materialized === undefined ||
                (filters.materialized === 'updates' ? row.id <= 4 : row.id > 4))
          );
        },
      },
    });
    let continuation: NativeSnapshotCursor | undefined;
    const ids: number[] = [];
    let pages = 0;
    do {
      const page = await session.nativeSnapshot({ fromId: 3, continuation });
      expect(page.oversized).toBe(false);
      expect(page.fence).toBe(6);
      expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(
        CONTROL_PLANE_NATIVE_SNAPSHOT_MAX_BYTES
      );
      expect(
        page.events.reduce(
          (bytes, event) => bytes + new TextEncoder().encode(JSON.stringify(event)).byteLength,
          0
        )
      ).toBeLessThanOrEqual(CONTROL_PLANE_NATIVE_SNAPSHOT_MAX_BYTES);
      ids.push(...page.events.map(event => event.eventId));
      continuation = page.continuation;
      expect(++pages).toBeLessThan(20);
    } while (continuation !== undefined);
    expect(ids).toEqual([4, 5, 6, 1, 2, 3, 4, 5, 6]);
    expect(filtersSeen.some(filter => filter.materialized === 'updates')).toBe(true);
    expect(filtersSeen.some(filter => filter.materialized === 'removals')).toBe(true);
  });
});
