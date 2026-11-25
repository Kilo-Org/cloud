import { vi } from 'vitest';

export type ManagerMock = {
  loginBodies: unknown[];
  secretRequests: Array<{ url: string; ifNoneMatch: string | null }>;
  goNotModified: () => void;
  lastAuthorization: () => string | null;
};

/**
 * Stands in for Infisical Cloud for the duration of one test. Values are synthetic;
 * the mock records the login body and every secret request it receives.
 */
export function installManager(options: {
  secrets: Record<string, string>;
  etag?: string;
  loginStatus?: number;
  readStatus?: number;
}): ManagerMock {
  let notModified = false;
  let authorization: string | null = null;
  const mock: ManagerMock = {
    loginBodies: [],
    secretRequests: [],
    goNotModified: () => {
      notModified = true;
    },
    lastAuthorization: () => authorization,
  };

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/api/v1/auth/oidc-auth/login')) {
      const raw = init?.body;
      const body: unknown = typeof raw === 'string' ? JSON.parse(raw) : null;
      mock.loginBodies.push(body);
      if (options.loginStatus !== undefined && options.loginStatus !== 200) {
        return new Response('login refused', { status: options.loginStatus });
      }
      return Response.json({ accessToken: 'manager-access-token', expiresIn: 3600 });
    }
    if (url.includes('/api/v4/secrets')) {
      const headers = new Headers(init?.headers);
      authorization = headers.get('authorization');
      mock.secretRequests.push({ url, ifNoneMatch: headers.get('if-none-match') });
      if (options.readStatus !== undefined && options.readStatus !== 200) {
        return new Response('read failed', { status: options.readStatus });
      }
      if (notModified) return new Response(null, { status: 304 });
      const secrets = Object.entries(options.secrets).map(([secretKey, secretValue], index) => ({
        secretKey,
        secretValue,
        version: index + 1,
      }));
      return Response.json(
        { secrets },
        options.etag === undefined ? {} : { headers: { etag: options.etag } }
      );
    }
    return new Response('not found', { status: 404 });
  };

  vi.stubGlobal('fetch', fetchImpl);
  return mock;
}
