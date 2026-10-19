import { describe, expect, it, vi } from 'vitest';

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
      nativeSubscriber: unknown;
      eventQueries: unknown;
      sessionId: string;
      deriveSessionStatus: () => unknown;
    };
    Object.assign(session, {
      initialized: Promise.resolve(),
      registration: { spec: { kiloSessionId: KILO_SESSION_ID } },
      sessionId: SESSION_ID,
      nativeSubscriber: null,
      deriveSessionStatus: () => ({ type: 'idle' }),
    });
    return session;
  }

  it('distinguishes missing registration from an empty log and fences stale releases', async () => {
    const session = attachmentUnit();
    Object.assign(session, { eventQueries: { getLatestEventId: () => null } });
    expect(
      await session.subscribeNativeEvents({ kiloSessionId: KILO_SESSION_ID, attachmentId: 'old' })
    ).toMatchObject({ registered: true, fence: null });
    await session.subscribeNativeEvents({ kiloSessionId: KILO_SESSION_ID, attachmentId: 'new' });
    await session.releaseNativeEvents({ attachmentId: 'old' });
    expect(session.nativeSubscriber).not.toBeNull();
    await session.releaseNativeEvents({ attachmentId: 'old' });
    expect(session.nativeSubscriber).not.toBeNull();
    await session.releaseNativeEvents({ attachmentId: 'new' });
    expect(session.nativeSubscriber).toBeNull();
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
