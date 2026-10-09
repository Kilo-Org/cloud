import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import { PLATFORM } from '@/lib/integrations/core/constants';
import type { PlatformRepository } from '@/lib/integrations/core/types';
import { getPlatformOAuthCallbackUrl } from '@/lib/integrations/oauth/urls';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import * as http from 'http';
import * as https from 'https';
import {
  buildGiteaUrl,
  DEFAULT_GITEA_INSTANCE_URL,
  type GiteaResolvedUrl,
  GiteaInstanceUrlError,
  isDefaultGiteaInstanceUrl,
  normalizeGiteaInstanceUrl,
  resolveGiteaUrlSafely,
} from './instance-url';

const GITEA_CLIENT_ID = process.env.GITEA_CLIENT_ID;
const GITEA_CLIENT_SECRET = getEnvVariable('GITEA_CLIENT_SECRET');
const GITEA_REDIRECT_URI = getPlatformOAuthCallbackUrl(PLATFORM.GITEA);

const DEFAULT_GITEA_URL = DEFAULT_GITEA_INSTANCE_URL;
const MAX_GITEA_REDIRECTS = 5;
const MAX_GITEA_RESPONSE_BYTES = 10 * 1024 * 1024;
const GITEA_REQUEST_TIMEOUT_MS = 30_000;

const GITEA_OAUTH_SCOPES = ['read:user', 'read:repository', 'read:organization', 'openid', 'profile', 'email'] as const;

export type GiteaOAuthCredentials = {
  clientId: string;
  clientSecret: string;
};

export type GiteaOAuthTokens = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  created_at: number;
  scope: string;
};

export type GiteaUser = {
  id: number;
  username: string;
  email: string;
  full_name: string;
  avatar_url: string;
};

export type GiteaRepo = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  clone_url: string;
  ssh_url: string;
};

export type GiteaBranch = {
  name: string;
  commit: {
    id: string;
    sha: string;
    url: string;
  };
  protected: boolean;
  default?: boolean;
};

async function fetchGitea(url: string, init?: RequestInit, redirectCount = 0): Promise<Response> {
  const response = await fetchGiteaOnce(url, init);
  if (!isGiteaRedirect(response.status)) {
    return response;
  }

  const location = response.headers.get('location');
  if (!location) {
    return response;
  }

  if (redirectCount >= MAX_GITEA_REDIRECTS) {
    throw new Error('Gitea request exceeded redirect limit');
  }

  const redirectUrl = new URL(location, url).toString();
  return fetchGitea(
    redirectUrl,
    buildRedirectRequestInit(init, response.status, url, redirectUrl),
    redirectCount + 1
  );
}

async function fetchGiteaOnce(url: string, init?: RequestInit): Promise<Response> {
  const resolvedUrl = await resolveGiteaUrlSafely(url);
  if (!resolvedUrl.address) {
    return fetch(url, { ...init, redirect: 'manual' });
  }

  return fetchGiteaBoundToAddress(
    { ...resolvedUrl, address: resolvedUrl.address },
    init
  );
}

