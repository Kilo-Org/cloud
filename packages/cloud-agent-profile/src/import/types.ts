import type { AgentCreateInput } from '../contracts/agents';
import type { KiloCommandCreateInput } from '../contracts/kilo-commands';
import type { SkillCustomInput } from '../contracts/skills';

export type ImportCategory = 'agents' | 'commands' | 'skills' | 'instructions';

/** Mapped cloud input shape for one agent. */
export type ImportedAgent = AgentCreateInput;

/** Mapped cloud input shape for one slash command. */
export type ImportedKiloCommand = KiloCommandCreateInput;

/** Mapped cloud input shape for one skill bundle. */
export type ImportedSkill = Pick<
  SkillCustomInput,
  'name' | 'description' | 'rawMarkdown' | 'files'
>;

/** Mapped cloud input shape for one instruction file (materialized as `.kilocode/rules/<name>.md`). */
export type ImportedInstruction = {
  name: string;
  content: string;
};

export type ImportIssueSeverity = 'error' | 'warning';

export type ImportIssueCode =
  | 'invalid-archive'
  | 'archive-too-large'
  | 'archive-entry-count-exceeded'
  | 'archive-expansion-limit-exceeded'
  | 'duplicate-entry'
  | 'invalid-entry-path'
  | 'unreadable-entry'
  | 'entry-too-large'
  | 'unmapped-entry'
  | 'duplicate-definition'
  | 'invalid-config-json'
  | 'invalid-config-section'
  | 'duplicate-config-file'
  | 'instruction-glob-limit'
  | 'instruction-globs-exceeded'
  | 'invalid-frontmatter'
  | 'empty-import'
  | 'missing-skill-manifest'
  | 'agent-slug-invalid'
  | 'agent-name-invalid'
  | 'agent-config-invalid'
  | 'command-name-invalid'
  | 'command-template-invalid'
  | 'command-field-invalid'
  | 'skill-name-invalid'
  | 'skill-markdown-invalid'
  | 'skill-files-invalid'
  | 'instruction-invalid';

export type ImportIssue = {
  severity: ImportIssueSeverity;
  code: ImportIssueCode;
  category: ImportCategory | 'archive' | 'config';
  /** Archive-relative source path, or a `<config>#<section>.<name>` pointer. */
  path: string | null;
  /** Dotted field path inside the mapped item, when the issue is field-scoped. */
  field: string | null;
  message: string;
};

export type ImportItem =
  | { category: 'agents'; agent: ImportedAgent }
  | { category: 'commands'; command: ImportedKiloCommand }
  | { category: 'skills'; skill: ImportedSkill }
  | { category: 'instructions'; instruction: ImportedInstruction };

export type ParsedLocalConfig = {
  agents: ImportedAgent[];
  commands: ImportedKiloCommand[];
  skills: ImportedSkill[];
  instructions: ImportedInstruction[];
};

/**
 * Result of decoding and mapping one uploaded config archive. `config` holds
 * only importable definitions; local-only settings are ignored without an
 * issue. Each issue explains why an in-scope definition is not in `config`,
 * so `hasErrors` does not block importing the definitions that are.
 */
export type ImportPreview = {
  config: ParsedLocalConfig;
  issues: ImportIssue[];
  hasErrors: boolean;
};

export function collectImportItems(config: ParsedLocalConfig): ImportItem[] {
  return [
    ...config.agents.map(agent => ({ category: 'agents' as const, agent })),
    ...config.commands.map(command => ({ category: 'commands' as const, command })),
    ...config.skills.map(skill => ({ category: 'skills' as const, skill })),
    ...config.instructions.map(instruction => ({ category: 'instructions' as const, instruction })),
  ];
}
