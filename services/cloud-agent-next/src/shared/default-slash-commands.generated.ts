export type SlashCommandInfo = {
  name: string;
  description?: string;
  agent?: string;
  model?: string;
  source?: 'command' | 'mcp' | 'skill';
  hints: string[];
  subtask?: boolean;
};

/**
 * Source Kilo version / ref used to generate this catalog.
 *
 * Note: skills (source: 'skill') are intentionally omitted. The Kilo TUI
 * filters them from slash-command autocomplete, so they never appear in the
 * local `/` list even though they can be invoked by typing the name manually.
 *
 * Regenerate with `pnpm --filter cloud-agent-next update-default-slash-commands`.
 */
export const DEFAULT_SLASH_COMMANDS_SOURCE = 'kilo@7.2.49';

/**
 * Default slash command catalog used when no live wrapper-reported catalog is
 * available. Sorted deterministically by name. Keep in sync with Kilo releases.
 */
export const DEFAULT_SLASH_COMMANDS = [
  {
    name: 'init',
    description: 'guided AGENTS.md setup',
    source: 'command',
    hints: ['$ARGUMENTS'],
  },
  {
    name: 'local-review',
    description: 'local review (current branch)',
    hints: [],
  },
  {
    name: 'local-review-uncommitted',
    description: 'local review (uncommitted changes)',
    hints: [],
  },
  {
    name: 'review',
    description: 'review changes [commit|branch|pr], defaults to uncommitted',
    source: 'command',
    subtask: true,
    hints: ['$ARGUMENTS'],
  },
] satisfies SlashCommandInfo[];
