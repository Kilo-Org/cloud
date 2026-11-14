import type { RuntimeAgentInput } from './runtime-profile.js';

type PermissionAction = 'allow' | 'ask' | 'deny';
type PermissionRuleMap = Record<string, PermissionAction>;
export type PermissionValue = PermissionAction | PermissionRuleMap;
export type PermissionMap = Record<string, PermissionValue>;

type AgentPermission = NonNullable<RuntimeAgentInput['config']['permission']>;

/**
 * A guarded session's map carries tool keys. Every other non-interactive
 * session carries only the question denial, which states no command policy, so
 * its profile agents keep their entries as written.
 */
export function isCommandGuardPermissionMap(permission: PermissionMap): boolean {
  return Object.keys(permission).some(tool => tool !== 'question');
}

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

function literalPrefix(pattern: string): string {
  const wildcard = pattern.search(/[*?]/);
  return wildcard < 0 ? pattern : pattern.slice(0, wildcard);
}

/** Two anchored patterns can describe a common command only if one literal prefix starts with the other. */
function patternsMayCover(a: string, b: string): boolean {
  const left = literalPrefix(a);
  const right = literalPrefix(b);
  return left.startsWith(right) || right.startsWith(left);
}

/**
 * Combine a session pattern map with an agent pattern map so both apply.
 *
 * The composed rule list is built by order rather than by comparing pattern
 * text. Agent rules come first in their own order, so a profile's exception
 * after its own refusal survives.
 *
 * An agent refusal applies as written. An agent ask applies as written too, and
 * carries every session decision of the commands it can reach, in the session's
 * order: a session refusal stays a refusal, and a session allow becomes the
 * profile's ask because the profile chose to ask there. A session refusal can
 * therefore never become a prompt.
 *
 * An agent allowance is kept only where the session writes an allow for that
 * same pattern, because the session decides every other pattern.
 *
 * A kept allowance is followed by each later session refusal that can decide a
 * command it covers. Only refusals are carried: an appended allow would lift a
 * refusal the profile wrote, while a session refusal whose literal prefix is
 * disjoint from the allowance cannot match any command the allowance matches,
 * so the session map already governs it. A refusal is never dropped in favour of
 * a later session allow, because the allowance would otherwise decide a command
 * the session refuses. The composed map is therefore never wider than the
 * session map, so a session verdict still governs every command the profile
 * permits.
 *
 * Every pattern appears once, at the position of its last decision, so the
 * rendered map follows the order the decisions were made in.
 */
function composeRuleMap(
  session: PermissionRuleMap | undefined,
  agent: PermissionRuleMap
): PermissionRuleMap | undefined {
  if (session === undefined) return { ...agent };
  const sessionEntries = Object.entries(session);
  const composed: Array<[string, PermissionAction]> = [];
  for (const [pattern, action] of Object.entries(agent)) {
    // A refusal and an ask apply as written; an allowance needs the session to
    // write the same pattern, which is what the session permits.
    if (action === 'allow' && session[pattern] !== 'allow') continue;
    composed.push([pattern, action]);
    if (action === 'deny') continue;
    if (action === 'ask') {
      for (const [sessionPattern, sessionAction] of sessionEntries) {
        if (!patternsMayCover(pattern, sessionPattern)) continue;
        composed.push([sessionPattern, sessionAction === 'allow' ? 'ask' : sessionAction]);
      }
      continue;
    }
    const index = sessionEntries.findIndex(([key]) => key === pattern);
    if (index < 0) continue;
    for (const [denyIndex, [denyPattern, denyAction]] of sessionEntries.entries()) {
      if (denyIndex <= index || denyAction !== 'deny') continue;
      if (!patternsMayCover(pattern, denyPattern)) continue;
      composed.push([denyPattern, 'deny']);
    }
  }
  const lastIndex = new Map<string, number>();
  composed.forEach(([pattern], index) => {
    lastIndex.set(pattern, index);
  });
  const rules: PermissionRuleMap = {};
  composed.forEach(([pattern, action], index) => {
    if (lastIndex.get(pattern) === index) rules[pattern] = action;
  });
  return Object.keys(rules).length > 0 ? rules : undefined;
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
    // A flat action covers every tool. A refusal applies as written. A flat ask
    // or allowance is omitted when the session denies any tool, because a prompt
    // or an allowance there would be wider than the session, so the session
    // policy governs that agent.
    if (agent === 'deny') return agent;
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
