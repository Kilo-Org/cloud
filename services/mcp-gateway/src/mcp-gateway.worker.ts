import { Hono } from 'hono';
import { handleOrgConnect, handleUserConnect } from './handlers/connect.handler';
import { handleHealth } from './handlers/health.handler';
import {
  handleOrgProtectedResourceMetadata,
  handleProtectedResourceMetadata,
  handleUserProtectedResourceMetadata,
} from './handlers/protected-resource.handler';
import type { MCPGatewayEnv } from './types';

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

const fetchHandler: ExportedHandler<Env>['fetch'] = (request, env, ctx) =>
  app.fetch(request, env, ctx);

export default {
  fetch: fetchHandler,
} satisfies ExportedHandler<Env>;
