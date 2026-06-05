import type { Context } from 'hono';
import type { MCPGatewayEnv } from '../types';

function authorizationServerMetadataUrl(c: Context<MCPGatewayEnv>) {
  return new URL('/.well-known/oauth-authorization-server', c.env.APP_BASE_URL).toString();
}

function authorizationServerAuthorizeMetadataUrl(c: Context<MCPGatewayEnv>) {
  return new URL(
    '/.well-known/oauth-authorization-server/oauth/authorize',
    c.env.APP_BASE_URL
  ).toString();
}

export function redirectToAuthorizationServerMetadata(c: Context<MCPGatewayEnv>) {
  return c.redirect(authorizationServerMetadataUrl(c), 307);
}

export function redirectToAuthorizationServerAuthorizeMetadata(c: Context<MCPGatewayEnv>) {
  return c.redirect(authorizationServerAuthorizeMetadataUrl(c), 307);
}
