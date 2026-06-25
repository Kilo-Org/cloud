import 'server-only';

import { BITBUCKET_CLIENT_ID, BITBUCKET_CLIENT_SECRET } from '@/lib/config.server';
import { MAX_BITBUCKET_WORKSPACES, type BitbucketWorkspace } from './metadata';
import { z } from 'zod';

const BITBUCKET_AUTHORIZE_URL = 'https://bitbucket.org/site/oauth2/authorize';
const BITBUCKET_TOKEN_URL = 'https://bitbucket.org/site/oauth2/access_token';
const BITBUCKET_CURRENT_USER_URL = 'https://api.bitbucket.org/2.0/user';
const BITBUCKET_WORKSPACES_URL = 'https://api.bitbucket.org/2.0/user/workspaces';
const MAX_BITBUCKET_TOKEN_EXPIRY_SECONDS = 24 * 60 * 60;
const MAX_BITBUCKET_WORKSPACE_PAGES = 20;

const NonEmptyOAuthTokenSchema = z
  .string()
  .min(1)
  .refine(value => value.trim() === value);
const NonEmptyProviderStringSchema = z
  .string()
  .min(1)
  .refine(value => value.trim() === value);

const BitbucketOAuthTokenPayloadSchema = z
  .object({
    access_token: NonEmptyOAuthTokenSchema,
    refresh_token: NonEmptyOAuthTokenSchema,
    token_type: z
      .string()
      .transform(value => value.toLowerCase())
      .pipe(z.literal('bearer')),
    expires_in: z.number().int().positive().max(MAX_BITBUCKET_TOKEN_EXPIRY_SECONDS),
    scope: z.string(),
    scopes: z.string().optional(),
  })
  .strict();

export type BitbucketOAuthTokens = {
  accessToken: string;
  refreshToken: string;
  tokenType: 'bearer';
  expiresIn: number;
  scopes: string[];
};

const BitbucketUserPayloadSchema = z.object({
  uuid: NonEmptyProviderStringSchema,
  nickname: NonEmptyProviderStringSchema,
  display_name: NonEmptyProviderStringSchema,
});

export type BitbucketUser = {
  uuid: string;
  nickname: string;
  displayName: string;
};

const BitbucketWorkspacePageSchema = z.object({
  values: z.array(
    z.object({
      workspace: z.object({
        uuid: NonEmptyProviderStringSchema,
        slug: NonEmptyProviderStringSchema,
        name: NonEmptyProviderStringSchema.optional(),
      }),
    })
  ),
  next: z.string().min(1).optional(),
});

export const BITBUCKET_OAUTH_SCOPES = [
  'account',
  'repository:write',
  'pullrequest',
  'webhook',
] as const;

const BITBUCKET_OAUTH_SCOPE_ALIASES: Record<string, readonly string[]> = {
  'read:account:bitbucket-legacy': ['account'],
  'read:email:bitbucket-legacy': ['email'],
  'read:repository:bitbucket-legacy': ['repository'],
  'write:repository:bitbucket-legacy': ['repository:write'],
  'read:webhook:bitbucket-legacy': ['webhook'],
  'write:webhook:bitbucket-legacy': ['webhook'],
  'admin:webhook:bitbucket-legacy': ['webhook'],
  pullrequest: ['pullrequest'],
  'read:pullrequest:bitbucket-legacy': ['pullrequest'],
  offline_access: [],
};

function expandBitbucketOAuthScopeClosure(scopes: Iterable<string>): Set<string> {
  const closure = new Set(scopes);
  if (closure.has('repository:write')) {
    closure.add('repository');
  }
  if (closure.has('account')) {
    closure.add('email');
  }
  return closure;
}

function normalizeBitbucketOAuthScopes(scope: string): string[] {
  const canonicalScopes = new Set<string>();
  for (const rawScope of scope.split(/\s+/).filter(Boolean)) {
    for (const canonicalScope of BITBUCKET_OAUTH_SCOPE_ALIASES[rawScope.toLowerCase()] ?? [
      rawScope.toLowerCase(),
    ]) {
      canonicalScopes.add(canonicalScope);
    }
  }

  const returnedScopes = expandBitbucketOAuthScopeClosure(canonicalScopes);
  const allowedScopes = expandBitbucketOAuthScopeClosure(BITBUCKET_OAUTH_SCOPES);
  if (BITBUCKET_OAUTH_SCOPES.some(requiredScope => !returnedScopes.has(requiredScope))) {
    const missingScopes = BITBUCKET_OAUTH_SCOPES.filter(
      requiredScope => !returnedScopes.has(requiredScope)
    );
    throw new Error(
      `Bitbucket OAuth token exchange returned invalid credentials: scope_mismatch missing=${missingScopes.join(',') || 'none'} observed=${[...returnedScopes].sort().join(',') || 'none'}`
    );
  }
  return [...returnedScopes].filter(scope => allowedScopes.has(scope)).sort();
}

function describeBitbucketTokenResponseShape(responseBody: unknown): unknown {
  if (!responseBody || typeof responseBody !== 'object' || Array.isArray(responseBody)) {
    return { type: Array.isArray(responseBody) ? 'array' : typeof responseBody };
  }

  return Object.fromEntries(
    Object.entries(responseBody).map(([key, value]) => [
      key,
      key.includes('token') && typeof value === 'string' ? 'redacted-string' : typeof value,
    ])
  );
}

