import { parseSkillFrontmatter } from '../contracts/skills';
import { decodeConfigArchive, ImportArchiveError, type ArchiveEntry } from './archive';
import { CONFIG_FILE_NAMES, readConfigSections, type ConfigSections } from './config-file';
import { parseFrontmatter } from './frontmatter';
import { matchesGlob } from './glob';
import { instructionNameForPath } from './instructions';
import {
  addAgent,
  addCommand,
  addInstruction,
  addSkill,
  claimPath,
  createParseState,
  makeIssue,
  pickFields,
  registerIdentity,
  type ParseState,
} from './parse-state';
import { RUNTIME_BUILTIN_AGENT_SLUGS } from './runtime-contract';
import type { ImportIssue, ImportPreview, ParsedLocalConfig } from './types';

const AGENT_DIRECTORY_NAMES = new Set(['agent', 'agents']);
const COMMAND_DIRECTORY_NAMES = new Set(['command', 'commands']);
const SKILLS_DIRECTORY_NAME = 'skills';
const INSTRUCTIONS_DIRECTORY_NAME = 'instructions';
const DEFINITION_DIRECTORY_NAMES = new Set([
  ...AGENT_DIRECTORY_NAMES,
  ...COMMAND_DIRECTORY_NAMES,
  SKILLS_DIRECTORY_NAME,
  INSTRUCTIONS_DIRECTORY_NAME,
]);

/**
 * Agents the Kilo CLI defines itself. A local entry for one of them tunes the
 * built-in (for example `disable: true` or a model override) instead of
 * defining a profile agent, so the import ignores it.
 */
const CLI_BUILTIN_AGENT_SLUGS = new Set([
  ...RUNTIME_BUILTIN_AGENT_SLUGS,
  'general',
  'explore',
  'compaction',
  'title',
  'summary',
]);

/** Global config globs name the config directory itself, which is the archive root. */
const GLOBAL_CONFIG_DIRECTORY_PREFIX = '~/.config/kilo/';

const MARKDOWN_AGENT_FIELDS = new Set([
  'description',
  'mode',
  'hidden',
  'model',
  'variant',
  'temperature',
  'top_p',
  'steps',
  'color',
  'permission',
  'disable',
  'options',
]);
const CONFIG_AGENT_FIELDS = new Set([...MARKDOWN_AGENT_FIELDS, 'prompt']);
/** Command markdown takes its template from the body, so frontmatter `template` is not a source. */
const MARKDOWN_COMMAND_FIELDS = new Set(['description', 'agent', 'model', 'subtask']);
const CONFIG_COMMAND_FIELDS = new Set([...MARKDOWN_COMMAND_FIELDS, 'template']);

const REMOTE_INSTRUCTION_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Map a `kilo.json` instruction glob onto archive-relative paths. */
function toArchiveGlob(glob: string): string {
  const normalized = glob.replaceAll('\\', '/');
  return normalized.startsWith(GLOBAL_CONFIG_DIRECTORY_PREFIX)
    ? normalized.slice(GLOBAL_CONFIG_DIRECTORY_PREFIX.length)
    : normalized;
}

function emptyConfig(): ParsedLocalConfig {
  return { agents: [], commands: [], skills: [], instructions: [] };
}

function parseAgentMarkdown(entry: ArchiveEntry, state: ParseState): void {
  const slug = entry.path.split('/')[1].slice(0, -3);
  if (CLI_BUILTIN_AGENT_SLUGS.has(slug)) return;
  if (!claimPath(state, entry.path, 'agents', slug)) return;

  const frontmatter = parseFrontmatter(entry.content);
  if (frontmatter.status === 'error') {
    registerIdentity(state, 'agents', slug, entry.path);
    state.issues.push(
      makeIssue(
        'error',
        'invalid-frontmatter',
        'agents',
        entry.path,
        null,
        `Agent frontmatter is invalid: ${frontmatter.message}`
      )
    );
    return;
  }
  const fields = frontmatter.status === 'ok' ? frontmatter.data : {};
  const body = (frontmatter.status === 'ok' ? frontmatter.body : entry.content).trim();
  const config = pickFields(fields, MARKDOWN_AGENT_FIELDS);
  if (body.length > 0) config.prompt = body;
  addAgent(state, slug, slug, config, entry.path);
}

function parseCommandMarkdown(entry: ArchiveEntry, state: ParseState): void {
  const name = entry.path.split('/')[1].slice(0, -3);
  if (!claimPath(state, entry.path, 'commands', name)) return;

  const frontmatter = parseFrontmatter(entry.content);
  if (frontmatter.status === 'error') {
    registerIdentity(state, 'commands', name, entry.path);
    state.issues.push(
      makeIssue(
        'error',
        'invalid-frontmatter',
        'commands',
        entry.path,
        null,
        `Command frontmatter is invalid: ${frontmatter.message}`
      )
    );
    return;
  }
  const fields = frontmatter.status === 'ok' ? frontmatter.data : {};
  const body = (frontmatter.status === 'ok' ? frontmatter.body : entry.content).trim();
  const command = pickFields(fields, MARKDOWN_COMMAND_FIELDS);
  command.template = body;
  addCommand(state, name, command, entry.path);
}

