import { parse as parseJsonc, parseTree, type Node, type ParseError } from 'jsonc-parser';
import type { ArchiveEntry } from './archive';
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
  if (Array.isArray(instructions)) {
    for (const glob of instructions) {
      if (typeof glob === 'string') sections.instructionGlobs.push(glob);
    }
  } else if (typeof instructions === 'string') {
    sections.instructionGlobs.push(instructions);
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
