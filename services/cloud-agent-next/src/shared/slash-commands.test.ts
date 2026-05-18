import { describe, expect, it } from 'vitest';
import { parseSlashInvocation, toSlashCommandInfo, commandsOrDefault } from './slash-commands.js';
import { DEFAULT_SLASH_COMMANDS } from './default-slash-commands.generated';

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
  it('returns the provided list when non-empty', () => {
    const live = [{ name: 'live', hints: [] }];
    expect(commandsOrDefault(live)).toBe(live);
  });

  it('returns defaults for undefined', () => {
    expect(commandsOrDefault(undefined)).toEqual(DEFAULT_SLASH_COMMANDS);
  });

  it('returns defaults for null', () => {
    expect(commandsOrDefault(null)).toEqual(DEFAULT_SLASH_COMMANDS);
  });

  it('returns defaults for empty array', () => {
    expect(commandsOrDefault([])).toEqual(DEFAULT_SLASH_COMMANDS);
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
