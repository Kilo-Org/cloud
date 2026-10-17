import 'server-only';
import { z } from 'zod';
import {
  ProviderAuthorizationServerMetadataSchema,
  RemoteProtectedResourceMetadataSchema,
  createGatewayError,
  GatewayErrorCode,
} from '@kilocode/mcp-gateway';
import {
  requestPublicHttps,
  validatePublicHttpsUrl,
  type GatewayOutboundRequest,
} from './outbound';

const maxDiscoveryBodyBytes = 128 * 1024;
const dynamicProviderClientName = 'Kilo MCP Gateway';

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

async function fetchJson(url: URL, request: GatewayOutboundRequest): Promise<unknown> {
  const response = await request(url.toString(), {
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

export function createDiscoveryService(params: { requestImpl?: GatewayOutboundRequest }) {
  const requestImpl = params.requestImpl ?? requestPublicHttps;

  async function discoverRemoteProvider(remoteUrl: string) {
    const endpoint = validatePublicHttpsUrl(remoteUrl);
    const metadataUrl = new URL('/.well-known/oauth-protected-resource', endpoint.origin);
    const metadataRaw = await fetchJson(metadataUrl, requestImpl);
    let metadata = metadataRaw ? RemoteProtectedResourceMetadataSchema.parse(metadataRaw) : null;
    const endpointResponse = await requestImpl(endpoint.toString(), {
      method: 'GET',
      redirect: 'manual',
    });
    const challenge = parseProviderChallenge(endpointResponse.headers.get('www-authenticate'));
    if (!metadata && challenge.resourceMetadataUrl) {
      const challengeMetadataUrl = validatePublicHttpsUrl(challenge.resourceMetadataUrl);
      const challengeMetadataRaw = await fetchJson(challengeMetadataUrl, requestImpl);
      metadata = challengeMetadataRaw
        ? RemoteProtectedResourceMetadataSchema.parse(challengeMetadataRaw)
        : null;
    }
    const authorizationServers = metadata?.authorization_servers?.length
      ? metadata.authorization_servers
      : challenge.authorizationServers;

    const candidates = await Promise.all(
      authorizationServers.map(async issuer => {
        const issuerUrl = validatePublicHttpsUrl(issuer);
        const metadataCandidates = [
          new URL('/.well-known/oauth-authorization-server', issuerUrl.origin),
          new URL('/.well-known/openid-configuration', issuerUrl.origin),
        ];
        for (const candidate of metadataCandidates) {
          const raw = await fetchJson(candidate, requestImpl);
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
    const endpoint = validatePublicHttpsUrl(paramsInput.registrationEndpoint);
    const response = await requestImpl(endpoint.toString(), {
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
