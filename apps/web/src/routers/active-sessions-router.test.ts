import { describe, expect, it, jest, beforeAll, afterEach } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  cli_sessions_v2,
  github_branch_pull_requests,
  organizations,
  organization_memberships,
} from '@kilocode/db/schema';
import type { User, Organization } from '@kilocode/db/schema';
import type { createCallerForUser as CreateCallerForUser } from '@/routers/test-utils';
import { CONTROL_PLANE_UPSTREAM_BUDGET_MS } from '@/lib/bounded-service-fetch';

// NOTE: `activeSessionSchema` validation is covered in the sibling
// `active-sessions-router.schema.test.ts`. It is deliberately NOT imported
// here: a static import of the router module evaluates `config.server.ts`
// (and freezes `SESSION_INGEST_WORKER_URL` at the empty `.env.test` value)
// before the `beforeAll` below can set the env — which is exactly what the
// dynamic-import dance is designed to avoid.

// `.env.test` sets SESSION_INGEST_WORKER_URL to '' (shared fixture used by
// other test files too — do not change it here). `createCallerForUser`'s
// import chain (test-utils -> trpc/init -> ...) transitively loads
// `@kilocode/web-shared/lib/config.server`, whose `SESSION_INGEST_WORKER_URL` export is a plain
// `const` computed once, the first time that module is evaluated. Static
// ES `import` statements are always hoisted above every other statement by
// the transform, so a statically-imported `createCallerForUser` would pull
// in the real ('') value before any `process.env` assignment written below
// it could run — and a `jest.mock('@kilocode/web-shared/lib/config.server', ...)` registered
// after that first (real) load cannot retroactively change the value
// active-sessions-router.ts already captured. A dynamic `import()` executes
// exactly where it is awaited (not hoisted), so resolving it in `beforeAll`
// — after the env var is set below — lets `config.server.ts` pick up the
// test value on its one evaluation, without the repo-lint-forbidden
// `require()`.
process.env.SESSION_INGEST_WORKER_URL = 'https://test-ingest.example.com';
let createCallerForUser: typeof CreateCallerForUser;

let regularUser: User;
let testOrganization: Organization;

const boundedTokenFlag = 'BOUNDED_INTERNAL_SERVICE_TOKENS_ENABLED';
const originalBoundedTokenFlag = process.env[boundedTokenFlag];

function restoreBoundedTokenFlag() {
  if (originalBoundedTokenFlag === undefined) {
    delete process.env[boundedTokenFlag];
  } else {
    process.env[boundedTokenFlag] = originalBoundedTokenFlag;
  }
}

function authorizationToken(fetchSpy: jest.SpiedFunction<typeof fetch>): string {
  const init = fetchSpy.mock.calls[0]?.[1];
  const authorization = new Headers(init?.headers).get('authorization');
  expect(authorization).toMatch(/^Bearer .+$/);
  if (!authorization) throw new Error('expected authorization header');
  return authorization.slice('Bearer '.length);
}

async function expectMintFailure(
  mint: Promise<unknown>,
  code: TRPCError['code'],
  message: string
): Promise<void> {
  const error = await mint.then(
    () => undefined,
    (rejection: unknown) => rejection
  );
  expect(error).toBeInstanceOf(TRPCError);
  expect(error).toMatchObject({ code, message });
}

function expectSessionIngestAssertion(
  token: string,
  secret: string,
  enabled: boolean
): jwt.JwtPayload {
  const claims = jwt.verify(token, secret, { algorithms: ['HS256'] });
  if (typeof claims === 'string') throw new Error('expected JWT claims');

  expect(claims.exp! - claims.iat!).toBe(60 * 60);
  expect(claims.organizationId).toBeUndefined();
  expect(claims.apiTokenPepper).toBeUndefined();
  expect(claims.env).toBeUndefined();
  if (enabled) {
    expect(claims).toMatchObject({
      aud: 'session-ingest',
      tokenPurpose: 'internal-service',
      credentialExchange: false,
    });
  } else {
    expect(claims.aud).toBeUndefined();
    expect(claims.tokenPurpose).toBeUndefined();
    expect(claims.credentialExchange).toBeUndefined();
  }
  return claims;
}

