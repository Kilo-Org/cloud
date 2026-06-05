/* eslint-disable drizzle/enforce-delete-with-where */
import { db } from '@/lib/drizzle';
import {
  kilocode_users,
  mcp_gateway_assignments,
  mcp_gateway_audit_events,
  mcp_gateway_authorization_codes,
  mcp_gateway_authorization_requests,
  mcp_gateway_config_secrets,
  mcp_gateway_configs,
  mcp_gateway_connect_resources,
  organizations,
  organization_memberships,
  mcp_gateway_connection_instances,
  mcp_gateway_oauth_clients,
  mcp_gateway_pending_provider_authorizations,
  mcp_gateway_provider_grants,
  mcp_gateway_rate_limit_windows,
  mcp_gateway_refresh_tokens,
} from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createGatewayServices } from './services';
import { revokeGatewayStateForOrganizationMember } from './lifecycle-service';
import type { GatewayAppConfig } from './config';
import { createHash, generateKeyPairSync, createPublicKey } from 'node:crypto';
import { OAuthAuthorizationQuerySchema, parseScopedConnectPath } from '@kilocode/mcp-gateway';
import { pkceChallenge } from './crypto';
import { eq } from 'drizzle-orm';

function createTestConfig(): Promise<GatewayAppConfig> {
  const jwtKeys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const credentialKeys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const publicJwk = createPublicKey(jwtKeys.publicKey).export({ format: 'jwk' });
  return Promise.resolve({
    appBaseUrl: 'https://app.kilo.ai',
    gatewayBaseUrl: 'https://mcp.kilosessions.ai',
    issuer: 'https://app.kilo.ai',
    accessTokenTtlSeconds: 900,
    authorizationRequestTtlSeconds: 1_800,
    authorizationCodeTtlSeconds: 600,
    registrationCredentialTtlSeconds: 30 * 24 * 60 * 60,
    rateLimitSecret: 'test-rate-limit-secret',
    jwtKeyset: {
      issuer: 'https://app.kilo.ai',
      activeKeyId: 'jwt-active',
      keys: [{ keyId: 'jwt-active', publicJwk, privateKeyPem: jwtKeys.privateKey }],
    },
    credentialKeyset: {
      active: { keyId: 'credential-active', publicKeyPem: credentialKeys.publicKey },
      decrypt: [{ keyId: 'credential-active', privateKeyPem: credentialKeys.privateKey }],
    },
  });
}

