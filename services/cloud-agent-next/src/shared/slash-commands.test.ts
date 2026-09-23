import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import {
  boundSlashCommandCatalog,
  parseSlashInvocation,
  toSlashCommandInfo,
  commandsOrDefault,
  SLASH_COMMAND_CATALOG_MAX_COMMANDS,
  SLASH_COMMAND_CATALOG_MAX_SERIALIZED_BYTES,
  type SlashCommandInfo,
} from './slash-commands.js';
import { DEFAULT_SLASH_COMMANDS } from './default-slash-commands.generated';

/**
 * The mobile composer (`apps/mobile/src/components/agents/chat-composer-slash-commands.ts`)
 * localizes a built-in row only when the description this catalog reports is
 * character-for-character equal to the app's English copy for that command:
 * the wire carries no "this is the built-in" marker, so the English source
 * string is the only signal that separates a built-in from a repository or MCP
 * command that reuses the name. Regenerating this catalog or editing the app
 * copy must therefore keep the two strings in step — this test fails when they
 * drift instead of letting the row silently fall back to English.
 */
const MOBILE_BUILT_IN_DESCRIPTION_KEYS = {
  compact: 'compactDescription',
  goal: 'goalDescription',
  init: 'initDescription',
  'resume-claude': 'resumeClaudeDescription',
  'resume-codex': 'resumeCodexDescription',
  review: 'reviewDescription',
} as const;

describe('parseSlashInvocation', () => {
  it('parses bare command', () => {
    expect(parseSlashInvocation('/review')).toEqual({ command: 'review', arguments: '' });
  });

  it('parses command with single arg', () => {
    expect(parseSlashInvocation('/review main')).toEqual({
      command: 'review',
      arguments: 'main',
    });
  });

  it('parses command with multi-word args, preserving inner whitespace', () => {
    expect(parseSlashInvocation('/review  main branch ')).toEqual({
      command: 'review',
      arguments: 'main branch',
    });
  });

  it('tolerates leading whitespace', () => {
    expect(parseSlashInvocation('   /review  arg')).toEqual({
      command: 'review',
      arguments: 'arg',
    });
  });

  it('returns null for non-slash text', () => {
    expect(parseSlashInvocation('hello world')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseSlashInvocation('')).toBeNull();
  });

  it('returns null for bare slash', () => {
    expect(parseSlashInvocation('/')).toBeNull();
  });

  it('accepts dotted and dashed names', () => {
    expect(parseSlashInvocation('/local-review-uncommitted')?.command).toBe(
      'local-review-uncommitted'
    );
    expect(parseSlashInvocation('/foo.bar')?.command).toBe('foo.bar');
  });
});

describe('toSlashCommandInfo', () => {
  it('strips template and validates required fields', () => {
    const result = toSlashCommandInfo({
      name: 'review',
      description: 'Review the diff',
      template: 'review this: $1',
      hints: ['$1'],
      source: 'command',
    });
    expect(result).toEqual({
      name: 'review',
      description: 'Review the diff',
      hints: ['$1'],
      source: 'command',
    });
    // Make sure template doesn't sneak through.
    expect(result && 'template' in result).toBe(false);
  });

  it('returns null when name is missing', () => {
    expect(toSlashCommandInfo({ template: 'x' })).toBeNull();
  });

  it('returns null for non-objects', () => {
    expect(toSlashCommandInfo(null)).toBeNull();
    expect(toSlashCommandInfo(undefined)).toBeNull();
    expect(toSlashCommandInfo('hi')).toBeNull();
  });

  it('drops invalid source values', () => {
    const result = toSlashCommandInfo({ name: 'foo', source: 'bogus' });
    expect(result?.source).toBeUndefined();
  });

  it('defaults hints to empty array when missing', () => {
    expect(toSlashCommandInfo({ name: 'foo' })?.hints).toEqual([]);
  });

  it('filters non-string hints', () => {
    expect(
      toSlashCommandInfo({ name: 'foo', hints: ['$1', 42, null, '$ARGUMENTS'] })?.hints
    ).toEqual(['$1', '$ARGUMENTS']);
  });
});

describe('commandsOrDefault', () => {
  it('returns live commands with session actions when non-empty', () => {
    const live = [{ name: 'live', hints: [] }];
    expect(commandsOrDefault(live)).toEqual([
      { name: 'live', hints: [] },
      { name: 'compact', description: 'compact the current session context', hints: [] },
    ]);
  });

  it('does not duplicate live session actions', () => {
    const live = [{ name: 'compact', description: 'live compact', hints: [] }];
    expect(commandsOrDefault(live)).toBe(live);
  });

  it('returns defaults for undefined', () => {
    expect(commandsOrDefault(undefined)).toEqual(
      expect.arrayContaining([
        ...DEFAULT_SLASH_COMMANDS,
        { name: 'compact', description: 'compact the current session context', hints: [] },
      ])
    );
  });

  it('returns defaults for null', () => {
    expect(commandsOrDefault(null)).toEqual(commandsOrDefault(undefined));
  });

  it('returns defaults for empty array', () => {
    expect(commandsOrDefault([])).toEqual(commandsOrDefault(undefined));
  });

  it('default commands are non-empty and validate', () => {
    expect(DEFAULT_SLASH_COMMANDS.length).toBeGreaterThan(0);
    for (const cmd of DEFAULT_SLASH_COMMANDS) {
      const validated = toSlashCommandInfo(cmd);
      expect(validated).not.toBeNull();
      expect(validated?.name).toBe(cmd.name);
    }
  });
});

