jest.mock('node:dns/promises', () => ({ resolve4: jest.fn(), resolve6: jest.fn() }));
jest.mock('node:https', () => ({ request: jest.fn() }));

import { generateKeyPairSync } from 'node:crypto';
import { resolve4, resolve6 } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import type { mcp_gateway_pending_provider_authorizations } from '@kilocode/db/schema';
import { encryptKeyedEnvelope } from '@kilocode/encryption';
import {
  connectedAddress,
  recordHttpsRequests,
  type RecordedRequest,
} from '@/tests/helpers/outbound-https-mock';
import type { GatewayAppConfig } from './config';
import type { GatewayRepository } from './repository';
import type { GatewayRouteService } from './route-service';
import type { GatewayGrantService } from './grant-service';
import type { GatewayOAuthGrantService } from './oauth-grant-service';
import { createProviderOAuthService } from './provider-oauth-service';

const pendingStateScheme = 'mcp-gateway-provider-pending-state-rsa-aes-256-gcm';
const stateValue = 'state-token-for-test';
const codeVerifier = 'v'.repeat(50);

type PendingAuthorization = typeof mcp_gateway_pending_provider_authorizations.$inferSelect;

function createConfig(): GatewayAppConfig {
  const credentialKeys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    appBaseUrl: 'https://app.example',
    gatewayBaseUrl: 'https://gateway.example',
    issuer: 'https://app.example',
    accessTokenTtlSeconds: 900,
    authorizationRequestTtlSeconds: 1_800,
    authorizationCodeTtlSeconds: 600,
    registrationCredentialTtlSeconds: 60,
    rateLimitSecret: 'test-rate-limit-secret',
    jwtKeyset: {
      issuer: 'https://app.example',
      activeKeyId: 'jwt-active',
      keys: [
        {
          keyId: 'jwt-active',
          publicJwk: { kty: 'RSA' },
          publicKeyPem: credentialKeys.publicKey,
          privateKeyPem: credentialKeys.privateKey,
        },
      ],
    },
    credentialKeyset: {
      active: { keyId: 'credential-active', publicKeyPem: credentialKeys.publicKey },
      decrypt: [{ keyId: 'credential-active', privateKeyPem: credentialKeys.privateKey }],
    },
  };
}

function createPending(config: GatewayAppConfig): PendingAuthorization {
  const encryptedState = encryptKeyedEnvelope(
    JSON.stringify({
      codeVerifier,
      clientId: 'provider-client',
      clientSecret: 'provider-secret',
      tokenEndpoint: 'https://token.example/token',
      redirectUri: 'https://app.example/api/mcp-gateway/oauth/mcp/callback',
    }),
    pendingStateScheme,
    config.credentialKeyset.active,
    `mcp-gateway:pending-provider:${stateValue}`
  );
  return {
    pending_provider_authorization_id: '8f0e2c1a-0000-4000-8000-000000000001',
    state_hash: 'state-hash',
    authorization_request_id: null,
    oauth_grant_id: null,
    config_id: '8f0e2c1a-0000-4000-8000-000000000002',
    instance_id: '8f0e2c1a-0000-4000-8000-000000000003',
    owner_scope: 'personal',
    owner_id: 'user-1',
    kilo_user_id: 'user-1',
    route_key: 'route-key',
    canonical_resource_url: 'https://gateway.example/mcp/personal/user-1/config/resource',
    remote_url: 'https://token.example/resource',
    auth_mode: 'oauth_static',
    provider_authorization_endpoint: 'https://token.example/authorize',
    provider_token_endpoint: 'https://token.example/token',
    encrypted_state: encryptedState,
    execution_context: { type: 'personal' },
    config_version: 1,
    pending_status: 'pending',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    consumed_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function createService(config: GatewayAppConfig, pending: PendingAuthorization) {
  const resolved = {
    config: {
      config_id: pending.config_id,
      config_version: pending.config_version,
      owner_scope: pending.owner_scope,
      owner_id: pending.owner_id,
    },
    route: {},
  };
  const repository = {
    database: {
      update: () => ({
        set: () => ({
          where: () => ({ returning: async () => [pending] }),
        }),
      }),
    },
    findActiveRouteByRoute: async () => resolved,
    findNonTerminalInstance: async () => ({ instance_id: pending.instance_id }),
  };
  const routeService = {
    parseResource: () => ({ ownerScope: 'personal' }),
    authorize: async () => undefined,
  };
  return createProviderOAuthService({
    repository: repository as unknown as GatewayRepository,
    routeService: routeService as unknown as GatewayRouteService,
    grantService: {} as GatewayGrantService,
    oauthGrantService: {} as GatewayOAuthGrantService,
    config,
  });
}

describe('provider token exchange outbound request', () => {
  beforeEach(() => {
    jest.mocked(resolve4).mockReset();
    jest.mocked(resolve6).mockReset();
    jest.mocked(httpsRequest).mockReset();
    jest.mocked(resolve4).mockResolvedValue(['93.184.216.77']);
    jest.mocked(resolve6).mockResolvedValue([]);
  });

  it('posts the authorization code to the resolved address only', async () => {
    const config = createConfig();
    const pending = createPending(config);
    const recorded = recordHttpsRequests(() => ({
      status: 400,
      body: JSON.stringify({ error: 'invalid_grant' }),
    }));
    const service = createService(config, pending);

    await expect(
      service.handleProviderCallback({ state: stateValue, code: 'auth-code', userId: 'user-1' })
    ).rejects.toMatchObject({ code: 'invalid_grant' });

    expect(recorded).toHaveLength(1);
    const request = recorded[0] as RecordedRequest;
    expect(request.options.method).toBe('POST');
    expect(request.options.hostname).toBe('token.example');
    expect(request.options.path).toBe('/token');
    expect(request.options.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const body = request.body?.toString() ?? '';
    expect(body).toContain('code=auth-code');
    expect(body).toContain('client_secret=provider-secret');
    expect(connectedAddress(request)).toBe('93.184.216.77');
  });

  it('keeps the address chosen when the request started', async () => {
    const config = createConfig();
    const pending = createPending(config);
    const recorded = recordHttpsRequests(() => ({ status: 400, body: '{}' }));
    const service = createService(config, pending);

    await expect(
      service.handleProviderCallback({ state: stateValue, code: 'auth-code', userId: 'user-1' })
    ).rejects.toMatchObject({ code: 'invalid_grant' });

    jest.mocked(resolve4).mockResolvedValue(['169.254.169.254']);
    expect(jest.mocked(resolve4)).toHaveBeenCalledTimes(1);
    expect(connectedAddress(recorded[0] as RecordedRequest)).toBe('93.184.216.77');
    expect(jest.mocked(resolve4)).toHaveBeenCalledTimes(1);
  });

  it('rejects the exchange when the hostname is not publicly routable', async () => {
    const config = createConfig();
    const pending = createPending(config);
    const recorded = recordHttpsRequests(() => ({ status: 400, body: '{}' }));
    const service = createService(config, pending);
    jest.mocked(resolve4).mockResolvedValue(['169.254.169.254']);

    await expect(
      service.handleProviderCallback({ state: stateValue, code: 'auth-code', userId: 'user-1' })
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(recorded).toHaveLength(0);
  });
});
