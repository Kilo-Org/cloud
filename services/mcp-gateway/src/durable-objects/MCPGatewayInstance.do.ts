import { DurableObject } from 'cloudflare:workers';

export class MCPGatewayInstance extends DurableObject<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
  }
}

export function getMCPGatewayInstanceStub(env: Env, instanceKey: string) {
  const id = env.MCP_GATEWAY_INSTANCE.idFromName(instanceKey);
  return env.MCP_GATEWAY_INSTANCE.get(id);
}
