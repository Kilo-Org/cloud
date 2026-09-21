import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parseSlashInvocation, toSlashCommandInfo, commandsOrDefault } from './slash-commands.js';
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
