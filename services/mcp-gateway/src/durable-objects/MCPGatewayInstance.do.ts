import { DurableObject } from 'cloudflare:workers';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import migration from './mcp-gateway-instance/migrations.v1.sql';
import {
  RefreshProviderGrantInputSchema,
  refreshProviderGrant as runRefreshProviderGrant,
} from './mcp-gateway-instance/refresh';
import { mcpGatewayInstanceState } from './mcp-gateway-instance/state.table';

export class MCPGatewayInstance extends DurableObject<Env> {
  private readonly sqlite: DrizzleSqliteDODatabase<{
    mcpGatewayInstanceState: typeof mcpGatewayInstanceState;
  }>;
  private readonly refreshInFlight = new Map<
    string,
    Promise<Awaited<ReturnType<typeof runRefreshProviderGrant>>>
  >();

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sqlite = drizzle(state.storage, { schema: { mcpGatewayInstanceState } });
    void state.blockConcurrencyWhile(async () => {
      state.storage.sql.exec(migration);
    });
  }

  async refreshProviderGrant(input: unknown) {
    const parsed = RefreshProviderGrantInputSchema.safeParse(input);
    if (!parsed.success) {
      return await runRefreshProviderGrant({ env: this.env, sqlite: this.sqlite, input });
    }
    const attemptKey = `${parsed.data.instanceId}:${parsed.data.grantId}:${parsed.data.expectedGrantVersion}`;
    const existing = this.refreshInFlight.get(attemptKey);
    if (existing) {
      return await existing;
    }
    const attempt = runRefreshProviderGrant({
      env: this.env,
      sqlite: this.sqlite,
      input: parsed.data,
    });
    this.refreshInFlight.set(attemptKey, attempt);
    try {
      return await attempt;
    } finally {
      this.refreshInFlight.delete(attemptKey);
    }
  }
}

export function getMCPGatewayInstanceStub(env: Env, instanceKey: string) {
  const id = env.MCP_GATEWAY_INSTANCE.idFromName(instanceKey);
  return env.MCP_GATEWAY_INSTANCE.get(id);
}
