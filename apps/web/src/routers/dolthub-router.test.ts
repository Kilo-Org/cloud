// Mock config.server so dolthub-service imports don't fail on missing env vars
import type * as ConfigServerModule from '@/lib/config.server';
jest.mock('@/lib/config.server', () => {
  const actual = jest.requireActual<typeof ConfigServerModule>('@/lib/config.server');
  return {
    ...actual,
    DOLTHUB_APP_CLIENT_ID: 'dolthub-client-id-test',
    DOLTHUB_APP_CLIENT_SECRET: 'dolthub-client-secret-test',
  };
});

// Don't actually send Sentry events from the test suite — `getDoltHubUser`
// emits warnings when DoltHub is unreachable / returns malformed payloads,
// and the resolveUsername / verifyUpstream tests exercise both happy and
// unhappy paths. We only override the two capture helpers — the rest of
// the module (notably `trpcMiddleware`) must come through actual so the
// trpc init at `lib/trpc/init.ts` keeps working.
jest.mock('@sentry/nextjs', () => ({
  ...jest.requireActual<object>('@sentry/nextjs'),
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));

import { describe, test, expect, beforeAll, afterEach } from '@jest/globals';
import type { User } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { platform_integrations } from '@kilocode/db/schema';
import { eq, and } from 'drizzle-orm';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { PLATFORM, INTEGRATION_STATUS } from '@/lib/integrations/core/constants';

describe('dolthubRouter', () => {
  const originalFetch = globalThis.fetch;
  let user: User;

  beforeAll(async () => {
    user = await insertTestUser({
      google_user_email: 'dolthub-router-test@example.com',
      google_user_name: 'DoltHub Router Test',
    });
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await db
      .delete(platform_integrations)
      .where(
        and(
          eq(platform_integrations.platform, PLATFORM.DOLTHUB),
          eq(platform_integrations.owned_by_user_id, user.id)
        )
      );
  });

  describe('getInstallation', () => {
    test('returns the persisted row when present', async () => {
      await db.insert(platform_integrations).values({
        owned_by_user_id: user.id,
        owned_by_organization_id: null,
        platform: PLATFORM.DOLTHUB,
        integration_type: 'oauth',
        integration_status: INTEGRATION_STATUS.ACTIVE,
        scopes: ['api_read_write'],
        metadata: { access_token: 'token' },
        installed_at: new Date().toISOString(),
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.dolthub.getInstallation();
      expect(result.installed).toBe(true);
      expect(result.installation).toMatchObject({
        status: 'active',
        scopes: ['api_read_write'],
      });
      expect(result.installation?.installedAt).toBeTruthy();
    });

    test('returns installed: false when no integration exists', async () => {
      const caller = await createCallerForUser(user.id);
      const result = await caller.dolthub.getInstallation();
      expect(result).toEqual({ installed: false, installation: null });
    });
  });

  describe('disconnect', () => {
    test('removes the integration', async () => {
      await db.insert(platform_integrations).values({
        owned_by_user_id: user.id,
        owned_by_organization_id: null,
        platform: PLATFORM.DOLTHUB,
        integration_type: 'oauth',
        platform_account_login: 'testuser',
        integration_status: INTEGRATION_STATUS.ACTIVE,
        metadata: { access_token: 'token' },
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.dolthub.disconnect();
      expect(result.success).toBe(true);

      const rows = await db
        .select()
        .from(platform_integrations)
        .where(
          and(
            eq(platform_integrations.platform, PLATFORM.DOLTHUB),
            eq(platform_integrations.owned_by_user_id, user.id)
          )
        );
      expect(rows).toHaveLength(0);
    });
  });

  describe('getInstallationCredentials', () => {
    test('returns null when no integration exists', async () => {
      const caller = await createCallerForUser(user.id);
      const result = await caller.dolthub.getInstallationCredentials();
      expect(result).toBeNull();
    });

    test('returns the access token plus null username when nothing cached yet', async () => {
      await db.insert(platform_integrations).values({
        owned_by_user_id: user.id,
        owned_by_organization_id: null,
        platform: PLATFORM.DOLTHUB,
        integration_type: 'oauth',
        integration_status: INTEGRATION_STATUS.ACTIVE,
        scopes: ['api_read_write'],
        metadata: {
          access_token: 'live-access-token',
          refresh_token: 'r',
          scope: 'api_read_write',
        },
        installed_at: new Date().toISOString(),
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.dolthub.getInstallationCredentials();
      expect(result).toEqual({ token: 'live-access-token', dolthubUsername: null });
    });

    test('returns the cached username alongside the token when present', async () => {
      await db.insert(platform_integrations).values({
        owned_by_user_id: user.id,
        owned_by_organization_id: null,
        platform: PLATFORM.DOLTHUB,
        integration_type: 'oauth',
        integration_status: INTEGRATION_STATUS.ACTIVE,
        scopes: ['api_read_write'],
        metadata: { access_token: 'tok', dolthub_username: 'me-on-dolthub' },
        installed_at: new Date().toISOString(),
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.dolthub.getInstallationCredentials();
      expect(result).toEqual({ token: 'tok', dolthubUsername: 'me-on-dolthub' });
    });

    test('returns null when the integration is not active', async () => {
      // Mirrors the `installed` semantics on `getInstallation` so a stale,
      // non-active row never leaks its bearer token through this endpoint.
      await db.insert(platform_integrations).values({
        owned_by_user_id: user.id,
        owned_by_organization_id: null,
        platform: PLATFORM.DOLTHUB,
        integration_type: 'oauth',
        integration_status: INTEGRATION_STATUS.SUSPENDED,
        scopes: ['api_read_write'],
        metadata: { access_token: 'should-not-leak' },
        installed_at: new Date().toISOString(),
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.dolthub.getInstallationCredentials();
      expect(result).toBeNull();
    });
  });

  describe('rememberUsername', () => {
    test('errors with PRECONDITION_FAILED when no integration exists', async () => {
      const caller = await createCallerForUser(user.id);
      await expect(caller.dolthub.rememberUsername({ username: 'me' })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
    });

    test('persists the username on the integration metadata', async () => {
      const [inserted] = await db
        .insert(platform_integrations)
        .values({
          owned_by_user_id: user.id,
          owned_by_organization_id: null,
          platform: PLATFORM.DOLTHUB,
          integration_type: 'oauth',
          integration_status: INTEGRATION_STATUS.ACTIVE,
          metadata: { access_token: 'tok', refresh_token: 'r' },
          installed_at: new Date().toISOString(),
        })
        .returning();

      const caller = await createCallerForUser(user.id);
      await caller.dolthub.rememberUsername({ username: 'me-on-dolthub' });

      const [reloaded] = await db
        .select()
        .from(platform_integrations)
        .where(eq(platform_integrations.id, inserted!.id));
      const meta = reloaded!.metadata as {
        access_token: string;
        refresh_token: string;
        dolthub_username: string;
      };
      expect(meta.access_token).toBe('tok');
      expect(meta.refresh_token).toBe('r');
      expect(meta.dolthub_username).toBe('me-on-dolthub');
    });

    test('rejects usernames with invalid characters', async () => {
      await db.insert(platform_integrations).values({
        owned_by_user_id: user.id,
        owned_by_organization_id: null,
        platform: PLATFORM.DOLTHUB,
        integration_type: 'oauth',
        integration_status: INTEGRATION_STATUS.ACTIVE,
        metadata: { access_token: 'tok' },
      });

      const caller = await createCallerForUser(user.id);
      await expect(caller.dolthub.rememberUsername({ username: 'has spaces' })).rejects.toThrow(
        /Invalid DoltHub username/
      );
      await expect(caller.dolthub.rememberUsername({ username: 'foo/bar' })).rejects.toThrow(
        /Invalid DoltHub username/
      );
    });
  });

  describe('resolveUsername', () => {
    test('returns null when no integration exists', async () => {
      const caller = await createCallerForUser(user.id);
      const result = await caller.dolthub.resolveUsername();
      expect(result).toBeNull();
    });

    test('returns the cached username when present', async () => {
      await db.insert(platform_integrations).values({
        owned_by_user_id: user.id,
        owned_by_organization_id: null,
        platform: PLATFORM.DOLTHUB,
        integration_type: 'oauth',
        integration_status: INTEGRATION_STATUS.ACTIVE,
        metadata: { access_token: 'tok', dolthub_username: 'cached-user' },
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.dolthub.resolveUsername();
      expect(result).toEqual({ username: 'cached-user' });
    });

    test('fetches /user when no cached username and persists the result', async () => {
      await db.insert(platform_integrations).values({
        owned_by_user_id: user.id,
        owned_by_organization_id: null,
        platform: PLATFORM.DOLTHUB,
        integration_type: 'oauth',
        integration_status: INTEGRATION_STATUS.ACTIVE,
        metadata: { access_token: 'tok' },
      });

      globalThis.fetch = jest.fn(
        async () => new Response(JSON.stringify({ username: 'fresh-user' }), { status: 200 })
      ) as unknown as typeof fetch;

      const caller = await createCallerForUser(user.id);
      const result = await caller.dolthub.resolveUsername();
      expect(result).toEqual({ username: 'fresh-user' });
    });
  });

  describe('verifyUpstream', () => {
    test('public-repo probe runs unauthenticated even when an OAuth token is installed', async () => {
      // Regression: forwarding the token directly trips DoltHub's
      // "Calls authenticated with a token must include a refName"
      // 400. The router resolves an installation but the service runs
      // a public probe first, escalating to auth only if needed.
      await db.insert(platform_integrations).values({
        owned_by_user_id: user.id,
        owned_by_organization_id: null,
        platform: PLATFORM.DOLTHUB,
        integration_type: 'oauth',
        integration_status: INTEGRATION_STATUS.ACTIVE,
        metadata: { access_token: 'oauth-token-1' },
      });

      const seenAuth: (string | null)[] = [];
      globalThis.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        seenAuth.push(new Headers(init?.headers).get('authorization'));
        expect(String(input)).toContain('/api/v1alpha1/foo/bar');
        return new Response(
          JSON.stringify({ query_execution_status: 'Success', commit_ref: 'main' }),
          { status: 200 }
        );
      }) as unknown as typeof fetch;

      const caller = await createCallerForUser(user.id);
      const result = await caller.dolthub.verifyUpstream({ upstream: 'foo/bar' });
      expect(result).toEqual({ exists: true, defaultBranch: 'main' });
      // Stage 1 is the only call that fires for a public hit, and it
      // must be unauthenticated.
      expect(seenAuth).toEqual([null]);
    });

    test('escalates to authenticated /main probe for private repos', async () => {
      await db.insert(platform_integrations).values({
        owned_by_user_id: user.id,
        owned_by_organization_id: null,
        platform: PLATFORM.DOLTHUB,
        integration_type: 'oauth',
        integration_status: INTEGRATION_STATUS.ACTIVE,
        metadata: { access_token: 'oauth-token-1' },
      });

      let call = 0;
      const seen: { url: string; auth: string | null }[] = [];
      globalThis.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        call += 1;
        seen.push({
          url: String(input),
          auth: new Headers(init?.headers).get('authorization'),
        });
        if (call === 1) {
          // Stage 1: anonymous probe sees private repo as missing.
          return new Response(
            JSON.stringify({
              query_execution_status: 'Error',
              query_execution_message: 'no such repository',
            }),
            { status: 400 }
          );
        }
        // Stage 2: authenticated /main probe resolves.
        return new Response(
          JSON.stringify({ query_execution_status: 'Success', commit_ref: 'main' }),
          { status: 200 }
        );
      }) as unknown as typeof fetch;

      const caller = await createCallerForUser(user.id);
      const result = await caller.dolthub.verifyUpstream({ upstream: 'me/private' });
      expect(result).toEqual({ exists: true, defaultBranch: 'main' });
      expect(seen[0]?.auth).toBeNull();
      expect(seen[1]?.auth).toBe('token oauth-token-1');
      expect(seen[1]?.url).toContain('/me/private/main?');
    });

    test('still works without an installation (public-repo probe with no token)', async () => {
      const seenAuth: (string | null)[] = [];
      const fetchCalls = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seenAuth.push(headers.get('authorization'));
        return new Response(
          JSON.stringify({
            query_execution_status: 'Error',
            query_execution_message: 'no such repository',
          }),
          { status: 400 }
        );
      });
      globalThis.fetch = fetchCalls as unknown as typeof fetch;

      const caller = await createCallerForUser(user.id);
      const result = await caller.dolthub.verifyUpstream({ upstream: 'never/exists' });
      expect(result).toEqual({ exists: false, reason: 'no such repository' });
      // No installation → only the unauthenticated probe runs; no
      // authenticated fallback because we have no token to escalate
      // with.
      expect(fetchCalls).toHaveBeenCalledTimes(1);
      expect(seenAuth).toEqual([null]);
    });

    test('rejects malformed upstream input', async () => {
      const caller = await createCallerForUser(user.id);
      await expect(caller.dolthub.verifyUpstream({ upstream: 'no-slash' })).rejects.toThrow(
        /Must be in the format owner\/repo/
      );
    });
  });
});
