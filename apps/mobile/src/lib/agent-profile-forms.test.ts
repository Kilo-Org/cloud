import { describe, expect, it } from 'vitest';

import {
  addCommand,
  cleanVariableKey,
  isValidVariableKey,
  MAX_SETUP_COMMANDS,
  moveCommand,
  parseSkillFrontmatter,
  removeCommand,
  replaceCommand,
  validateProfileDescription,
  validateProfileName,
  validateSkillInput,
} from '@/lib/agent-profile-forms';

describe('validateProfileName', () => {
  it('accepts a trimmed name within the 1..100 bound', () => {
    expect(validateProfileName('Backend debugging')).toBeNull();
    expect(validateProfileName('  padded  ')).toBeNull();
  });

  it('reports an empty name after trimming', () => {
    expect(validateProfileName('')).toBe('empty');
    expect(validateProfileName('   ')).toBe('empty');
  });

  it('reports a name longer than 100 characters', () => {
    expect(validateProfileName('a'.repeat(100))).toBeNull();
    expect(validateProfileName('a'.repeat(101))).toBe('too-long');
  });
});

describe('validateProfileDescription', () => {
  it('accepts a trimmed description within the 500 bound', () => {
    expect(validateProfileDescription('Reviews a diff')).toBeNull();
    expect(validateProfileDescription('  padded  ')).toBeNull();
    expect(validateProfileDescription('')).toBeNull();
    expect(validateProfileDescription('a'.repeat(500))).toBeNull();
  });

  it('reports a description longer than 500 characters', () => {
    expect(validateProfileDescription('a'.repeat(501))).toBe('too-long');
  });

  it('measures the trimmed length, not the raw length', () => {
    expect(validateProfileDescription(`  ${'a'.repeat(500)}  `)).toBeNull();
    expect(validateProfileDescription(`  ${'a'.repeat(501)}  `)).toBe('too-long');
  });
});

describe('parseSkillFrontmatter', () => {
  it('parses unquoted name and description', () => {
    const markdown = ['---', 'name: code-review', 'description: Reviews a diff', '---', ''].join(
      '\n'
    );
    expect(parseSkillFrontmatter(markdown)).toEqual({
      name: 'code-review',
      description: 'Reviews a diff',
    });
  });

  it('strips matching double and single quotes', () => {
    expect(
      parseSkillFrontmatter(
        ['---', 'name: "code-review"', "description: 'Reviews a diff'", '---', ''].join('\n')
      )
    ).toEqual({ name: 'code-review', description: 'Reviews a diff' });
  });

  it('handles CRLF line endings', () => {
    const markdown = '---\r\nname: crlf-skill\r\ndescription: Windows file\r\n---\r\nbody';
    expect(parseSkillFrontmatter(markdown)).toEqual({
      name: 'crlf-skill',
      description: 'Windows file',
    });
  });

  it('returns nothing without a leading frontmatter block', () => {
    expect(parseSkillFrontmatter('# Just markdown')).toEqual({});
    expect(parseSkillFrontmatter('')).toEqual({});
  });

  it('ignores unrelated frontmatter fields and missing fields', () => {
    expect(parseSkillFrontmatter(['---', 'name: only-name', '---', ''].join('\n'))).toEqual({
      name: 'only-name',
      description: undefined,
    });
    expect(parseSkillFrontmatter(['---', 'license: MIT', '---', ''].join('\n'))).toEqual({
      name: undefined,
      description: undefined,
    });
  });
});

describe('validateSkillInput', () => {
  const content = ['---', 'name: my-skill', 'description: Does a thing', '---', 'Body'].join('\n');

  it('accepts a valid name and content', () => {
    expect(validateSkillInput({ name: 'my-skill', content })).toEqual({
      error: null,
      description: 'Does a thing',
    });
  });

  it('accepts valid input without frontmatter and returns no description', () => {
    expect(validateSkillInput({ name: 'my-skill', content: 'Body only' })).toEqual({ error: null });
  });

  it('reports an empty name even with content present', () => {
    expect(validateSkillInput({ name: '   ', content })).toEqual({ error: 'empty' });
  });

  it('reports a name the server pattern rejects', () => {
    expect(validateSkillInput({ name: 'My Skill', content })).toEqual({ error: 'bad-name' });
    expect(validateSkillInput({ name: '-leading-dash', content })).toEqual({ error: 'bad-name' });
    expect(validateSkillInput({ name: 'Upper', content })).toEqual({ error: 'bad-name' });
  });

  it('reports empty content', () => {
    expect(validateSkillInput({ name: 'my-skill', content: '   ' })).toEqual({
      error: 'no-content',
    });
  });
});

describe('variable keys', () => {
  it('cleans a typed key into the stored shape', () => {
    expect(cleanVariableKey('api key')).toBe('API_KEY');
    expect(cleanVariableKey('api-key.v2')).toBe('API_KEY_V2');
    expect(cleanVariableKey('ALREADY_OK')).toBe('ALREADY_OK');
  });

  it('validates the 1..256 non-empty bound', () => {
    expect(isValidVariableKey('API_KEY')).toBe(true);
    expect(isValidVariableKey('a'.repeat(256))).toBe(true);
    expect(isValidVariableKey('a'.repeat(257))).toBe(false);
    expect(isValidVariableKey('   ')).toBe(false);
  });
});

describe('setup command list operations', () => {
  const commands = ['pnpm install', 'pnpm build', 'pnpm test'];

  it('appends a blank command', () => {
    expect(addCommand(commands)).toEqual(['pnpm install', 'pnpm build', 'pnpm test', '']);
    expect(addCommand([])).toEqual(['']);
  });

  it('refuses a command beyond the server list cap', () => {
    const atCap = Array.from({ length: MAX_SETUP_COMMANDS }, (_, index) => `cmd ${index}`);
    expect(addCommand(atCap)).toEqual(atCap);
  });

  it('replaces the command at an index', () => {
    expect(replaceCommand(commands, 1, 'pnpm lint')).toEqual([
      'pnpm install',
      'pnpm lint',
      'pnpm test',
    ]);
    expect(replaceCommand(commands, 7, 'ignored')).toEqual(commands);
  });

  it('removes the command at an index without touching the source list', () => {
    expect(removeCommand(commands, 0)).toEqual(['pnpm build', 'pnpm test']);
    expect(removeCommand(commands, 7)).toEqual(commands);
    expect(commands).toEqual(['pnpm install', 'pnpm build', 'pnpm test']);
  });

  it('moves a command up and down', () => {
    expect(moveCommand(commands, 2, -1)).toEqual(['pnpm install', 'pnpm test', 'pnpm build']);
    expect(moveCommand(commands, 0, 1)).toEqual(['pnpm build', 'pnpm install', 'pnpm test']);
  });

  it('clamps a move at both edges and returns new arrays', () => {
    expect(moveCommand(commands, 0, -1)).toEqual(commands);
    expect(moveCommand(commands, 2, 1)).toEqual(commands);
    expect(moveCommand(commands, 5, -1)).toEqual(commands);
    expect(moveCommand(commands, 0, -1)).not.toBe(commands);
    expect(commands).toEqual(['pnpm install', 'pnpm build', 'pnpm test']);
  });
});
