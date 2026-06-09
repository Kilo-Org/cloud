import 'server-only';
import { resolve4, resolve6 } from 'node:dns/promises';
import { z } from 'zod';
import {
  ProviderAuthorizationServerMetadataSchema,
  RemoteProtectedResourceMetadataSchema,
  createGatewayError,
  GatewayErrorCode,
  isIpAddress,
  isPublicIp,
} from '@kilocode/mcp-gateway';

const maxDiscoveryBodyBytes = 128 * 1024;
const dynamicProviderClientName = 'Kilo MCP Gateway';

export function validatePublicHttpsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw createGatewayError(GatewayErrorCode.InvalidRequest, 'Invalid URL', 400);
  }
  if (url.protocol !== 'https:') {
    throw createGatewayError(
      GatewayErrorCode.InvalidRequest,
      'Remote endpoint must use HTTPS',
      400
    );
  }
  if (url.username || url.password || url.hash) {
    throw createGatewayError(
      GatewayErrorCode.InvalidRequest,
      'Remote endpoint must not contain credentials or fragment',
      400
    );
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw createGatewayError(
      GatewayErrorCode.InvalidRequest,
      'Remote endpoint must be publicly reachable',
      400
    );
  }
  if (isIpAddress(hostname) && !isPublicIp(hostname)) {
    throw createGatewayError(
      GatewayErrorCode.InvalidRequest,
      'Remote endpoint must be publicly reachable',
      400
    );
  }
  return url;
}

async function resolvePublicHostname(hostname: string): Promise<void> {
  if (isIpAddress(hostname)) {
    if (!isPublicIp(hostname)) {
      throw createGatewayError(
        GatewayErrorCode.InvalidRequest,
        'Remote endpoint must be publicly reachable',
        400
      );
    }
    return;
  }
  const [ipv4, ipv6] = await Promise.all([
    resolve4(hostname).catch(() => [] as string[]),
    resolve6(hostname).catch(() => [] as string[]),
  ]);
  const addresses = [...ipv4, ...ipv6];
  if (addresses.length === 0) {
    throw createGatewayError(
      GatewayErrorCode.InvalidRequest,
      'Remote endpoint DNS could not be validated',
      400
    );
  }
  if (addresses.some(address => !isPublicIp(address))) {
    throw createGatewayError(
      GatewayErrorCode.InvalidRequest,
      'Remote endpoint resolves to a non-public destination',
      400
    );
  }
}

async function readCappedJson(response: Response): Promise<unknown> {
  if (!response.body) {
    throw createGatewayError(GatewayErrorCode.InvalidRequest, 'Discovery response is empty', 400);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let body = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    totalBytes += chunk.value.byteLength;
    if (totalBytes > maxDiscoveryBodyBytes) {
      throw createGatewayError(
        GatewayErrorCode.InvalidRequest,
        'Discovery response is too large',
        400
      );
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
  body += decoder.decode();
  try {
    return JSON.parse(body);
  } catch {
    throw createGatewayError(
      GatewayErrorCode.InvalidRequest,
      'Discovery response is malformed',
      400
    );
  }
}

export async function validatePublicHttpsDestination(value: string): Promise<URL> {
  const url = validatePublicHttpsUrl(value);
  await resolvePublicHostname(url.hostname.toLowerCase());
  return url;
}

async function fetchJson(url: URL, fetchImpl: typeof fetch): Promise<unknown> {
  await validatePublicHttpsDestination(url.toString());
  const response = await fetchImpl(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    redirect: 'manual',
  });
  if (!response.ok) return null;
  return await readCappedJson(response);
}

type ProviderChallenge = {
  authorizationServers: string[];
  providerScopes: string[] | null;
  resourceMetadataUrl: string | null;
};

function parseProviderChallenge(header: string | null): ProviderChallenge {
  if (!header) {
    return { authorizationServers: [], providerScopes: null, resourceMetadataUrl: null };
  }
  const authorizationServers = Array.from(
    header.matchAll(/(?:authorization_uri|authorization_server)="([^"]+)"/gi),
    match => match[1]
  );
  const scopeMatch = header.match(/\bscope="([^"]*)"/i);
  const providerScopes = scopeMatch?.[1] ? scopeMatch[1].split(/\s+/).filter(Boolean) : null;
  const resourceMetadataMatch = header.match(/\bresource_metadata="([^"]+)"/i);
  return {
    authorizationServers,
    providerScopes,
    resourceMetadataUrl: resourceMetadataMatch?.[1] ?? null,
  };
}

