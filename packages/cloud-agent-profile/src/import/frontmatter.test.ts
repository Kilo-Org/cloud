import { describe, expect, test } from 'vitest';
import { parseFrontmatter } from './frontmatter';
import { matchesGlob } from './glob';

describe('parseFrontmatter', () => {
  test('preserves prototype-like keys as data and detects duplicates', () => {
    const parsed = parseFrontmatter(
      '---\n__proto__:\n  hidden: true\nconstructor: value\n---\nBody'
    );
    expect(parsed.status).toBe('ok');
    if (parsed.status !== 'ok') throw new Error('Expected parsed frontmatter');
    expect(Object.getPrototypeOf(parsed.data)).toBe(null);
    expect(Object.keys(parsed.data)).toEqual(['__proto__', 'constructor']);
    expect(parsed.data.__proto__).toEqual({ hidden: true });
    expect(parsed.data.constructor).toBe('value');
    expect(parseFrontmatter('---\n__proto__: first\n__proto__: second\n---\nBody')).toMatchObject({
      status: 'error',
      message: 'Duplicate key "__proto__" in frontmatter',
    });
  });

  test('returns none when the document does not start with a delimiter', () => {
    expect(parseFrontmatter('# Heading\nBody')).toEqual({ status: 'none' });
  });

  test('parses scalar keys and preserves the body', () => {
    const result = parseFrontmatter(
      [
        '---',
        'description: Reviews code',
        'mode: subagent',
        'hidden: true',
        'disable: false',
        'temperature: 0.3',
        'steps: 4',
        'model: null',
        'quoted: "with: colon"',
        "single: 'quoted'",
        '---',
        'Prompt body',
        '',
      ].join('\n')
    );
    expect(result).toEqual({
      status: 'ok',
      data: {
        description: 'Reviews code',
        mode: 'subagent',
        hidden: true,
        disable: false,
        temperature: 0.3,
        steps: 4,
        model: null,
        quoted: 'with: colon',
        single: 'quoted',
      },
      body: 'Prompt body\n',
    });
  });

  test('parses nested maps such as permission', () => {
    const result = parseFrontmatter(
      [
        '---',
        'description: Reviews code',
        'permission:',
        '  edit: deny',
        '  bash:',
        '    "git *": allow',
        '    "*": ask',
        '---',
        'Body',
      ].join('\n')
    );
    expect(result).toEqual({
      status: 'ok',
      data: {
        description: 'Reviews code',
        permission: { edit: 'deny', bash: { 'git *': 'allow', '*': 'ask' } },
      },
      body: 'Body',
    });
  });

  test('accepts +++ delimiters, CRLF, and skips comments', () => {
    const result = parseFrontmatter('+++\r\n# comment\r\ndescription: Ready\r\n+++\r\nBody');
    expect(result).toEqual({ status: 'ok', data: { description: 'Ready' }, body: 'Body' });
  });

  test('parses an empty frontmatter block', () => {
    expect(parseFrontmatter('---\n---\nBody')).toEqual({ status: 'ok', data: {}, body: 'Body' });
  });

  test('rejects unterminated frontmatter', () => {
    expect(parseFrontmatter('---\ndescription: Ready')).toEqual({
      status: 'error',
      message: 'Frontmatter is not terminated',
    });
  });

  test('rejects list values and inconsistent indentation', () => {
    expect(parseFrontmatter('---\ntools:\n  - read\n---\nBody').status).toBe('error');
    expect(parseFrontmatter('---\n  description: Ready\n---\nBody').status).toBe('error');
  });

  test('decodes single-quoted keys and values without altering them', () => {
    const result = parseFrontmatter(
      ['---', 'permission:', "  'git *': deny", "quoted: 'plain'", '---', 'Body'].join('\n')
    );
    expect(result).toEqual({
      status: 'ok',
      data: { permission: { 'git *': 'deny' }, quoted: 'plain' },
      body: 'Body',
    });
  });

  test('removes inline comments from unquoted scalars', () => {
    const result = parseFrontmatter(
      ['---', 'description: Reviews code # trailing note', 'steps: 4 # four', '---', 'Body'].join(
        '\n'
      )
    );
    expect(result).toEqual({
      status: 'ok',
      data: { description: 'Reviews code', steps: 4 },
      body: 'Body',
    });
  });

  test('keeps a hash inside a quoted scalar', () => {
    const result = parseFrontmatter(['---', 'description: "a # b"', '---', 'Body'].join('\n'));
    expect(result).toEqual({ status: 'ok', data: { description: 'a # b' }, body: 'Body' });
  });

  test('rejects escaped strings instead of decoding them incorrectly', () => {
    expect(parseFrontmatter('---\ndescription: "a\\"b"\n---\nBody').status).toBe('error');
    expect(parseFrontmatter("---\ndescription: 'it''s'\n---\nBody").status).toBe('error');
  });

  test('rejects inline collections instead of treating them as strings', () => {
    expect(parseFrontmatter('---\noptions: { custom: value }\n---\nBody').status).toBe('error');
    expect(parseFrontmatter('---\ntools: [read, write]\n---\nBody').status).toBe('error');
  });

  test('rejects YAML anchors, aliases, and tags instead of importing their literal text', () => {
    const anchored = parseFrontmatter('---\nmodel: &default sonnet\n---\nBody');
    expect(anchored.status).toBe('error');
    expect(anchored.status === 'error' && anchored.message).toContain('anchor');

    const aliased = parseFrontmatter('---\nmodel: *default\n---\nBody');
    expect(aliased.status).toBe('error');

    const tagged = parseFrontmatter('---\nmodel: !!str sonnet\n---\nBody');
    expect(tagged.status).toBe('error');

    const aliasedKey = parseFrontmatter('---\npermission:\n  *: deny\n---\nBody');
    expect(aliasedKey.status).toBe('error');
  });

  test('keeps node indicator characters inside quoted strings and unquoted values', () => {
    const quoted = parseFrontmatter('---\ndescription: "uses * and & and !"\n---\nBody');
    expect(quoted).toEqual({
      status: 'ok',
      data: { description: 'uses * and & and !' },
      body: 'Body',
    });
    const unquoted = parseFrontmatter('---\ndescription: glob git *\n---\nBody');
    expect(unquoted).toEqual({ status: 'ok', data: { description: 'glob git *' }, body: 'Body' });
  });

  test('rejects duplicate frontmatter keys', () => {
    const result = parseFrontmatter(
      ['---', 'description: A', 'description: B', '---', 'Body'].join('\n')
    );
    expect(result).toEqual({
      status: 'error',
      message: 'Duplicate key "description" in frontmatter',
    });
  });
});

describe('matchesGlob', () => {
  test('matches ** across directories and * within a segment', () => {
    expect(matchesGlob('**/*.md', 'AGENTS.md')).toBe(true);
    expect(matchesGlob('**/*.md', 'docs/style.md')).toBe(true);
    expect(matchesGlob('**/*.md', 'docs/style.txt')).toBe(false);
    expect(matchesGlob('instructions/*.md', 'instructions/style.md')).toBe(true);
    expect(matchesGlob('instructions/*.md', 'instructions/sub/style.md')).toBe(false);
    expect(matchesGlob('agent/**', 'agent/team/a.md')).toBe(true);
  });

  test('escapes regex metacharacters and supports ?', () => {
    expect(matchesGlob('.cursor/rules/*.md', '.cursor/rules/style.md')).toBe(true);
    expect(matchesGlob('.cursor/rules/*.md', 'xcursor/rules/style.md')).toBe(false);
    expect(matchesGlob('rules/a?c.md', 'rules/abc.md')).toBe(true);
    expect(matchesGlob('rules/a?c.md', 'rules/ac.md')).toBe(false);
  });
});
