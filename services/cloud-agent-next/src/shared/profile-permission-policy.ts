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

/** The last rule that matches `pattern`, with the position it holds. */
function lastMatchingRule(
  rules: PermissionRuleMap,
  pattern: string
): { action: PermissionAction; index: number } | undefined {
  const entries = Object.entries(rules);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry === undefined) continue;
    if (matchesKiloPermissionPattern(pattern, entry[0])) {
      return { action: entry[1], index };
    }
  }
  return undefined;
}

/** Two patterns overlap when either one matches the other written as a value. */
function patternsOverlap(left: string, right: string): boolean {
  return matchesKiloPermissionPattern(right, left) || matchesKiloPermissionPattern(left, right);
}

/**
 * Keep an agent allowance only when the session permits the same patterns. The
 * session's rule for the pattern must be an allow, and no later session
 * refusal may cover that pattern.
 */
function sessionPermitsPattern(session: PermissionRuleMap | undefined, pattern: string): boolean {
  if (session === undefined) return true;
  const permitted = lastMatchingRule(session, pattern);
  if (permitted?.action !== 'allow') return false;
  const entries = Object.entries(session);
  for (let index = permitted.index + 1; index < entries.length; index++) {
    const entry = entries[index];
    if (entry === undefined) continue;
    if (entry[1] === 'deny' && patternsOverlap(entry[0], pattern)) return false;
  }
  return true;
}

/**
 * Combine a session pattern map with an agent pattern map. Every agent
 * restriction survives, and an agent allowance survives only where the session
 * permits those patterns.
 */
function composeRuleMap(
  session: PermissionRuleMap | undefined,
  agent: PermissionRuleMap
): PermissionRuleMap | undefined {
  const composed: PermissionRuleMap = {};
  for (const [pattern, action] of Object.entries(agent)) {
    if (action !== 'deny' && !sessionPermitsPattern(session, pattern)) continue;
    composed[pattern] = action;
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
    // A flat action covers every tool, so it applies only when the session sets
    // no restriction. Otherwise the entry is omitted and the session policy
    // governs the agent.
    if (agent === 'deny') return 'deny';
    return Object.values(session).some(value => valueHasDenial(value)) ? undefined : agent;
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