describe('boundSlashCommandCatalog', () => {
  it('returns a catalog inside both bounds untouched', () => {
    const commands: SlashCommandInfo[] = [
      { name: 'review', hints: [] },
      {
        name: 'kilo-config',
        description: 'Guide for Kilo configuration',
        source: 'skill',
        hints: [],
      },
    ];
    expect(boundSlashCommandCatalog(commands)).toEqual({ commands, dropped: 0, overLimit: false });
  });

  it('drops non-skill rows first and never truncates a skill row', () => {
    const skills: SlashCommandInfo[] = Array.from({ length: 3 }, (_, index) => ({
      name: `skill-${index}`,
      source: 'skill',
      hints: [],
    }));
    const commands: SlashCommandInfo[] = [
      ...Array.from({ length: 260 }, (_, index) => ({ name: `cmd-${index}`, hints: [] })),
      ...skills,
    ];

    const result = boundSlashCommandCatalog(commands);

    expect(result.commands).toHaveLength(SLASH_COMMAND_CATALOG_MAX_COMMANDS);
    expect(result.commands.filter(command => command.source === 'skill')).toEqual(skills);
    expect(result.dropped).toBe(commands.length - SLASH_COMMAND_CATALOG_MAX_COMMANDS);
    expect(result.overLimit).toBe(false);
  });

  it('keeps every skill row even when the skill rows alone exceed the count bound', () => {
    const skills: SlashCommandInfo[] = Array.from({ length: 300 }, (_, index) => ({
      name: `skill-${index}`,
      source: 'skill',
      hints: [],
    }));

    const result = boundSlashCommandCatalog(skills);

    expect(result.commands).toEqual(skills);
    expect(result.dropped).toBe(0);
    // The returned catalog is over the count bound, so the caller must report
    // it rather than hide the skills.
    expect(result.overLimit).toBe(true);
  });

  it('keeps every skill row even when the skill rows alone exceed the byte bound', () => {
    const skills: SlashCommandInfo[] = Array.from({ length: 200 }, (_, index) => ({
      name: `skill-${index}`,
      description: 'x'.repeat(3_000),
      source: 'skill',
      hints: [],
    }));

    const result = boundSlashCommandCatalog(skills);

    // A skill row is never truncated: the catalog is reported as-is rather than
    // silently hiding a skill the session offers.
    expect(result.commands).toEqual(skills);
    expect(result.dropped).toBe(0);
    expect(result.overLimit).toBe(true);
  });

  it('trims non-skill rows until the serialized payload fits the byte bound, keeping skills', () => {
    const skill: SlashCommandInfo = { name: 'kilo-config', source: 'skill', hints: [] };
    const commands: SlashCommandInfo[] = [
      skill,
      ...Array.from({ length: 255 }, (_, index) => ({
        name: `cmd-${index}`,
        description: 'x'.repeat(3_000),
        hints: [],
      })),
    ];

    const result = boundSlashCommandCatalog(commands);

    expect(result.commands).toContain(skill);
    expect(result.dropped).toBeGreaterThan(0);
    expect(result.overLimit).toBe(false);
    expect(
      new TextEncoder().encode(JSON.stringify(result.commands)).byteLength
    ).toBeLessThanOrEqual(SLASH_COMMAND_CATALOG_MAX_SERIALIZED_BYTES);
  });
});

describe('mobile catalogue contract', () => {
  it('reports the built-in English descriptions the app catalogue matches on', () => {
    const en = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL('../../../../apps/mobile/src/i18n/locales/en.json', import.meta.url).href
        ),
        'utf8'
      )
    ) as { agentChat: { slashCommands: Record<string, string> } };
    const defaults = commandsOrDefault([]);
    const reported = new Map(defaults.map(command => [command.name, command.description]));
    for (const command of defaults) {
      expect(MOBILE_BUILT_IN_DESCRIPTION_KEYS).toHaveProperty(command.name);
    }
    for (const [name, key] of Object.entries(MOBILE_BUILT_IN_DESCRIPTION_KEYS)) {
      expect(reported.get(name)).toBe(en.agentChat.slashCommands[key]);
    }
  });
});