function isGiteaRedirect(status: number): boolean {
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
    throw new Error('Gitea request refused HTTPS-to-HTTP redirect');
  }

  if (from.origin !== to.origin) {
    if ((status === 307 || status === 308) && init.body != null) {
      throw new Error('Gitea request refused cross-origin redirect with request body');
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

type ResolvedGiteaUrl = GiteaResolvedUrl & { address: string };

function fetchGiteaBoundToAddress(
  resolvedUrl: GiteaResolvedUrl & { address: string },
  init?: RequestInit
): Promise<Response> {
  const reqUrl = resolvedUrl.url;
  const request = reqUrl.protocol === 'https:' ? https.request : http.request;
  const headers = headersInitToRecord(init?.headers);
  const body = bodyInitToBuffer(init?.body);

  if (body && !hasHeader(headers, 'content-length')) {
    headers['content-length'] = String(Buffer.byteLength(body));
  }

  return new Promise((resolve, reject) => {
    const req = request(
      {
        protocol: reqUrl.protocol,
        hostname: reqUrl.hostname,
        port: reqUrl.port || undefined,
        path: `${reqUrl.pathname}${reqUrl.search}`,
        method: init?.method ?? 'GET',
        headers,
        family: resolvedUrl.family,
        lookup: (_hostname, _options, callback) =>
          callback(null, resolvedUrl.address, resolvedUrl.family ?? 0),
        ...(reqUrl.protocol === 'https:' ? { servername: reqUrl.hostname } : {}),
      },
      response => {
        const chunks: Buffer[] = [];
        let responseBytes = 0;
        response.on('data', chunk => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          responseBytes += buffer.byteLength;
          if (responseBytes > MAX_GITEA_RESPONSE_BYTES) {
            const error = new Error('Gitea response exceeded size limit');
            response.destroy(error);
            req.destroy(error);
            reject(error);
            return;
          }

          chunks.push(buffer);
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            const status = response.statusCode ?? 500;
            const body = responseStatusForbidsBody(status) ? null : Buffer.concat(chunks);
            resolve(
              new Response(body, {
                status,
                statusText: response.statusMessage,
                headers: responseHeadersToHeaders(response.headers),
              })
            );
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(GITEA_REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('Gitea request timed out'));
    });

    const signal = init?.signal;
    if (signal) {
      if (signal.aborted) {
        req.destroy(signal.reason);
        reject(signal.reason);
        return;
      }

      signal.addEventListener(
        'abort',
        () => {
          req.destroy(signal.reason);
          reject(signal.reason);
        },
        { once: true }
      );
    }

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function isGiteaRedirectStatus(status: number): boolean {
  return isGiteaRedirect(status);
}

function headersInitToRecord(headers: HeadersInit | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function bodyInitToBuffer(body: BodyInit | null | undefined): Buffer | undefined {
  if (body == null) return undefined;
  if (typeof body === 'string') return Buffer.from(body);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (body instanceof FormData) {
    // Can't easily convert FormData to buffer, return undefined
    return undefined;
  }
  return undefined;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(headers, name);
}

function responseStatusForbidsBody(status: number): boolean {
  return status === 204 || status === 304;
}

function responseHeadersToHeaders(headers: http.IncomingHttpHeaders): Headers {
  const responseHeaders = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        responseHeaders.append(key, item);
      }
    } else if (value !== undefined && value !== null && typeof value === 'string') {
      responseHeaders.set(key, value);
    }
  }
  return responseHeaders;
}

export function buildGiteaOAuthUrl(
  state: string,
  instanceUrl: string = DEFAULT_GITEA_URL,
  customCredentials?: GiteaOAuthCredentials
): string {
  const normalizedInstanceUrl = normalizeGiteaInstanceUrl(instanceUrl);
  if (!isDefaultGiteaInstanceUrl(normalizedInstanceUrl) && !customCredentials) {
    throw new Error('Custom Gitea OAuth credentials are required for self-hosted instances');
  }

  const clientId = customCredentials?.clientId || GITEA_CLIENT_ID;

  if (!clientId || !GITEA_REDIRECT_URI) {
    throw new Error('Gitea OAuth credentials not configured');
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: GITEA_REDIRECT_URI,
    response_type: 'code',
    state,
    scope: GITEA_OAUTH_SCOPES.join(' '),
  });

  return buildGiteaUrl(
    normalizedInstanceUrl,
    '/login/oauth/authorize',
    Object.fromEntries(params)
  );
}

export async function exchangeGiteaOAuthCode(
  code: string,
  instanceUrl: string = DEFAULT_GITEA_URL,
  customCredentials?: GiteaOAuthCredentials
): Promise<GiteaOAuthTokens> {
  const normalizedInstanceUrl = normalizeGiteaInstanceUrl(instanceUrl);
  if (!isDefaultGiteaInstanceUrl(normalizedInstanceUrl) && !customCredentials) {
    throw new Error('Custom Gitea OAuth credentials are required for self-hosted instances');
  }

  const clientId = customCredentials?.clientId || GITEA_CLIENT_ID;
  const clientSecret = customCredentials?.clientSecret || GITEA_CLIENT_SECRET;

  if (!clientId || !clientSecret || !GITEA_REDIRECT_URI) {
    throw new Error('Gitea OAuth credentials not configured');
  }

  const response = await fetchGitea(buildGiteaUrl(normalizedInstanceUrl, '/login/oauth/access_token'), {
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
      redirect_uri: GITEA_REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    logExceptInTest('Gitea OAuth token exchange failed:', { status: response.status, error });
    throw new Error(`Gitea OAuth token exchange failed: ${response.status}`);
  }

  const tokens = (await response.json()) as GiteaOAuthTokens;

  logExceptInTest('Gitea OAuth tokens received', {
    hasAccessToken: !!tokens.access_token,
    hasRefreshToken: !!tokens.refresh_token,
    expiresIn: tokens.expires_in,
    scope: tokens.scope,
  });

  return tokens;
}

export async function fetchGiteaUser(
  accessToken: string,
  instanceUrl: string = DEFAULT_GITEA_URL
): Promise<GiteaUser> {
  const response = await fetchGitea(buildGiteaUrl(instanceUrl, '/api/v1/user'), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    logExceptInTest('Gitea user fetch failed:', { status: response.status, error });
    throw new Error(`Gitea user fetch failed: ${response.status}`);
  }

  return (await response.json()) as GiteaUser;
}

export async function fetchGiteaRepos(
  accessToken: string,
  instanceUrl: string = DEFAULT_GITEA_URL
): Promise<PlatformRepository[]> {
  const repos: PlatformRepository[] = [];
  let page = 1;
  const limit = 100;

  while (true) {
    const response = await fetchGitea(
      buildGiteaUrl(instanceUrl, '/api/v1/user/repos', {
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
      logExceptInTest('Gitea repos fetch failed:', { status: response.status, error });
      throw new Error(`Gitea repos fetch failed: ${response.status}`);
    }

    const data = (await response.json()) as GiteaRepo[];

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

  logExceptInTest('Gitea repos fetched', { count: repos.length });

  return repos;
}

export async function fetchGiteaBranches(
  accessToken: string,
  repoPath: string,
  instanceUrl: string = DEFAULT_GITEA_URL
): Promise<GiteaBranch[]> {
  const encodedRepoPath = encodeURIComponent(repoPath);
  const branches: GiteaBranch[] = [];
  let page = 1;
  const limit = 100;

  while (true) {
    const response = await fetchGitea(
      buildGiteaUrl(instanceUrl, `/api/v1/repos/${encodedRepoPath}/branches`, {
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
      logExceptInTest('Gitea branches fetch failed:', { status: response.status, error });
      throw new Error(`Gitea branches fetch failed: ${response.status}`);
    }

    const data = (await response.json()) as GiteaBranch[];
    branches.push(...data);

    if (data.length < limit) break;
    page++;
  }

  logExceptInTest('Gitea branches fetched', { repoPath, count: branches.length });

  return branches;
}

export function calculateTokenExpiry(createdAt: number, expiresIn: number): string {
  const expiresAtMs = (createdAt + expiresIn) * 1000;
  return new Date(expiresAtMs).toISOString();
}

export { DEFAULT_GITEA_INSTANCE_URL, normalizeGiteaInstanceUrl };

export type GiteaInstanceValidationResult = {
  valid: boolean;
  version?: string;
  error?: string;
};

/**
 * Uses the public /api/v1/version endpoint which doesn't require authentication.
 * This allows users to verify their self-hosted Gitea URL before attempting OAuth.
 */
export async function validateGiteaInstance(
  instanceUrl: string
): Promise<GiteaInstanceValidationResult> {
  let normalizedUrl: string;
  try {
    normalizedUrl = normalizeGiteaInstanceUrl(instanceUrl);
  } catch (error) {
    return {
      valid: false,
      error: error instanceof GiteaInstanceUrlError ? error.message : 'Invalid URL format.',
    };
  }

  try {
    const response = await fetchGitea(buildGiteaUrl(normalizedUrl, '/api/v1/version'), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      logExceptInTest('[validateGiteaInstance] Invalid response from instance', {
        instanceUrl: normalizedUrl,
        status: response.status,
      });

      return {
        valid: false,
        error: `Gitea instance returned status ${response.status}. Please verify the URL.`,
      };
    }

    const data = (await response.json()) as { version: string };

    if (!data.version || typeof data.version !== 'string') {
      return {
        valid: false,
        error: 'Response does not appear to be from a Gitea instance.',
      };
    }

    logExceptInTest('[validateGiteaInstance] Valid Gitea instance found', {
      instanceUrl: normalizedUrl,
      version: data.version,
    });

    return {
      valid: true,
      version: data.version,
    };
  } catch (error) {
    if (error instanceof GiteaInstanceUrlError) {
      return {
        valid: false,
        error: error.message,
      };
    }

    logExceptInTest('[validateGiteaInstance] Error validating instance', {
      instanceUrl: normalizedUrl,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      valid: false,
      error: 'Failed to validate Gitea instance. Please verify the URL is correct and accessible.',
    };
  }
}

export function fetchGiteaProjects(...args: Parameters<typeof fetchGiteaRepos>) {
  return fetchGiteaRepos(...args);
}
