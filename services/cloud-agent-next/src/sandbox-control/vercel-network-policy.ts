import type {
  VercelSandboxForwardRule,
  VercelSandboxKeyValueMatcher,
  VercelSandboxMatcher,
  VercelSandboxNetworkPolicy,
  VercelSandboxRule,
} from '../agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import { isSafeSandboxId } from '../shared/control-plane-credential.js';
import { configuredVercelRuntimeProxyForwardUrl } from '../runtime-credential-proxy-origin.js';

export type VercelCredentialForwardRule = VercelSandboxForwardRule & { domain: string };

export type VercelCredentialPolicyInput = {
  sandboxId: string;
  runtimeProxy: {
    /**
     * Adopted handle strings still valid until their JWT `exp`. An adopted
     * handle is shared by every member root; their rules stay in force so a
     * wrapper that has not yet applied a rotation can still reach the facade.
     */
    handles?: readonly string[];
    members?: Array<{ sessionId: string; kiloSessionId: string; handle: string }>;
    targets: { backendBaseUrl: string; providerBaseUrl: string; sessionIngestBaseUrl: string };
  };
};

function invalidPolicy(): never {
  throw new Error('Invalid Vercel credential network policy');
}

function runtimeTarget(targets: VercelCredentialPolicyInput['runtimeProxy']['targets']): URL {
  const parsed = [
    targets.backendBaseUrl,
    targets.providerBaseUrl,
    targets.sessionIngestBaseUrl,
  ].map(value => {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.port !== '' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      invalidPolicy();
    }
    return url;
  });
  const [backend, provider, ingest] = parsed;
  if (
    backend.toString().replace(/\/+$/, '') !== provider.toString().replace(/\/+$/, '') ||
    backend.toString().replace(/\/+$/, '') !== ingest.toString().replace(/\/+$/, '')
  ) {
    invalidPolicy();
  }
  return backend;
}

/**
 * Vercel forwards the original request to the Worker with the exact handle it
 * already carries. The receiver, not the provider matcher, owns route
 * permissions, so a single exact-Authorization rule is enough per handle.
 */
export function buildVercelCredentialNetworkPolicy(input: VercelCredentialPolicyInput): {
  forwardRules: VercelCredentialForwardRule[];
} {
  if (!isSafeSandboxId(input.sandboxId)) invalidPolicy();
  const target = runtimeTarget(input.runtimeProxy.targets);
  const forwardURL = configuredVercelRuntimeProxyForwardUrl(
    { WORKER_URL: target.toString() },
    input.sandboxId
  );
  if (!forwardURL) invalidPolicy();
  const handles = [
    ...new Set([
      ...(input.runtimeProxy.members ?? []).map(member => member.handle),
      ...(input.runtimeProxy.handles ?? []),
    ]),
  ];
  if (handles.some(handle => handle.length === 0 || handle.length > 4096)) invalidPolicy();
  return {
    forwardRules: handles.map(handle => ({
      domain: target.hostname,
      forwardURL,
      match: {
        headers: [{ key: { exact: 'authorization' }, value: { exact: `Bearer ${handle}` } }],
      },
    })),
  };
}

function matchesValue(matcher: VercelSandboxMatcher | undefined, value: string | null): boolean {
  if (!matcher) return true;
  if (value === null) return false;
  if ('exact' in matcher) return matcher.exact === value;
  if ('startsWith' in matcher) return value.startsWith(matcher.startsWith);
  return new RegExp(matcher.regex).test(value);
}

function exactKey(matcher: VercelSandboxMatcher | undefined): string | undefined {
  return matcher !== undefined && 'exact' in matcher ? matcher.exact : undefined;
}

function matchesQuery(matcher: VercelSandboxKeyValueMatcher, params: URLSearchParams): boolean {
  const name = exactKey(matcher.key);
  return name !== undefined && matchesValue(matcher.value, params.get(name));
}

export function findMatchingVercelRule(
  rules: readonly (VercelSandboxRule & { domain?: string })[],
  request: { url: URL; method: string; headers: Headers }
): VercelSandboxRule | undefined {
  return rules.find(rule => {
    if (rule.domain !== undefined && rule.domain !== request.url.hostname) return false;
    const match = rule.match;
    if (!match) return true;
    if (match.method && !match.method.includes(request.method)) return false;
    if (
      match.path &&
      !matchesValue(match.path, request.url.pathname === '/' ? '/' : request.url.pathname)
    ) {
      return false;
    }
    if (
      match.queryString &&
      !match.queryString.every(matcher => matchesQuery(matcher, request.url.searchParams))
    ) {
      return false;
    }
    return (
      match.headers?.every(matcher =>
        matchesValue(matcher.value, request.headers.get(exactKey(matcher.key) ?? ''))
      ) ?? true
    );
  });
}

export function buildVercelForwardNetworkPolicy(
  forwardRules: readonly VercelCredentialForwardRule[]
): VercelSandboxNetworkPolicy {
  const allow: VercelSandboxNetworkPolicy['allow'] = {};
  for (const { domain, ...rule } of forwardRules) {
    (allow[domain] ??= []).push(rule);
  }
  allow['*'] = [];
  return { allow };
}