async function readBitbucketJson(
  response: Response,
  invalidResponseMessage: string
): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(invalidResponseMessage);
  }
}

function validateBitbucketWorkspacePageUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Bitbucket refused unsafe workspace pagination URL');
  }

  if (
    (value !== BITBUCKET_WORKSPACES_URL && !value.startsWith(`${BITBUCKET_WORKSPACES_URL}?`)) ||
    url.protocol !== 'https:' ||
    url.origin !== 'https://api.bitbucket.org' ||
    url.hostname !== 'api.bitbucket.org' ||
    url.pathname !== '/2.0/user/workspaces' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    value.includes('#')
  ) {
    throw new Error('Bitbucket refused unsafe workspace pagination URL');
  }

  return value;
}

export function buildBitbucketOAuthUrl(state: string): string {
  if (!BITBUCKET_CLIENT_ID) {
    throw new Error('Bitbucket OAuth client ID is not configured');
  }

  const url = new URL(BITBUCKET_AUTHORIZE_URL);
  url.searchParams.set('client_id', BITBUCKET_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', BITBUCKET_OAUTH_SCOPES.join(' '));
  url.searchParams.set('state', state);
  return url.toString();
}

export async function exchangeBitbucketOAuthCode(code: string): Promise<BitbucketOAuthTokens> {
  if (!BITBUCKET_CLIENT_ID || !BITBUCKET_CLIENT_SECRET) {
    throw new Error('Bitbucket OAuth credentials are not configured');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
  });
  const basicAuth = Buffer.from(`${BITBUCKET_CLIENT_ID}:${BITBUCKET_CLIENT_SECRET}`).toString(
    'base64'
  );
  const response = await fetch(BITBUCKET_TOKEN_URL, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Bitbucket OAuth token exchange failed (${response.status})`);
  }

  const invalidCredentialsMessage = 'Bitbucket OAuth token exchange returned invalid credentials';
  const responseBody = await readBitbucketJson(response, invalidCredentialsMessage);
  const parsedTokens = BitbucketOAuthTokenPayloadSchema.safeParse(responseBody);
  if (!parsedTokens.success) {
    if (process.env.NODE_ENV === 'development') {
      console.error('Bitbucket OAuth token response failed validation', {
        shape: describeBitbucketTokenResponseShape(responseBody),
        issues: parsedTokens.error.issues.map(issue => ({
          code: issue.code,
          path: issue.path,
          message: issue.message,
        })),
      });
    }
    throw new Error(`${invalidCredentialsMessage}: token_response_schema`);
  }

  return {
    accessToken: parsedTokens.data.access_token,
    refreshToken: parsedTokens.data.refresh_token,
    tokenType: 'bearer',
    expiresIn: parsedTokens.data.expires_in,
    scopes: normalizeBitbucketOAuthScopes(parsedTokens.data.scope),
  };
}

export async function fetchBitbucketUser(accessToken: string): Promise<BitbucketUser> {
  const response = await fetch(BITBUCKET_CURRENT_USER_URL, {
    redirect: 'manual',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Bitbucket current-user request failed (${response.status})`);
  }

  const invalidIdentityMessage = 'Bitbucket current-user request returned an invalid identity';
  const responseBody = await readBitbucketJson(response, invalidIdentityMessage);
  const parsedUser = BitbucketUserPayloadSchema.safeParse(responseBody);
  if (!parsedUser.success) {
    throw new Error(invalidIdentityMessage);
  }
  return {
    uuid: parsedUser.data.uuid,
    nickname: parsedUser.data.nickname,
    displayName: parsedUser.data.display_name,
  };
}

export async function fetchBitbucketWorkspaces(accessToken: string): Promise<BitbucketWorkspace[]> {
  const workspaces: BitbucketWorkspace[] = [];
  const visitedUrls = new Set<string>();
  let nextUrl: string | undefined = BITBUCKET_WORKSPACES_URL;

  while (nextUrl) {
    if (visitedUrls.size >= MAX_BITBUCKET_WORKSPACE_PAGES) {
      throw new Error('Bitbucket workspace pagination exceeded page limit');
    }

    const pageUrl = validateBitbucketWorkspacePageUrl(nextUrl);
    const pageKey = new URL(pageUrl).toString();
    if (visitedUrls.has(pageKey)) {
      throw new Error('Bitbucket workspace pagination cycle detected');
    }
    visitedUrls.add(pageKey);

    const response = await fetch(pageUrl, {
      redirect: 'manual',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!response.ok) {
      throw new Error(`Bitbucket workspace request failed (${response.status})`);
    }

    const invalidResponseMessage = 'Bitbucket workspace request returned an invalid response';
    const responseBody = await readBitbucketJson(response, invalidResponseMessage);
    const page = BitbucketWorkspacePageSchema.safeParse(responseBody);
    if (!page.success) {
      throw new Error(invalidResponseMessage);
    }
    if (workspaces.length + page.data.values.length > MAX_BITBUCKET_WORKSPACES) {
      throw new Error('Bitbucket workspace pagination exceeded item limit');
    }
    workspaces.push(
      ...page.data.values.map(({ workspace }) => ({
        uuid: workspace.uuid,
        slug: workspace.slug,
        name: workspace.name ?? workspace.slug,
      }))
    );
    if (page.data.next && workspaces.length >= MAX_BITBUCKET_WORKSPACES) {
      throw new Error('Bitbucket workspace pagination exceeded item limit');
    }
    nextUrl = page.data.next;
  }

  return workspaces;
}
