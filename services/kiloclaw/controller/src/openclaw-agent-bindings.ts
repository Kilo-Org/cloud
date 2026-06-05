import { z } from 'zod';
import {
  AgentConfigError,
  DEFAULT_AGENT_ID,
  readAgentConfigSnapshot,
  readAgentSummary,
  requireAgentId,
  serializeAgentConfigMutation,
  summarizeAgentConfig,
  type AgentConfigOptions,
  type AgentConfigSnapshot,
  type AgentSummary,
} from './openclaw-agent-config';
import { bindAgentViaCli, unbindAgentViaCli } from './openclaw-agent-cli';

const ChannelSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(value => !value.startsWith('-'), { message: 'Channel must not begin with a dash' });

// Declarative set: the agent's channel-level (default-account) routes should be
// exactly `channels`. Advanced and account-scoped bindings are preserved.
export const AgentBindingsPutBodySchema = z
  .object({
    etag: z.string().min(1).optional(),
    channels: z.array(ChannelSchema).max(50),
  })
  .strict();

export type AgentBindingsPutBody = z.infer<typeof AgentBindingsPutBodySchema>;

export type SetAgentBindingsDeps = {
  bindViaCli: typeof bindAgentViaCli;
  unbindViaCli: typeof unbindAgentViaCli;
  serializeMutation: typeof serializeAgentConfigMutation;
  readSnapshot: typeof readAgentConfigSnapshot;
  readSummary: typeof readAgentSummary;
};

const defaultDeps: SetAgentBindingsDeps = {
  bindViaCli: bindAgentViaCli,
  unbindViaCli: unbindAgentViaCli,
  serializeMutation: serializeAgentConfigMutation,
  readSnapshot: readAgentConfigSnapshot,
  readSummary: readAgentSummary,
};

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Apply a declarative channel-route set to one agent. Reads the agent's current
 * channel-level default-account routes, diffs against the requested set, and runs
 * the matching `bind`/`unbind` CLI calls inside one serialized mutation. Advanced
 * bindings (peer/guild/team/roles, non-route types) and account-scoped routes are
 * left untouched. A binding claimed by another agent surfaces as
 * `409 agent_binding_conflict`.
 */
export async function setAgentBindings(
  agentId: string,
  body: AgentBindingsPutBody,
  deps: SetAgentBindingsDeps = defaultDeps,
  options: AgentConfigOptions = {}
): Promise<{ snapshot: AgentConfigSnapshot; agent: AgentSummary }> {
  const normalized = requireAgentId(agentId);
  const desired = dedupe(body.channels.map(channel => channel.trim().toLowerCase()));

  return deps.serializeMutation(async () => {
    const snapshot = deps.readSnapshot(options);
    if (body.etag !== undefined && snapshot.etag !== body.etag) {
      throw new AgentConfigError(409, 'config_etag_conflict', 'Config changed since last read');
    }

    const agent = summarizeAgentConfig(snapshot.config).agents.find(a => a.id === normalized);
    if (agent === undefined && normalized !== DEFAULT_AGENT_ID) {
      throw new AgentConfigError(404, 'agent_not_found', `Agent "${normalized}" not found`);
    }

    // Only the channel-level, default-account routes are managed by the set.
    const current = new Set(
      (agent?.bindings ?? [])
        .filter(binding => !binding.advanced && binding.accountId === null)
        .map(binding => binding.channel)
    );
    const desiredSet = new Set(desired);
    const toBind = desired.filter(channel => !current.has(channel));
    const toUnbind = [...current].filter(channel => !desiredSet.has(channel));

    if (toUnbind.length > 0) {
      await deps.unbindViaCli(normalized, toUnbind);
    }
    if (toBind.length > 0) {
      const result = await deps.bindViaCli(normalized, toBind);
      if (result.conflicts.length > 0) {
        throw new AgentConfigError(
          409,
          'agent_binding_conflict',
          `Channel already routed to another agent: ${result.conflicts.join(', ')}`
        );
      }
    }

    const after = deps.readSummary(normalized, options);
    return { snapshot: after.snapshot, agent: after.agent };
  }, options);
}
