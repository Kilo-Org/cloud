import { describe, expect, test } from 'vitest';
import {
  GatewayOwnerScope,
  buildMCPID,
  buildScopedConnectCanonicalUrl,
  buildScopedConnectRootPath,
  buildUpstreamHeaders,
  parseScopedConnectPath,
  isPublicIp,
  ProviderGrantBundleSchema,
  OAuthClientMetadataSchema,
  OAuthAuthorizationQuerySchema,
} from './index';

describe('scoped routes', () => {
  test('parses personal routes and descendants', () => {
    const route = parseScopedConnectPath(
      '/mcp-connect/user/user-1/11111111-1111-4111-8111-111111111111/abcdefghijklmnopqrstuvwxyzABCDEF/tools/list'
    );

    expect(route).toEqual({
      routeScope: 'user',
      ownerScope: 'personal',
      ownerId: 'user-1',
      configId: '11111111-1111-4111-8111-111111111111',
      routeKey: 'abcdefghijklmnopqrstuvwxyzABCDEF',
      rootPath:
        '/mcp-connect/user/user-1/11111111-1111-4111-8111-111111111111/abcdefghijklmnopqrstuvwxyzABCDEF',
      descendantPath: '/tools/list',
    });
  });

  test('builds canonical route identity', () => {
    const route = {
      ownerScope: GatewayOwnerScope.Organization,
      ownerId: '11111111-1111-4111-8111-111111111111',
      configId: '22222222-2222-4222-8222-222222222222',
      routeKey: 'abcdefghijklmnopqrstuvwxyzABCDEF',
    };

    expect(buildScopedConnectRootPath(route)).toBe(
      '/mcp-connect/org/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/abcdefghijklmnopqrstuvwxyzABCDEF'
    );
    expect(buildScopedConnectCanonicalUrl('https://mcp.kilosessions.ai', route)).toBe(
      'https://mcp.kilosessions.ai/mcp-connect/org/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/abcdefghijklmnopqrstuvwxyzABCDEF'
    );
    expect(buildMCPID(route)).toBe(
      'organization:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:abcdefghijklmnopqrstuvwxyzABCDEF'
    );
  });

  test('rejects low-entropy route keys', () => {
    expect(
      parseScopedConnectPath('/mcp-connect/user/user-1/11111111-1111-4111-8111-111111111111/short')
    ).toBeNull();
  });
});

describe('provider grant schema', () => {
  test('requires an explicit token type for stored grants', () => {
    expect(() =>
      ProviderGrantBundleSchema.parse({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: null,
      })
    ).toThrow();
  });
});

describe('OAuth client metadata', () => {
  test('ignores unsupported RFC metadata fields', () => {
    const parsed = OAuthClientMetadataSchema.parse({
      client_name: 'Codex',
      redirect_uris: ['http://localhost:3000/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      scope: 'profile',
      client_uri: 'https://client.example',
      logo_uri: 'https://client.example/logo.svg',
      software_id: 'codex',
    });

    expect(parsed).toEqual({
      client_name: 'Codex',
      redirect_uris: ['http://localhost:3000/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      scope: 'profile',
    });
  });

  test.each([undefined, '', '   '])('requires a non-empty scope declaration: %p', scope => {
    expect(
      OAuthClientMetadataSchema.safeParse({
        redirect_uris: ['http://localhost:3000/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        response_types: ['code'],
        scope,
      }).success
    ).toBe(false);
  });
});

describe('OAuth redirect URI policy', () => {
  test('requires HTTPS except loopback HTTP redirects', () => {
    expect(
      OAuthClientMetadataSchema.safeParse({
        redirect_uris: ['https://client.example/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        response_types: ['code'],
        scope: 'profile',
      }).success
    ).toBe(true);
    expect(
      OAuthClientMetadataSchema.safeParse({
        redirect_uris: ['http://localhost:3000/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        response_types: ['code'],
        scope: 'profile',
      }).success
    ).toBe(true);
    expect(
      OAuthAuthorizationQuerySchema.safeParse({
        client_id: 'mcp:client',
        redirect_uri: 'http://example.com/callback',
        response_type: 'code',
      }).success
    ).toBe(false);
  });
});

describe('IP policy', () => {
  test('allows ordinary public IPv4 addresses', () => {
    expect(isPublicIp('8.8.8.8')).toBe(true);
    expect(isPublicIp('1.1.1.1')).toBe(true);
  });

  test.each([
    '0.0.0.1',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.1.1',
    '172.16.0.1',
    '192.0.0.1',
    '192.0.2.1',
    '192.88.99.1',
    '192.168.0.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
  ])('rejects non-public IPv4 %s', address => {
    expect(isPublicIp(address)).toBe(false);
  });

  test('allows ordinary public IPv6 addresses and bracketed literals', () => {
    expect(isPublicIp('2606:4700:4700::1111')).toBe(true);
    expect(isPublicIp('[2606:4700:4700::1111]')).toBe(true);
  });

  test.each([
    '::',
    '::1',
    '::ffff:0:0',
    'fc00::1',
    'fd00::1',
    'fe80::1',
    'ff00::1',
    '2001:db8::1',
    '2001:0::1',
    '2001:2::1',
    '2001:10::1',
    '2001:20::1',
    '3fff::1',
  ])('rejects non-public IPv6 %s', address => {
    expect(isPublicIp(address)).toBe(false);
  });
});

describe('upstream headers', () => {
  test('forwards only allowlisted transient headers and injects credentials', () => {
    const source = new Headers({
      Accept: 'application/json',
      Authorization: 'Bearer client-token',
      Cookie: 'session=value',
      'MCP-Session-Id': 'session-1',
      'X-Auth-Token': 'should-not-forward',
      'X-Other': 'should-not-forward',
    });
    const headers = buildUpstreamHeaders({
      source,
      auxiliaryHeaders: [['X-Request-Id', 'request-1']],
      staticCredentialHeaders: [['X-API-Key', 'secret']],
      providerAuthorization: 'Bearer provider-token',
    });

    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('mcp-session-id')).toBe('session-1');
    expect(headers.get('x-request-id')).toBe('request-1');
    expect(headers.get('x-api-key')).toBe('secret');
    expect(headers.get('authorization')).toBe('Bearer provider-token');
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('x-auth-token')).toBeNull();
    expect(headers.get('x-other')).toBeNull();
  });
});
