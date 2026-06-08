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
          // `:` is OpenClaw's `channel:accountId` separator. This endpoint manages
          // only channel-level default-account routes, so an account spec would
          // create a route the declarative clear could never remove again.
          .refine(value => !value.includes(':'), {
            message: 'Channel must not include an account specifier',
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

// Map a CLI binding to a read summary. We report the account id verbatim (any
// value, including the literal "default", means the route is account-scoped) and
// flag anything beyond a plain channel(/account) route as advanced. We do NOT
// coerce account ids here — see isManagedDefaultRoute for why.
function toBindingSummary(binding: CliBinding): AgentBindingSummary {
  const match = binding.match as Record<string, unknown>;
  const accountIdRaw = typeof match.accountId === 'string' ? match.accountId.trim() : '';
  const accountId = accountIdRaw === '' ? null : accountIdRaw;
  const advanced = Object.keys(match).some(key => key !== 'channel' && key !== 'accountId');
  return { channel: binding.match.channel, accountId, advanced };
}

// A binding the declarative set manages: a channel-level default-account route.
// This is defined as the EXACT shape `agents bind <channel>` writes — a match
// with only a `channel` key (no accountId, no peer/guild/etc.) — because that is
// also the only shape `agents unbind <channel>` can remove. Treating any route
// that carries an accountId (even the literal "default", or runtime-normalized
// values) as account-scoped keeps classification consistent with what the CLI
// can actually clear, instead of replicating OpenClaw's account normalization.
function isManagedDefaultRoute(binding: CliBinding): boolean {
  const keys = Object.keys(binding.match);
  return keys.length === 1 && keys[0] === 'channel';
}

// Stable identity for a binding's match, used to diff an agent's routes before
// and after a bind so we can isolate exactly what that invocation produced.
function routeKey(binding: CliBinding): string {
  const match = binding.match as Record<string, unknown>;
  return Object.keys(match)
    .sort()
    .map(key => `${key}=${JSON.stringify(match[key])}`)
    .join('&');
}

// The `--bind` spec that removes a given route: bare `channel` for a default
// route, `channel:accountId` for an account-scoped one.
function routeToUnbindSpec(binding: CliBinding): string {
  const summary = toBindingSummary(binding);
  return summary.accountId === null ? summary.channel : `${summary.channel}:${summary.accountId}`;
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
 * view and issuing `bind`/`unbind`. Binds run first; on a conflict we roll back
 * the additions and remove nothing, so a rejected request (→ 409) leaves the
 * agent's routing unchanged. The CLI owns conflict/canonicalization/$include/order.
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

    const before = await deps.listBindings(normalized);
    const current = before
      .filter(isManagedDefaultRoute)
      .map(binding => toBindingSummary(binding).channel);
    const currentSet = new Set(current);
    const desiredSet = new Set(desired);
    const toBind = desired.filter(channel => !currentSet.has(channel));
    const toUnbind = current.filter(channel => !desiredSet.has(channel));

    const beforeKeys = new Set(before.map(routeKey));

    // Undo exactly the routes a rejected/aborted bind produced, then CONFIRM the
    // agent's routes match the pre-bind snapshot. We diff against `before` rather
    // than unbinding `toBind` blindly: a bare unbind can resolve to an
    // account-scoped route, so unbinding requested channels could delete a
    // pre-existing route this request never created. If restoration can't be
    // confirmed (CLI timeout, write conflict, …), surface a distinct
    // state-uncertain error instead of reporting a clean rejection over mutated
    // routing.
    const restoreToBefore = async (created: CliBinding[]): Promise<void> => {
      try {
        if (created.length > 0) {
          await deps.unbind(normalized, created.map(routeToUnbindSpec));
        }
      } catch (rollbackError) {
        console.error(
          '[controller] Agent binding rollback unbind failed:',
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        );
      }
      const afterRollback = await deps.listBindings(normalized);
      const afterKeys = new Set(afterRollback.map(routeKey));
      const drifted =
        afterRollback.some(binding => !beforeKeys.has(routeKey(binding))) ||
        before.some(binding => !afterKeys.has(routeKey(binding)));
      if (drifted) {
        throw new AgentConfigError(
          500,
          'agent_binding_rollback_failed',
          'Binding change was rejected but could not be fully rolled back; routing state is uncertain — re-read bindings before retrying'
        );
      }
    };

    // Bind first, before removing anything. OpenClaw applies every
    // non-conflicting addition and THEN reports the conflict (exit 1), so we
    // diff the agent's routes against the pre-bind snapshot to see exactly what
    // this invocation produced, and roll those back on any rejection.
    if (toBind.length > 0) {
      const result = await deps.bind(normalized, toBind);
      const created = (await deps.listBindings(normalized)).filter(
        binding => !beforeKeys.has(routeKey(binding))
      );

      if (result.conflicts.length > 0) {
        await restoreToBefore(created);
        throw new AgentConfigError(
          409,
          'agent_binding_conflict',
          `Channel already routed to another agent: ${result.conflicts.join(', ')}`
        );
      }

      // Defense-in-depth: a channel's bare bind could (for some channel plugin)
      // resolve into an account-scoped route this endpoint can't manage as a
      // default route — a later `channels: []` clear would then silently leave
      // it. Confirm every route this invocation produced is a channel-key-only
      // default route; if not, roll back and fail closed. The cloud channels all
      // bind cleanly, so this only guards a future auto-resolving channel.
      const unmanageable = created.filter(binding => !isManagedDefaultRoute(binding));
      if (unmanageable.length > 0) {
        await restoreToBefore(created);
        const channels = [
          ...new Set(unmanageable.map(binding => toBindingSummary(binding).channel)),
        ];
        throw new AgentConfigError(
          422,
          'invalid_agent_config',
          `OpenClaw resolved a bind to an account-scoped route this endpoint cannot manage as a default route: ${channels.join(', ')}`
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
