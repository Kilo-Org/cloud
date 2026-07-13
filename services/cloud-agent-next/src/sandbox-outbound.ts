import { Buffer } from 'node:buffer';
import { ContainerProxy, Sandbox as StockSandbox } from '@cloudflare/sandbox';
import { logger } from './logger.js';
import { MANAGED_SCM_OUTBOUND_HANDLER } from './sandbox-id.js';
import type { GitTokenService } from './types.js';

export { MANAGED_SCM_OUTBOUND_HANDLER } from './sandbox-id.js';

const GITHUB_CAPABILITY_PREFIXES = ['kgh1.', 'kgh2.'];
const GITLAB_CAPABILITY_PREFIXES = ['kgl1.', 'kgl2.'];
const KILO_CAPABILITY_PREFIXES = ['kka1.'];
const MAX_KILO_SESSION_BOOTSTRAP_BYTES = 16_000;

type GitHubTokenRedemptionBinding = Pick<GitTokenService, 'redeemGitHubSessionCapability'>;
type GitLabTokenRedemptionBinding = Pick<GitTokenService, 'redeemGitLabSessionCapability'>;
type KiloTokenRedemptionBinding = Pick<GitTokenService, 'redeemKiloSessionCapability'>;
type ManagedScmOutboundContext = { containerId: string };
type RedeemableAuthorization = { provider: 'github' | 'gitlab' | 'kilo'; capability: string };
type AuthorizationExtraction =
  | { type: 'none' }
  | { type: 'capability'; value: RedeemableAuthorization }
  | { type: 'unsupported_capability' };

const NO_AUTHORIZATION_CAPABILITY = { type: 'none' } satisfies AuthorizationExtraction;

type ScmClient = 'github-cli' | 'gitlab-cli' | 'git-lfs' | 'git' | 'other';
type ScmMethod = 'GET' | 'HEAD' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' | 'OPTIONS' | 'other';
type ScmTarget = 'github-api' | 'github-git' | 'gitlab' | 'other';
type AuthorizationClass =
  | 'github-managed'
  | 'gitlab-managed'
  | 'unsupported-managed'
  | 'mixed'
  | 'unmanaged'
  | 'none';
type DiagnosticLevel = 'debug' | 'info' | 'warn';
type LocalKiloUrlDiagnosticsEnvironment = { LOG_REJECTED_KILO_URLS?: string };

function isLocalKiloUrlDiagnosticsEnabled(
  env: Cloudflare.Env & LocalKiloUrlDiagnosticsEnvironment
): boolean {
  return env.LOG_REJECTED_KILO_URLS === '1';
}

function logDiagnostic(
  level: DiagnosticLevel,
  fields: Record<string, string | number | boolean | null | undefined>,
  message: string
): void {
  try {
    const scopedLogger = logger.withFields(fields);
    scopedLogger[level](message);
  } catch {
    // Diagnostics must never change outbound request behavior.
  }
}

function classifyScmClient(userAgent: string | null): ScmClient {
  const normalized = userAgent?.toLowerCase() ?? '';
  if (normalized.includes('github cli') || normalized.startsWith('gh/')) return 'github-cli';
  if (normalized.includes('glab')) return 'gitlab-cli';
  if (normalized.includes('git-lfs')) return 'git-lfs';
  if (normalized.includes('git/')) return 'git';
  return 'other';
}

function classifyScmMethod(method: string): ScmMethod {
  const normalized = method.toUpperCase();
  if (
    normalized === 'GET' ||
    normalized === 'HEAD' ||
    normalized === 'POST' ||
    normalized === 'PATCH' ||
    normalized === 'PUT' ||
    normalized === 'DELETE' ||
    normalized === 'OPTIONS'
  ) {
    return normalized;
  }
  return 'other';
}

function classifyScmTarget(url: URL): ScmTarget {
  if (url.hostname === 'api.github.com') return 'github-api';
  if (url.hostname === 'github.com') return 'github-git';
  if (url.hostname === 'gitlab.com') return 'gitlab';
  return 'other';
}

