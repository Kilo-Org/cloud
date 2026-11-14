import type { RuntimeAgentInput } from './runtime-profile.js';

type PermissionAction = 'allow' | 'ask' | 'deny';
type PermissionRuleMap = Record<string, PermissionAction>;
export type PermissionValue = PermissionAction | PermissionRuleMap;
export type PermissionMap = Record<string, PermissionValue>;

type AgentPermission = NonNullable<RuntimeAgentInput['config']['permission']>;

// A profile agent's permission map is reconciled with the session command
// policy before it is stored, so the session policy and every stricter agent
// restriction both apply.

function isPermissionAction(value: unknown): value is PermissionAction {
  return value === 'allow' || value === 'ask' || value === 'deny';
}

/**
 * Match a command or pattern with the CLI's rule syntax. A permission rule is
 * anchored at both ends of the whole value, `*` matches any run of characters,
 * and `?` matches one.
 */
export function matchesKiloPermissionPattern(input: string, pattern: string): boolean {
  let escaped = pattern
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  if (escaped.endsWith(' .*')) {
    escaped = `${escaped.slice(0, -3)}( .*)?`;
  }
  return new RegExp(`^${escaped}$`, 's').test(input.replaceAll('\\', '/'));
}

/**
 * Combine a session pattern map with an agent pattern map so both apply.
 *
 * Agent rules keep their order, so a profile's own exception after its own
 * refusal survives. An agent allowance is kept only where the session writes an
 * allow for that same pattern, because the session decides every other pattern.
 * The session's refusals that follow that allow are placed after it, so a
 * command the guard refuses still ends in a refusal.
 */
function composeRuleMap(
  session: PermissionRuleMap | undefined,
  agent: PermissionRuleMap
): PermissionRuleMap | undefined {
  if (session === undefined) return { ...agent };
  const sessionEntries = Object.entries(session);
  const composed: PermissionRuleMap = {};
  const protectedFrom: number[] = [];
  for (const [pattern, action] of Object.entries(agent)) {
    if (action !== 'deny' && session[pattern] !== 'allow') continue;
    composed[pattern] = action;
    if (action === 'allow') {
      const index = sessionEntries.findIndex(([key]) => key === pattern);
      if (index >= 0) protectedFrom.push(index);
    }
  }
  if (protectedFrom.length > 0) {
    const from = Math.min(...protectedFrom);
    sessionEntries.forEach(([pattern, action], index) => {
      if (action === 'deny' && index > from && composed[pattern] === undefined) {
        composed[pattern] = 'deny';
      }
    });
  }
  return Object.keys(composed).length > 0 ? composed : undefined;
}

/** A single tool value denies when it is `deny` or holds a `deny` rule. */
function valueHasDenial(value: PermissionValue | undefined): boolean {
  if (value === undefined) return false;
  if (value === 'deny') return true;
  return Object.values(value).includes('deny');
}

export function narrowProfilePermission(
  session: PermissionMap,
  agent: AgentPermission
): PermissionValue | PermissionMap | undefined {
  if (isPermissionAction(agent)) {
    // A flat action covers every tool. A refusal and an ask apply as written; a
    // flat allowance is omitted when the session restricts any tool, so the
    // session policy governs that agent.
    if (agent !== 'allow') return agent;
    return Object.values(session).some(value => valueHasDenial(value)) ? undefined : 'allow';
  }
  if (typeof agent !== 'object' || agent === null) return undefined;
  const narrowed: PermissionMap = {};
  for (const [tool, agentValue] of Object.entries(agent)) {
    const sessionValue = session[tool];
    if (isPermissionAction(agentValue)) {
      if (agentValue !== 'deny' && valueHasDenial(sessionValue)) continue;
      narrowed[tool] = sessionValue === 'ask' && agentValue === 'allow' ? 'ask' : agentValue;
      continue;
    }
    if (typeof agentValue !== 'object' || agentValue === null) continue;
    const agentRules: PermissionRuleMap = {};
    // A value that carries no rule, such as the null sentinel an editor writes,
    // is ignored; the remaining rules of the tool still apply.
    for (const [pattern, value] of Object.entries(agentValue)) {
      if (isPermissionAction(value)) agentRules[pattern] = value;
    }
    if (Object.keys(agentRules).length === 0) continue;
    // A flat session action covers every pattern, so it composes as the single
    // wildcard rule and both policies apply to each call.
    const sessionRules =
      typeof sessionValue === 'string'
        ? { '*': sessionValue }
        : typeof sessionValue === 'object'
          ? sessionValue
          : undefined;
    const rules = composeRuleMap(sessionRules, agentRules);
    if (rules !== undefined) narrowed[tool] = rules;
  }
  return Object.keys(narrowed).length > 0 ? narrowed : undefined;
}

/**
 * Apply the session command policy to each profile agent map. The caller passes
 * the command guard's map, so a session without a guard keeps its profile
 * entries unchanged.
 */
export function narrowProfileAgents(
  session: PermissionMap,
  agents: readonly RuntimeAgentInput[]
): RuntimeAgentInput[] {
  if (Object.keys(session).length === 0) return [...agents];
  return agents.map(agent => {
    if (agent.config.permission === undefined) return agent;
    const permission = narrowProfilePermission(session, agent.config.permission);
    if (permission === undefined) {
      const { permission: _dropped, ...config } = agent.config;
      return { ...agent, config };
    }
    return { ...agent, config: { ...agent.config, permission } };
  });
}
