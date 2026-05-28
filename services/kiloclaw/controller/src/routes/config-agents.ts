import type { Context, Hono } from 'hono';
import {
  AgentConfigError,
  AgentDefaultsPatchBodySchema,
  AgentSettingsPatchBodySchema,
  readAgentConfigSnapshot,
  readAgentSummary,
  serializeAgentConfigMutation,
  summarizeAgentConfig,
  updateAgentDefaults,
  updateAgentSettings,
} from '../openclaw-agent-config';
import {
  BasicAgentCreateBodySchema,
  OpenClawAgentCliError,
  createAgentViaCli,
  deleteAgentViaCli,
} from '../openclaw-agent-cli';

export type AgentRouteDeps = {
  readSnapshot: typeof readAgentConfigSnapshot;
  readSummary: typeof readAgentSummary;
  serializeMutation: typeof serializeAgentConfigMutation;
  summarize: typeof summarizeAgentConfig;
  updateSettings: typeof updateAgentSettings;
  updateDefaults: typeof updateAgentDefaults;
  createViaCli: typeof createAgentViaCli;
  deleteViaCli: typeof deleteAgentViaCli;
};

const defaultDeps: AgentRouteDeps = {
  readSnapshot: readAgentConfigSnapshot,
  readSummary: readAgentSummary,
  serializeMutation: serializeAgentConfigMutation,
  summarize: summarizeAgentConfig,
  updateSettings: updateAgentSettings,
  updateDefaults: updateAgentDefaults,
  createViaCli: createAgentViaCli,
  deleteViaCli: deleteAgentViaCli,
};

function errorStatus(status: number): 400 | 404 | 409 | 422 | 500 | 502 | 504 {
  switch (status) {
    case 400:
    case 404:
    case 409:
    case 422:
    case 500:
    case 502:
    case 504:
      return status;
    default:
      return 500;
  }
}

function respondError(c: Context, error: unknown) {
  if (error instanceof AgentConfigError || error instanceof OpenClawAgentCliError) {
    return c.json({ code: error.code, error: error.message }, errorStatus(error.status));
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error('[controller] Agent config route failed:', message);
  return c.json(
    { code: 'agent_config_failed', error: 'Agent configuration operation failed' },
    500
  );
}

async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AgentConfigError(400, 'invalid_agent_request', 'Invalid JSON body');
  }
}

export function registerAgentConfigRoutes(app: Hono, deps: AgentRouteDeps = defaultDeps): void {
  app.get('/_kilo/config/agents', c => {
    try {
      const snapshot = deps.readSnapshot();
      return c.json({ etag: snapshot.etag, ...deps.summarize(snapshot.config) });
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.get('/_kilo/config/agents/:agentId', c => {
    try {
      const { snapshot, agent } = deps.readSummary(c.req.param('agentId'));
      return c.json({ etag: snapshot.etag, agent });
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.post('/_kilo/config/agents', async c => {
    try {
      const parsed = BasicAgentCreateBodySchema.safeParse(await readJsonBody(c));
      if (!parsed.success) {
        return c.json(
          { code: 'invalid_agent_request', error: 'Invalid agent create request' },
          400
        );
      }
      const result = await deps.serializeMutation(async () => {
        const created = await deps.createViaCli(parsed.data);
        const { snapshot, agent } = deps.readSummary(created.agentId);
        return { etag: snapshot.etag, agent, created };
      });
      return c.json({ ok: true, ...result });
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.patch('/_kilo/config/agents/:agentId', async c => {
    try {
      const parsed = AgentSettingsPatchBodySchema.safeParse(await readJsonBody(c));
      if (!parsed.success) {
        return c.json(
          { code: 'invalid_agent_request', error: 'Invalid agent update request' },
          400
        );
      }
      const result = await deps.updateSettings(c.req.param('agentId'), parsed.data);
      return c.json({ ok: true, etag: result.snapshot.etag, agent: result.agent });
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.patch('/_kilo/config/agent-defaults', async c => {
    try {
      const parsed = AgentDefaultsPatchBodySchema.safeParse(await readJsonBody(c));
      if (!parsed.success) {
        return c.json(
          { code: 'invalid_agent_request', error: 'Invalid agent defaults request' },
          400
        );
      }
      const result = await deps.updateDefaults(parsed.data);
      return c.json({ ok: true, etag: result.snapshot.etag, defaults: result.defaults });
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.delete('/_kilo/config/agents/:agentId', async c => {
    try {
      const deleted = await deps.serializeMutation(() => deps.deleteViaCli(c.req.param('agentId')));
      return c.json({ ok: true, ...deleted, filesystemDisposition: 'unverified' });
    } catch (error) {
      return respondError(c, error);
    }
  });
}
