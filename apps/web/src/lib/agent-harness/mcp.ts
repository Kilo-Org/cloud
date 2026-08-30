import 'server-only';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { GatewayError } from '@kilocode/mcp-gateway';
import { toolDefinitions, ToolRequestSchema } from '@kilocode/agent-harness/tools';
import { createGatewayServices } from '@/lib/mcp-gateway/services';
import { authorizeHarnessCapability, harnessInputDigest } from './authorization';

const Invocation = z.strictObject({
  conversationId: z.uuid(),
  operationId: z.uuid(),
  request: ToolRequestSchema,
});

/** Internal server-to-server access only. Never project these ephemeral tokens into client or model state. */
export async function authorizeHarnessMcp(token: string, input: unknown) {
  const parsed = Invocation.safeParse(input);
  if (!parsed.success) throw new TRPCError({ code: 'BAD_REQUEST', message: 'invalid_input' });
  const { conversationId, operationId, request } = parsed.data;
  if (request.name !== 'mcp.discover' && request.name !== 'mcp.call') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'invalid_input' });
  }
  const definition = toolDefinitions.find(tool => tool.name === request.name);
  if (!definition) throw new TRPCError({ code: 'BAD_REQUEST', message: 'invalid_input' });
  try {
    const { authority } = await authorizeHarnessCapability(token, {
      audience: 'agent-harness:operations',
      conversationId,
      operation: request.name,
      definitionVersion: definition.version,
      inputDigest: harnessInputDigest(request.arguments),
      dispatchId: operationId,
      target: { kind: 'backend' },
    });
    const executionContext =
      authority.organizationId === null
        ? { type: 'personal' as const }
        : { type: 'organization' as const, organizationId: authority.organizationId };
    const gateway = createGatewayServices();
    const available = await gateway.availableService.listAvailableConfigs(
      authority.userId,
      executionContext
    );
    const selected =
      request.name === 'mcp.discover'
        ? available
        : available.filter(config => config.configId === request.arguments.serverId);
    if (request.name === 'mcp.call' && selected.length !== 1) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'unavailable_server' });
    }
    const connections = [];
    for (const config of selected) {
      const { route, resolved } = await gateway.routeService.resolveResource(config.canonicalUrl);
      const url = gateway.routeService.canonicalUrl(route);
      const destination = new URL(url);
      if (
        url !== config.canonicalUrl ||
        destination.protocol !== 'https:' ||
        destination.username ||
        destination.password ||
        route.configId !== config.configId
      ) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'unsafe_destination' });
      }
      const configurationVersion = String(resolved.config.config_version);
      if (
        request.name === 'mcp.call' &&
        request.arguments.configurationVersion !== configurationVersion
      ) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'definition_changed' });
      }
      const access = await gateway.tokenService.mintDerivedConnectToken({
        route,
        userId: authority.userId,
        executionContext,
      });
      const claims = await gateway.tokenService.verifyUserInfoToken(access.token);
      if (String(claims.config_version) !== configurationVersion) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'definition_changed' });
      }
      connections.push({
        serverId: config.configId,
        configurationVersion,
        url,
        authorization: `Bearer ${access.token}`,
      });
    }
    return connections;
  } catch (error) {
    if (
      (error instanceof GatewayError && error.code === 'access_denied') ||
      (error instanceof TRPCError && (error.code === 'FORBIDDEN' || error.code === 'UNAUTHORIZED'))
    ) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'access_revoked' });
    }
    if (
      error instanceof TRPCError &&
      ['unavailable_server', 'unsafe_destination', 'definition_changed'].includes(error.message)
    ) {
      throw new TRPCError({ code: error.code, message: error.message });
    }
    if (error instanceof GatewayError && error.code === 'invalid_request') {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'unsafe_destination' });
    }
    const reauthorize =
      error instanceof GatewayError &&
      (error.code === 'forbidden' || error.code === 'invalid_grant');
    throw new TRPCError({
      code: reauthorize ? 'PRECONDITION_FAILED' : 'SERVICE_UNAVAILABLE',
      message: reauthorize ? 'reauthorization_required' : 'unavailable_server',
    });
  }
}