function classifyScmRoute(url: URL, target: ScmTarget): string {
  if (target === 'github-api') {
    if (url.pathname === '/graphql') return 'graphql';
    if (url.pathname === '/user') return 'user';
    if (url.pathname.startsWith('/repos/')) return 'repository-api';
    return 'github-api-other';
  }
  if (target === 'github-git') {
    if (url.pathname.includes('/info/lfs/')) return 'git-lfs';
    if (url.pathname.endsWith('/info/refs')) return 'git-info-refs';
    if (url.pathname.endsWith('/git-upload-pack')) return 'git-upload-pack';
    if (url.pathname.endsWith('/git-receive-pack')) return 'git-receive-pack';
    return 'github-git-other';
  }
  return target === 'gitlab' ? 'gitlab' : 'other';
}

function getSafeRequestLogFields(request: Request) {
  const url = new URL(request.url);
  const target = classifyScmTarget(url);
  return {
    client: classifyScmClient(request.headers.get('User-Agent')),
    method: classifyScmMethod(request.method),
    target,
    route: classifyScmRoute(url, target),
  };
}

function getCapabilityVersion(capability: string): string {
  const separator = capability.indexOf('.');
  return separator === -1 ? 'unknown' : capability.slice(0, separator);
}

function isKiloSessionBootstrapRequest(request: Request): boolean {
  if (request.method.toUpperCase() !== 'POST') return false;
  try {
    return new URL(request.url).pathname.endsWith('/api/session');
  } catch {
    return false;
  }
}

/**
 * Reads a clone of the request body, stopping as soon as it exceeds maxBytes
 * so an unbounded (or under-declared) body is never fully buffered.
 */
async function readBoundedRequestBody(
  request: Request,
  maxBytes: number
): Promise<string | undefined> {
  const body: ReadableStream<Uint8Array> | null = request.clone().body;
  if (!body) return undefined;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) return undefined;
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buffer);
}

async function getKiloSessionBootstrapId(request: Request): Promise<string | undefined> {
  if (!isKiloSessionBootstrapRequest(request)) return undefined;
  const contentType = request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') return undefined;

  const contentLength = request.headers.get('Content-Length');
  if (
    contentLength &&
    (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > MAX_KILO_SESSION_BOOTSTRAP_BYTES)
  ) {
    return undefined;
  }

  try {
    const body = await readBoundedRequestBody(request, MAX_KILO_SESSION_BOOTSTRAP_BYTES);
    if (body === undefined) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      'sessionId' in parsed &&
      typeof parsed.sessionId === 'string' &&
      parsed.sessionId.length > 0
    ) {
      return parsed.sessionId;
    }
  } catch {
    // The broker rejects a bootstrap route without a matching session identity.
  }
  return undefined;
}

function classifyDiagnosticError(error: unknown): 'error' | 'unknown' {
  return error instanceof Error ? 'error' : 'unknown';
}

/** Query strings can carry credentials — even local diagnostics log only origin + path. */
function redactUrlQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return 'invalid-url';
  }
}

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

function supportsKiloSessionCapabilityRedemption(
  service: unknown
): service is KiloTokenRedemptionBinding {
  return (
    typeof service === 'object' &&
    service !== null &&
    'redeemKiloSessionCapability' in service &&
    typeof service.redeemKiloSessionCapability === 'function'
  );
}

function classifyCapability(capability: string): AuthorizationExtraction {
  if (GITHUB_CAPABILITY_PREFIXES.some(prefix => capability.startsWith(prefix))) {
    return { type: 'capability', value: { provider: 'github', capability } };
  }
  if (GITLAB_CAPABILITY_PREFIXES.some(prefix => capability.startsWith(prefix))) {
    return { type: 'capability', value: { provider: 'gitlab', capability } };
  }
  if (KILO_CAPABILITY_PREFIXES.some(prefix => capability.startsWith(prefix))) {
    return { type: 'capability', value: { provider: 'kilo', capability } };
  }
  return /^(?:kgh|kgl|kka)\d+\./.test(capability)
    ? { type: 'unsupported_capability' }
    : NO_AUTHORIZATION_CAPABILITY;
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
  const extraction = classifyCapability(credential.slice(separator + 1));
  if (extraction.type !== 'capability') return extraction;
  if (username === 'x-access-token' && extraction.value.provider === 'github') {
    return extraction;
  }
  if (username === 'oauth2' && extraction.value.provider === 'gitlab') {
    return extraction;
  }
  return { type: 'unsupported_capability' };
}

