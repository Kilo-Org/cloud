/**
 * Agent ids the Kilo CLI owns, plus the cloud mode aliases that resolve to them.
 * A profile agent, runtime agent, or council specialist uses an id of its own,
 * so every id in this list stays reserved.
 *
 * The list mirrors the agent registrations in the pinned CLI core
 * (`packages/core/src/plugin/agent.ts`: `build` via `AgentV2.defaultID`, `plan`,
 * `general`, `explore`, `compaction`, `title`, `summary`) and the cloud mode
 * names that resolve to them (`code`, `debug`, `orchestrator`, `ask`,
 * `architect`, `custom`). Keep this list in lockstep when the CLI adds an id.
 */
export const RESERVED_AGENT_SLUGS = [
  'code',
  'plan',
  'debug',
  'orchestrator',
  'ask',
  'build',
  'architect',
  'custom',
  'general',
  'explore',
  'compaction',
  'title',
  'summary',
] as const;

export type ReservedAgentSlug = (typeof RESERVED_AGENT_SLUGS)[number];

const RESERVED_AGENT_SLUG_SET: ReadonlySet<string> = new Set(RESERVED_AGENT_SLUGS);

/** True when an agent id belongs to the CLI's own agents. */
export function isReservedAgentSlug(slug: string): boolean {
  return RESERVED_AGENT_SLUG_SET.has(slug);
}

/**
 * Lowercase words of an agent name or slug, joined by single spaces.
 *
 * A slug is limited to `[a-z][a-z0-9-]*`, so its separators are hyphens; a name
 * may carry any punctuation or spacing. Comparing only the words lets
 * `Code Reviewer` and `code-reviewer` count as the same text.
 */
function words(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * True when an agent's slug only repeats its display name, so a list row can
 * leave the slug out instead of printing the same words twice.
 *
 * The match ignores case, hyphens and spacing (`Reviewer` / `reviewer`,
 * `Code Reviewer` / `code-reviewer`). A name in a script the Latin-only slug
 * alphabet cannot express never matches, so its slug keeps showing.
 */
export function isRedundantAgentSlug(name: string, slug: string): boolean {
  const slugWords = words(slug);
  return slugWords.length > 0 && slugWords === words(name);
}
