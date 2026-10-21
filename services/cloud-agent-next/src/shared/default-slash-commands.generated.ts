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
 * Note: this snapshot is generated with project config disabled, so it carries
 * the commands the CLI always has and no session skills. Skills are surfaced
 * from the live wrapper-reported catalog, which keeps every `source: 'skill'`
 * row the CLI reports for the session.
 *
 * Regenerate with `pnpm --filter cloud-agent-next update-default-slash-commands`.
 */
export const DEFAULT_SLASH_COMMANDS_SOURCE = 'kilo@7.8.1';

/**
 * Default slash command catalog used when no live wrapper-reported catalog is
 * available. Sorted deterministically by name. Keep in sync with Kilo releases.
 */
export const DEFAULT_SLASH_COMMANDS = [
  {
    name: 'goal',
    description: 'Keep working toward a session goal. /goal <objective> or pause, resume, clear',
    source: 'command',
    hints: ['$ARGUMENTS'],
  },
  {
    name: 'init',
    description: 'guided AGENTS.md setup',
    source: 'command',
    hints: ['$ARGUMENTS'],
  },
  {
    name: 'kilo-config',
    description:
      'Guide for Kilo configuration: config paths, kilo.json fields, commands, agents, skills, permissions, MCPs, providers, TUI settings, plus Agent Manager worktree setup/run scripts, workflows, and state. Use for Kilo config questions, locating loaded config, changing settings, or Agent Manager questions about run/setup scripts, worktree setup/workflows, apply/merge/PR/conflicts, missing sessions/worktrees, and agent-manager.json recovery.',
    source: 'skill',
    hints: ['$1', '$ARGUMENTS'],
  },
  {
    name: 'resume-claude',
    description: 'import a Claude Code session transcript',
    source: 'command',
    hints: [],
  },
  {
    name: 'resume-codex',
    description: 'import an OpenAI Codex session transcript',
    source: 'command',
    hints: [],
  },
  {
    name: 'review',
    description: 'review changes [uncommitted|staged|unpushed|branch|commit|pr]',
    hints: ['$ARGUMENTS'],
  },
] satisfies SlashCommandInfo[];
