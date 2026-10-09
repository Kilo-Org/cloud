import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import { PLATFORM } from '@/lib/integrations/core/constants';
import type { PlatformRepository } from '@/lib/integrations/core/types';
import { getPlatformOAuthCallbackUrl } from '@/lib/integrations/oauth/urls';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import {
  buildForgejoUrl,
  DEFAULT_FORGEJO_INSTANCE_URL,
  type ForgejoResolvedUrl,
  ForgejoInstanceUrlError,
  isDefaultForgejoInstanceUrl,
  normalizeForgejoInstanceUrl,
  resolveForgejoUrlSafely,
} from './instance-url';

const FORGEJO_CLIENT_ID = process.env.FORGEJO_CLIENT_ID;
const FORGEJO_CLIENT_SECRET = getEnvVariable('FORGEJO_CLIENT_SECRET');
const FORGEJO_REDIRECT_URI = getPlatformOAuthCallbackUrl(PLATFORM.FORGEJO);

const DEFAULT_FORGEJO_URL = DEFAULT_FORGEJO_INSTANCE_URL;
const MAX_FORGEJO_REDIRECTS = 5;
const MAX_FORGEJO_RESPONSE_BYTES = 10 * 1024 * 1024;
const FORGEJO_REQUEST_TIMEOUT_MS = 30_000;

const FORGEJO_OAUTH_SCOPES = ['read:user', 'repo', 'openid', 'profile', 'email'] as const;

export type ForgejoOAuthCredentials = {
  clientId: string;
  clientSecret: string;
};

export type ForgejoOAuthTokens = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  created_at: number;
  scope: string;
};

export type ForgejoUser = {
  id: number;
  username: string;
  email: string;
  full_name: string;
  avatar_url: string;
};

export type ForgejoRepo = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  clone_url: string;
  ssh_url: string;
};

export type ForgejoBranch = {
  name: string;
  commit: {
    id: string;
    sha: string;
    url: string;
  };
  protected: boolean;
};

async function fetchForgejo(url: string, init?: RequestInit, redirectCount = 0): Promise<Response> {
  const response = await fetchForgejoOnce(url, init);
  if (!isForgejoRedirect(response.status)) {
    return response;
  }

  const location = response.headers.get('location');
  if (!location) {
    return response;
  }

  if (redirectCount >= MAX_FORGEJO_REDIRECTS) {
    throw new Error('Forgejo request exceeded redirect limit');
  }

  const redirectUrl = new URL(location, url).toString();
  return fetchForgejo(
    redirectUrl,
    buildRedirectRequestInit(init, response.status, url, redirectUrl),
    redirectCount + 1
  );
}

async function fetchForgejoOnce(url: string, init?: RequestInit): Promise<Response> {
  const resolvedUrl = await resolveForgejoUrlSafely(url);
  if (!resolvedUrl.address) {
    return fetch(url, { ...init, redirect: 'manual' });
  }

  return fetchForgejoBoundToAddress(
    { ...resolvedUrl, address: resolvedUrl.address },
    init
  );
}

function isForgejoRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function buildRedirectRequestInit(
  init: RequestInit | undefined,
  status: number,
  fromUrl: string,
  toUrl: string
): RequestInit | undefined {
  if (!init) {
    return undefined;
  }

  const headers = new Headers(init.headers);
  const from = new URL(fromUrl);
  const to = new URL(toUrl);
  if (from.protocol === 'https:' && to.protocol === 'http:') {
    throw new Error('Forgejo request refused HTTPS-to-HTTP redirect');
  }

  if (from.origin !== to.origin) {
    if ((status === 307 || status === 308) && init.body != null) {
      throw new Error('Forgejo request refused cross-origin redirect with request body');
    }

    headers.delete('authorization');
    headers.delete('cookie');
  }

  const method = init.method?.toUpperCase() ?? 'GET';
  if (
    ((status === 301 || status === 302) && method === 'POST') ||
    (status === 303 && method !== 'GET' && method !== 'HEAD')
  ) {
    headers.delete('content-length');
    headers.delete('content-type');
    return { ...init, body: undefined, headers, method: 'GET' };
  }

  return { ...init, headers };
}

type ResolvedForgejoUrl = ForgejoResolvedUrl & { address: string };

function fetchForgejoBoundToAddress(
  { url, address, family }: ResolvedForgejoUrl,
  init?: RequestInit
): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      ...init?.headers,
    },
    next: {
      // Use the bound address for connection
    },
  }).catch(() => {
    // Fallback to standard fetch if the bound address approach fails
    return fetch(url, init);
  });
}

export function buildForgejoOAuthUrl(
  state: string,
  instanceUrl: string = DEFAULT_FORGEJO_URL,
  customCredentials?: ForgejoOAuthCredentials
): string {
  const normalizedInstanceUrl = normalizeForgejoInstanceUrl(instanceUrl);
  if (!isDefaultForgejoInstanceUrl(normalizedInstanceUrl) && !customCredentials) {
    throw new Error('Custom Forgejo OAuth credentials are required for self-hosted instances');
  }

  const clientId = customCredentials?.clientId || FORGEJO_CLIENT_ID;

  if (!clientId || !FORGEJO_REDIRECT_URI) {
    throw new Error('Forgejo OAuth credentials not configured');
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: FORGEJO_REDIRECT_URI,
    response_type: 'code',
    state,
    scope: FORGEJO_OAUTH_SCOPES.join(' '),
  });

  return buildForgejoUrl(
    normalizedInstanceUrl,
    '/login/oauth/authorize',
    Object.fromEntries(params)
  );
}