export function createDiscoveryService(params: { fetchImpl?: typeof fetch }) {
  const fetchImpl = params.fetchImpl ?? fetch;

  async function discoverRemoteProvider(remoteUrl: string) {
    const endpoint = await validatePublicHttpsDestination(remoteUrl);
    const metadataUrl = new URL('/.well-known/oauth-protected-resource', endpoint.origin);
    const metadataRaw = await fetchJson(metadataUrl, fetchImpl);
    let metadata = metadataRaw ? RemoteProtectedResourceMetadataSchema.parse(metadataRaw) : null;
    const endpointResponse = await fetchImpl(endpoint.toString(), {
      method: 'GET',
      redirect: 'manual',
    });
    const challenge = parseProviderChallenge(endpointResponse.headers.get('www-authenticate'));
    if (!metadata && challenge.resourceMetadataUrl) {
      const challengeMetadataUrl = await validatePublicHttpsDestination(
        challenge.resourceMetadataUrl
      );
      const challengeMetadataRaw = await fetchJson(challengeMetadataUrl, fetchImpl);
      metadata = challengeMetadataRaw
        ? RemoteProtectedResourceMetadataSchema.parse(challengeMetadataRaw)
        : null;
    }
    const authorizationServers = metadata?.authorization_servers?.length
      ? metadata.authorization_servers
      : challenge.authorizationServers;

    const candidates = await Promise.all(
      authorizationServers.map(async issuer => {
        const issuerUrl = await validatePublicHttpsDestination(issuer);
        const metadataCandidates = [
          new URL('/.well-known/oauth-authorization-server', issuerUrl.origin),
          new URL('/.well-known/openid-configuration', issuerUrl.origin),
        ];
        for (const candidate of metadataCandidates) {
          const raw = await fetchJson(candidate, fetchImpl);
          if (!raw) continue;
          const parsed = ProviderAuthorizationServerMetadataSchema.parse(raw);
          if (parsed.issuer !== issuerUrl.toString() && parsed.issuer !== issuerUrl.origin)
            continue;
          return parsed;
        }
        return null;
      })
    );

    return {
      remoteUrl: endpoint.toString(),
      protectedResourceMetadata: metadata,
      providerScopes: challenge.providerScopes,
      providerScopeSource: challenge.providerScopes ? 'discovered' : 'none',
      providerResource: metadata?.resource ?? null,
      providerCandidates: candidates.filter(candidate => candidate !== null),
    };
  }

  async function registerDynamicProviderClient(paramsInput: {
    registrationEndpoint: string;
    redirectUri: string;
  }) {
    const endpoint = await validatePublicHttpsDestination(paramsInput.registrationEndpoint);
    const response = await fetchImpl(endpoint.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: dynamicProviderClientName,
        redirect_uris: [paramsInput.redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
      }),
      redirect: 'manual',
    });
    if (!response.ok) {
      throw createGatewayError(
        GatewayErrorCode.InvalidRequest,
        'Provider registration failed',
        400
      );
    }
    return ProviderRegistrationResponseSchema.parse(await readCappedJson(response));
  }

  return { discoverRemoteProvider, registerDynamicProviderClient };
}

const ProviderRegistrationResponseSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1).optional(),
});

export type GatewayDiscoveryService = ReturnType<typeof createDiscoveryService>;
