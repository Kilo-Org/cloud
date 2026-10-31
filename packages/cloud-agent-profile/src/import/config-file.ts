import {
  createScanner,
  parse as parseJsonc,
  parseTree,
  type Node,
  type ParseError,
  type SyntaxKind,
} from 'jsonc-parser';
import type { ArchiveEntry } from './archive';
import {
  MAX_IMPORT_CONFIG_NESTING_DEPTH,
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
 * jsonc-parser declares its token kinds as an ambient `const` enum, whose
 * members a module compiled with `isolatedModules` cannot read, so the
 * structural kinds and end of input are taken from the scanner's own scan.
 */
function scanTokenKind(text: string): SyntaxKind {
  return createScanner(text, false).scan();
}

const TOKEN_OPEN_BRACE = scanTokenKind('{');
const TOKEN_CLOSE_BRACE = scanTokenKind('}');
const TOKEN_OPEN_BRACKET = scanTokenKind('[');
const TOKEN_CLOSE_BRACKET = scanTokenKind(']');
const TOKEN_EOF = scanTokenKind('');

/**
 * Whether the document nests objects or arrays deeper than `maxDepth`. The
 * JSONC parser recurses once per level, so this runs on the raw text before
 * either parse: the scanner is jsonc-parser's own lexer, so braces inside
 * strings, escapes and comments never count, and no document reaches the
 * parsers or the walk below with more levels than they can take. One token pass
 * costs about a third of a parse (measured 7 ms against 22 ms for a 650 KB
 * config), which the per-entry limit bounds.
 */
function exceedsNestingDepth(text: string, maxDepth: number): boolean {
  const scanner = createScanner(text, false);
  let depth = 0;
  for (let token = scanner.scan(); token !== TOKEN_EOF; token = scanner.scan()) {
    if (token === TOKEN_OPEN_BRACE || token === TOKEN_OPEN_BRACKET) {
      depth += 1;
      if (depth > maxDepth) return true;
    } else if (token === TOKEN_CLOSE_BRACE || token === TOKEN_CLOSE_BRACKET) {
      depth -= 1;
    }
  }
  return false;
}

/** The dotted path of one tree node: the ancestors' keys, then this node's. */
type WalkFrame = {
  node: Node;
  /** Dotted path of every ancestor, with a trailing dot; empty at the root. */
  prefix: string;
};

/**
 * Walk the JSONC syntax tree to find properties that repeat within one object.
 * `parse` reduces repeated properties into an object where the last one wins,
 * which would discard earlier definitions before ambiguity can be reported.
 *
 * The walk keeps its own stack because the tree comes from a client-supplied
 * document, and carries the ancestors' path as one string instead of copying an
 * array per node. Duplicates are reported in offset order, so the issue list
 * does not depend on the order the stack happens to visit subtrees in.
 */
function collectDuplicateProperties(node: Node, duplicates: DuplicateProperty[]): void {
  const stack: WalkFrame[] = [{ node, prefix: '' }];
  for (let frame = stack.pop(); frame; frame = stack.pop()) {
    const children = frame.node.children ?? [];
    if (frame.node.type === 'array') {
      for (let index = 0; index < children.length; index += 1) {
        stack.push({ node: children[index], prefix: `${frame.prefix}${index}.` });
      }
      continue;
    }
    if (frame.node.type !== 'object') continue;
    const seen = new Map<string, number>();
    for (let index = 0; index < children.length; index += 1) {
      const property = children[index];
      const keyNode = property.children?.[0];
      const valueNode = property.children?.[1];
      if (!keyNode || typeof keyNode.value !== 'string') continue;
      const name = keyNode.value;
      if (valueNode) stack.push({ node: valueNode, prefix: `${frame.prefix}${name}.` });
      const firstOffset = seen.get(name);
      if (firstOffset === undefined) {
        seen.set(name, keyNode.offset);
      } else {
        duplicates.push({
          path: `${frame.prefix}${name}`,
          firstOffset,
          secondOffset: keyNode.offset,
        });
      }
    }
  }
  duplicates.sort((first, second) => first.secondOffset - second.secondOffset);
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

  // Checked before either parse, because the JSONC parser itself recurses per
  // nesting level and would throw out of this function on a deep document.
  if (exceedsNestingDepth(configEntry.content, MAX_IMPORT_CONFIG_NESTING_DEPTH)) {
    state.issues.push(
      makeIssue(
        'error',
        'invalid-config-json',
        'config',
        configEntry.path,
        null,
        `${configEntry.path} nests objects or arrays more than ${MAX_IMPORT_CONFIG_NESTING_DEPTH} levels deep, the import limit; the config is not imported`
      )
    );
    return sections;
  }

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
  if (tree) collectDuplicateProperties(tree, duplicates);
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
