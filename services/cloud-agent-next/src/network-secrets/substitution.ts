import { Buffer } from 'node:buffer';
import { CAPABILITY_FAMILY_PATTERN_SOURCE } from '@kilocode/worker-utils/scm-capability-contract';
import { parseControlPlaneCredential } from '../shared/control-plane-credential.js';
import { builderNetworkSecretEnvironmentId } from './builder-scope.js';
import { networkSecretResolutionSchema, type ResolvedNetworkSecret } from './contract.js';

export type NetworkSecretAudit = {
  credentialKey?: string;
  credentialDecision:
    | 'substituted'
    | 'denied_host_mismatch'
    | 'denied_unknown'
    | 'denied_location'
    | 'denied_policy'
    | 'unavailable';
};
export type NetworkSecretRouting =
  | { type: 'unmanaged' }
  | { type: 'rewritten'; request: Request; audit: NetworkSecretAudit[] }
  | { type: 'denied'; response: Response; audit: NetworkSecretAudit[] };

const secretFamily = /kcp\d+\.[A-Za-z0-9_-]*\.secret\.[A-Za-z0-9._-]*/g;
const exactSecretToken =
  /(?<![A-Za-z0-9._-])kcp\d+\.[A-Za-z0-9_-]+\.secret\.[0-9a-f]{64}(?![A-Za-z0-9._-])/g;
const capabilityFamily = new RegExp(CAPABILITY_FAMILY_PATTERN_SOURCE);
const controlCredentialPurpose = /kcp\d+\.[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\./g;

function carriesManagedCredential(value: string): boolean {
  return (
    capabilityFamily.test(value) ||
    [...value.matchAll(controlCredentialPurpose)].some(match => match[1] !== 'secret')
  );
}

function aliases(value: string): string[] {
  return [...value.matchAll(secretFamily)].map(match => match[0]);
}

function exactTokens(value: string): string[] {
  return [...value.matchAll(exactSecretToken)].map(match => match[0]);
}

function basicCredential(value: string): { username: string; password: string } | null {
  const encoded = /^Basic[ \t]+([A-Za-z0-9+/]+={0,2})$/i.exec(value)?.[1];
  if (!encoded) return null;
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.toString('base64') !== encoded) return null;
  const text = decoded.toString('utf8');
  const colon = text.indexOf(':');
  return colon === -1 ? null : { username: text.slice(0, colon), password: text.slice(colon + 1) };
}

function decodedUrl(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

export async function substituteNetworkSecrets(
  request: Request,
  sandbox: { containerId: string },
  resolve: (input: {
    credential: string;
    outboundContainerId: string;
    url: string;
    method: string;
  }) => Promise<unknown>
): Promise<NetworkSecretRouting> {
  const url = new URL(request.url);
  const safeHost = /kcp\d+\./.test(url.hostname) ? '[redacted]' : url.hostname;
  const headers = [...request.headers];
  const basic = basicCredential(request.headers.get('authorization') ?? '');
  const headerText = headers.map(([, value]) => value).join(' ');
  const unsupported = `${decodedUrl(request.url)} ${basic?.username ?? ''} ${request.headers.get('host') ?? ''}`;
  const locations = `${headerText} ${basic?.password ?? ''} ${unsupported}`;
  const presented = [...new Set(aliases(locations))];
  if (presented.length === 0) return { type: 'unmanaged' };
  const deny = (
    reason: 'host_mismatch' | 'unknown' | 'location_denied' | 'policy_denied',
    key?: string
  ): Extract<NetworkSecretRouting, { type: 'denied' }> => ({
    type: 'denied',
    response: Response.json(
      {
        error: `network_secret_${reason}`,
        ...(key ? { key } : {}),
        host: safeHost,
      },
      { status: 403 }
    ),
    audit: [
      {
        ...(key ? { credentialKey: key } : {}),
        credentialDecision:
          reason === 'location_denied'
            ? 'denied_location'
            : reason === 'policy_denied'
              ? 'denied_policy'
              : `denied_${reason}`,
      },
    ],
  });
  if (
    presented.length > 20 ||
    carriesManagedCredential(locations) ||
    aliases(unsupported).length > 0
  )
    return deny('location_denied');
  const tokens = new Set([
    ...headers.flatMap(([, value]) => exactTokens(value)),
    ...exactTokens(basic?.password ?? ''),
  ]);
  if (presented.some(alias => parseControlPlaneCredential(alias)?.purpose !== 'secret'))
    return deny('unknown');
  if (presented.some(alias => !tokens.has(alias))) return deny('location_denied');
  const resolved = new Map<string, ResolvedNetworkSecret>();
  const unavailable = (error: unknown): NetworkSecretRouting => ({
    type: 'denied',
    response: Response.json(
      {
        error: 'network_secret_unavailable',
        retryable: error instanceof Error && Reflect.get(error, 'retryable') === true,
        host: safeHost,
      },
      { status: 503 }
    ),
    audit: [{ credentialDecision: 'unavailable' }],
  });
  for (const alias of presented) {
    let result: unknown;
    try {
      result = await resolve({
        credential: alias,
        outboundContainerId: sandbox.containerId,
        url: request.url,
        method: request.method,
      });
    } catch (error) {
      return unavailable(error);
    }
    const parsed = networkSecretResolutionSchema.safeParse(result);
    if (!parsed.success) {
      if (result !== null) return unavailable(undefined);
      const scope = parseControlPlaneCredential(alias)?.sandboxId;
      if (scope && builderNetworkSecretEnvironmentId(scope)) {
        return {
          ...deny('unknown'),
          response: Response.json(
            {
              error: 'network_secret_build_scope_denied',
              host: safeHost,
              message:
                'This build placeholder is not valid here. Reference the network-secret environment variable at runtime.',
            },
            { status: 403 }
          ),
        };
      }
      return deny('unknown');
    }
    const secret = parsed.data;
    if (secret.type === 'network-denied') return deny(secret.reason, secret.key);
    if (
      url.protocol !== 'https:' ||
      url.port !== '' ||
      url.username ||
      url.password ||
      !secret.allowedHosts.includes(url.hostname)
    )
      return deny('host_mismatch', secret.key);
    if (!secret.locations.includes('header')) return deny('location_denied', secret.key);
    resolved.set(alias, secret);
  }
  const replace = (value: string) =>
    value.replace(exactSecretToken, alias => resolved.get(alias)?.value ?? alias);
  try {
    const rewritten = new Headers(request.headers);
    for (const [name, value] of headers) rewritten.set(name, replace(value));
    if (basic && aliases(basic.password).length > 0)
      rewritten.set(
        'authorization',
        `Basic ${Buffer.from(`${basic.username}:${replace(basic.password)}`).toString('base64')}`
      );
    rewritten.set('host', url.host);
    return {
      type: 'rewritten',
      request: new Request(request, { headers: rewritten, redirect: 'manual' }),
      audit: [...resolved.values()].map(secret => ({
        credentialKey: secret.key,
        credentialDecision: 'substituted',
      })),
    };
  } catch {
    return deny('location_denied');
  }
}
