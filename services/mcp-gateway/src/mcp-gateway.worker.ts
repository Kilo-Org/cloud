import { Hono } from 'hono';
import { handleOrgConnect, handleUserConnect } from './handlers/connect.handler';
import { handleHealth } from './handlers/health.handler';
import {
  handleOrgProtectedResourceMetadata,
  handleProtectedResourceMetadata,
  handleUserProtectedResourceMetadata,
} from './handlers/protected-resource.handler';
import {
  redirectToAuthorizationServerAuthorizeMetadata,
  redirectToAuthorizationServerMetadata,
} from './handlers/authorization-server-metadata.handler';
import type { MCPGatewayEnv } from './types';
import { runCleanup } from './lib/cleanup';

export { MCPGatewayInstance } from './durable-objects/MCPGatewayInstance.do';

export const app = new Hono<MCPGatewayEnv>();

app.get('/health', c => handleHealth(c));

app.get('/mcp-connect/user/:userId/:configId/:routeKey', c => handleUserConnect(c, c.req.param()));
app.post('/mcp-connect/user/:userId/:configId/:routeKey', c => handleUserConnect(c, c.req.param()));
app.get('/mcp-connect/user/:userId/:configId/:routeKey/*', c =>
  handleUserConnect(c, c.req.param())
);
app.post('/mcp-connect/user/:userId/:configId/:routeKey/*', c =>
  handleUserConnect(c, c.req.param())
);

app.get('/mcp-connect/org/:orgId/:configId/:routeKey', c => handleOrgConnect(c, c.req.param()));
app.post('/mcp-connect/org/:orgId/:configId/:routeKey', c => handleOrgConnect(c, c.req.param()));
app.get('/mcp-connect/org/:orgId/:configId/:routeKey/*', c => handleOrgConnect(c, c.req.param()));
app.post('/mcp-connect/org/:orgId/:configId/:routeKey/*', c => handleOrgConnect(c, c.req.param()));

app.get('/.well-known/oauth-protected-resource', c => handleProtectedResourceMetadata(c));
app.get('/.well-known/oauth-protected-resource/mcp-connect/user/:userId/:configId/:routeKey', c =>
  handleUserProtectedResourceMetadata(c, c.req.param())
);
app.get('/.well-known/oauth-protected-resource/mcp-connect/org/:orgId/:configId/:routeKey', c =>
  handleOrgProtectedResourceMetadata(c, c.req.param())
);

// These are discovery aliases only. The app remains the owner of first-level OAuth
// metadata, registration, authorization, token, JWKS, and user-info routes.
app.get('/.well-known/oauth-authorization-server', c => redirectToAuthorizationServerMetadata(c));
app.get('/.well-known/oauth-authorization-server/oauth/authorize', c =>
  redirectToAuthorizationServerAuthorizeMetadata(c)
);
app.get('/.well-known/oauth-authorization-server/mcp-connect/user/:userId/:configId/:routeKey', c =>
  redirectToAuthorizationServerMetadata(c)
);
app.get('/.well-known/oauth-authorization-server/mcp-connect/org/:orgId/:configId/:routeKey', c =>
  redirectToAuthorizationServerMetadata(c)
);

const fetchHandler: ExportedHandler<Env>['fetch'] = (request, env, ctx) =>
  app.fetch(request, env, ctx);

const scheduledHandler: ExportedHandler<Env>['scheduled'] = async (_event, env) => {
  await runCleanup(env);
};

export default {
  fetch: fetchHandler,
  scheduled: scheduledHandler,
} satisfies ExportedHandler<Env>;
