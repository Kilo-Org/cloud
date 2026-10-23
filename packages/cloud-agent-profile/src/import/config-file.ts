import { parse as parseJsonc, parseTree, type Node, type ParseError } from 'jsonc-parser';
import type { ArchiveEntry } from './archive';
import {
  MAX_IMPORT_INSTRUCTION_GLOB_LENGTH,
  MAX_IMPORT_INSTRUCTION_GLOB_WILDCARDS,
  MAX_IMPORT_INSTRUCTION_GLOBS,
} from './limits';
import { makeIssue, type ParseState } from './parse-state';

export type ConfigSections = {
  agentEntries: Array<{ name: string; value: Record<string, unknown> }>;
  commandEntries: Array<{ name: string; value: Record<string, unknown> }>;
  instructionGlobs: string[];
};

export const CONFIG_FILE_NAMES = new Set(['kilo.json', 'kilo.jsonc']);

const AGENT_SECTION_KEYS = ['agent', 'agents'] as const;
const COMMAND_SECTION_KEYS = ['command', 'commands'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type DuplicateProperty = { path: string; firstOffset: number; secondOffset: number };

/**
 * Walk the JSONC syntax tree to find properties that repeat within one object.
 * `parse` reduces repeated properties into an object where the last one wins,
 * which would discard earlier definitions before ambiguity can be reported.
 */
function collectDuplicateProperties(
  node: Node,
  path: string[],
  duplicates: DuplicateProperty[]
): void {
  if (node.type === 'object') {
    const seen = new Map<string, number>();
    for (const property of node.children ?? []) {
      const keyNode = property.children?.[0];
      const valueNode = property.children?.[1];
      if (!keyNode || typeof keyNode.value !== 'string') continue;
      const name = keyNode.value;
      const firstOffset = seen.get(name);
      if (firstOffset !== undefined) {
        duplicates.push({
          path: [...path, name].join('.'),
          firstOffset,
          secondOffset: keyNode.offset,
        });
      } else {
        seen.set(name, keyNode.offset);
      }
      if (valueNode) collectDuplicateProperties(valueNode, [...path, name], duplicates);
    }
    return;
  }
  if (node.type === 'array') {
    for (const [index, child] of (node.children ?? []).entries()) {
      collectDuplicateProperties(child, [...path, String(index)], duplicates);
    }
  }
}

function reportMalformedSection(
  state: ParseState,
  configEntry: ArchiveEntry,
  key: string,
  category: 'agents' | 'commands' | 'config',
  expected: string
): void {
  state.issues.push(
    makeIssue(
      'error',
      'invalid-config-section',
      category,
      configEntry.path,
      key,
      `Section "${key}" is present but ${expected}`
    )
  );
}

/** Longest glob echoed back in an issue message. */
const GLOB_ECHO_LENGTH = 64;

/** Count `*` and `**` tokens the way the matcher reads them: `**` counts once. */
function countStarTokens(glob: string): number {
  let count = 0;
  for (let index = 0; index < glob.length; index += 1) {
    if (glob[index] !== '*') continue;
    count += 1;
    if (glob[index + 1] === '*') index += 1;
  }
  return count;
}

/**
 * Keep one `instructions` glob when it is within the import bounds. A glob over
 * either bound is reported and ignored.
 */
function collectInstructionGlob(
  sections: ConfigSections,
  state: ParseState,
  configEntry: ArchiveEntry,
  glob: string,
  index: number | null
): void {
  if (
    glob.length <= MAX_IMPORT_INSTRUCTION_GLOB_LENGTH &&
    countStarTokens(glob) <= MAX_IMPORT_INSTRUCTION_GLOB_WILDCARDS
  ) {
    sections.instructionGlobs.push(glob);
    return;
  }

  const echo = glob.length > GLOB_ECHO_LENGTH ? `${glob.slice(0, GLOB_ECHO_LENGTH)}...` : glob;
  state.issues.push(
    makeIssue(
      'error',
      'instruction-glob-limit',
      'config',
      configEntry.path,
      index === null ? 'instructions' : `instructions.${index}`,
      `Instruction glob "${echo}" is over the import limit of ${MAX_IMPORT_INSTRUCTION_GLOB_LENGTH} characters or ${MAX_IMPORT_INSTRUCTION_GLOB_WILDCARDS} * tokens and is ignored`
    )
  );
}

/** Read the importable `kilo.json`/`kilo.jsonc` sections; local-only sections are ignored. */
export function readConfigSections(configEntry: ArchiveEntry, state: ParseState): ConfigSections {
  const sections: ConfigSections = {
    agentEntries: [],
    commandEntries: [],
    instructionGlobs: [],
  };

  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(configEntry.content, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    state.issues.push(
      makeIssue(
        'error',
        'invalid-config-json',
        'config',
        configEntry.path,
        null,
        `Could not parse ${configEntry.path}: ${errors[0].error} at offset ${errors[0].offset}`
      )
    );
    return sections;
  }
  if (!isPlainObject(parsed)) {
    state.issues.push(
      makeIssue(
        'error',
        'invalid-config-json',
        'config',
        configEntry.path,
        null,
        `${configEntry.path} is not a JSON object`
      )
    );
    return sections;
  }

  const duplicates: DuplicateProperty[] = [];
  const tree = parseTree(configEntry.content, undefined, { allowTrailingComma: true });
  if (tree) collectDuplicateProperties(tree, [], duplicates);
  if (duplicates.length > 0) {
    for (const duplicate of duplicates) {
      state.issues.push(
        makeIssue(
          'error',
          'duplicate-definition',
          'config',
          `${configEntry.path}#${duplicate.path}`,
          null,
          `Duplicate property "${duplicate.path}" at offsets ${duplicate.firstOffset} and ${duplicate.secondOffset} in ${configEntry.path}; import is ambiguous`
        )
      );
    }
    return sections;
  }

  for (const key of AGENT_SECTION_KEYS) {
    const value = parsed[key];
    if (value === undefined) continue;
    if (!isPlainObject(value)) {
      reportMalformedSection(state, configEntry, key, 'agents', 'an object of agent definitions');
      continue;
    }
    for (const [name, entryValue] of Object.entries(value)) {
      if (!isPlainObject(entryValue)) {
        state.issues.push(
          makeIssue(
            'error',
            'unmapped-entry',
            'agents',
            `${configEntry.path}#${key}.${name}`,
            null,
            `Agent entry "${name}" is not an object`
          )
        );
        continue;
      }
      sections.agentEntries.push({ name, value: entryValue });
    }
  }

  for (const key of COMMAND_SECTION_KEYS) {
    const value = parsed[key];
    if (value === undefined) continue;
    if (!isPlainObject(value)) {
      reportMalformedSection(
        state,
        configEntry,
        key,
        'commands',
        'an object of command definitions'
      );
      continue;
    }
    for (const [name, entryValue] of Object.entries(value)) {
      if (!isPlainObject(entryValue)) {
        state.issues.push(
          makeIssue(
            'error',
            'unmapped-entry',
            'commands',
            `${configEntry.path}#${key}.${name}`,
            null,
            `Command entry "${name}" is not an object`
          )
        );
        continue;
      }
      sections.commandEntries.push({ name, value: entryValue });
    }
  }

  const instructions = parsed.instructions;
  if (typeof instructions === 'string') {
    collectInstructionGlob(sections, state, configEntry, instructions, null);
  } else if (Array.isArray(instructions)) {
    const read = Math.min(instructions.length, MAX_IMPORT_INSTRUCTION_GLOBS);
    for (let index = 0; index < read; index += 1) {
      const glob: unknown = instructions[index];
      if (typeof glob === 'string') {
        collectInstructionGlob(sections, state, configEntry, glob, index);
      }
    }
    if (instructions.length > read) {
      state.issues.push(
        makeIssue(
          'error',
          'instruction-globs-exceeded',
          'config',
          configEntry.path,
          'instructions',
          `Only the first ${MAX_IMPORT_INSTRUCTION_GLOBS} instruction globs are read; the other ${instructions.length - read} are ignored`
        )
      );
    }
  } else if (instructions !== undefined) {
    reportMalformedSection(
      state,
      configEntry,
      'instructions',
      'config',
      'a string glob or an array of string globs'
    );
  }

  return sections;
}
