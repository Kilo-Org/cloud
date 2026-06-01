import { Buffer } from 'node:buffer';
import { ContainerProxy, Sandbox as StockSandbox } from '@cloudflare/sandbox';
import type { GitTokenService } from './types.js';

const GITHUB_CAPABILITY_PREFIX = 'kgh1.';
const GITLAB_CAPABILITY_PREFIX = 'kgl1.';

type GitHubTokenRedemptionBinding = Pick<GitTokenService, 'redeemGitHubSessionCapability'>;
type GitLabTokenRedemptionBinding = Pick<GitTokenService, 'redeemGitLabSessionCapability'>;
type RedeemableAuthorization = { provider: 'github' | 'gitlab'; capability: string };
type AuthorizationExtraction =
  | { type: 'none' }
  | { type: 'capability'; value: RedeemableAuthorization }
  | { type: 'unsupported_capability' };

const NO_AUTHORIZATION_CAPABILITY = { type: 'none' } satisfies AuthorizationExtraction;

function supportsGitHubSessionCapabilityRedemption(
  service: unknown
): service is GitHubTokenRedemptionBinding {
  return (
    typeof service === 'object' &&
    service !== null &&
    'redeemGitHubSessionCapability' in service &&
    typeof service.redeemGitHubSessionCapability === 'function'
  );
}

function supportsGitLabSessionCapabilityRedemption(
  service: unknown
): service is GitLabTokenRedemptionBinding {
  return (
    typeof service === 'object' &&
    service !== null &&
    'redeemGitLabSessionCapability' in service &&
    typeof service.redeemGitLabSessionCapability === 'function'
  );
}

function identifyCapability(capability: string): RedeemableAuthorization | null {
  if (capability.startsWith(GITHUB_CAPABILITY_PREFIX)) return { provider: 'github', capability };
  if (capability.startsWith(GITLAB_CAPABILITY_PREFIX)) return { provider: 'gitlab', capability };
  return null;
}

function extractGitCapability(authorization: string | null): AuthorizationExtraction {
  if (!authorization) return NO_AUTHORIZATION_CAPABILITY;
  const match = /^Basic[ \t]+(.+)$/i.exec(authorization);
  if (!match) return NO_AUTHORIZATION_CAPABILITY;
  const encodedCredential = match[1];
  if (!encodedCredential) return NO_AUTHORIZATION_CAPABILITY;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedCredential)) return NO_AUTHORIZATION_CAPABILITY;
  const decodedCredential = Buffer.from(encodedCredential, 'base64');
  if (decodedCredential.toString('base64') !== encodedCredential)
    return NO_AUTHORIZATION_CAPABILITY;
  const credential = decodedCredential.toString('utf8');
  const separator = credential.indexOf(':');
  if (separator === -1) return NO_AUTHORIZATION_CAPABILITY;
  const username = credential.slice(0, separator);
  const capability = identifyCapability(credential.slice(separator + 1));
  if (!capability) return NO_AUTHORIZATION_CAPABILITY;
  if (username === 'x-access-token' && capability.provider === 'github') {
    return { type: 'capability', value: capability };
  }
  if (username === 'oauth2' && capability.provider === 'gitlab') {
    return { type: 'capability', value: capability };
  }
  return { type: 'unsupported_capability' };
}

function extractApiCapability(authorization: string | null): AuthorizationExtraction {
  if (!authorization) return NO_AUTHORIZATION_CAPABILITY;
  const match = /^(token|Bearer)[ \t]+(.+)$/i.exec(authorization);
  if (!match) return NO_AUTHORIZATION_CAPABILITY;
  const capability = match[2] ? identifyCapability(match[2]) : null;
  if (!capability) return NO_AUTHORIZATION_CAPABILITY;
  if (capability.provider === 'gitlab' && match[1]?.toLowerCase() !== 'bearer') {
    return { type: 'unsupported_capability' };
  }
  return { type: 'capability', value: capability };
}

function extractGitLabPrivateTokenCapability(privateToken: string | null): AuthorizationExtraction {
  if (!privateToken) return NO_AUTHORIZATION_CAPABILITY;
  const capability = identifyCapability(privateToken.trim());
  if (!capability) return NO_AUTHORIZATION_CAPABILITY;
  return capability.provider === 'gitlab'
    ? { type: 'capability', value: capability }
    : { type: 'unsupported_capability' };
}

