import { describe, expect, it } from 'vitest';
import {
  authorizationServerMetadata,
  handleAuthorizationServerMetadata,
  handleProtectedResourceMetadata,
  mcpResourceUrl,
  protectedResourceMetadata,
} from './metadata';

const ISSUER = 'https://kilo-mcp.test';

describe('authorizationServerMetadata', () => {
  it('advertises this worker as the issuer with the four OAuth endpoints', () => {
    const doc = authorizationServerMetadata(ISSUER);
    expect(doc).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      registration_endpoint: `${ISSUER}/register`,
    });
  });

  it('declares the MCP OAuth 2.1 profile: code-only, S256-only, public clients (requirement 16)', () => {
    const doc = authorizationServerMetadata(ISSUER);
    expect(doc['response_types_supported']).toEqual(['code']);
    expect(doc['code_challenge_methods_supported']).toEqual(['S256']);
    expect(doc['grant_types_supported']).toEqual(['authorization_code', 'refresh_token']);
    expect(doc['scopes_supported']).toEqual(['mcp']);
    expect(doc['token_endpoint_auth_methods_supported']).toEqual(['none']);
  });
});

describe('protectedResourceMetadata', () => {
  it('advertises the resource name and the authorization servers list (RFC 9728)', () => {
    const doc = protectedResourceMetadata(ISSUER, mcpResourceUrl(ISSUER));
    expect(doc).toMatchObject({
      resource: `${ISSUER}/mcp`,
      resource_name: 'Kilo MCP',
      authorization_servers: [ISSUER],
      scopes_supported: ['mcp'],
    });
  });
});

describe('metadata handlers', () => {
  it('serves the authorization-server document on GET', async () => {
    const response = handleAuthorizationServerMetadata(
      new Request(`${ISSUER}/.well-known/oauth-authorization-server`),
      { issuer: ISSUER }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    await expect(response.json()).resolves.toMatchObject({ issuer: ISSUER });
  });

  it('serves the protected-resource document on GET', async () => {
    const response = handleProtectedResourceMetadata(
      new Request(`${ISSUER}/.well-known/oauth-protected-resource/mcp`),
      { issuer: ISSUER }
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ resource: `${ISSUER}/mcp` });
  });

  it('rejects non-GET with an RFC error object', async () => {
    const response = handleAuthorizationServerMetadata(
      new Request(`${ISSUER}/.well-known/oauth-authorization-server`, { method: 'POST' }),
      { issuer: ISSUER }
    );
    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_request' });
  });

  it('carries CORS so MCP clients can fetch discovery from any origin', async () => {
    const response = handleProtectedResourceMetadata(
      new Request(`${ISSUER}/.well-known/oauth-protected-resource`),
      { issuer: ISSUER }
    );
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});
