import { readBoundedRequestBodyBytes } from '../bounded-request-body.js';
import {
  GITHUB_RATE_LIMIT_MAX_RETRY_ATTEMPTS,
  GITHUB_RATE_LIMIT_MAX_RETRY_TOTAL_WAIT_MS,
  inspectGitHubRateLimitResponse,
  resolveGitHubRateLimitRetryDelayMs,
} from '../github-rate-limit-diagnostics.js';
import type { GitTokenService } from '../types.js';
import type { ResolvedScmCapability } from './authorization.js';
import {
  classifyDiagnosticError,
  classifyScmRoute,
  classifyScmTarget,
  getCapabilityVersion,
  getSafeRequestLogFields,
  logDiagnostic,
} from './diagnostics.js';

const GITHUB_GIT_RETRY_MAX_BODY_BYTES = 1_048_576;
type GitHubTokenRedemptionBinding = Pick<GitTokenService, 'redeemGitHubSessionCapability'>;
type GitLabTokenRedemptionBinding = Pick<GitTokenService, 'redeemGitLabSessionCapability'>;
type BitbucketTokenRedemptionBinding = {
  redeemBitbucketSessionCapability: NonNullable<
    GitTokenService['redeemBitbucketSessionCapability']
  >;
};

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

function supportsBitbucketSessionCapabilityRedemption(
  service: unknown
): service is BitbucketTokenRedemptionBinding {
  return (
    typeof service === 'object' &&
    service !== null &&
    'redeemBitbucketSessionCapability' in service &&
    typeof service.redeemBitbucketSessionCapability === 'function'
  );
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

/** Only upload-pack reads can retry; receive-pack discovery shares the info/refs path. */
function isGitHubGitUploadRetryableRequest(request: Request): boolean {
  const url = new URL(request.url);
  if (classifyScmTarget(url) !== 'github-git') return false;
  const route = classifyScmRoute(url, 'github-git');
  if (request.method === 'GET') {
    return route === 'git-info-refs' && url.searchParams.get('service') === 'git-upload-pack';
  }
  if (request.method === 'POST') return route === 'git-upload-pack';
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function forwardGitHubGitWithRateLimitReset(
  createRequest: () => Request,
  headersToApply: Record<string, string | undefined>,
  maxRetryAttempts: number
): Promise<Response> {
  let response = await forwardRedeemedRequest(createRequest(), headersToApply);
  let attemptsUsed = 0;
  let remainingTotalWaitMs = GITHUB_RATE_LIMIT_MAX_RETRY_TOTAL_WAIT_MS;

  while (response.status === 429 && attemptsUsed < maxRetryAttempts) {
    let diagnostic: Awaited<ReturnType<typeof inspectGitHubRateLimitResponse>>;
    try {
      diagnostic = await inspectGitHubRateLimitResponse(response);
    } catch {
      diagnostic = undefined;
    }
    if (!diagnostic) return response;

    const delayMs = resolveGitHubRateLimitRetryDelayMs(diagnostic, Date.now());
    if (delayMs === undefined || delayMs > remainingTotalWaitMs) return response;

    void response.body?.cancel().catch(() => {});
    await sleep(delayMs);
    remainingTotalWaitMs -= delayMs;
    attemptsUsed += 1;
    logDiagnostic(
      'info',
      { retryDelayMs: delayMs, retryAttempt: attemptsUsed },
      'Managed GitHub git request rate limited; retrying after observed reset'
    );
    response = await forwardRedeemedRequest(createRequest(), headersToApply);
  }
  return response;
}

async function handleManagedGitHubOutbound(
  request: Request,
  tokenService: unknown,
  capability: { capability: string },
  outboundContainerId: string
): Promise<Response> {
  const logFields = {
    ...getSafeRequestLogFields(request),
    provider: 'github',
    capabilityVersion: getCapabilityVersion(capability.capability),
    outboundContainerId,
  };
  logDiagnostic('debug', logFields, 'Redeeming managed GitHub outbound request');

  if (!supportsGitHubSessionCapabilityRedemption(tokenService)) {
    logDiagnostic(
      'warn',
      { ...logFields, failureStage: 'redemption-binding' },
      'Managed GitHub outbound redemption unavailable'
    );
    return new Response('GitHub authorization unavailable', { status: 502 });
  }

  let result: Awaited<ReturnType<GitHubTokenRedemptionBinding['redeemGitHubSessionCapability']>>;
  try {
    result = await tokenService.redeemGitHubSessionCapability({
      capability: capability.capability,
      outboundContainerId,
      requestMethod: request.method,
      requestUrl: request.url,
    });
  } catch (error) {
    logDiagnostic(
      'warn',
      {
        ...logFields,
        failureStage: 'redemption-rpc',
        errorClass: classifyDiagnosticError(error),
      },
      'Managed GitHub outbound redemption failed'
    );
    return new Response('GitHub authorization unavailable', { status: 502 });
  }

  if (!result.success) {
    logDiagnostic(
      'warn',
      { ...logFields, failureStage: 'redemption-policy', reason: result.reason },
      'Managed GitHub outbound redemption rejected'
    );
    return new Response('GitHub authorization unavailable', { status: 502 });
  }

  const headersToApply = { authorization: result.authorization ?? undefined };
  let response: Response;
  try {
    if (!isGitHubGitUploadRetryableRequest(request)) {
      response = await forwardRedeemedRequest(request, headersToApply);
    } else if (request.method === 'POST') {
      const bodyBytes = await readBoundedRequestBodyBytes(request, GITHUB_GIT_RETRY_MAX_BODY_BYTES);
      if (bodyBytes === undefined) {
        // Over the replay cap: forward once unchanged and return the real response.
        response = await forwardRedeemedRequest(request, headersToApply);
      } else {
        response = await forwardGitHubGitWithRateLimitReset(
          () =>
            new Request(request.url, {
              method: request.method,
              headers: request.headers,
              body: bodyBytes,
            }),
          headersToApply,
          GITHUB_RATE_LIMIT_MAX_RETRY_ATTEMPTS
        );
      }
    } else {
      response = await forwardGitHubGitWithRateLimitReset(
        () => request,
        headersToApply,
        GITHUB_RATE_LIMIT_MAX_RETRY_ATTEMPTS
      );
    }
  } catch (error) {
    logDiagnostic(
      'warn',
      {
        ...logFields,
        failureStage: 'upstream-forward',
        errorClass: classifyDiagnosticError(error),
      },
      'Managed GitHub outbound forwarding failed'
    );
    return new Response('GitHub authorization unavailable', { status: 502 });
  }

  logDiagnostic(
    'info',
    { ...logFields, upstreamStatus: response.status },
    'Managed GitHub outbound request forwarded'
  );
  if (response.status === 403 || response.status === 429) {
    let rateLimitDiagnostic;
    try {
      rateLimitDiagnostic = await inspectGitHubRateLimitResponse(response);
    } catch {
      rateLimitDiagnostic = undefined;
    }
    logDiagnostic(
      'warn',
      {
        ...logFields,
        githubInstallationId: result.installationId ?? null,
        githubAuthSource: result.source ?? null,
        githubAppType: result.appType ?? null,
        upstreamStatus: response.status,
        quotaClass: rateLimitDiagnostic?.quotaClass ?? 'unknown',
        bodySignal: rateLimitDiagnostic?.bodySignal ?? 'none',
        ...(rateLimitDiagnostic
          ? {
              githubRateLimitLimit: rateLimitDiagnostic.githubRateLimitLimit,
              githubRateLimitRemaining: rateLimitDiagnostic.githubRateLimitRemaining,
              githubRateLimitUsed: rateLimitDiagnostic.githubRateLimitUsed,
              githubRateLimitReset: rateLimitDiagnostic.githubRateLimitReset,
              githubRateLimitResource: rateLimitDiagnostic.githubRateLimitResource,
              githubRetryAfter: rateLimitDiagnostic.githubRetryAfter,
            }
          : {}),
      },
      'Managed GitHub upstream rate-limit response'
    );
  }
  return response;
}

async function handleManagedGitLabOutbound(
  request: Request,
  tokenService: unknown,
  capability: { capability: string },
  outboundContainerId: string
): Promise<Response> {
  const logFields = {
    ...getSafeRequestLogFields(request),
    provider: 'gitlab',
    capabilityVersion: getCapabilityVersion(capability.capability),
    outboundContainerId,
  };
  logDiagnostic('debug', logFields, 'Redeeming managed GitLab outbound request');

  if (!supportsGitLabSessionCapabilityRedemption(tokenService)) {
    logDiagnostic(
      'warn',
      { ...logFields, failureStage: 'redemption-binding' },
      'Managed GitLab outbound redemption unavailable'
    );
    return new Response('GitLab authorization unavailable', { status: 502 });
  }

  let result: Awaited<ReturnType<GitLabTokenRedemptionBinding['redeemGitLabSessionCapability']>>;
  try {
    result = await tokenService.redeemGitLabSessionCapability({
      capability: capability.capability,
      outboundContainerId,
      requestMethod: request.method,
      requestUrl: request.url,
    });
  } catch (error) {
    logDiagnostic(
      'warn',
      {
        ...logFields,
        failureStage: 'redemption-rpc',
        errorClass: classifyDiagnosticError(error),
      },
      'Managed GitLab outbound redemption failed'
    );
    return new Response('GitLab authorization unavailable', { status: 502 });
  }

  if (!result.success) {
    logDiagnostic(
      'warn',
      { ...logFields, failureStage: 'redemption-policy', reason: result.reason },
      'Managed GitLab outbound redemption rejected'
    );
    return new Response('GitLab authorization unavailable', { status: 502 });
  }

  let response: Response;
  try {
    response = await forwardRedeemedRequest(request, result.headers, true);
  } catch (error) {
    logDiagnostic(
      'warn',
      {
        ...logFields,
        failureStage: 'upstream-forward',
        errorClass: classifyDiagnosticError(error),
      },
      'Managed GitLab outbound forwarding failed'
    );
    return new Response('GitLab authorization unavailable', { status: 502 });
  }

  logDiagnostic(
    'info',
    { ...logFields, upstreamStatus: response.status },
    'Managed GitLab outbound request forwarded'
  );
  return response;
}

async function handleManagedBitbucketOutbound(
  request: Request,
  tokenService: unknown,
  capability: { capability: string },
  outboundContainerId: string
): Promise<Response> {
  const logFields = {
    ...getSafeRequestLogFields(request),
    provider: 'bitbucket',
    capabilityVersion: getCapabilityVersion(capability.capability),
    outboundContainerId,
  };
  logDiagnostic('debug', logFields, 'Redeeming managed Bitbucket outbound request');

  if (!supportsBitbucketSessionCapabilityRedemption(tokenService)) {
    logDiagnostic(
      'warn',
      { ...logFields, failureStage: 'redemption-binding' },
      'Managed Bitbucket outbound redemption unavailable'
    );
    return new Response('Bitbucket authorization unavailable', { status: 502 });
  }

  let result: Awaited<
    ReturnType<BitbucketTokenRedemptionBinding['redeemBitbucketSessionCapability']>
  >;
  try {
    result = await tokenService.redeemBitbucketSessionCapability({
      capability: capability.capability,
      outboundContainerId,
      requestMethod: request.method,
      requestUrl: request.url,
    });
  } catch (error) {
    logDiagnostic(
      'warn',
      { ...logFields, failureStage: 'redemption-rpc', errorClass: classifyDiagnosticError(error) },
      'Managed Bitbucket outbound redemption failed'
    );
    return new Response('Bitbucket authorization unavailable', { status: 502 });
  }

  if (!result.success) {
    logDiagnostic(
      'warn',
      { ...logFields, failureStage: 'redemption-policy', reason: result.reason },
      'Managed Bitbucket outbound redemption rejected'
    );
    return new Response('Bitbucket authorization unavailable', { status: 502 });
  }

  let response: Response;
  try {
    response = await forwardRedeemedRequest(request, result.headers);
  } catch (error) {
    logDiagnostic(
      'warn',
      {
        ...logFields,
        failureStage: 'upstream-forward',
        errorClass: classifyDiagnosticError(error),
      },
      'Managed Bitbucket outbound forwarding failed'
    );
    return new Response('Bitbucket authorization unavailable', { status: 502 });
  }

  logDiagnostic(
    'info',
    { ...logFields, upstreamStatus: response.status },
    'Managed Bitbucket outbound request forwarded'
  );
  return response;
}

/** The caller must admit the provider identity and resolve any alias before calling this entry. */
export function forwardResolvedScmCapability(
  request: Request,
  tokenService: unknown,
  capability: ResolvedScmCapability,
  outboundContainerId: string
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set('Host', new URL(request.url).host);
  request = new Request(request, { headers });
  if (capability.provider === 'github') {
    return handleManagedGitHubOutbound(request, tokenService, capability, outboundContainerId);
  }
  if (capability.provider === 'bitbucket') {
    return handleManagedBitbucketOutbound(request, tokenService, capability, outboundContainerId);
  }
  return handleManagedGitLabOutbound(request, tokenService, capability, outboundContainerId);
}