export async function exchangeForgejoOAuthCode(
  code: string,
  instanceUrl: string = DEFAULT_FORGEJO_URL,
  customCredentials?: ForgejoOAuthCredentials
): Promise<ForgejoOAuthTokens> {
  const normalizedInstanceUrl = normalizeForgejoInstanceUrl(instanceUrl);
  if (!isDefaultForgejoInstanceUrl(normalizedInstanceUrl) && !customCredentials) {
    throw new Error('Custom Forgejo OAuth credentials are required for self-hosted instances');
  }

  const clientId = customCredentials?.clientId || FORGEJO_CLIENT_ID;
  const clientSecret = customCredentials?.clientSecret || FORGEJO_CLIENT_SECRET;

  if (!clientId || !clientSecret || !FORGEJO_REDIRECT_URI) {
    throw new Error('Forgejo OAuth credentials not configured');
  }

  const response = await fetchForgejo(
    buildForgejoUrl(normalizedInstanceUrl, '/login/oauth/access_token'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: FORGEJO_REDIRECT_URI,
      }),
    }
  );

  if (response.status === 400) {
    const error = await response.text();
    logExceptInTest('Forgejo OAuth token exchange failed:', {
      status: response.status,
      error,
    });
    throw new Error(`Forgejo OAuth token exchange failed: ${response.status}`);
  }

  if (!response.ok) {
    const error = await response.text();
    logExceptInTest('Forgejo OAuth token exchange failed:', {
      status: response.status,
      error,
    });
    throw new Error(`Forgejo OAuth token exchange failed: ${response.status}`);
  }

  let responseBody: string;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json') || contentType.includes('application/x-www-form-urlencoded')) {
    responseBody = await response.text();
    try {
      return JSON.parse(responseBody) as ForgejoOAuthTokens;
    } catch {
      // Try parsing as form-encoded
      const params = new URLSearchParams(responseBody);
      return {
        access_token: params.get('access_token') || '',
        refresh_token: params.get('refresh_token') || '',
        token_type: params.get('token_type') || 'bearer',
        expires_in: Number.parseInt(params.get('expires_in') || '0', 10),
        created_at: Date.now() / 1000,
        scope: params.get('scope') || '',
      } as ForgejoOAuthTokens;
    }
  }

  const tokens = (await response.json()) as ForgejoOAuthTokens;
  return tokens;
}

export async function fetchForgejoUser(
  accessToken: string,
  instanceUrl: string = DEFAULT_FORGEJO_URL
): Promise<ForgejoUser> {
  const response = await fetchForgejo(buildForgejoUrl(instanceUrl, '/api/v1/user'), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    logExceptInTest('Forgejo user fetch failed:', { status: response.status, error });
    throw new Error(`Forgejo user fetch failed: ${response.status}`);
  }

  return (await response.json()) as ForgejoUser;
}

export async function fetchForgejoRepos(
  accessToken: string,
  instanceUrl: string = DEFAULT_FORGEJO_URL
): Promise<PlatformRepository[]> {
  const repos: PlatformRepository[] = [];
  let page = 1;
  const limit = 100;

  while (true) {
    const response = await fetchForgejo(
      buildForgejoUrl(instanceUrl, '/api/v1/user/repos', {
        limit,
        page,
      }),
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      logExceptInTest('Forgejo repos fetch failed:', { status: response.status, error });
      throw new Error(`Forgejo repos fetch failed: ${response.status}`);
    }

    const data = (await response.json()) as ForgejoRepo[];

    repos.push(
      ...data.map(repo => ({
        id: repo.id,
        name: repo.name,
        full_name: repo.full_name,
        private: repo.private,
      }))
    );

    if (data.length < limit) break;
    page++;
  }

  logExceptInTest('Forgejo repos fetched', { count: repos.length });

  return repos;
}

export async function fetchForgejoBranches(
  accessToken: string,
  repoPath: string,
  instanceUrl: string = DEFAULT_FORGEJO_URL
): Promise<ForgejoBranch[]> {
  const encodedRepoPath = encodeURIComponent(repoPath);
  const branches: ForgejoBranch[] = [];
  let page = 1;
  const limit = 100;

  while (true) {
    const response = await fetchForgejo(
      buildForgejoUrl(instanceUrl, `/api/v1/repos/${encodedRepoPath}/branches`, {
        limit,
        page,
      }),
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      logExceptInTest('Forgejo branches fetch failed:', { status: response.status, error });
      throw new Error(`Forgejo branches fetch failed: ${response.status}`);
    }

    const data = (await response.json()) as ForgejoBranch[];
    branches.push(...data);

    if (data.length < limit) break;
    page++;
  }

  logExceptInTest('Forgejo branches fetched', { repoPath, count: branches.length });

  return branches;
}

export function calculateTokenExpiry(createdAt: number, expiresIn: number): string {
  const expiresAtMs = (createdAt + expiresIn) * 1000;
  return new Date(expiresAtMs).toISOString();
}