function providerDiscoveryResponse(url: string): Response | null {
  if (url === 'https://example.com/.well-known/oauth-protected-resource') {
    return new Response(JSON.stringify({ authorization_servers: ['https://example.com'] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (
    url === 'https://example.com/.well-known/oauth-authorization-server' ||
    url === 'https://example.com/.well-known/openid-configuration'
  ) {
    return new Response(
      JSON.stringify({
        issuer: 'https://example.com',
        authorization_endpoint: 'https://example.com/authorize',
        token_endpoint: 'https://example.com/token',
        registration_endpoint: 'https://example.com/register',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  return null;
}

const providerDiscoveryFetch: typeof fetch = async input => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const response = providerDiscoveryResponse(url);
  if (response) return response;
  throw new Error(`Unexpected discovery fetch: ${url}`);
};

async function cleanupGatewayTables() {
  await db.delete(mcp_gateway_pending_provider_authorizations);
  await db.delete(mcp_gateway_authorization_codes);
  await db.delete(mcp_gateway_authorization_requests);
  await db.delete(mcp_gateway_refresh_tokens);
  await db.delete(mcp_gateway_provider_grants);
  await db.delete(mcp_gateway_connection_instances);
  await db.delete(mcp_gateway_assignments);
  await db.delete(mcp_gateway_config_secrets);
  await db.delete(mcp_gateway_connect_resources);
  await db.delete(mcp_gateway_configs);
  await db.delete(mcp_gateway_oauth_clients);
  await db.delete(mcp_gateway_rate_limit_windows);
  await db.delete(mcp_gateway_audit_events);
}

describe('MCP gateway app OAuth flow', () => {
  beforeEach(async () => {
    await cleanupGatewayTables();
  });

  afterEach(async () => {
    await cleanupGatewayTables();
  });

  it('requires explicit supported scopes during client registration', async () => {
    const config = await createTestConfig();
    const services = createGatewayServices({ config });
    const headers = new Headers({ 'x-vercel-forwarded-for': '203.0.113.14' });

    await expect(
      services.clientService.registerClient({
        metadata: {
          redirect_uris: ['http://localhost:3000/callback'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code'],
          response_types: ['code'],
        },
        headers,
      })
    ).rejects.toMatchObject({ code: 'invalid_client_metadata' });
    await expect(
      services.clientService.registerClient({
        metadata: {
          redirect_uris: ['http://localhost:3000/callback'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code'],
          response_types: ['code'],
          scope: 'unsupported',
        },
        headers,
      })
    ).rejects.toMatchObject({ code: 'invalid_client_metadata' });
  });

  it('issues an authorization code and rotates refresh tokens', async () => {
    const config = await createTestConfig();
    const services = createGatewayServices({ config });
    const user = await insertTestUser({ id: `gateway-user-${crypto.randomUUID()}` });
    const created = await services.configService.createPersonalConfig({
      userId: user.id,
      name: 'Test MCP',
      remoteUrl: 'https://example.com/mcp',
      authMode: 'none',
    });

    const registration = await services.clientService.registerClient({
      metadata: {
        redirect_uris: ['http://localhost:3000/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'profile',
      },
      headers: new Headers({ 'x-forwarded-for': '203.0.113.15' }),
    });
    const route = parseScopedConnectPath(new URL(created.route.canonical_url).pathname);
    expect(route).not.toBeNull();
    if (!route) return;
    const verifier =
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abcdefghijk';
    const query = OAuthAuthorizationQuerySchema.parse({
      client_id: registration.clientId,
      redirect_uri: 'http://localhost:3000/callback',
      response_type: 'code',
      scope: 'profile',
      state: 'client-state',
      resource: created.route.canonical_url,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
    });
    const authorization = await services.authorizationService.authorize({
      query,
      userId: user.id,
      executionContext: { type: 'personal' },
    });
    expect(authorization.kind).toBe('redirect');
    if (authorization.kind !== 'redirect') return;
    const code = new URL(authorization.redirectUrl).searchParams.get('code');
    expect(code).toBeTruthy();
    if (!code) return;

    const tokenResponse = await services.tokenService.exchangeToken({
      request: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'http://localhost:3000/callback',
        client_id: registration.clientId,
        code_verifier: verifier,
      },
      headers: new Headers(),
    });
    expect(tokenResponse.token_type).toBe('bearer');
    expect(tokenResponse.refresh_token).toBeTruthy();
    const claims = await services.tokenService.verifyUserInfoToken(tokenResponse.access_token);
    expect(claims.sub).toBe(user.id);
    expect(claims.aud).toBe(created.route.canonical_url);
    await expect(services.tokenService.userInfo(tokenResponse.access_token)).resolves.toEqual({
      sub: user.id,
      name: user.google_user_name,
      preferred_username: user.google_user_email,
      picture: user.google_user_image_url,
      updated_at: expect.any(String),
      email: user.google_user_email,
    });

    const refreshed = await services.tokenService.exchangeToken({
      request: {
        grant_type: 'refresh_token',
        refresh_token: tokenResponse.refresh_token,
        client_id: registration.clientId,
      },
      headers: new Headers(),
    });
    expect(refreshed.refresh_token).not.toBe(tokenResponse.refresh_token);
    await expect(
      services.tokenService.exchangeToken({
        request: {
          grant_type: 'refresh_token',
          refresh_token: tokenResponse.refresh_token,
          client_id: registration.clientId,
        },
        headers: new Headers(),
      })
    ).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('redeems client_secret_basic credentials with namespace client IDs', async () => {
    const config = await createTestConfig();
    const services = createGatewayServices({ config });
    const user = await insertTestUser({ id: `gateway-user-${crypto.randomUUID()}` });
    const created = await services.configService.createPersonalConfig({
      userId: user.id,
      name: 'Test MCP',
      remoteUrl: 'https://example.com/mcp',
      authMode: 'none',
    });
    const registration = await services.clientService.registerClient({
      metadata: {
        redirect_uris: ['https://client.example/callback'],
        token_endpoint_auth_method: 'client_secret_basic',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'profile',
      },
      headers: new Headers({ 'x-vercel-forwarded-for': '203.0.113.31' }),
    });
    if (!registration.clientSecret) throw new Error('Expected confidential client secret');
    const authorization = await services.authorizationService.authorize({
      query: OAuthAuthorizationQuerySchema.parse({
        client_id: registration.clientId,
        redirect_uri: 'https://client.example/callback',
        response_type: 'code',
        resource: created.route.canonical_url,
      }),
      userId: user.id,
      executionContext: { type: 'personal' },
    });
    if (authorization.kind !== 'redirect') return;
    const code = new URL(authorization.redirectUrl).searchParams.get('code');
    if (!code) return;
    const basic = Buffer.from(
      `${encodeURIComponent(registration.clientId)}:${encodeURIComponent(registration.clientSecret)}`
    ).toString('base64');
    const tokenResponse = await services.tokenService.exchangeToken({
      request: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://client.example/callback',
      },
      headers: new Headers({ Authorization: `Basic ${basic}` }),
    });
    expect(tokenResponse.access_token).toBeTruthy();
  });

  it('does not redeem an authorization code after it expires', async () => {
    const config = await createTestConfig();
    const services = createGatewayServices({ config });
    const user = await insertTestUser({ id: `gateway-user-${crypto.randomUUID()}` });
    const created = await services.configService.createPersonalConfig({
      userId: user.id,
      name: 'Test MCP',
      remoteUrl: 'https://example.com/mcp',
      authMode: 'none',
    });
    const registration = await services.clientService.registerClient({
      metadata: {
        redirect_uris: ['http://localhost:3000/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'profile',
      },
      headers: new Headers({ 'x-vercel-forwarded-for': '203.0.113.29' }),
    });
    const verifier =
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abcdefghijk';
    const authorization = await services.authorizationService.authorize({
      query: OAuthAuthorizationQuerySchema.parse({
        client_id: registration.clientId,
        redirect_uri: 'http://localhost:3000/callback',
        response_type: 'code',
        resource: created.route.canonical_url,
        code_challenge: pkceChallenge(verifier),
        code_challenge_method: 'S256',
      }),
      userId: user.id,
      executionContext: { type: 'personal' },
    });
    if (authorization.kind !== 'redirect') return;
    const code = new URL(authorization.redirectUrl).searchParams.get('code');
    if (!code) return;
    await db
      .update(mcp_gateway_authorization_codes)
      .set({ expires_at: new Date(Date.now() - 1_000).toISOString() })
      .where(
        eq(
          mcp_gateway_authorization_codes.code_hash,
          createHash('sha256').update(code).digest('hex')
        )
      );
    await expect(
      services.tokenService.exchangeToken({
        request: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: 'http://localhost:3000/callback',
          client_id: registration.clientId,
          code_verifier: verifier,
        },
        headers: new Headers(),
      })
    ).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('rejects authorization code redemption after the user becomes blocked', async () => {
    const config = await createTestConfig();
    const services = createGatewayServices({ config });
    const user = await insertTestUser({ id: `gateway-user-${crypto.randomUUID()}` });
    const created = await services.configService.createPersonalConfig({
      userId: user.id,
      name: 'Test MCP',
      remoteUrl: 'https://example.com/mcp',
      authMode: 'none',
    });
    const registration = await services.clientService.registerClient({
      metadata: {
        redirect_uris: ['http://localhost:3000/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'profile',
      },
      headers: new Headers({ 'x-forwarded-for': '203.0.113.19' }),
    });
    const verifier =
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abcdefghijk';
    const authorization = await services.authorizationService.authorize({
      query: OAuthAuthorizationQuerySchema.parse({
        client_id: registration.clientId,
        redirect_uri: 'http://localhost:3000/callback',
        response_type: 'code',
        resource: created.route.canonical_url,
        code_challenge: pkceChallenge(verifier),
        code_challenge_method: 'S256',
      }),
      userId: user.id,
      executionContext: { type: 'personal' },
    });
    expect(authorization.kind).toBe('redirect');
    if (authorization.kind !== 'redirect') return;
    const code = new URL(authorization.redirectUrl).searchParams.get('code');
    if (!code) return;
    await db
      .update(kilocode_users)
      .set({ blocked_reason: 'soft-deleted' })
      .where(eq(kilocode_users.id, user.id));
    await expect(
      services.tokenService.exchangeToken({
        request: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: 'http://localhost:3000/callback',
          client_id: registration.clientId,
          code_verifier: verifier,
        },
        headers: new Headers(),
      })
    ).rejects.toMatchObject({ code: 'access_denied' });
  });

  it('discovers provider metadata during OAuth config creation', async () => {
    const config = await createTestConfig();
    const services = createGatewayServices({ config, fetchImpl: providerDiscoveryFetch });
    const user = await insertTestUser({ id: `gateway-user-${crypto.randomUUID()}` });
    const created = await services.configService.createPersonalConfig({
      userId: user.id,
      name: 'OAuth MCP',
      remoteUrl: 'https://example.com/mcp',
      authMode: 'oauth_static',
    });
    expect(created.config.discovered_provider_metadata).toMatchObject({
      issuer: 'https://example.com',
      authorization_endpoint: 'https://example.com/authorize',
      token_endpoint: 'https://example.com/token',
    });
  });

  it('rejects oauth_dynamic configs when the provider has no registration endpoint', async () => {
    const config = await createTestConfig();
    const fetchImpl: typeof fetch = async input => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://example.com/.well-known/oauth-protected-resource') {
        return new Response(JSON.stringify({ authorization_servers: ['https://example.com'] }), {
          status: 200,
        });
      }
      if (url === 'https://example.com/.well-known/oauth-authorization-server') {
        return new Response(
          JSON.stringify({
            issuer: 'https://example.com',
            authorization_endpoint: 'https://example.com/authorize',
            token_endpoint: 'https://example.com/token',
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected discovery fetch: ${url}`);
    };
    const services = createGatewayServices({ config, fetchImpl });
    const user = await insertTestUser({ id: `gateway-user-${crypto.randomUUID()}` });
    await expect(
      services.configService.createPersonalConfig({
        userId: user.id,
        name: 'OAuth MCP',
        remoteUrl: 'https://example.com/mcp',
        authMode: 'oauth_dynamic',
      })
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('consumes provider state when the provider returns an error', async () => {
    const config = await createTestConfig();
    const fetchImpl: typeof fetch = async input => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const discovery = providerDiscoveryResponse(url);
      if (discovery) return discovery;
      if (url === 'https://example.com/token') {
        return new Response(
          JSON.stringify({
            access_token: 'provider-access',
            refresh_token: 'provider-refresh',
            expires_in: 900,
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };
    const services = createGatewayServices({ config, fetchImpl });
    const user = await insertTestUser({ id: `gateway-user-${crypto.randomUUID()}` });
    const created = await services.configService.createPersonalConfig({
      userId: user.id,
      name: 'OAuth MCP',
      remoteUrl: 'https://example.com/mcp',
      authMode: 'oauth_static',
    });
    await db
      .update(mcp_gateway_configs)
      .set({
        discovered_provider_metadata: {
          issuer: 'https://example.com',
          authorization_endpoint: 'https://example.com/authorize',
          token_endpoint: 'https://example.com/token',
        },
      })
      .where(eq(mcp_gateway_configs.config_id, created.config.config_id));
    await services.configService.upsertSecret({
      configId: created.config.config_id,
      kind: 'static_provider_credentials',
      value: { clientId: 'provider-client', clientSecret: 'provider-secret' },
    });
    const registration = await services.clientService.registerClient({
      metadata: {
        redirect_uris: ['http://localhost:3000/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'profile',
      },
      headers: new Headers({ 'x-forwarded-for': '203.0.113.17' }),
    });
    const verifier =
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abcdefghijk';
    const authorization = await services.authorizationService.authorize({
      query: OAuthAuthorizationQuerySchema.parse({
        client_id: registration.clientId,
        redirect_uri: 'http://localhost:3000/callback',
        response_type: 'code',
        scope: 'profile',
        state: 'client-state',
        resource: created.route.canonical_url,
        code_challenge: pkceChallenge(verifier),
        code_challenge_method: 'S256',
      }),
      userId: user.id,
      executionContext: { type: 'personal' },
    });
    expect(authorization.kind).toBe('provider_redirect');
    if (authorization.kind !== 'provider_redirect') return;
    const state = new URL(authorization.authorizationUrl).searchParams.get('state');
    expect(state).toBeTruthy();
    if (!state) return;

    const pending = await services.providerOAuthService.consumeProviderError({
      state,
      userId: user.id,
    });
    expect(pending?.pending_status).toBe('error');
    expect(pending?.consumed_at).toBeTruthy();
    await expect(
      services.providerOAuthService.handleProviderCallback({
        state,
        code: 'provider-code',
        userId: user.id,
      })
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('rejects a provider token response without an explicit bearer token type', async () => {
    const config = await createTestConfig();
    const fetchImpl: typeof fetch = async input => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const discovery = providerDiscoveryResponse(url);
      if (discovery) return discovery;
      if (url === 'https://example.com/token') {
        return new Response(
          JSON.stringify({
            access_token: 'provider-access',
            refresh_token: 'provider-refresh',
            expires_in: 900,
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };
    const services = createGatewayServices({ config, fetchImpl });
    const user = await insertTestUser({ id: `gateway-user-${crypto.randomUUID()}` });
    const created = await services.configService.createPersonalConfig({
      userId: user.id,
      name: 'OAuth MCP',
      remoteUrl: 'https://example.com/mcp',
      authMode: 'oauth_static',
    });
    await db
      .update(mcp_gateway_configs)
      .set({
        discovered_provider_metadata: {
          issuer: 'https://example.com',
          authorization_endpoint: 'https://example.com/authorize',
          token_endpoint: 'https://example.com/token',
        },
      })
      .where(eq(mcp_gateway_configs.config_id, created.config.config_id));
    await services.configService.upsertSecret({
      configId: created.config.config_id,
      kind: 'static_provider_credentials',
      value: { clientId: 'provider-client', clientSecret: 'provider-secret' },
    });
    const registration = await services.clientService.registerClient({
      metadata: {
        redirect_uris: ['http://localhost:3000/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'profile',
      },
      headers: new Headers({ 'x-vercel-forwarded-for': '203.0.113.30' }),
    });
    const authorization = await services.authorizationService.authorize({
      query: OAuthAuthorizationQuerySchema.parse({
        client_id: registration.clientId,
        redirect_uri: 'http://localhost:3000/callback',
        response_type: 'code',
        resource: created.route.canonical_url,
        code_challenge: pkceChallenge(
          'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abcdefghijk'
        ),
        code_challenge_method: 'S256',
      }),
      userId: user.id,
      executionContext: { type: 'personal' },
    });
    if (authorization.kind !== 'provider_redirect') return;
    const state = new URL(authorization.authorizationUrl).searchParams.get('state');
    if (!state) return;
    await expect(
      services.providerOAuthService.handleProviderCallback({
        state,
        code: 'provider-code',
        userId: user.id,
      })
    ).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('persists a provider grant before final authorization code issuance', async () => {
    const config = await createTestConfig();
    const fetchImpl: typeof fetch = async input => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const discovery = providerDiscoveryResponse(url);
      if (discovery) return discovery;
      if (url === 'https://example.com/token') {
        return new Response(
          JSON.stringify({
            access_token: 'provider-access',
            refresh_token: 'provider-refresh',
            token_type: 'bearer',
            expires_in: 900,
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };
    const services = createGatewayServices({ config, fetchImpl });
    const user = await insertTestUser({ id: `gateway-user-${crypto.randomUUID()}` });
    const created = await services.configService.createPersonalConfig({
      userId: user.id,
      name: 'OAuth MCP',
      remoteUrl: 'https://example.com/mcp',
      authMode: 'oauth_static',
    });
    await db
      .update(mcp_gateway_configs)
      .set({
        discovered_provider_metadata: {
          issuer: 'https://example.com',
          authorization_endpoint: 'https://example.com/authorize',
          token_endpoint: 'https://example.com/token',
        },
      })
      .where(eq(mcp_gateway_configs.config_id, created.config.config_id));
    await services.configService.upsertSecret({
      configId: created.config.config_id,
      kind: 'static_provider_credentials',
      value: { clientId: 'provider-client', clientSecret: 'provider-secret' },
    });
    const registration = await services.clientService.registerClient({
      metadata: {
        redirect_uris: ['http://localhost:3000/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'profile',
      },
      headers: new Headers({ 'x-forwarded-for': '203.0.113.16' }),
    });
    const verifier =
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abcdefghijk';
    const authorization = await services.authorizationService.authorize({
      query: OAuthAuthorizationQuerySchema.parse({
        client_id: registration.clientId,
        redirect_uri: 'http://localhost:3000/callback',
        response_type: 'code',
        scope: 'profile',
        state: 'client-state',
        resource: created.route.canonical_url,
        code_challenge: pkceChallenge(verifier),
        code_challenge_method: 'S256',
      }),
      userId: user.id,
      executionContext: { type: 'personal' },
    });
    expect(authorization.kind).toBe('provider_redirect');
    if (authorization.kind !== 'provider_redirect') return;
    const state = new URL(authorization.authorizationUrl).searchParams.get('state');
    expect(state).toBeTruthy();
    if (!state) return;

    const callback = await services.providerOAuthService.handleProviderCallback({
      state,
      code: 'provider-code',
      userId: user.id,
    });
    expect(callback.grant.grant_status).toBe('active');
    const grants = await db
      .select()
      .from(mcp_gateway_provider_grants)
      .where(eq(mcp_gateway_provider_grants.instance_id, callback.instance.instance_id));
    expect(grants).toHaveLength(1);
    const finalized = await services.authorizationService.completeProviderAuthorization({
      authorizationRequest: callback.authorizationRequest,
    });
    expect(new URL(finalized.redirectUrl).searchParams.get('code')).toBeTruthy();
  });

  it('keeps grant versions strictly advancing across replacement', async () => {
    const config = await createTestConfig();
    const services = createGatewayServices({ config, fetchImpl: providerDiscoveryFetch });
    const user = await insertTestUser({ id: `gateway-user-${crypto.randomUUID()}` });
    const created = await services.configService.createPersonalConfig({
      userId: user.id,
      name: 'OAuth MCP',
      remoteUrl: 'https://example.com/mcp',
      authMode: 'oauth_static',
    });
    const instance = await services.repository.ensureConnectionInstance({
      ownerScope: 'personal',
      ownerId: user.id,
      configId: created.config.config_id,
      userId: user.id,
    });
    await services.grantService.replaceGrant({
      instanceId: instance.instance_id,
      bundle: {
        accessToken: 'first',
        refreshToken: 'first-refresh',
        expiresAt: null,
        tokenType: 'bearer',
      },
    });
    await services.grantService.replaceGrant({
      instanceId: instance.instance_id,
      bundle: {
        accessToken: 'second',
        refreshToken: 'second-refresh',
        expiresAt: null,
        tokenType: 'bearer',
      },
    });
    await services.grantService.replaceGrant({
      instanceId: instance.instance_id,
      bundle: {
        accessToken: 'third',
        refreshToken: 'third-refresh',
        expiresAt: null,
        tokenType: 'bearer',
      },
    });
    const grants = await db
      .select()
      .from(mcp_gateway_provider_grants)
      .where(eq(mcp_gateway_provider_grants.instance_id, instance.instance_id))
      .orderBy(mcp_gateway_provider_grants.grant_version);
    const versions = grants.map(grant => grant.grant_version);
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions).toEqual([2, 4, 5]);
    expect(grants.at(-1)?.grant_status).toBe('active');
  });

  it('requires provider reauthorization for needs-reauth instances', async () => {
    const config = await createTestConfig();
    const services = createGatewayServices({ config, fetchImpl: providerDiscoveryFetch });
    const user = await insertTestUser({ id: `gateway-user-${crypto.randomUUID()}` });
    const created = await services.configService.createPersonalConfig({
      userId: user.id,
      name: 'OAuth MCP',
      remoteUrl: 'https://example.com/mcp',
      authMode: 'oauth_static',
    });
    await db
      .update(mcp_gateway_configs)
      .set({
        discovered_provider_metadata: {
          issuer: 'https://example.com',
          authorization_endpoint: 'https://example.com/authorize',
          token_endpoint: 'https://example.com/token',
        },
      })
      .where(eq(mcp_gateway_configs.config_id, created.config.config_id));
    await services.configService.upsertSecret({
      configId: created.config.config_id,
      kind: 'static_provider_credentials',
      value: { clientId: 'provider-client', clientSecret: 'provider-secret' },
    });
    const instance = await services.repository.ensureConnectionInstance({
      ownerScope: 'personal',
      ownerId: user.id,
      configId: created.config.config_id,
      userId: user.id,
    });
    await services.grantService.replaceGrant({
      instanceId: instance.instance_id,
      bundle: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: null,
        tokenType: 'bearer',
      },
    });
    await db
      .update(mcp_gateway_connection_instances)
      .set({ instance_status: 'needs_reauth' })
      .where(eq(mcp_gateway_connection_instances.instance_id, instance.instance_id));
    const registration = await services.clientService.registerClient({
      metadata: {
        redirect_uris: ['http://localhost:3000/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'profile',
      },
      headers: new Headers({ 'x-forwarded-for': '203.0.113.18' }),
    });
    const authorization = await services.authorizationService.authorize({
      query: OAuthAuthorizationQuerySchema.parse({
        client_id: registration.clientId,
        redirect_uri: 'http://localhost:3000/callback',
        response_type: 'code',
        resource: created.route.canonical_url,
        code_challenge: pkceChallenge(
          'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abcdefghijk'
        ),
        code_challenge_method: 'S256',
      }),
      userId: user.id,
      executionContext: { type: 'personal' },
    });
    expect(authorization.kind).toBe('provider_redirect');
  });

  it('enforces one active assignee for single-user org configs', async () => {
    const config = await createTestConfig();
    const services = createGatewayServices({ config });
    const owner = await insertTestUser({ id: `gateway-user-${crypto.randomUUID()}` });
    const firstUser = await insertTestUser({ id: `gateway-user-${crypto.randomUUID()}` });
    const secondUser = await insertTestUser({ id: `gateway-user-${crypto.randomUUID()}` });
    const organizationId = crypto.randomUUID();
    await db.insert(organizations).values({ id: organizationId, name: 'Gateway Org' });
    await db.insert(organization_memberships).values([
      { organization_id: organizationId, kilo_user_id: owner.id, role: 'owner' },
      { organization_id: organizationId, kilo_user_id: firstUser.id, role: 'member' },
      { organization_id: organizationId, kilo_user_id: secondUser.id, role: 'member' },
    ]);
    const created = await services.configService.createOrganizationConfig({
      organizationId,
      actorUserId: owner.id,
      name: 'Org MCP',
      remoteUrl: 'https://example.com/mcp',
      authMode: 'none',
      sharingMode: 'single_user',
      initialAssignedUserId: firstUser.id,
    });
    await expect(
      db.insert(mcp_gateway_assignments).values({
        config_id: created.config.config_id,
        kilo_user_id: secondUser.id,
        assigned_by_kilo_user_id: owner.id,
        single_user_slot: 'single_user',
      })
    ).rejects.toThrow();
  });

  it('rejects an org resource when the authenticated execution context is personal', async () => {
    const config = await createTestConfig();
    const services = createGatewayServices({ config });
    const user = await insertTestUser({ id: `gateway-user-${crypto.randomUUID()}` });
    const organizationId = crypto.randomUUID();
    await db.insert(organizations).values({ id: organizationId, name: 'Gateway Org' });
    await db.insert(organization_memberships).values({
      organization_id: organizationId,
      kilo_user_id: user.id,
      role: 'owner',
    });
    const created = await services.configService.createOrganizationConfig({
      organizationId,
      actorUserId: user.id,
      name: 'Org MCP',
      remoteUrl: 'https://example.com/mcp',
      authMode: 'none',
      sharingMode: 'single_user',
      initialAssignedUserId: user.id,
    });
    const registration = await services.clientService.registerClient({
      metadata: {
        redirect_uris: ['http://localhost:3000/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'profile',
      },
      headers: new Headers({ 'x-vercel-forwarded-for': '203.0.113.18' }),
    });
    const query = OAuthAuthorizationQuerySchema.parse({
      client_id: registration.clientId,
      redirect_uri: 'http://localhost:3000/callback',
      response_type: 'code',
      resource: created.route.canonical_url,
      code_challenge: pkceChallenge(
        'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abcdefghijk'
      ),
      code_challenge_method: 'S256',
    });

    await expect(
      services.authorizationService.authorize({
        query,
        userId: user.id,
        executionContext: { type: 'personal' },
      })
    ).rejects.toMatchObject({ code: 'access_denied' });
  });

  it('revokes organization-scoped OAuth artifacts when a member is removed', async () => {
    const config = await createTestConfig();
    const services = createGatewayServices({ config });
    const user = await insertTestUser({ id: `gateway-user-${crypto.randomUUID()}` });
    const organizationId = crypto.randomUUID();
    await db.insert(organizations).values({ id: organizationId, name: 'Gateway Org' });
    await db.insert(organization_memberships).values({
      organization_id: organizationId,
      kilo_user_id: user.id,
      role: 'owner',
    });
    const created = await services.configService.createOrganizationConfig({
      organizationId,
      actorUserId: user.id,
      name: 'Org MCP',
      remoteUrl: 'https://example.com/mcp',
      authMode: 'none',
      sharingMode: 'single_user',
      initialAssignedUserId: user.id,
    });
    const instance = await services.repository.ensureConnectionInstance({
      ownerScope: 'organization',
      ownerId: organizationId,
      configId: created.config.config_id,
      userId: user.id,
    });
    const registration = await services.clientService.registerClient({
      metadata: {
        redirect_uris: ['http://localhost:3000/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'profile',
      },
      headers: new Headers({ 'x-vercel-forwarded-for': '203.0.113.22' }),
    });
    const client = await services.clientService.findClientById(registration.clientId);
    if (!client) throw new Error('Expected registered OAuth client');
    const [authorizationRequest] = await db
      .insert(mcp_gateway_authorization_requests)
      .values({
        request_state_hash: `request-${crypto.randomUUID()}`,
        oauth_client_id: client.oauth_client_id,
        client_id: client.client_id,
        owner_scope: 'organization',
        owner_id: organizationId,
        config_id: created.config.config_id,
        route_key: created.route.route_key,
        canonical_resource_url: created.route.canonical_url,
        redirect_uri: 'http://localhost:3000/callback',
        requested_scopes: ['profile'],
        granted_scopes: ['profile'],
        execution_context: { type: 'organization', organizationId },
        kilo_user_id: user.id,
        instance_id: instance.instance_id,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      })
      .returning();
    if (!authorizationRequest) throw new Error('Expected authorization request');
    await db.insert(mcp_gateway_authorization_codes).values({
      code_hash: `code-${crypto.randomUUID()}`,
      authorization_request_id: authorizationRequest.authorization_request_id,
      oauth_client_id: client.oauth_client_id,
      client_id: client.client_id,
      owner_scope: 'organization',
      owner_id: organizationId,
      config_id: created.config.config_id,
      route_key: created.route.route_key,
      canonical_resource_url: created.route.canonical_url,
      redirect_uri: 'http://localhost:3000/callback',
      granted_scopes: ['profile'],
      execution_context: { type: 'organization', organizationId },
      kilo_user_id: user.id,
      instance_id: instance.instance_id,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    await db.insert(mcp_gateway_refresh_tokens).values({
      token_hash: `refresh-${crypto.randomUUID()}`,
      oauth_client_id: client.oauth_client_id,
      client_id: client.client_id,
      owner_scope: 'organization',
      owner_id: organizationId,
      config_id: created.config.config_id,
      route_key: created.route.route_key,
      canonical_resource_url: created.route.canonical_url,
      granted_scopes: ['profile'],
      execution_context: { type: 'organization', organizationId },
      kilo_user_id: user.id,
      instance_id: instance.instance_id,
    });

    await revokeGatewayStateForOrganizationMember(db, organizationId, user.id);

    await expect(
      db
        .select()
        .from(mcp_gateway_authorization_requests)
        .where(eq(mcp_gateway_authorization_requests.kilo_user_id, user.id))
    ).resolves.toHaveLength(0);
    await expect(
      db
        .select()
        .from(mcp_gateway_authorization_codes)
        .where(eq(mcp_gateway_authorization_codes.kilo_user_id, user.id))
    ).resolves.toHaveLength(0);
    await expect(
      db
        .select()
        .from(mcp_gateway_refresh_tokens)
        .where(eq(mcp_gateway_refresh_tokens.kilo_user_id, user.id))
    ).resolves.toHaveLength(0);
  });

  it('does not list unassigned org configs in the current execution context', async () => {
    const config = await createTestConfig();
    const services = createGatewayServices({ config });
    const assignedUser = await insertTestUser({ id: `gateway-user-${crypto.randomUUID()}` });
    const unassignedUser = await insertTestUser({ id: `gateway-user-${crypto.randomUUID()}` });
    const organizationId = crypto.randomUUID();
    await db.insert(organizations).values({ id: organizationId, name: 'Gateway Org' });
    await db.insert(organization_memberships).values([
      { organization_id: organizationId, kilo_user_id: assignedUser.id, role: 'owner' },
      { organization_id: organizationId, kilo_user_id: unassignedUser.id, role: 'member' },
    ]);
    await services.configService.createOrganizationConfig({
      organizationId,
      actorUserId: assignedUser.id,
      name: 'Org MCP',
      remoteUrl: 'https://example.com/mcp',
      authMode: 'none',
      sharingMode: 'single_user',
      initialAssignedUserId: assignedUser.id,
    });
    const assigned = await services.availableService.listAvailableConfigs(assignedUser.id, {
      type: 'organization',
      organizationId,
    });
    const unassigned = await services.availableService.listAvailableConfigs(unassignedUser.id, {
      type: 'organization',
      organizationId,
    });
    expect(assigned).toHaveLength(1);
    expect(unassigned).toHaveLength(0);
  });
});
