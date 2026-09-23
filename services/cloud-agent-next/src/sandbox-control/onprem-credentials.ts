import { timingSafeEqual } from '@kilocode/encryption';
import {
  onPremCredentialRequestSchema,
  parseCanonicalOnPremUrl,
  type OnPremCredentialRequest,
  type OnPremCredentialResolution,
} from '../shared/onprem-credential-protocol.js';
import { parseControlPlaneCredential } from './managed-credential.js';
import {
  isContainedSessionCredentialGrant,
  sessionCredentialGrantSchema,
  type SessionCredentialGrant,
} from './session-credentials.js';
import {
  buildVercelCredentialNetworkPolicy,
  findMatchingCredentialInjectionRule,
} from './vercel-network-policy.js';

function authorizationAlias(authorization: string): string | null {
  const match = /^(Bearer|token|Basic) (\S+)$/i.exec(authorization);
  if (!match) return null;
  if (match[1].toLowerCase() !== 'basic') return match[2];
  try {
    const decoded = atob(match[2]);
    const prefix = 'x-access-token:';
    return btoa(decoded) === match[2] && decoded.startsWith(prefix)
      ? decoded.slice(prefix.length)
      : null;
  } catch {
    return null;
  }
}

function basePath(url: URL): string {
  return url.pathname.replace(/\/+$/, '');
}

function permitsKiloRequest(grant: SessionCredentialGrant, url: URL, method: string): boolean {
  const backend = new URL(grant.kilo.targets.backendBaseUrl);
  const provider = new URL(grant.kilo.targets.providerBaseUrl);
  const ingest = new URL(grant.kilo.targets.sessionIngestBaseUrl);
  const pathname = url.pathname;
  const sessionCollection = `${basePath(ingest)}/api/session`;
  if (
    url.origin === ingest.origin &&
    (pathname === sessionCollection || pathname.startsWith(`${sessionCollection}/`))
  ) {
    return grant.members.some(
      member =>
        (method === 'GET' && pathname === `${sessionCollection}/${member.kiloSessionId}/export`) ||
        (method === 'POST' && pathname === `${sessionCollection}/${member.kiloSessionId}/ingest`)
    );
  }

  if (url.origin === backend.origin) {
    const api = `${basePath(backend)}/api`;
    if (
      method === 'GET' &&
      ['user', 'profile', 'profile/balance', 'defaults', 'users/notifications'].some(
        suffix => pathname === `${api}/${suffix}`
      )
    ) {
      return true;
    }
    if (grant.orgId) {
      const organization = `${api}/organizations/${grant.orgId}`;
      if (
        (method === 'GET' &&
          ['models', 'defaults', 'modes'].some(
            suffix => pathname === `${organization}/${suffix}`
          )) ||
        (method === 'POST' && pathname === `${organization}/models/validate`)
      ) {
        return true;
      }
    } else if (method === 'POST' && pathname === `${api}/openrouter/models/validate`) {
      return true;
    }
  }

  if (url.origin !== provider.origin) return false;
  const path = basePath(provider);
  const segments = path.split('/').filter(Boolean);
  for (let index = 0; index < segments.length; index++) {
    if (
      segments[index] === 'api' &&
      segments[index + 1] === 'organizations' &&
      (!grant.orgId || segments[index + 2] !== grant.orgId)
    ) {
      return false;
    }
  }
  const catalog = grant.orgId
    ? path.includes('/api/organizations/')
      ? path
      : `${path}${path.endsWith('/api') ? '' : '/api'}/organizations/${grant.orgId}`
    : provider.toString().includes('/openrouter')
      ? path
      : `${path}${path.endsWith('/api') ? '' : '/api'}/openrouter`;
  if (
    (method === 'GET' && pathname === `${catalog}/models`) ||
    (method === 'POST' && pathname === `${catalog}/models/validate`)
  ) {
    return true;
  }
  const apiIndex = segments.lastIndexOf('api');
  const prefix = apiIndex < 0 ? segments : segments.slice(0, apiIndex);
  return (
    (method === 'GET' || method === 'POST') &&
    ['openrouter', 'gateway'].some(route =>
      pathname.startsWith(`/${[...prefix, 'api', route].join('/')}/`)
    )
  );
}

