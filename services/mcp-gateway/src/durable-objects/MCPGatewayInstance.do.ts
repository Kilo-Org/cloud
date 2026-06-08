import { DurableObject } from 'cloudflare:workers';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import initialMigration from './mcp-gateway-instance/001_initial.sql';
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
      const schemaVersion = await state.storage.get<number>('schema_version');
      if (schemaVersion === undefined) {
        state.storage.sql.exec(initialMigration);
        await state.storage.put('schema_version', 1);
        return;
      }
      if (schemaVersion !== 1) {
        throw new Error(`Unsupported MCP gateway DO schema version: ${schemaVersion}`);
      }
    });
  }

  async refreshProviderGrant(input: unknown) {
    const parsed = RefreshProviderGrantInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error('Invalid refreshProviderGrant input');
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