describe('active-sessions-router', () => {
  beforeAll(async () => {
    ({ createCallerForUser } = await import('@/routers/test-utils'));

    regularUser = await insertTestUser({
      google_user_email: 'active-sessions-user@example.com',
      google_user_name: 'Active Sessions User',
      is_admin: false,
    });

    const [org] = await db
      .insert(organizations)
      .values({
        name: 'Active Sessions Test Org',
        created_by_kilo_user_id: regularUser.id,
      })
      .returning();
    testOrganization = org;

    await db.insert(organization_memberships).values({
      organization_id: testOrganization.id,
      kilo_user_id: regularUser.id,
      role: 'owner',
    });
    // kilocode_change - the dynamic `import()` above (needed so
    // `process.env.SESSION_INGEST_WORKER_URL` is set before
    // `config.server.ts` evaluates it — see the comment above the env
    // assignment) resolves a module graph on its first hit rather than
    // reusing a build-time-hoisted static import, which can push this
    // hook past Jest's default 5s under full-suite parallel load even
    // though it is comfortably fast in isolation. Give it real headroom
    // rather than a fragile default.
  }, 15_000);

  afterEach(() => {
    jest.restoreAllMocks();
    restoreBoundedTokenFlag();
  });

  describe.each([
    { name: 'disabled', enabled: false },
    { name: 'enabled', enabled: true },
  ])('bounded Session Ingest assertions when issuance is $name', ({ enabled }) => {
    beforeEach(() => {
      if (enabled) {
        process.env[boundedTokenFlag] = 'true';
      } else {
        delete process.env[boundedTokenFlag];
      }
    });

    it.each([
      {
        name: 'mintWebTicket',
        path: '/api/user/web-ticket',
        response: { ticket: 'opaque-web-ticket', expiresAt: 1_700_000_060 },
        invoke: (caller: Awaited<ReturnType<typeof createCallerForUser>>) =>
          caller.activeSessions.createWebTicket(),
      },
      {
        name: 'list',
        path: '/api/sessions/active',
        response: { sessions: [] },
        invoke: (caller: Awaited<ReturnType<typeof createCallerForUser>>) =>
          caller.activeSessions.list(),
      },
      {
        name: 'listInstances',
        path: '/api/instances/active',
        response: { instances: [] },
        invoke: (caller: Awaited<ReturnType<typeof createCallerForUser>>) =>
          caller.activeSessions.listInstances(),
      },
    ])('signs the $name request with the expected claims', async ({ path, response, invoke }) => {
      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      const { NEXTAUTH_SECRET } = await import('@kilocode/web-shared/lib/config.server');
      const caller = await createCallerForUser(regularUser.id);

      const result = await invoke(caller);

      expect(fetchSpy.mock.calls[0]?.[0]).toBe(`https://test-ingest.example.com${path}`);
      const token = authorizationToken(fetchSpy);
      expectSessionIngestAssertion(token, NEXTAUTH_SECRET, enabled);
      if (path === '/api/user/web-ticket') {
        expect(result).toEqual({ token: 'opaque-web-ticket', expiresAt: 1_700_000_060 });
        expect(() => jwt.verify('opaque-web-ticket', NEXTAUTH_SECRET)).toThrow();
      }
    });
  });

  describe('web ticket minting', () => {
    it('mints a one-use ticket and returns { token, expiresAt }', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ ticket: 'ticket-abc', expiresAt: 1_700_000_060 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.activeSessions.getToken();

      expect(result).toEqual({ token: 'ticket-abc', expiresAt: 1_700_000_060 });

      const [calledUrl, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
      expect(calledUrl).toBe('https://test-ingest.example.com/api/user/web-ticket');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>).Authorization).toContain('Bearer ');
    });

    it('mints the same ticket through the createWebTicket mutation', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ ticket: 'ticket-abc', expiresAt: 1_700_000_060 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const caller = await createCallerForUser(regularUser.id);

      await expect(caller.activeSessions.createWebTicket()).resolves.toEqual({
        token: 'ticket-abc',
        expiresAt: 1_700_000_060,
      });
    });

    it('throws SERVICE_UNAVAILABLE when fetch itself fails (network error)', async () => {
      jest.spyOn(global, 'fetch').mockRejectedValue(new Error('socket hang up'));

      const caller = await createCallerForUser(regularUser.id);

      await expectMintFailure(
        caller.activeSessions.createWebTicket(),
        'SERVICE_UNAVAILABLE',
        'Session ingest is unavailable'
      );
    });

    it('throws SERVICE_UNAVAILABLE when the worker does not answer inside the budget', async () => {
      let fetchCalled: () => void = () => {};
      const fetchStarted = new Promise<void>(resolve => {
        fetchCalled = resolve;
      });
      jest.spyOn(global, 'fetch').mockImplementation(() => {
        fetchCalled();
        return new Promise<Response>(() => {});
      });
      const caller = await createCallerForUser(regularUser.id);

      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
      try {
        const rejection = caller.activeSessions.createWebTicket();
        const failure = expectMintFailure(
          rejection,
          'SERVICE_UNAVAILABLE',
          'Session ingest is unavailable'
        );
        await fetchStarted;
        await jest.advanceTimersByTimeAsync(CONTROL_PLANE_UPSTREAM_BUDGET_MS);
        await failure;
      } finally {
        jest.useRealTimers();
      }
    });

    it.each([500, 401])('throws BAD_GATEWAY when the worker answers %i', async status => {
      jest.spyOn(global, 'fetch').mockResolvedValue(new Response('upstream failed', { status }));

      const caller = await createCallerForUser(regularUser.id);

      await expectMintFailure(
        caller.activeSessions.createWebTicket(),
        'BAD_GATEWAY',
        `Session ingest failed to mint a ticket (status ${status})`
      );
    });

    it.each([503, 504])(
      'keeps the worker %i retryable instead of flattening it into a gateway error',
      async status => {
        jest.spyOn(global, 'fetch').mockResolvedValue(new Response('upstream failed', { status }));

        const caller = await createCallerForUser(regularUser.id);

        await expectMintFailure(
          caller.activeSessions.createWebTicket(),
          'SERVICE_UNAVAILABLE',
          'Session ingest is unavailable'
        );
      }
    );

    it.each([
      ['a malformed', JSON.stringify({ ticket: '', expiresAt: 'not-a-number' })],
      ['a non-JSON', '<html>gateway</html>'],
    ])('throws BAD_GATEWAY when the worker returns %s 200 body', async (_label, body) => {
      jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const caller = await createCallerForUser(regularUser.id);

      await expectMintFailure(
        caller.activeSessions.createWebTicket(),
        'BAD_GATEWAY',
        'Invalid ticket response from session ingest'
      );
    });

    it('reports a 200 body that never completes as SERVICE_UNAVAILABLE', async () => {
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(new ReadableStream({ start() {} }), { status: 200 }));
      const caller = await createCallerForUser(regularUser.id);

      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
      try {
        const rejection = caller.activeSessions.createWebTicket();
        const failure = expectMintFailure(
          rejection,
          'SERVICE_UNAVAILABLE',
          'Session ingest is unavailable'
        );
        await jest.advanceTimersByTimeAsync(CONTROL_PLANE_UPSTREAM_BUDGET_MS);
        await failure;
      } finally {
        jest.useRealTimers();
      }
    });

    it('reports a 200 body that fails mid-transfer as SERVICE_UNAVAILABLE', async () => {
      // The transfer is torn down after the headers (a reset connection or a
      // premature close), so the read rejects with a stream error rather than a
      // timeout. That is the same transport failure the fetch stage maps to
      // SERVICE_UNAVAILABLE, not a malformed body.
      jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(
          new ReadableStream({
            pull() {
              throw new Error('network error');
            },
          }),
          { status: 200 }
        )
      );
      const caller = await createCallerForUser(regularUser.id);

      await expectMintFailure(
        caller.activeSessions.createWebTicket(),
        'SERVICE_UNAVAILABLE',
        'Session ingest is unavailable'
      );
    });
  });

  describe('listInstances', () => {
    it('returns the instances from the worker when the upstream call succeeds', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            instances: [
              { connectionId: 'cli-A', name: 'laptop-A', projectName: 'kilo', version: '0.1.2' },
              { connectionId: 'cli-B', name: 'laptop-B', projectName: 'kilo' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.activeSessions.listInstances();

      expect(result).toEqual({
        instances: [
          {
            connectionId: 'cli-A',
            name: 'laptop-A',
            projectName: 'kilo',
            version: '0.1.2',
            kind: 'cli',
            startedAt: null,
            gitBranch: null,
          },
          {
            connectionId: 'cli-B',
            name: 'laptop-B',
            projectName: 'kilo',
            kind: 'cli',
            startedAt: null,
            gitBranch: null,
          },
        ],
      });
      // Verify it actually called the worker with the right path.
      const calledUrl = fetchSpy.mock.calls[0][0] as unknown as string;
      expect(calledUrl).toBe('https://test-ingest.example.com/api/instances/active');
    });

    it('returns the empty `instances` array when the worker has no live CLIs', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ instances: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.activeSessions.listInstances();
      expect(result).toEqual({ instances: [] });
    });

    it('passes through capabilities when the worker advertises them', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            instances: [
              {
                connectionId: 'cli-cap',
                name: 'laptop-cap',
                projectName: 'kilo',
                capabilities: { attachments: true },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.activeSessions.listInstances();
      expect(result).toEqual({
        instances: [
          {
            connectionId: 'cli-cap',
            name: 'laptop-cap',
            projectName: 'kilo',
            kind: 'cli',
            startedAt: null,
            gitBranch: null,
            capabilities: { attachments: true },
          },
        ],
      });
    });

    it('keeps capabilities absent when the worker omits them (legacy CLI)', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            instances: [{ connectionId: 'cli-legacy', name: 'laptop-legacy', projectName: 'kilo' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.activeSessions.listInstances();
      expect(result).toEqual({
        instances: [
          {
            connectionId: 'cli-legacy',
            name: 'laptop-legacy',
            projectName: 'kilo',
            kind: 'cli',
            startedAt: null,
            gitBranch: null,
          },
        ],
      });
      expect(result.instances[0]).not.toHaveProperty('capabilities');
    });

    it.each([
      {
        kind: 'remote',
        startedAt: '2026-08-28T19:30:00.123Z',
        gitBranch: 'feature/metadata-routing',
      },
      { kind: 'cli', startedAt: null, gitBranch: null },
    ])('preserves $kind metadata and every existing instance field', async metadata => {
      const instance = {
        connectionId: 'cli-metadata',
        name: 'laptop-metadata',
        projectName: 'kilo',
        version: '0.1.2',
        capabilities: { attachments: true, sessionClone: true, sessionCloneAtMessage: true },
        ...metadata,
      };
      jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ instances: [instance] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const caller = await createCallerForUser(regularUser.id);
      await expect(caller.activeSessions.listInstances()).resolves.toEqual({
        instances: [instance],
      });
    });

    it.each([
      { kind: 'cloud' },
      { kind: null },
      { startedAt: 'not-a-date' },
      { startedAt: '2026-08-28T19:30:00Z' },
      { startedAt: '2026-08-28T19:30:00.1234Z' },
      { startedAt: '2026-08-28T19:30:00.123+00:00' },
      { gitBranch: 'a'.repeat(25) },
      { gitBranch: 42 },
    ])('rejects invalid instance metadata %j instead of returning empty', async metadata => {
      jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            instances: [
              {
                connectionId: 'cli-invalid',
                name: 'laptop-invalid',
                projectName: 'kilo',
                ...metadata,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const caller = await createCallerForUser(regularUser.id);
      await expect(caller.activeSessions.listInstances()).rejects.toMatchObject({
        code: 'BAD_GATEWAY',
        cause: expect.objectContaining({ name: 'ZodError' }),
      });
    });

    it('throws BAD_GATEWAY when the upstream worker returns a non-2xx response', async () => {
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response('upstream failed', { status: 502 }));

      const caller = await createCallerForUser(regularUser.id);
      const rejection = caller.activeSessions.listInstances();
      await expect(rejection).rejects.toBeInstanceOf(TRPCError);
      try {
        await rejection;
      } catch (err) {
        if (!(err instanceof TRPCError)) throw err;
        expect(err.code).toBe('BAD_GATEWAY');
        // Mobile uses the thrown status to render a retryable error state;
        // verify the contract is "throws, never returns empty".
        expect(err.message).toContain('502');
      }
    });

    it('throws SERVICE_UNAVAILABLE when fetch itself fails (network error)', async () => {
      jest.spyOn(global, 'fetch').mockRejectedValue(new Error('socket hang up'));

      const caller = await createCallerForUser(regularUser.id);

      await expect(caller.activeSessions.listInstances()).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Session ingest is unavailable',
      });
    });

    it('throws BAD_GATEWAY when the worker returns an unexpected payload shape', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ wrong: 'shape' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const caller = await createCallerForUser(regularUser.id);

      await expect(caller.activeSessions.listInstances()).rejects.toMatchObject({
        code: 'BAD_GATEWAY',
        message: 'Invalid instance response from session ingest',
      });
    });

    it.each([503, 504])('keeps the worker %i retryable as SERVICE_UNAVAILABLE', async status => {
      jest.spyOn(global, 'fetch').mockResolvedValue(new Response('upstream failed', { status }));

      const caller = await createCallerForUser(regularUser.id);

      await expect(caller.activeSessions.listInstances()).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Session ingest is unavailable',
      });
    });

    it('answers a 503 with a stalled body without waiting for the body read', async () => {
      // A worker that sends the 503 status line and then never finishes the
      // body: its `pull` never resolves, so any read of it would hang. The
      // status alone decides the answer, so the procedure must settle on that
      // instead of spending the rest of the poll's budget on a body it will not
      // use.
      const cancel = jest.fn(async () => undefined);
      const stream = new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => {}),
        cancel,
      });
      // Reading the body takes it over through `getReader`; the release is a
      // plain `cancel`, so the reader must never appear.
      const getReader = jest.spyOn(stream, 'getReader');
      const stalled = new Response(stream, { status: 503 });
      jest.spyOn(global, 'fetch').mockResolvedValue(stalled);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const caller = await createCallerForUser(regularUser.id);

      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
      try {
        const rejection = caller.activeSessions.listInstances();
        // No timer advance at all: settling here proves the answer came from
        // the status line, not from the budget expiring.
        await expect(rejection).rejects.toMatchObject({
          code: 'SERVICE_UNAVAILABLE',
          message: 'Session ingest is unavailable',
        });
        // The body was never read, and it was released instead of being left
        // checked out: `cancel` disturbs it (hence `bodyUsed`), which is what
        // ends the transfer, and it ran exactly once.
        expect(getReader).not.toHaveBeenCalled();
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(stalled.bodyUsed).toBe(true);
        expect(jest.getTimerCount()).toBe(0);
        // Status only: the 503 log line carries no excerpt argument.
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toMatch(/^\[active-sessions\.instances\] non-2xx: 503/);
        expect(warn.mock.calls[0]?.length).toBe(1);
      } finally {
        jest.useRealTimers();
        warn.mockRestore();
      }
    });

    it('reports a body that never completes as SERVICE_UNAVAILABLE instead of hanging', async () => {
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(new ReadableStream({ start() {} }), { status: 200 }));
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const caller = await createCallerForUser(regularUser.id);

      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
      try {
        const rejection = caller.activeSessions.listInstances();
        const assertion = expect(rejection).rejects.toMatchObject({
          code: 'SERVICE_UNAVAILABLE',
          message: 'Session ingest is unavailable',
        });
        await jest.advanceTimersByTimeAsync(CONTROL_PLANE_UPSTREAM_BUDGET_MS);
        await assertion;
      } finally {
        jest.useRealTimers();
        warn.mockRestore();
      }
    });

    it('reports a body that fails mid-transfer as SERVICE_UNAVAILABLE', async () => {
      // The upstream sends headers and then the transfer breaks (a reset
      // connection or a premature close). `reader.read()` rejects with a
      // TypeError, which is the same transport failure the fetch stage maps to
      // SERVICE_UNAVAILABLE — not a malformed body, so not BAD_GATEWAY.
      jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(
          new ReadableStream({
            pull() {
              throw new Error('network error');
            },
          }),
          { status: 200 }
        )
      );
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      const caller = await createCallerForUser(regularUser.id);

      try {
        await expect(caller.activeSessions.listInstances()).rejects.toMatchObject({
          code: 'SERVICE_UNAVAILABLE',
          message: 'Session ingest is unavailable',
        });
      } finally {
        warn.mockRestore();
      }
    });

    it('logs a bounded excerpt of a non-2xx body instead of the whole payload', async () => {
      const longRun = 'x'.repeat(500);
      jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ error: longRun }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      const caller = await createCallerForUser(regularUser.id);
      await expect(caller.activeSessions.listInstances()).rejects.toMatchObject({
        code: 'BAD_GATEWAY',
      });

      const logged = warn.mock.calls[0];
      // `Response` constructed in-process carries no status text; the status
      // alone is the report.
      expect(logged[0]).toMatch(/^\[active-sessions\.instances\] non-2xx: 500/);
      const excerpt = logged[1];
      expect(typeof excerpt).toBe('string');
      expect((excerpt as string).length).toBeLessThanOrEqual(200);
      for (const argument of logged) {
        expect(String(argument)).not.toContain(longRun);
      }
    });

    it('logs a capped excerpt of a non-2xx non-JSON body', async () => {
      // The upstream error body is unclassified text, so a JSON-only read would
      // add no note at all for an HTML error page. The excerpt is the first 200
      // characters of whatever the body is.
      const longRun = 'y'.repeat(500);
      jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(`<html>${longRun}</html>`, {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        })
      );
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      const caller = await createCallerForUser(regularUser.id);
      await expect(caller.activeSessions.listInstances()).rejects.toMatchObject({
        code: 'BAD_GATEWAY',
      });

      const logged = warn.mock.calls[0];
      expect(logged[0]).toMatch(/^\[active-sessions\.instances\] non-2xx: 502/);
      const excerpt = logged[1];
      expect(typeof excerpt).toBe('string');
      expect((excerpt as string).length).toBeLessThanOrEqual(200);
      expect(excerpt as string).toContain('<html>');
      for (const argument of logged) {
        expect(String(argument)).not.toContain(longRun);
      }
    });

    it('reports a 502 as SERVICE_UNAVAILABLE for list and BAD_GATEWAY for listInstances', async () => {
      jest
        .spyOn(global, 'fetch')
        .mockImplementation(() => Promise.resolve(new Response('bad gateway', { status: 502 })));

      const caller = await createCallerForUser(regularUser.id);

      await expect(caller.activeSessions.list()).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Session ingest is unavailable',
      });
      await expect(caller.activeSessions.listInstances()).rejects.toMatchObject({
        code: 'BAD_GATEWAY',
      });
    });
  });

  describe('list enrichment associatedPr', () => {
    const sessionWithPr = 'ses_active_pr_present_0001';
    const sessionWithoutPr = 'ses_active_pr_absent_0001';
    const sessionBranchOnly = 'ses_active_pr_branch_only_0001';
    const CACHE_GIT_URL = 'https://github.com/kilo/active-provenance-repo';

    beforeEach(async () => {
      await db.insert(cli_sessions_v2).values([
        {
          session_id: sessionWithPr,
          kilo_user_id: regularUser.id,
          created_on_platform: 'cli',
          title: 'active with PR',
          git_url: CACHE_GIT_URL,
          git_branch: 'feature/active-x',
          platform: 'github',
          pr_url: 'https://github.com/kilo/active-provenance-repo/pull/42',
          pr_number: 42,
          pr_head_ref: 'feature/active-x',
          pr_link_verified_at: '2026-01-01T00:00:00.000Z',
        },
        {
          session_id: sessionWithoutPr,
          kilo_user_id: regularUser.id,
          created_on_platform: 'cli',
          title: 'active without PR',
          git_url: CACHE_GIT_URL,
          git_branch: 'feature/active-y',
        },
        {
          // Same repo + branch as the cache row but no verified link of its own.
          session_id: sessionBranchOnly,
          kilo_user_id: regularUser.id,
          created_on_platform: 'cli',
          title: 'active branch only',
          git_url: CACHE_GIT_URL,
          git_branch: 'feature/active-x',
        },
      ]);
      await db.insert(github_branch_pull_requests).values({
        git_url: CACHE_GIT_URL,
        git_branch: 'feature/active-x',
        owned_by_user_id: regularUser.id,
        pr_url: 'https://github.com/kilo/active-provenance-repo/pull/42',
        pr_number: 42,
        pr_state: 'open',
        pr_title: 'Active PR title',
        pr_head_sha: 'beefcafe',
      });
    });

    afterEach(async () => {
      await db
        .delete(github_branch_pull_requests)
        .where(
          and(
            eq(github_branch_pull_requests.git_url, CACHE_GIT_URL),
            eq(github_branch_pull_requests.owned_by_user_id, regularUser.id)
          )
        );
      await db
        .delete(cli_sessions_v2)
        .where(
          and(
            eq(cli_sessions_v2.kilo_user_id, regularUser.id),
            eq(cli_sessions_v2.git_url, CACHE_GIT_URL)
          )
        );
    });

    async function mockHeartbeats(sessionIds: string[]) {
      jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            sessions: sessionIds.map(id => ({
              id,
              status: 'live',
              title: `heartbeat ${id}`,
              connectionId: `conn-${id}`,
            })),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
    }

    it('includes associatedPr number and title for a joined cache PR', async () => {
      await mockHeartbeats([sessionWithPr, sessionWithoutPr]);

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.activeSessions.list();

      const withPr = result.sessions.find(s => s.id === sessionWithPr);
      expect(withPr?.associatedPr).toMatchObject({ number: 42, title: 'Active PR title' });
    });

    it('omits associatedPr for a row without a cache PR', async () => {
      await mockHeartbeats([sessionWithPr, sessionWithoutPr]);

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.activeSessions.list();

      const withoutPr = result.sessions.find(s => s.id === sessionWithoutPr);
      expect(withoutPr).toBeDefined();
      expect(withoutPr).not.toHaveProperty('associatedPr');
    });

    it('omits associatedPr for a session with no verified link even on a branch with a cache row', async () => {
      await mockHeartbeats([sessionBranchOnly]);

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.activeSessions.list();

      const branchOnly = result.sessions.find(s => s.id === sessionBranchOnly);
      expect(branchOnly).toBeDefined();
      expect(branchOnly).not.toHaveProperty('associatedPr');
    });
  });
});