function isAnonymousGitHubRequest(url: URL, method: string): boolean {
  if (url.origin !== 'https://github.com') return false;
  const path =
    /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(
      url.pathname
    );
  if (!path) return false;
  if (path[1] === 'info/refs') {
    return (
      method === 'GET' &&
      url.searchParams.size === 1 &&
      ['git-upload-pack', 'git-receive-pack'].includes(url.searchParams.get('service') ?? '')
    );
  }
  return method === 'POST' && !url.search;
}

export function resolveOnPremCredentialGrant(input: {
  grant: SessionCredentialGrant;
  request: OnPremCredentialRequest;
  now?: number;
}): OnPremCredentialResolution | null {
  const parsed = sessionCredentialGrantSchema.safeParse(input.grant);
  const request = onPremCredentialRequestSchema.safeParse(input.request);
  const now = input.now ?? Date.now();
  if (!parsed.success || !request.success || !Number.isSafeInteger(now)) return null;
  const grant = parsed.data;
  if (
    grant.provider !== 'onprem' ||
    !isContainedSessionCredentialGrant(grant) ||
    now < grant.preparedAt ||
    now >= grant.expiresAt
  ) {
    return null;
  }
  const { method, authorization } = request.data;
  const url = parseCanonicalOnPremUrl(request.data.url);
  if (!url) return null;
  if (authorization === undefined) {
    return isAnonymousGitHubRequest(url, method)
      ? { headers: {}, expiresAt: grant.expiresAt }
      : null;
  }
  const credential = authorizationAlias(authorization);
  const alias = credential && parseControlPlaneCredential(credential);
  if (!alias || alias.sandboxId !== grant.sandboxId) return null;
  const expected = alias.purpose === 'kilo' ? grant.kilo.alias : grant.scm?.alias;
  if (!expected || !credential || !timingSafeEqual(credential, expected)) return null;
  if (alias.purpose === 'kilo') {
    if (!permitsKiloRequest(grant, url, method)) return null;
    return {
      headers: {
        authorization: `Bearer ${grant.kilo.token}`,
        host: url.host,
        'x-kilocode-organizationid': grant.orgId ?? '',
      },
      expiresAt: grant.expiresAt,
    };
  }
  if (
    alias.purpose !== 'github' ||
    grant.repository?.type !== 'github' ||
    grant.scm?.purpose !== 'github' ||
    !grant.scm.nativeToken ||
    !['https://github.com', 'https://api.github.com'].includes(url.origin) ||
    /\/actions\/runners\/(registration-token|remove-token|generate-jitconfig)(?:\/|$)/i.test(
      url.pathname
    )
  ) {
    return null;
  }
  try {
    const rules = buildVercelCredentialNetworkPolicy({
      github: {
        token: grant.scm.nativeToken,
        placeholder: expected,
        repository: grant.repository.repo,
      },
    }).injectionRules;
    const git = url.origin === 'https://github.com';
    const rule = findMatchingCredentialInjectionRule(rules, {
      url,
      method,
      headers: new Headers({
        authorization: git
          ? `Basic ${btoa(`x-access-token:${credential}`)}`
          : `Bearer ${credential}`,
      }),
    });
    const nativeAuthorization = git
      ? `Basic ${btoa(`x-access-token:${grant.scm.nativeToken}`)}`
      : `Bearer ${grant.scm.nativeToken}`;
    return rule?.headers.authorization === nativeAuthorization && rule.headers.host === url.host
      ? { headers: { ...rule.headers }, expiresAt: grant.expiresAt }
      : null;
  } catch {
    return null;
  }
}