function parseDefinitionDirectories(
  entries: ArchiveEntry[],
  directoryNames: Set<string>,
  category: 'agents' | 'commands',
  state: ParseState
): void {
  for (const entry of entries) {
    const segments = entry.path.split('/');
    if (segments.length < 2) continue;
    if (!directoryNames.has(segments[0].toLowerCase())) continue;
    if (segments.length !== 2 || !entry.path.toLowerCase().endsWith('.md')) continue;
    if (category === 'agents') parseAgentMarkdown(entry, state);
    else parseCommandMarkdown(entry, state);
  }
}

function reportIncompleteSkill(state: ParseState, name: string, unreadable: ImportIssue): void {
  state.issues.push(
    makeIssue(
      'error',
      'skill-files-invalid',
      'skills',
      unreadable.path,
      'files',
      `Skill "${name}" is not imported because a file is missing: ${unreadable.message}`
    )
  );
}

function parseSkillDirectories(
  entries: ArchiveEntry[],
  incompleteSkills: Map<string, ImportIssue>,
  state: ParseState
): void {
  const skillDirectories = new Map<
    string,
    { manifest?: ArchiveEntry; companions: ArchiveEntry[]; ambiguous?: boolean }
  >();

  for (const entry of entries) {
    const segments = entry.path.split('/');
    if (segments.length < 2) continue;
    if (segments[0].toLowerCase() !== SKILLS_DIRECTORY_NAME) continue;
    if (segments.length < 3) continue;
    const directory = segments[1];
    const bundle = skillDirectories.get(directory) ?? { companions: [] };
    if (segments.length === 3 && segments[2].toLowerCase() === 'skill.md') {
      if (bundle.manifest) {
        bundle.ambiguous = true;
        state.issues.push(
          makeIssue(
            'error',
            'duplicate-definition',
            'skills',
            entry.path,
            null,
            `Skill "${directory}" has multiple manifests, ${bundle.manifest.path} and ${entry.path}; import is ambiguous`
          )
        );
      } else {
        bundle.manifest = entry;
      }
    } else {
      bundle.companions.push(entry);
    }
    skillDirectories.set(directory, bundle);
  }

  for (const [name, bundle] of skillDirectories) {
    if (bundle.ambiguous) continue;
    const unreadable = incompleteSkills.get(name);
    if (unreadable) {
      reportIncompleteSkill(state, name, unreadable);
      continue;
    }
    if (!bundle.manifest) {
      state.issues.push(
        makeIssue(
          'error',
          'missing-skill-manifest',
          'skills',
          `${SKILLS_DIRECTORY_NAME}/${name}`,
          null,
          `Skill "${name}" has no SKILL.md manifest`
        )
      );
      continue;
    }
    if (!claimPath(state, bundle.manifest.path, 'skills', name)) continue;

    const files: Record<string, string> = {};
    const companionPaths = new Set<string>();
    for (const companion of bundle.companions) {
      const relativePath = companion.path.split('/').slice(2).join('/');
      if (companionPaths.has(relativePath)) {
        bundle.ambiguous = true;
        state.issues.push(
          makeIssue(
            'error',
            'duplicate-definition',
            'skills',
            companion.path,
            null,
            `Skill "${name}" has multiple companion files for ${relativePath}; import is ambiguous`
          )
        );
      }
      companionPaths.add(relativePath);
      files[relativePath] = companion.content;
    }
    if (bundle.ambiguous) continue;

    const { description } = parseSkillFrontmatter(bundle.manifest.content);
    addSkill(
      state,
      name,
      description ?? undefined,
      bundle.manifest.content,
      files,
      bundle.manifest.path
    );
  }

  // Every file of the skill was unreadable, so the loop above never saw it.
  for (const [name, unreadable] of incompleteSkills) {
    if (!skillDirectories.has(name)) reportIncompleteSkill(state, name, unreadable);
  }
}

function parseInstructionDirectories(entries: ArchiveEntry[], state: ParseState): void {
  for (const entry of entries) {
    const segments = entry.path.split('/');
    if (segments.length < 2) continue;
    if (segments[0].toLowerCase() !== INSTRUCTIONS_DIRECTORY_NAME) continue;
    if (!entry.path.toLowerCase().endsWith('.md')) continue;
    const name = instructionNameForPath(entry.path);
    if (!claimPath(state, entry.path, 'instructions', name)) continue;
    addInstruction(state, name, entry.content, entry.path);
  }
}

