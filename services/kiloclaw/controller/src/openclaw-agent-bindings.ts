import { z } from 'zod';
import {
  AgentConfigError,
  normalizeAgentId,
  readAgentConfigSnapshot,
  readAgentSummary,
  requireAgentId,
  serializeAgentConfigMutation,
  type AgentBindingSummary,
  type AgentConfigOptions,
  type AgentConfigSnapshot,
  type AgentSummary,
} from './openclaw-agent-config';
import {
  bindAgentViaCli,
  listAgentBindingsViaCli,
  unbindAgentViaCli,
  type CliBinding,
} from './openclaw-agent-cli';

// Declarative channel-route set: the agent's channel-level default-account routes
// should become exactly `channels`. OpenClaw (via the CLI) owns all routing
// semantics — conflict detection, account canonicalization, $include, ordering.
export const AgentBindingsPutBodySchema = z
  .object({
    etag: z.string().min(1).optional(),
    channels: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(64)
          .refine(value => !value.startsWith('-'), {
            message: 'Channel must not begin with a dash',
          })
      )
      .max(50),
  })
  .strict();

export type AgentBindingsPutBody = z.infer<typeof AgentBindingsPutBodySchema>;

export type AgentBindingsDeps = {
  listBindings: typeof listAgentBindingsViaCli;
  bind: typeof bindAgentViaCli;
  unbind: typeof unbindAgentViaCli;
  serializeMutation: typeof serializeAgentConfigMutation;
  readSnapshot: typeof readAgentConfigSnapshot;
  readSummary: typeof readAgentSummary;
};

const defaultDeps: AgentBindingsDeps = {
  listBindings: listAgentBindingsViaCli,
  bind: bindAgentViaCli,
  unbind: unbindAgentViaCli,
  serializeMutation: serializeAgentConfigMutation,
  readSnapshot: readAgentConfigSnapshot,
  readSummary: readAgentSummary,
};

// The CLI emits canonical match data, so mapping is trivial: account-default
// (absent or "default") → null; anything beyond channel/accountId → advanced.
function toBindingSummary(binding: CliBinding): AgentBindingSummary {
  const match = binding.match as Record<string, unknown>;
  const accountIdRaw = typeof match.accountId === 'string' ? match.accountId.trim() : '';
  const accountId =
    accountIdRaw === '' || accountIdRaw.toLowerCase() === 'default' ? null : accountIdRaw;
  const advanced = Object.keys(match).some(key => key !== 'channel' && key !== 'accountId');
  return { channel: binding.match.channel, accountId, advanced };
}

// A binding the declarative set manages: a default-account channel route.
function isManagedDefaultRoute(binding: CliBinding): boolean {
  const summary = toBindingSummary(binding);
  return summary.accountId === null && !summary.advanced;
}

/** Per-agent binding summaries, sourced from the CLI (the routing source of truth). */
export async function listAgentBindingSummaries(
  agentId: string | undefined,
  deps: AgentBindingsDeps = defaultDeps
): Promise<Map<string, AgentBindingSummary[]>> {
  const bindings = await deps.listBindings(agentId);
  const byAgent = new Map<string, AgentBindingSummary[]>();
  for (const binding of bindings) {
    const summaries = byAgent.get(binding.agentId) ?? [];
    summaries.push(toBindingSummary(binding));
    byAgent.set(binding.agentId, summaries);
  }
  return byAgent;
}

/**
 * Declaratively set an agent's channel-level routes by diffing the CLI's current
 * view and issuing `bind`/`unbind`. Bind runs first so a conflict (→ 409) leaves
 * existing routes intact. The CLI owns conflict/canonicalization/$include/order.
 */
export async function updateAgentBindings(
  agentId: string,
  body: AgentBindingsPutBody,
  deps: AgentBindingsDeps = defaultDeps,
  options: AgentConfigOptions = {}
): Promise<{ snapshot: AgentConfigSnapshot; agent: AgentSummary }> {
  const normalized = requireAgentId(agentId);
  const desired = [...new Set(body.channels.map(channel => channel.trim().toLowerCase()))];

  return deps.serializeMutation(async () => {
    const snapshot = deps.readSnapshot(options);
    if (body.etag !== undefined && snapshot.etag !== body.etag) {
      throw new AgentConfigError(409, 'config_etag_conflict', 'Config changed since last read');
    }

    // The CLI refuses to bind an agent absent from agents.list (incl. implicit
    // main). Check up front for a clean 404 rather than a generic CLI failure.
    const configured = (snapshot.config.agents?.list ?? []).some(
      entry => normalizeAgentId(entry.id) === normalized
    );
    if (!configured) {
      throw new AgentConfigError(404, 'agent_not_found', `Agent "${normalized}" not found`);
    }

    const current = (await deps.listBindings(normalized))
      .filter(isManagedDefaultRoute)
      .map(binding => toBindingSummary(binding).channel);
    const currentSet = new Set(current);
    const desiredSet = new Set(desired);
    const toBind = desired.filter(channel => !currentSet.has(channel));
    const toUnbind = current.filter(channel => !desiredSet.has(channel));

    // Bind first: a conflict aborts before anything is removed.
    if (toBind.length > 0) {
      const result = await deps.bind(normalized, toBind);
      if (result.conflicts.length > 0) {
        throw new AgentConfigError(
          409,
          'agent_binding_conflict',
          `Channel already routed to another agent: ${result.conflicts.join(', ')}`
        );
      }
    }
    if (toUnbind.length > 0) {
      await deps.unbind(normalized, toUnbind);
    }

    const after = deps.readSummary(normalized, options);
    const bindings = (await deps.listBindings(normalized)).map(toBindingSummary);
    return { snapshot: after.snapshot, agent: { ...after.agent, bindings } };
  }, options);
}
