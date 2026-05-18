// Sentry telemetry from `getDoltHubUser`'s degraded paths is mocked away
// so the test suite doesn't try to send real events. We only override
// the capture helpers — pass everything else through so any module that
// imports more than `captureMessage` from `@sentry/nextjs` keeps working.
jest.mock('@sentry/nextjs', () => ({
  ...jest.requireActual<object>('@sentry/nextjs'),
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));

import { afterEach, beforeAll, describe, expect, test } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { platform_integrations } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import type { User } from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { PLATFORM, INTEGRATION_STATUS } from '@/lib/integrations/core/constants';
import {
  getDoltHubOAuthUrl,
  exchangeDoltHubOAuthCode,
  refreshDoltHubAccessToken,
  getInstallation,
  upsertDoltHubInstallation,
  uninstall,
  getValidDoltHubToken,
  getCachedDoltHubUsername,
  rememberDoltHubUsername,
  getDoltHubUser,
  verifyDoltHubUpstreamExists,
  DOLTHUB_REDIRECT_URI,
  DOLTHUB_SCOPES,
} from '@/lib/integrations/dolthub-service';
import { DOLTHUB_APP_CLIENT_ID } from '@/lib/config.server';

describe('dolthub-service', () => {
  const originalFetch = globalThis.fetch;
  let user: User;

  beforeAll(async () => {
    user = await insertTestUser({
      google_user_email: 'dolthub-test@example.com',
      google_user_name: 'DoltHub Test',
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

  describe('getDoltHubOAuthUrl', () => {
    test('includes the required OAuth parameters', () => {
      const url = getDoltHubOAuthUrl('test-state-123');
      expect(url).toMatch(/^https:\/\/www\.dolthub\.com\/oauth\/authorize/);
      expect(url).toContain(`client_id=${encodeURIComponent(DOLTHUB_APP_CLIENT_ID)}`);
      expect(url).toContain('response_type=code');
      expect(url).toContain(`redirect_uri=${encodeURIComponent(DOLTHUB_REDIRECT_URI)}`);
      expect(url).toContain(`scope=${encodeURIComponent(DOLTHUB_SCOPES.join(','))}`);
      expect(url).toContain('state=test-state-123');
    });
  });

  describe('exchangeDoltHubOAuthCode', () => {
    test('successfully exchanges code for tokens', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'access-token-123',
          refresh_token: 'refresh-token-456',
          expires_in: 3600,
          scope: 'api_read_write',
        }),
      });
      globalThis.fetch = mockFetch;

      const result = await exchangeDoltHubOAuthCode('auth-code-xyz');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://www.dolthub.com/api/oauth/access_token');
      expect(init?.method).toBe('POST');
      expect(init?.headers?.Authorization).toContain('Basic ');

      expect(result.accessToken).toBe('access-token-123');
      expect(result.refreshToken).toBe('refresh-token-456');
      expect(result.expiresIn).toBe(3600);
      expect(result.scope).toBe('api_read_write');
    });

    test('throws when token exchange fails', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
      });

      await expect(exchangeDoltHubOAuthCode('bad-code')).rejects.toThrow(
        'DoltHub token exchange failed: 400 Bad Request'
      );
    });

    test('throws when response lacks access_token', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ refresh_token: 'only-refresh' }),
      });

      await expect(exchangeDoltHubOAuthCode('incomplete')).rejects.toThrow(
        'DoltHub token exchange returned invalid payload'
      );
    });
  });

  describe('refreshDoltHubAccessToken', () => {
    test('successfully refreshes and returns new tokens', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 7200,
          scope: 'api_read_write',
        }),
      });
      globalThis.fetch = mockFetch;

      const result = await refreshDoltHubAccessToken('old-refresh-token');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://www.dolthub.com/api/oauth/access_token');
      const body = init?.body as string;
      expect(body).toContain('grant_type=refresh_token');
      expect(body).toContain('refresh_token=old-refresh-token');

      expect(result.accessToken).toBe('new-access-token');
      expect(result.refreshToken).toBe('new-refresh-token');
      expect(result.expiresIn).toBe(7200);
    });
  });

  describe('getInstallation', () => {
    test('returns an integration when found', async () => {
      await db.insert(platform_integrations).values({
        owned_by_user_id: user.id,
        owned_by_organization_id: null,
        platform: PLATFORM.DOLTHUB,
        integration_type: 'oauth',
        platform_account_login: 'testuser',
        integration_status: INTEGRATION_STATUS.ACTIVE,
        metadata: { access_token: 'token' },
      });

      const result = await getInstallation({ type: 'user', id: user.id });
      expect(result).not.toBeNull();
      expect(result?.platform_account_login).toBe('testuser');
    });

    test('returns null when not found', async () => {
      const result = await getInstallation({ type: 'user', id: user.id });
      expect(result).toBeNull();
    });
  });

  describe('upsertDoltHubInstallation', () => {
    test('creates a new installation when none exists', async () => {
      const result = await upsertDoltHubInstallation({
        owner: { type: 'user', id: user.id },
        tokens: {
          accessToken: 'token-new',
          refreshToken: 'refresh-new',
          expiresIn: 3600,
          scope: 'api_read_write',
        },
      });

      expect(result.platform).toBe(PLATFORM.DOLTHUB);
      expect(result.integration_status).toBe(INTEGRATION_STATUS.ACTIVE);
      expect(result.platform_account_login).toBeNull();
      expect(result.platform_installation_id).toBe(`dolthub-user-${user.id}`);

      const [row] = await db
        .select()
        .from(platform_integrations)
        .where(
          and(
            eq(platform_integrations.platform, PLATFORM.DOLTHUB),
            eq(platform_integrations.owned_by_user_id, user.id)
          )
        );
      const meta = row.metadata as { access_token: string };
      expect(meta.access_token).toBe('token-new');
    });

    test('updates an existing installation', async () => {
      await upsertDoltHubInstallation({
        owner: { type: 'user', id: user.id },
        tokens: {
          accessToken: 'token-old',
          refreshToken: 'refresh-old',
          expiresIn: 3600,
          scope: 'api_read_write',
        },
      });

      await upsertDoltHubInstallation({
        owner: { type: 'user', id: user.id },
        tokens: {
          accessToken: 'token-updated',
          refreshToken: 'refresh-updated',
          expiresIn: 7200,
          scope: 'api_read_write',
        },
      });

      const [row] = await db
        .select()
        .from(platform_integrations)
        .where(
          and(
            eq(platform_integrations.platform, PLATFORM.DOLTHUB),
            eq(platform_integrations.owned_by_user_id, user.id)
          )
        );
      const meta = row.metadata as { access_token: string; refresh_token: string };
      expect(meta.access_token).toBe('token-updated');
      expect(meta.refresh_token).toBe('refresh-updated');
    });

    test('concurrent upserts for the same owner produce a single row', async () => {
      const tokens = (suffix: string) => ({
        accessToken: `token-${suffix}`,
        refreshToken: `refresh-${suffix}`,
        expiresIn: 3600,
        scope: 'api_read_write',
      });

      await Promise.all([
        upsertDoltHubInstallation({ owner: { type: 'user', id: user.id }, tokens: tokens('a') }),
        upsertDoltHubInstallation({ owner: { type: 'user', id: user.id }, tokens: tokens('b') }),
        upsertDoltHubInstallation({ owner: { type: 'user', id: user.id }, tokens: tokens('c') }),
      ]);

      const rows = await db
        .select()
        .from(platform_integrations)
        .where(
          and(
            eq(platform_integrations.platform, PLATFORM.DOLTHUB),
            eq(platform_integrations.owned_by_user_id, user.id)
          )
        );
      expect(rows).toHaveLength(1);
    });
  });

  describe('uninstall', () => {
    test('deletes the installation when found', async () => {
      await db.insert(platform_integrations).values({
        owned_by_user_id: user.id,
        owned_by_organization_id: null,
        platform: PLATFORM.DOLTHUB,
        integration_type: 'oauth',
        platform_account_login: 'testuser',
        integration_status: INTEGRATION_STATUS.ACTIVE,
        metadata: { access_token: 'token' },
      });

      const result = await uninstall({ type: 'user', id: user.id });
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

    test('succeeds when no installation exists', async () => {
      const result = await uninstall({ type: 'user', id: user.id });
      expect(result.success).toBe(true);
    });
  });

  describe('getValidDoltHubToken', () => {
    test('returns access token when not expired', async () => {
      const [integration] = await db
        .insert(platform_integrations)
        .values({
          owned_by_user_id: user.id,
          owned_by_organization_id: null,
          platform: PLATFORM.DOLTHUB,
          integration_type: 'oauth',
          platform_account_login: 'testuser',
          integration_status: INTEGRATION_STATUS.ACTIVE,
          metadata: {
            access_token: 'current-token',
            refresh_token: 'refresh-token',
            expires_at: Date.now() + 3600 * 1000,
            scope: 'api_read_write',
          },
        })
        .returning();

      const token = await getValidDoltHubToken(integration);
      expect(token).toBe('current-token');
    });

    test('refreshes and persists new token when expired', async () => {
      const [integration] = await db
        .insert(platform_integrations)
        .values({
          owned_by_user_id: user.id,
          owned_by_organization_id: null,
          platform: PLATFORM.DOLTHUB,
          integration_type: 'oauth',
          platform_account_login: 'testuser',
          integration_status: INTEGRATION_STATUS.ACTIVE,
          metadata: {
            access_token: 'expired-token',
            refresh_token: 'old-refresh',
            expires_at: Date.now() - 1000,
            scope: 'api_read_write',
          },
        })
        .returning();

      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'refreshed-access',
          refresh_token: 'refreshed-refresh',
          expires_in: 3600,
          scope: 'api_read_write',
        }),
      });

      const token = await getValidDoltHubToken(integration);
      expect(token).toBe('refreshed-access');

      const [row] = await db
        .select()
        .from(platform_integrations)
        .where(eq(platform_integrations.id, integration.id));
      const meta = row.metadata as {
        access_token: string;
        refresh_token: string;
        expires_at: number;
      };
      expect(meta.access_token).toBe('refreshed-access');
      expect(meta.refresh_token).toBe('refreshed-refresh');
      expect(meta.expires_at).toBeGreaterThan(Date.now());
    });

    test('preserves existing refresh_token and scope when refresh response omits them', async () => {
      const [integration] = await db
        .insert(platform_integrations)
        .values({
          owned_by_user_id: user.id,
          owned_by_organization_id: null,
          platform: PLATFORM.DOLTHUB,
          integration_type: 'oauth',
          platform_account_login: 'testuser',
          integration_status: INTEGRATION_STATUS.ACTIVE,
          metadata: {
            access_token: 'expired-token',
            refresh_token: 'old-refresh',
            expires_at: Date.now() - 1000,
            scope: 'api_read_write',
          },
        })
        .returning();

      // DoltHub may return only an access_token on refresh; per RFC 6749 the
      // previous refresh_token and scope remain valid.
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'refreshed-access',
          expires_in: 3600,
        }),
      });

      const token = await getValidDoltHubToken(integration);
      expect(token).toBe('refreshed-access');

      const [row] = await db
        .select()
        .from(platform_integrations)
        .where(eq(platform_integrations.id, integration.id));
      const meta = row.metadata as {
        access_token: string;
        refresh_token: string;
        expires_at: number;
        scope: string;
      };
      expect(meta.access_token).toBe('refreshed-access');
      expect(meta.refresh_token).toBe('old-refresh');
      expect(meta.scope).toBe('api_read_write');
      expect(meta.expires_at).toBeGreaterThan(Date.now());
    });

    test('returns null when expired and no refresh token exists', async () => {
      const [integration] = await db
        .insert(platform_integrations)
        .values({
          owned_by_user_id: user.id,
          owned_by_organization_id: null,
          platform: PLATFORM.DOLTHUB,
          integration_type: 'oauth',
          platform_account_login: 'testuser',
          integration_status: INTEGRATION_STATUS.ACTIVE,
          metadata: {
            access_token: 'expired-token',
            refresh_token: null,
            expires_at: Date.now() - 1000,
            scope: 'api_read_write',
          },
        })
        .returning();

      const token = await getValidDoltHubToken(integration);
      expect(token).toBeNull();
    });

    test('returns null when access token is missing', async () => {
      const [integration] = await db
        .insert(platform_integrations)
        .values({
          owned_by_user_id: user.id,
          owned_by_organization_id: null,
          platform: PLATFORM.DOLTHUB,
          integration_type: 'oauth',
          platform_account_login: 'testuser',
          integration_status: INTEGRATION_STATUS.ACTIVE,
          metadata: {
            refresh_token: 'refresh-token',
            expires_at: Date.now() + 3600 * 1000,
            scope: 'api_read_write',
          },
        })
        .returning();

      const token = await getValidDoltHubToken(integration);
      expect(token).toBeNull();
    });
  });

  describe('getCachedDoltHubUsername / rememberDoltHubUsername', () => {
    test('round-trips a username through metadata', async () => {
      const [integration] = await db
        .insert(platform_integrations)
        .values({
          owned_by_user_id: user.id,
          owned_by_organization_id: null,
          platform: PLATFORM.DOLTHUB,
          integration_type: 'oauth',
          integration_status: INTEGRATION_STATUS.ACTIVE,
          metadata: { access_token: 'token', refresh_token: 'r', scope: 'api_read_write' },
          installed_at: new Date().toISOString(),
        })
        .returning();

      expect(getCachedDoltHubUsername(integration)).toBeNull();

      await rememberDoltHubUsername(integration, 'my-username');

      const [reloaded] = await db
        .select()
        .from(platform_integrations)
        .where(eq(platform_integrations.id, integration.id));
      expect(reloaded).toBeDefined();
      expect(getCachedDoltHubUsername(reloaded!)).toBe('my-username');
    });

    test('does not clobber existing OAuth fields when caching the username', async () => {
      const [integration] = await db
        .insert(platform_integrations)
        .values({
          owned_by_user_id: user.id,
          owned_by_organization_id: null,
          platform: PLATFORM.DOLTHUB,
          integration_type: 'oauth',
          integration_status: INTEGRATION_STATUS.ACTIVE,
          metadata: {
            access_token: 'preserved-access',
            refresh_token: 'preserved-refresh',
            expires_at: 1234567890,
            scope: 'api_read_write',
          },
          installed_at: new Date().toISOString(),
        })
        .returning();

      await rememberDoltHubUsername(integration, 'someone');

      const [reloaded] = await db
        .select()
        .from(platform_integrations)
        .where(eq(platform_integrations.id, integration.id));
      const meta = reloaded!.metadata as {
        access_token: string;
        refresh_token: string;
        expires_at: number;
        scope: string;
        dolthub_username: string;
      };
      expect(meta.access_token).toBe('preserved-access');
      expect(meta.refresh_token).toBe('preserved-refresh');
      expect(meta.expires_at).toBe(1234567890);
      expect(meta.scope).toBe('api_read_write');
      expect(meta.dolthub_username).toBe('someone');
    });

    test('overwrites a previously cached username', async () => {
      const [integration] = await db
        .insert(platform_integrations)
        .values({
          owned_by_user_id: user.id,
          owned_by_organization_id: null,
          platform: PLATFORM.DOLTHUB,
          integration_type: 'oauth',
          integration_status: INTEGRATION_STATUS.ACTIVE,
          metadata: { access_token: 'token', dolthub_username: 'old-name' },
          installed_at: new Date().toISOString(),
        })
        .returning();

      expect(getCachedDoltHubUsername(integration)).toBe('old-name');

      await rememberDoltHubUsername(integration, 'new-name');

      const [reloaded] = await db
        .select()
        .from(platform_integrations)
        .where(eq(platform_integrations.id, integration.id));
      expect(getCachedDoltHubUsername(reloaded!)).toBe('new-name');
    });
  });

  describe('getDoltHubUser', () => {
    test('returns the cached username without hitting the API', async () => {
      const [integration] = await db
        .insert(platform_integrations)
        .values({
          owned_by_user_id: user.id,
          owned_by_organization_id: null,
          platform: PLATFORM.DOLTHUB,
          integration_type: 'oauth',
          integration_status: INTEGRATION_STATUS.ACTIVE,
          metadata: { access_token: 'tok', dolthub_username: 'cached-user' },
          installed_at: new Date().toISOString(),
        })
        .returning();

      // Set fetch to throw so we can prove the cache short-circuits.
      globalThis.fetch = jest.fn(() => {
        throw new Error('fetch should not be called when username is cached');
      }) as unknown as typeof fetch;

      const result = await getDoltHubUser(integration!);
      expect(result).toEqual({ username: 'cached-user' });
    });

    test('fetches /user when username is not cached and persists it', async () => {
      const [integration] = await db
        .insert(platform_integrations)
        .values({
          owned_by_user_id: user.id,
          owned_by_organization_id: null,
          platform: PLATFORM.DOLTHUB,
          integration_type: 'oauth',
          integration_status: INTEGRATION_STATUS.ACTIVE,
          metadata: { access_token: 'live-token' },
          installed_at: new Date().toISOString(),
        })
        .returning();

      globalThis.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toContain('/api/v1alpha1/user');
        const headers = new Headers(init?.headers);
        expect(headers.get('authorization')).toBe('token live-token');
        return new Response(JSON.stringify({ username: 'me-on-dolthub' }), { status: 200 });
      }) as unknown as typeof fetch;

      const result = await getDoltHubUser(integration!);
      expect(result).toEqual({ username: 'me-on-dolthub' });

      // Persisted: a follow-up call should hit the cache.
      const [reloaded] = await db
        .select()
        .from(platform_integrations)
        .where(eq(platform_integrations.id, integration!.id));
      expect(getCachedDoltHubUsername(reloaded!)).toBe('me-on-dolthub');
    });

    test('returns null when DoltHub returns a non-2xx', async () => {
      const [integration] = await db
        .insert(platform_integrations)
        .values({
          owned_by_user_id: user.id,
          owned_by_organization_id: null,
          platform: PLATFORM.DOLTHUB,
          integration_type: 'oauth',
          integration_status: INTEGRATION_STATUS.ACTIVE,
          metadata: { access_token: 'revoked-token' },
          installed_at: new Date().toISOString(),
        })
        .returning();

      globalThis.fetch = jest.fn(
        async () => new Response('{"message":"unauthorized"}', { status: 401 })
      ) as unknown as typeof fetch;

      const result = await getDoltHubUser(integration!);
      expect(result).toBeNull();

      const [reloaded] = await db
        .select()
        .from(platform_integrations)
        .where(eq(platform_integrations.id, integration!.id));
      expect(getCachedDoltHubUsername(reloaded!)).toBeNull();
    });

    test('returns null when /user payload is malformed', async () => {
      const [integration] = await db
        .insert(platform_integrations)
        .values({
          owned_by_user_id: user.id,
          owned_by_organization_id: null,
          platform: PLATFORM.DOLTHUB,
          integration_type: 'oauth',
          integration_status: INTEGRATION_STATUS.ACTIVE,
          metadata: { access_token: 'tok' },
          installed_at: new Date().toISOString(),
        })
        .returning();

      globalThis.fetch = jest.fn(
        async () => new Response('{"some":"other","shape":1}', { status: 200 })
      ) as unknown as typeof fetch;

      const result = await getDoltHubUser(integration!);
      expect(result).toBeNull();
    });
  });

  describe('verifyDoltHubUpstreamExists', () => {
    test('public probe resolves and never sends a token (avoids DoltHub refName error)', async () => {
      const seenAuthHeaders: (string | null)[] = [];
      const seenUrls: string[] = [];
      globalThis.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        seenUrls.push(String(input));
        seenAuthHeaders.push(new Headers(init?.headers).get('authorization'));
        return new Response(
          JSON.stringify({
            query_execution_status: 'Success',
            commit_ref: 'main',
            repository_owner: 'hop',
            repository_name: 'wl-commons',
          }),
          { status: 200 }
        );
      }) as unknown as typeof fetch;

      // Even when a token is available, the public probe runs first
      // unauthenticated so DoltHub doesn't reject the call with
      // "Calls authenticated with a token must include a refName".
      const result = await verifyDoltHubUpstreamExists('hop/wl-commons', 'oauth-token-1');
      expect(result).toEqual({ exists: true, defaultBranch: 'main' });
      expect(seenAuthHeaders).toEqual([null]);
      expect(seenUrls[0]).toContain('/api/v1alpha1/hop/wl-commons?');
      expect(seenUrls[0]).not.toContain('/main?');
    });

    test('returns exists=false when the public probe says missing and no token is available', async () => {
      const fetchCalls = jest.fn(
        async () =>
          new Response(
            JSON.stringify({
              query_execution_status: 'Error',
              query_execution_message: 'no such repository',
            }),
            { status: 400 }
          )
      );
      globalThis.fetch = fetchCalls as unknown as typeof fetch;

      const result = await verifyDoltHubUpstreamExists('totally/fake', null);
      expect(result).toEqual({ exists: false, reason: 'no such repository' });
      expect(fetchCalls).toHaveBeenCalledTimes(1);
    });

    test('falls back to authenticated /main probe when public probe says missing', async () => {
      // Simulates a private repo: the unauthenticated probe says "no
      // such repository" because the caller can't see it, but an
      // authenticated probe at /{owner}/{repo}/main resolves.
      let call = 0;
      const seen: { url: string; auth: string | null }[] = [];
      globalThis.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        call += 1;
        seen.push({
          url: String(input),
          auth: new Headers(init?.headers).get('authorization'),
        });
        if (call === 1) {
          return new Response(
            JSON.stringify({
              query_execution_status: 'Error',
              query_execution_message: 'no such repository',
            }),
            { status: 400 }
          );
        }
        return new Response(
          JSON.stringify({ query_execution_status: 'Success', commit_ref: 'main' }),
          { status: 200 }
        );
      }) as unknown as typeof fetch;

      const result = await verifyDoltHubUpstreamExists('me/private-repo', 'oauth-token-1');
      expect(result).toEqual({ exists: true, defaultBranch: 'main' });
      // First call: public, no token, no branch
      expect(seen[0]).toEqual({
        url: expect.stringContaining('/api/v1alpha1/me/private-repo?'),
        auth: null,
      });
      expect(seen[0]?.url).not.toContain('/main?');
      // Second call: authenticated, with /main segment
      expect(seen[1]).toEqual({
        url: expect.stringContaining('/api/v1alpha1/me/private-repo/main?'),
        auth: 'token oauth-token-1',
      });
    });

    test("treats 'branch not found' on the auth fallback as exists=true", async () => {
      // Repo exists, but its default branch is `master` (or anything
      // other than `main`). DoltHub returns a 200 with status=Error
      // and message="branch not found". That still proves the repo
      // exists; we just don't know the actual default branch.
      let call = 0;
      globalThis.fetch = jest.fn(async () => {
        call += 1;
        if (call === 1) {
          return new Response(
            JSON.stringify({
              query_execution_status: 'Error',
              query_execution_message: 'no such repository',
            }),
            { status: 400 }
          );
        }
        return new Response(
          JSON.stringify({
            query_execution_status: 'Error',
            query_execution_message: 'query error: branch not found',
          }),
          { status: 200 }
        );
      }) as unknown as typeof fetch;

      const result = await verifyDoltHubUpstreamExists('me/master-default', 'tok');
      expect(result).toEqual({ exists: true, defaultBranch: null });
    });

    test('returns exists=false when both stages report missing', async () => {
      const fetchCalls = jest.fn(
        async () =>
          new Response(
            JSON.stringify({
              query_execution_status: 'Error',
              query_execution_message: 'no such repository',
            }),
            { status: 400 }
          )
      );
      globalThis.fetch = fetchCalls as unknown as typeof fetch;

      const result = await verifyDoltHubUpstreamExists('me/genuinely-fake', 'tok');
      expect(result).toEqual({ exists: false, reason: 'no such repository' });
      expect(fetchCalls).toHaveBeenCalledTimes(2);
    });

    test('returns a synthetic reason when the public probe body is unparseable', async () => {
      globalThis.fetch = jest.fn(
        async () => new Response('not json', { status: 502 })
      ) as unknown as typeof fetch;

      const result = await verifyDoltHubUpstreamExists('owner/repo', null);
      expect(result.exists).toBe(false);
      if (!result.exists) {
        expect(result.reason).toContain('502');
      }
    });
  });
});