function parseConfigEntries(sections: ConfigSections, configPath: string, state: ParseState): void {
  for (const { name, value } of sections.agentEntries) {
    if (CLI_BUILTIN_AGENT_SLUGS.has(name)) continue;
    const source = `${configPath}#agent.${name}`;
    addAgent(state, name, name, pickFields(value, CONFIG_AGENT_FIELDS), source);
  }

  for (const { name, value } of sections.commandEntries) {
    const source = `${configPath}#command.${name}`;
    addCommand(state, name, pickFields(value, CONFIG_COMMAND_FIELDS), source);
  }
}

function parseInstructionGlobs(globs: string[], entries: ArchiveEntry[], state: ParseState): void {
  for (const glob of globs) {
    for (const entry of entries) {
      if (!entry.path.toLowerCase().endsWith('.md') || !matchesGlob(glob, entry.path)) continue;
      const name = instructionNameForPath(entry.path);
      if (!claimPath(state, entry.path, 'instructions', name)) continue;
      addInstruction(state, name, entry.content, entry.path);
    }
  }
}

function isImportablePath(path: string, globs: string[]): boolean {
  const segments = path.split('/');
  if (segments.length === 1 && CONFIG_FILE_NAMES.has(path.toLowerCase())) return true;
  if (segments.length > 1 && DEFINITION_DIRECTORY_NAMES.has(segments[0].toLowerCase())) return true;
  return globs.some(glob => matchesGlob(glob, path));
}

/**
 * Keep unreadable-entry issues only for entries the import would read. A
 * skill with an unreadable member is returned so it is excluded as a whole:
 * importing it without that file would change the skill.
 */
function routeEntryIssues(
  issues: ImportIssue[],
  globs: string[],
  state: ParseState
): Map<string, ImportIssue> {
  const incompleteSkills = new Map<string, ImportIssue>();
  for (const issue of issues) {
    if (issue.path === null) {
      state.issues.push(issue);
      continue;
    }
    if (!isImportablePath(issue.path, globs)) continue;
    const segments = issue.path.split('/');
    if (segments.length >= 3 && segments[0].toLowerCase() === SKILLS_DIRECTORY_NAME) {
      if (!incompleteSkills.has(segments[1])) incompleteSkills.set(segments[1], issue);
      continue;
    }
    state.issues.push(issue);
  }
  return incompleteSkills;
}

export function parseLocalConfigArchive(zipBytes: Uint8Array): ImportPreview {
  let decoded;
  try {
    decoded = decodeConfigArchive(zipBytes);
  } catch (error) {
    const code = error instanceof ImportArchiveError ? error.code : 'invalid-archive';
    const message = error instanceof Error ? error.message : 'Failed to read the archive';
    return {
      config: emptyConfig(),
      issues: [makeIssue('error', code, 'archive', null, null, message)],
      hasErrors: true,
    };
  }

  const state = createParseState();

  const configFiles = decoded.entries.filter(
    entry => !entry.path.includes('/') && CONFIG_FILE_NAMES.has(entry.path.toLowerCase())
  );
  if (configFiles.length > 1) {
    state.issues.push(
      makeIssue(
        'error',
        'duplicate-config-file',
        'config',
        configFiles[1].path,
        null,
        `Archive contains both ${configFiles[0].path} and ${configFiles[1].path}; import is ambiguous`
      )
    );
  }

  const sections = configFiles.length === 1 ? readConfigSections(configFiles[0], state) : null;
  const instructionGlobs = (sections?.instructionGlobs ?? [])
    .filter(glob => !REMOTE_INSTRUCTION_PATTERN.test(glob))
    .map(toArchiveGlob);
  const incompleteSkills = routeEntryIssues(decoded.issues, instructionGlobs, state);

  parseDefinitionDirectories(decoded.entries, AGENT_DIRECTORY_NAMES, 'agents', state);
  parseDefinitionDirectories(decoded.entries, COMMAND_DIRECTORY_NAMES, 'commands', state);
  parseSkillDirectories(decoded.entries, incompleteSkills, state);
  parseInstructionDirectories(decoded.entries, state);

  if (sections) {
    parseConfigEntries(sections, configFiles[0].path, state);
    parseInstructionGlobs(instructionGlobs, decoded.entries, state);
  }

  const config: ParsedLocalConfig = {
    agents: [...state.agents.values()].map(entry => entry.item),
    commands: [...state.commands.values()].map(entry => entry.item),
    skills: [...state.skills.values()].map(entry => entry.item),
    instructions: [...state.instructions.values()].map(entry => entry.item),
  };

  const itemCount =
    config.agents.length +
    config.commands.length +
    config.skills.length +
    config.instructions.length;
  if (itemCount === 0 && configFiles.length === 0 && state.issues.length === 0) {
    state.issues.push(
      makeIssue(
        'warning',
        'empty-import',
        'archive',
        null,
        null,
        'Archive contains no kilo.json and no supported agent, command, skill, or instruction definitions'
      )
    );
  }

  return {
    config,
    issues: state.issues,
    hasErrors: state.issues.some(issue => issue.severity === 'error'),
  };
}
