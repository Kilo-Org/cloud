import type { RuntimeAgentInput } from './runtime-profile.js';

type PermissionAction = 'allow' | 'ask' | 'deny';
type PermissionRuleMap = Record<string, PermissionAction>;
export type PermissionValue = PermissionAction | PermissionRuleMap;
export type PermissionMap = Record<string, PermissionValue>;

type AgentPermission = NonNullable<RuntimeAgentInput['config']['permission']>;

// A profile agent's permission map is reconciled with the session command
// policy before it is stored, so the session policy and every stricter agent
// restriction both apply. Resolution keeps the agent's restrictions, takes an
// agent allowance only where the session permits the same pattern, and ends
// with the session's own refusals.

function isPermissionAction(value: unknown): value is PermissionAction {
  return value === 'allow' || value === 'ask' || value === 'deny';
}

function isRuleMap(value: unknown): value is PermissionRuleMap {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isPermissionAction)
  );
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

/** Resolve one pattern with the CLI's rules: the last matching rule wins. */
function resolveRuleAction(
  rules: PermissionRuleMap,
  pattern: string
): PermissionAction | undefined {
  let result: PermissionAction | undefined;
  for (const [candidate, action] of Object.entries(rules)) {
    if (matchesKiloPermissionPattern(pattern, candidate)) result = action;
  }
  return result;
}

function lastAllowIndex(rules: PermissionRuleMap): number {
  const entries = Object.entries(rules);
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index]?.[1] === 'allow') return index;
  }
  return -1;
}

/**
 * Combine a session pattern map with an agent pattern map so both apply. Every
 * agent restriction survives, an agent allowance survives only where the
 * session resolves the same pattern to allow, and the session's own refusals
 * are placed last so they decide over any surviving allowance.
 */
function narrowRuleMap(
  session: PermissionRuleMap | undefined,
  agent: PermissionRuleMap
): PermissionRuleMap | undefined {
  // An empty agent map declares no restriction, so the session policy governs
  // and the entry carries nothing.
  if (Object.keys(agent).length === 0) return undefined;
  const narrowed: PermissionRuleMap = {};
  for (const [pattern, action] of Object.entries(agent)) {
    if (action === 'deny' || session === undefined) {
      narrowed[pattern] = action;
      continue;
    }
    const verdict = resolveRuleAction(session, pattern);
    if (verdict === 'allow') narrowed[pattern] = action;
    else if (verdict === 'ask' && action === 'allow') narrowed[pattern] = 'ask';
  }
  if (session !== undefined) {
    const protectedFrom = lastAllowIndex(session);
    Object.entries(session).forEach(([pattern, action], index) => {
      if (action === 'deny' && index > protectedFrom && narrowed[pattern] === undefined) {
        narrowed[pattern] = 'deny';
      }
    });
  }
  return Object.keys(narrowed).length > 0 ? narrowed : undefined;
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
    // A flat action covers every tool, so it applies only when the session sets
    // no restriction. Otherwise the entry is omitted and the session policy
    // governs the agent.
    if (agent === 'deny') return 'deny';
    return Object.values(session).some(value => valueHasDenial(value)) || agent === 'ask'
      ? undefined
      : 'allow';
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
    if (!isRuleMap(agentValue)) continue;
    // A flat session action covers every pattern, so it narrows the agent map as
    // the single wildcard rule and both policies apply to each call.
    const sessionRules =
      typeof sessionValue === 'string'
        ? { '*': sessionValue }
        : typeof sessionValue === 'object'
          ? sessionValue
          : undefined;
    const rules = narrowRuleMap(sessionRules, agentValue);
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