async function forwardRedeemedRequest(
  request: Request,
  headersToApply: Record<string, string | undefined>,
  removeGitLabPrivateToken = false
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete('Authorization');
  if (removeGitLabPrivateToken) headers.delete('PRIVATE-TOKEN');
  for (const [name, value] of Object.entries(headersToApply)) {
    if (value !== undefined) headers.set(name, value);
  }
  return fetch(
    new Request(request, {
      headers,
      redirect: 'manual',
    })
  );
}

async function handleManagedGitHubOutbound(
  request: Request,
  env: Cloudflare.Env,
  capability: { capability: string }
): Promise<Response> {
  const tokenService = env.GIT_TOKEN_SERVICE;
  if (!supportsGitHubSessionCapabilityRedemption(tokenService)) {
    return new Response('GitHub authorization unavailable', { status: 502 });
  }
  try {
    const result = await tokenService.redeemGitHubSessionCapability({
      capability: capability.capability,
      requestMethod: request.method,
      requestUrl: request.url,
    });
    if (!result.success) {
      return new Response('GitHub authorization unavailable', { status: 502 });
    }
    return forwardRedeemedRequest(request, { authorization: result.authorization });
  } catch {
    return new Response('GitHub authorization unavailable', { status: 502 });
  }
}

async function handleManagedGitLabOutbound(
  request: Request,
  env: Cloudflare.Env,
  capability: { capability: string }
): Promise<Response> {
  const tokenService = env.GIT_TOKEN_SERVICE;
  if (!supportsGitLabSessionCapabilityRedemption(tokenService)) {
    return new Response('GitLab authorization unavailable', { status: 502 });
  }
  try {
    const result = await tokenService.redeemGitLabSessionCapability({
      capability: capability.capability,
      requestMethod: request.method,
      requestUrl: request.url,
    });
    if (!result.success) {
      return new Response('GitLab authorization unavailable', { status: 502 });
    }
    return forwardRedeemedRequest(request, result.headers, true);
  } catch {
    return new Response('GitLab authorization unavailable', { status: 502 });
  }
}

export function handleManagedScmOutbound(request: Request, env: Cloudflare.Env): Promise<Response> {
  const authorization = request.headers.get('Authorization');
  const gitCapability = extractGitCapability(authorization);
  const apiCapability = extractApiCapability(authorization);
  const privateTokenCapability = extractGitLabPrivateTokenCapability(
    request.headers.get('PRIVATE-TOKEN')
  );
  if (
    gitCapability.type === 'unsupported_capability' ||
    apiCapability.type === 'unsupported_capability' ||
    privateTokenCapability.type === 'unsupported_capability'
  ) {
    return Promise.resolve(new Response('SCM authorization unavailable', { status: 502 }));
  }
  const authorizationCapability =
    gitCapability.type === 'capability'
      ? gitCapability.value
      : apiCapability.type === 'capability'
        ? apiCapability.value
        : null;
  const gitLabPrivateTokenCapability =
    privateTokenCapability.type === 'capability' ? privateTokenCapability.value : null;
  if (
    authorizationCapability &&
    gitLabPrivateTokenCapability &&
    (authorizationCapability.provider !== 'gitlab' ||
      authorizationCapability.capability !== gitLabPrivateTokenCapability.capability)
  ) {
    return Promise.resolve(new Response('GitLab authorization unavailable', { status: 502 }));
  }
  const capability = authorizationCapability ?? gitLabPrivateTokenCapability;
  if (!capability) return fetch(request);
  return capability.provider === 'github'
    ? handleManagedGitHubOutbound(request, env, capability)
    : handleManagedGitLabOutbound(request, env, capability);
}

export class Sandbox extends StockSandbox<Cloudflare.Env> {
  enableInternet = true;
  interceptHttps = true;
}

Sandbox.outbound = handleManagedScmOutbound;

export class SandboxSmall extends StockSandbox<Cloudflare.Env> {
  enableInternet = true;
  interceptHttps = true;
}

SandboxSmall.outbound = handleManagedScmOutbound;

export class SandboxDIND extends StockSandbox<Cloudflare.Env> {
  enableInternet = true;
  interceptHttps = true;
}

SandboxDIND.outbound = handleManagedScmOutbound;

export { ContainerProxy };
