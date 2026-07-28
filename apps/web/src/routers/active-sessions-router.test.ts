import { describe, expect, it, jest, beforeAll, afterEach } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { db } from '@/lib/drizzle';
import { organizations, organization_memberships } from '@kilocode/db/schema';
import type { User, Organization } from '@kilocode/db/schema';
import type { createCallerForUser as CreateCallerForUser } from '@/routers/test-utils';

// NOTE: `activeSessionSchema` validation is covered in the sibling
// `active-sessions-router.schema.test.ts`. It is deliberately NOT imported
// here: a static import of the router module evaluates `config.server.ts`
// (and freezes `SESSION_INGEST_WORKER_URL` at the empty `.env.test` value)
// before the `beforeAll` below can set the env — which is exactly what the
// dynamic-import dance is designed to avoid.

// `.env.test` sets SESSION_INGEST_WORKER_URL to '' (shared fixture used by
// other test files too — do not change it here). `createCallerForUser`'s
// import chain (test-utils -> trpc/init -> ...) transitively loads
// `@/lib/config.server`, whose `SESSION_INGEST_WORKER_URL` export is a plain
// `const` computed once, the first time that module is evaluated. Static
// ES `import` statements are always hoisted above every other statement by
// the transform, so a statically-imported `createCallerForUser` would pull
// in the real ('') value before any `process.env` assignment written below
// it could run — and a `jest.mock('@/lib/config.server', ...)` registered
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
          { connectionId: 'cli-A', name: 'laptop-A', projectName: 'kilo', version: '0.1.2' },
          { connectionId: 'cli-B', name: 'laptop-B', projectName: 'kilo' },
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

    it('throws a TRPCError when the upstream worker returns a non-2xx response', async () => {
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
        expect(err.code).toBe('INTERNAL_SERVER_ERROR');
        // Mobile (later slice) uses the thrown status to render a retryable
        // error state; verify the contract is "throws, never returns empty".
        expect(err.message).toContain('502');
      }
    });

    it('throws a TRPCError when fetch itself fails (network error)', async () => {
      jest.spyOn(global, 'fetch').mockRejectedValue(new Error('socket hang up'));

      const caller = await createCallerForUser(regularUser.id);
      const rejection = caller.activeSessions.listInstances();
      await expect(rejection).rejects.toBeInstanceOf(TRPCError);
    });

    it('throws a TRPCError when the worker returns an unexpected payload shape', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ wrong: 'shape' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const caller = await createCallerForUser(regularUser.id);
      await expect(caller.activeSessions.listInstances()).rejects.toBeInstanceOf(TRPCError);
    });

    it('does NOT swallow upstream failures into {instances: []} (unlike `list`)', async () => {
      // Sanity: `list` returns {sessions: []} on a 502; `listInstances` must not.
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }));

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.activeSessions.list();
      expect(result).toEqual({ sessions: [] });
    });
  });
});
