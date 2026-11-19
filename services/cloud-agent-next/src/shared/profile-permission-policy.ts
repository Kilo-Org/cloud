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
 * A tool value's rules, with a flat action normalised to the single wildcard
 * that covers every command. An absent or non-map value states no rule, and the
 * callers that spread the result treat it as such.
 */
export function permissionRulesOf(
  value: PermissionValue | undefined
): PermissionRuleMap | undefined {
  if (typeof value === 'string') return { '*': value };
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return { ...value };
  return undefined;
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

type GlobToken = { kind: 'literal'; value: string } | { kind: 'one' } | { kind: 'run' };

/**
 * The token sequence a pattern stands for. The matcher treats a trailing ` *`
 * as an optional group, so such a pattern is one of two plain globs.
 */
function globAlternatives(pattern: string): GlobToken[][] {
  const texts = pattern.endsWith(' *') ? [pattern.slice(0, -2), pattern] : [pattern];
  return texts.map(text => {
    const tokens: GlobToken[] = [];
    for (const char of text.replaceAll('\\', '/')) {
      if (char === '*') {
        if (tokens.at(-1)?.kind !== 'run') tokens.push({ kind: 'run' });
        continue;
      }
      tokens.push(char === '?' ? { kind: 'one' } : { kind: 'literal', value: char });
    }
    return tokens;
  });
}

function globsOverlap(left: GlobToken[], right: GlobToken[]): boolean {
  const memo = new Map<string, boolean>();
  const walk = (i: number, j: number): boolean => {
    const key = `${i},${j}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (i === left.length || j === right.length) {
      const rest = i === left.length ? right.slice(j) : left.slice(i);
      result = rest.every(token => token.kind === 'run');
    } else {
      const a: GlobToken = left[i];
      const b: GlobToken = right[j];
      if (a.kind === 'run' || b.kind === 'run') {
        // A run absorbs nothing, or it absorbs the one character the other
        // token produces; either way one side advances.
        result = walk(i + 1, j) || walk(i, j + 1);
      } else {
        const compatible = a.kind !== 'literal' || b.kind !== 'literal' || a.value === b.value;
        result = compatible && walk(i + 1, j + 1);
      }
    }
    memo.set(key, result);
    return result;
  };
  return walk(0, 0);
}

/** Two anchored patterns describe a common command only when their globs overlap. */
function patternsMayCover(a: string, b: string): boolean {
  return globAlternatives(a).some(left =>
    globAlternatives(b).some(right => globsOverlap(left, right))
  );
}

/**
 * The positions a token sequence can sit at without reading a character. A run
 * also matches an empty sequence, so it may advance on its own.
 */
function globEpsilonClosure(
  tokens: readonly GlobToken[],
  positions: ReadonlySet<number>
): Set<number> {
  const closed = new Set(positions);
  const pending = [...positions];
  while (pending.length > 0) {
    const position = pending.pop() as number;
    if (tokens[position]?.kind !== 'run' || closed.has(position + 1)) continue;
    closed.add(position + 1);
    pending.push(position + 1);
  }
  return closed;
}

/** The positions a token sequence reaches after reading one character. */
function globAdvance(
  tokens: readonly GlobToken[],
  positions: ReadonlySet<number>,
  char: string
): Set<number> {
  const reached = new Set<number>();
  for (const position of positions) {
    const token = tokens[position];
    if (token === undefined) continue;
    if (token.kind === 'run') reached.add(position);
    else if (token.kind === 'one') reached.add(position + 1);
    else if (token.value === char) reached.add(position + 1);
  }
  return globEpsilonClosure(tokens, reached);
}

function positionKey(positions: ReadonlySet<number>): string {
  return [...positions].sort((left, right) => left - right).join(',');
}

/**
 * Every command the left glob matches is also matched by the right one.
 *
 * The two languages are searched over the characters either glob names, plus
 * one character neither names, which stands for every character both treat
 * alike. A command the left reaches with nothing left of the right is a command
 * the right misses, so the walk reports the pair as not covered; a command set
 * that runs out without such a command is covered.
 */
function globCoveredBy(left: readonly GlobToken[], right: readonly GlobToken[]): boolean {
  const literals = new Set<string>();
  for (const token of [...left, ...right]) {
    if (token.kind === 'literal') literals.add(token.value);
  }
  let spare = 1;
  while (literals.has(String.fromCharCode(spare))) spare += 1;
  const alphabet = [...literals, String.fromCharCode(spare)];

  const visited = new Set<string>();
  const pending: Array<[Set<number>, Set<number>]> = [
    [globEpsilonClosure(left, new Set([0])), globEpsilonClosure(right, new Set([0]))],
  ];
  while (pending.length > 0) {
    const [leftPositions, rightPositions] = pending.pop() as [Set<number>, Set<number>];
    const key = `${positionKey(leftPositions)}/${positionKey(rightPositions)}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (leftPositions.has(left.length) && !rightPositions.has(right.length)) return false;
    for (const char of alphabet) {
      const nextLeft = globAdvance(left, leftPositions, char);
      if (nextLeft.size === 0) continue;
      pending.push([nextLeft, globAdvance(right, rightPositions, char)]);
    }
  }
  return true;
}

/** Every command the left pattern matches is also matched by the right pattern. */
function patternIsCoveredBy(left: string, right: string): boolean {
  return globAlternatives(left).every(leftTokens =>
    globAlternatives(right).some(rightTokens => globCoveredBy(leftTokens, rightTokens))
  );
}

/**
 * The profile entries written with a strictly broader pattern before the
 * narrower pattern it covers, so the profile's most specific verdict is the one
 * the runtime resolves last. Coverage is a strict partial order, so Kahn over
 * the broader-first edges with the author's index as the tie-break keeps equal
 * and incomparable patterns in the order the author wrote.
 */
function agentEntriesBroadestFirst(
  entries: Array<[string, PermissionAction]>
): Array<[string, PermissionAction]> {
  const wider: boolean[][] = entries.map(([broadPattern], broadIndex) =>
    entries.map(([narrowPattern], narrowIndex) =>
      broadIndex !== narrowIndex &&
      patternIsCoveredBy(narrowPattern, broadPattern) &&
      !patternIsCoveredBy(broadPattern, narrowPattern)
    )
  );
  const placed = new Set<number>();
  const ordered: Array<[string, PermissionAction]> = [];
  while (placed.size < entries.length) {
    const ready = entries.findIndex(
      (_, narrow) =>
        !placed.has(narrow) && wider.every((row, broad) => !row[narrow] || placed.has(broad))
    );
    if (ready < 0) return [...entries];
    placed.add(ready);
    ordered.push(entries[ready]);
  }
  return ordered;
}

/**
 * Combine a session pattern map with an agent pattern map so both apply.
 *
 * The rendered map orders each tool's profile rules from the broadest pattern to
 * the narrowest, so the profile's most specific decision is the one the runtime
 * applies. Rules the author writes with equal patterns, or patterns where
 * neither covers the other, keep the order the author wrote, so a profile's
 * exception written after its own refusal survives, and each session decision it
 * carries follows it.
 *
 * A profile refusal applies as written. A profile ask applies as written too.
 * A profile allowance is kept only where the session writes an allow for that
 * same pattern, because the session decides every other pattern.
 *
 * A kept rule carries the session refusals it can reach: a refusal is carried
 * after the profile rule when the two patterns can describe a common command,
 * so it decides one of the commands that rule covers. It is skipped only when a
 * later session allow's pattern matches every command the refusal matches. The
 * composed entry therefore never takes a verdict wider than the session's,
 * while a profile refusal keeps its effect.
 *
 * An ask also carries a session allow, as the profile's ask, but only when the
 * allow's own pattern satisfies the ask's pattern, so every command the allow
 * permits is one the profile asked about; a wider session allow keeps its own
 * verdict for the commands the ask does not cover. A pattern the profile decides
 * itself keeps the profile's own verdict, so a carried ask never overwrites it.
 *
 * A session refusal on the ask's own key comes before the carried allows,
 * because the session writes those allows to refine that refusal and they are
 * its later word. Every other carried refusal comes after the carried allows,
 * because it names a command the profile never asked about, so it keeps the last
 * word and an ask never lifts a refusal the session wrote.
 *
 * Every pattern appears once, at the position of its last decision, so the
 * rendered map follows the order the decisions were made in.
 */
function composeRuleMap(
  session: PermissionRuleMap | undefined,
  agent: PermissionRuleMap
): PermissionRuleMap | undefined {
  if (session === undefined) return { ...agent };
  const entries = Object.entries(session);
  const composed: Array<[string, PermissionAction]> = [];
  for (const [pattern, action] of agentEntriesBroadestFirst(Object.entries(agent))) {
    // A refusal and an ask apply as written; an allowance needs the session to
    // write the same pattern, which is what the session permits.
    if (action === 'allow' && session[pattern] !== 'allow') continue;
    composed.push([pattern, action]);
    if (action === 'deny') continue;
    // The profile rule sits after every session rule from this index on, so a
    // session refusal written earlier cannot follow it, unless it names the
    // same key.
    const index = entries.findIndex(([key]) => key === pattern);
    const refusals: Array<[string, 'deny']> = [];
    for (const [denyIndex, [denyPattern, denyAction]] of entries.entries()) {
      if (denyAction !== 'deny') continue;
      if (!(index < 0 || denyIndex > index || denyPattern === pattern)) continue;
      if (!patternsMayCover(denyPattern, pattern)) continue;
      // A later session allow that matches every command of the refusal
      // decides it on its own, so carrying the refusal would only repeat that
      // decision.
      const overridden = entries.some(
        ([later, laterAction], laterIndex) =>
          laterIndex > denyIndex &&
          laterAction === 'allow' &&
          patternIsCoveredBy(denyPattern, later)
      );
      if (overridden) continue;
      refusals.push([denyPattern, 'deny']);
    }
    if (action !== 'ask') {
      composed.push(...refusals);
      continue;
    }
    // The session's own refusal on the ask's key states the whole pattern, and
    // the session refines it with the allows carried below, so that refusal
    // stays before them. A refusal on another key names commands the profile
    // never asked about, so it keeps the last word over the ask.
    composed.push(...refusals.filter(([refusalPattern]) => refusalPattern === pattern));
    for (const [allowPattern, allowAction] of entries) {
      if (allowAction !== 'allow' || allowPattern === pattern) continue;
      // The profile decides that pattern itself, so a carried ask must not
      // overwrite it and the profile's own order keeps deciding.
      if (agent[allowPattern] !== undefined) continue;
      if (!patternIsCoveredBy(allowPattern, pattern)) continue;
      composed.push([allowPattern, 'ask']);
    }
    composed.push(...refusals.filter(([refusalPattern]) => refusalPattern !== pattern));
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
    const sessionRules = permissionRulesOf(sessionValue);
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
