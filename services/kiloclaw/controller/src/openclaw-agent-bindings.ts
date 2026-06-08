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

// Map a CLI binding to a read summary. account id is reported verbatim and is
// null ONLY when the key is absent — never coerced from a blank/whitespace value
// — so the read stays consistent with isManagedDefaultRoute (which treats ANY
// present accountId as account-scoped). Otherwise a hand-authored
// `{ channel, accountId: "  " }` would read as a plain default route while a
// clear silently left it in place. Anything beyond channel/accountId is advanced.
function toBindingSummary(binding: CliBinding): AgentBindingSummary {
  const match = binding.match as Record<string, unknown>;
  const accountId = 'accountId' in match ? String(match.accountId) : null;
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

// The canonical `--bind`/`--unbind` spec for a route: bare `channel` for a
// default route, `channel:accountId` for an account-scoped one. Used both to
// remove a created route and to re-create a removed one during restoration.
function routeToSpec(binding: CliBinding): string {
  const summary = toBindingSummary(binding);
  return summary.accountId === null ? summary.channel : `${summary.channel}:${summary.accountId}`;
}

// The set of channels an agent catches via a managed (channel-key-only) default
// route, lower-cased for comparison against the desired set.
function managedChannelSet(bindings: CliBinding[]): Set<string> {
  return new Set(
    bindings
      .filter(isManagedDefaultRoute)
      .map(binding => toBindingSummary(binding).channel.toLowerCase())
  );
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
 * view and issuing `bind`/`unbind`. Every write through the final
 * managed-set verification runs under one recovery path: on any failure the
 * agent's routes are restored to the pre-change snapshot and the original reason
 * is surfaced; if restoration cannot be confirmed the request fails with
 * `500 agent_binding_rollback_failed` rather than report a clean result over
 * mutated routing. The endpoint only returns success once the managed route set
 * actually equals the requested channels. The CLI owns
 * conflict/canonicalization/$include/order.
 */
export async function updateAgentBindings(
  agentId: string,
  body: AgentBindingsPutBody,
  deps: AgentBindingsDeps = defaultDeps,
  options: AgentConfigOptions = {}
): Promise<{ snapshot: AgentConfigSnapshot; agent: AgentSummary }> {
  const normalized = requireAgentId(agentId);
  const desiredSet = new Set(body.channels.map(channel => channel.trim().toLowerCase()));
  const desired = [...desiredSet];

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
    const beforeKeys = new Set(before.map(routeKey));
    const beforeManaged = managedChannelSet(before);
    const toBind = desired.filter(channel => !beforeManaged.has(channel));
    const toUnbind = [...beforeManaged].filter(channel => !desiredSet.has(channel));

    // Restore the agent's routes to `before` after a failed/aborted change, then
    // CONFIRM it. We diff the live state against the snapshot rather than
    // replaying `toBind`/`toUnbind`: a bare spec can resolve to an account-scoped
    // route, so we undo exactly the routes that diverged (unbind what was added,
    // re-bind what was removed) by their canonical specs. If the confirming read
    // fails or still shows drift, the routing state is uncertain — surface that
    // instead of a clean result.
    const restoreToBefore = async (): Promise<void> => {
      try {
        const live = await deps.listBindings(normalized);
        const liveKeys = new Set(live.map(routeKey));
        const created = live.filter(binding => !beforeKeys.has(routeKey(binding)));
        const removed = before.filter(binding => !liveKeys.has(routeKey(binding)));
        if (created.length > 0) await deps.unbind(normalized, created.map(routeToSpec));
        if (removed.length > 0) await deps.bind(normalized, removed.map(routeToSpec));
      } catch (rollbackError) {
        console.error(
          '[controller] Agent binding rollback failed:',
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        );
      }
      let afterRollback: CliBinding[];
      try {
        afterRollback = await deps.listBindings(normalized);
      } catch {
        throw new AgentConfigError(
          500,
          'agent_binding_rollback_failed',
          'Binding change failed and the rollback could not be confirmed; routing state is uncertain — re-read bindings before retrying'
        );
      }
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

    if (toBind.length > 0 || toUnbind.length > 0) {
      // OpenClaw writes config before emitting its JSON result, so a bind/unbind
      // timeout, malformed result, conflict, or a managed set that doesn't match
      // the request can all leave routes changed. Funnel every such case through
      // one recovery path: restore to `before`, then surface the reason.
      let failure: unknown = null;
      try {
        if (toBind.length > 0) {
          const result = await deps.bind(normalized, toBind);
          if (result.conflicts.length > 0) {
            failure = new AgentConfigError(
              409,
              'agent_binding_conflict',
              `Channel already routed to another agent: ${result.conflicts.join(', ')}`
            );
          }
        }
        if (!failure && toUnbind.length > 0) {
          await deps.unbind(normalized, toUnbind);
        }
        if (!failure) {
          // Only report success if the managed route set is exactly the request.
          // A bare bind can resolve to an existing account route (reported
          // `skipped`) or a bare unbind to a different account scope (reported
          // `missing`), either of which leaves the managed set wrong despite an
          // ok-looking CLI result.
          const finalManaged = managedChannelSet(await deps.listBindings(normalized));
          const matches =
            finalManaged.size === desiredSet.size &&
            [...desiredSet].every(channel => finalManaged.has(channel));
          if (!matches) {
            failure = new AgentConfigError(
              422,
              'invalid_agent_config',
              'Could not set the requested channel routes; OpenClaw resolved one or more channels outside the managed default-account scope'
            );
          }
        }
      } catch (writeError) {
        failure = writeError;
      }

      if (failure) {
        await restoreToBefore(); // throws 500 agent_binding_rollback_failed if unconfirmable
        throw failure;
      }
    }

    const after = deps.readSummary(normalized, options);
    const bindings = (await deps.listBindings(normalized)).map(toBindingSummary);
    return { snapshot: after.snapshot, agent: { ...after.agent, bindings } };
  }, options);
}