function extractApiCapability(authorization: string | null): AuthorizationExtraction {
  if (!authorization) return NO_AUTHORIZATION_CAPABILITY;
  const match = /^(token|Bearer)[ \t]+(.+)$/i.exec(authorization);
  if (!match?.[2]) return NO_AUTHORIZATION_CAPABILITY;
  const extraction = classifyCapability(match[2]);
  if (extraction.type !== 'capability') return extraction;
  if (extraction.value.provider === 'gitlab' && match[1]?.toLowerCase() !== 'bearer') {
    return { type: 'unsupported_capability' };
  }
  return extraction;
}

function extractGitLabPrivateTokenCapability(privateToken: string | null): AuthorizationExtraction {
  if (!privateToken) return NO_AUTHORIZATION_CAPABILITY;
  const extraction = classifyCapability(privateToken.trim());
  if (extraction.type !== 'capability') return extraction;
  return extraction.value.provider === 'gitlab' ? extraction : { type: 'unsupported_capability' };
}

function getAuthorizationClass(
  extractions: AuthorizationExtraction[],
  hasUnmanagedAuthorization: boolean
): AuthorizationClass {
  if (extractions.some(extraction => extraction.type === 'unsupported_capability')) {
    return 'unsupported-managed';
  }
  const capabilities = extractions.flatMap(extraction =>
    extraction.type === 'capability' ? [extraction.value] : []
  );
  const capability = capabilities[0];
  if (!capability) return hasUnmanagedAuthorization ? 'unmanaged' : 'none';
  if (
    hasUnmanagedAuthorization ||
    capabilities.some(
      candidate =>
        candidate.provider !== capability.provider || candidate.capability !== capability.capability
    )
  ) {
    return 'mixed';
  }
  return capability.provider === 'github' ? 'github-managed' : 'gitlab-managed';
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

  const tokenService = env.GIT_TOKEN_SERVICE;
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

  let response: Response;
  try {
    response = await forwardRedeemedRequest(request, { authorization: result.authorization });
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
  return response;
}

async function handleManagedKiloOutbound(
  request: Request,
  env: Cloudflare.Env,
  capability: { capability: string },
  outboundContainerId: string
): Promise<Response> {
  const logFields = {
    ...getSafeRequestLogFields(request),
    provider: 'kilo',
    capabilityVersion: getCapabilityVersion(capability.capability),
    outboundContainerId,
  };
  logDiagnostic('debug', logFields, 'Redeeming managed Kilo outbound request');

  const tokenService = env.GIT_TOKEN_SERVICE;
  if (!supportsKiloSessionCapabilityRedemption(tokenService)) {
    logDiagnostic(
      'warn',
      { ...logFields, failureStage: 'redemption-binding' },
      'Managed Kilo outbound redemption unavailable'
    );
    return new Response('Kilo authorization unavailable', { status: 502 });
  }

  let result: Awaited<ReturnType<KiloTokenRedemptionBinding['redeemKiloSessionCapability']>>;
  try {
    const bootstrapKiloSessionId = await getKiloSessionBootstrapId(request);
    result = await tokenService.redeemKiloSessionCapability({
      capability: capability.capability,
      outboundContainerId,
      requestMethod: request.method,
      requestUrl: request.url,
      bootstrapKiloSessionId,
    });
  } catch (error) {
    logDiagnostic(
      'warn',
      {
        ...logFields,
        failureStage: 'redemption-rpc',
        errorClass: classifyDiagnosticError(error),
      },
      'Managed Kilo outbound redemption failed'
    );
    return new Response('Kilo authorization unavailable', { status: 502 });
  }

  if (!result.success) {
    if (isLocalKiloUrlDiagnosticsEnabled(env)) {
      logDiagnostic(
        'debug',
        {
          ...logFields,
          failureStage: 'redemption-policy',
          reason: result.reason,
          rejectedRequestUrl: redactUrlQuery(request.url),
        },
        'Managed Kilo outbound redemption rejected with local URL diagnostics'
      );
    }
    logDiagnostic(
      'warn',
      { ...logFields, failureStage: 'redemption-policy', reason: result.reason },
      'Managed Kilo outbound redemption rejected'
    );
    return new Response('Kilo authorization unavailable', { status: 502 });
  }

  let response: Response;
  try {
    response = await forwardRedeemedRequest(request, { authorization: result.authorization });
  } catch (error) {
    logDiagnostic(
      'warn',
      {
        ...logFields,
        failureStage: 'upstream-forward',
        errorClass: classifyDiagnosticError(error),
      },
      'Managed Kilo outbound forwarding failed'
    );
    return new Response('Kilo authorization unavailable', { status: 502 });
  }

  logDiagnostic(
    'info',
    { ...logFields, upstreamStatus: response.status, routeClass: result.routeClass },
    'Managed Kilo outbound request forwarded'
  );
  return response;
}

async function handleManagedGitLabOutbound(
  request: Request,
  env: Cloudflare.Env,
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

  const tokenService = env.GIT_TOKEN_SERVICE;
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

export function handleManagedScmOutbound(
  request: Request,
  env: Cloudflare.Env,
  ctx: ManagedScmOutboundContext
): Promise<Response> {
  const authorization = request.headers.get('Authorization');
  const gitCapability = extractGitCapability(authorization);
  const apiCapability = extractApiCapability(authorization);
  const privateTokenCapability = extractGitLabPrivateTokenCapability(
    request.headers.get('PRIVATE-TOKEN')
  );
  const extractions = [gitCapability, apiCapability, privateTokenCapability];
  const hasUnmanagedAuthorization =
    (authorization !== null && gitCapability.type === 'none' && apiCapability.type === 'none') ||
    (request.headers.has('PRIVATE-TOKEN') && privateTokenCapability.type === 'none');
  const safeRequestLogFields = getSafeRequestLogFields(request);
  if (safeRequestLogFields.client === 'github-cli') {
    logDiagnostic(
      'debug',
      {
        ...safeRequestLogFields,
        authorizationClass: getAuthorizationClass(extractions, hasUnmanagedAuthorization),
        outboundContainerId: ctx.containerId,
      },
      'Observed GitHub CLI outbound request'
    );
  }
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
  if (capability.provider === 'github') {
    return handleManagedGitHubOutbound(request, env, capability, ctx.containerId);
  }
  if (capability.provider === 'kilo') {
    return handleManagedKiloOutbound(request, env, capability, ctx.containerId);
  }
  return handleManagedGitLabOutbound(request, env, capability, ctx.containerId);
}

const managedScmOutboundHandlers = {
  [MANAGED_SCM_OUTBOUND_HANDLER]: handleManagedScmOutbound,
};

export class Sandbox extends StockSandbox<Cloudflare.Env> {
  enableInternet = true;
  interceptHttps = false;
}

export class SandboxSmall extends StockSandbox<Cloudflare.Env> {
  enableInternet = true;
  interceptHttps = false;
}

export class SandboxDIND extends StockSandbox<Cloudflare.Env> {
  enableInternet = true;
  interceptHttps = false;
}

export class SandboxCodeReview extends StockSandbox<Cloudflare.Env> {
  enableInternet = true;
  interceptHttps = false;
}

export class SandboxContainment extends Sandbox {
  interceptHttps = true;
}
// Assignment (not a static class field) so it invokes the inherited Container.outboundHandlers
// setter and registers into @cloudflare/containers' internal outboundHandlersRegistry. A static
// class field here would shadow the inherited accessor and silently no-op the registration.
SandboxContainment.outboundHandlers = managedScmOutboundHandlers;

export class SandboxSmallContainment extends SandboxSmall {
  interceptHttps = true;
}
SandboxSmallContainment.outboundHandlers = managedScmOutboundHandlers;

export class SandboxCodeReviewContainment extends SandboxCodeReview {
  interceptHttps = true;
}
SandboxCodeReviewContainment.outboundHandlers = managedScmOutboundHandlers;

export { ContainerProxy };
