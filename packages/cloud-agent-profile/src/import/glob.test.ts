import { describe, expect, test } from 'vitest';
import { compileGlob } from './glob';

/**
 * Reference matcher transcribed straight from the glob contract (`**` spans
 * separators, `*`/`?` stay inside a segment, anchored at both ends), used as an
 * oracle for the tiny inputs below.
 */
function referenceMatch(pattern: string, path: string): boolean {
  const glob = pattern.replaceAll('\\', '/').replace(/^\.\//, '');
  const walk = (globIndex: number, pathIndex: number): boolean => {
    if (globIndex === glob.length) return pathIndex === path.length;
    const char = glob[globIndex];
    if (char === '*' && glob[globIndex + 1] === '*') {
      if (glob[globIndex + 2] === '/') {
        // `(?:.*/)?`: empty, or any prefix ending in `/`.
        if (walk(globIndex + 3, pathIndex)) return true;
        for (let end = pathIndex + 1; end <= path.length; end += 1) {
          if (path[end - 1] === '/' && walk(globIndex + 3, end)) return true;
        }
        return false;
      }
      for (let end = pathIndex; end <= path.length; end += 1) {
        if (walk(globIndex + 2, end)) return true;
      }
      return false;
    }
    if (char === '*') {
      for (let end = pathIndex; end <= path.length; end += 1) {
        if (end > pathIndex && path[end - 1] === '/') break;
        if (walk(globIndex + 1, end)) return true;
      }
      return false;
    }
    if (char === '?') {
      return (
        pathIndex < path.length && path[pathIndex] !== '/' && walk(globIndex + 1, pathIndex + 1)
      );
    }
    return (
      pathIndex < path.length && path[pathIndex] === char && walk(globIndex + 1, pathIndex + 1)
    );
  };
  return walk(0, 0);
}

const REGEXP_SPECIAL: Record<string, true> = {
  '\\': true,
  '^': true,
  $: true,
  '.': true,
  '|': true,
  '+': true,
  '(': true,
  ')': true,
  '[': true,
  ']': true,
  '{': true,
  '}': true,
};

/** Regex translation of a glob, used as a second oracle. */
function legacyRegExp(pattern: string): RegExp {
  const glob = pattern.replaceAll('\\', '/').replace(/^\.\//, '');
  let source = '^';
  let index = 0;
  while (index < glob.length) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') {
      if (glob[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 3;
      } else {
        source += '.*';
        index += 2;
      }
      continue;
    }
    if (char === '*') {
      source += '[^/]*';
      index += 1;
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }
    source += REGEXP_SPECIAL[char] === true ? `\\${char}` : char;
    index += 1;
  }
  return new RegExp(`${source}$`);
}

const PATTERN_ALPHABET = ['a', '/', '*', '?'];
const PATH_ALPHABET = ['a', 'b', '/'];

function buildStrings(alphabet: string[], maxLength: number): string[] {
  let level = [''];
  const all = [''];
  for (let length = 1; length <= maxLength; length += 1) {
    const nextLevel: string[] = [];
    for (const prefix of level) {
      for (const char of alphabet) nextLevel.push(prefix + char);
    }
    level = nextLevel;
    all.push(...level);
  }
  return all;
}

describe('compileGlob', () => {
  test('matches ** across directories and * within a segment', () => {
    expect(compileGlob('**/*.md').matches('AGENTS.md')).toBe(true);
    expect(compileGlob('**/*.md').matches('docs/style.md')).toBe(true);
    expect(compileGlob('**/*.md').matches('docs/style.txt')).toBe(false);
    expect(compileGlob('instructions/*.md').matches('instructions/style.md')).toBe(true);
    expect(compileGlob('instructions/*.md').matches('instructions/sub/style.md')).toBe(false);
    expect(compileGlob('agent/**').matches('agent/team/a.md')).toBe(true);
  });

  test('escapes regex metacharacters and supports ?', () => {
    expect(compileGlob('.cursor/rules/*.md').matches('.cursor/rules/style.md')).toBe(true);
    expect(compileGlob('.cursor/rules/*.md').matches('xcursor/rules/style.md')).toBe(false);
    expect(compileGlob('rules/a?c.md').matches('rules/abc.md')).toBe(true);
    expect(compileGlob('rules/a?c.md').matches('rules/ac.md')).toBe(false);
  });

  test('collapses consecutive stars without changing the matched set', () => {
    expect(compileGlob('**/**/*.md').matches('AGENTS.md')).toBe(true);
    expect(compileGlob('**/**/*.md').matches('docs/deep/style.md')).toBe(true);
    expect(compileGlob('**/**/*.md').matches('docs/deep/style.txt')).toBe(false);
    expect(compileGlob('docs/**/a.md').matches('docs/a.md')).toBe(true);
    expect(compileGlob('docs/**/a.md').matches('docs/x/y/a.md')).toBe(true);
    expect(compileGlob('a/**b/c').matches('a/x/yb/c')).toBe(true);
    expect(compileGlob('a/**b/c').matches('a/yb/z')).toBe(false);
    // A directory wildcard only extends forward from a reachable position.
    expect(compileGlob('a/a**/a').matches('a/a')).toBe(false);
    expect(compileGlob('a/a**/a').matches('a/a/a')).toBe(true);
    expect(compileGlob('a**/a').matches('a/a')).toBe(true);
    expect(compileGlob('*').tokenCount).toBe(1);
  });

  test('matches the same set as the previous translation', () => {
    const paths = buildStrings(PATH_ALPHABET, 4);
    for (const pattern of buildStrings(PATTERN_ALPHABET, 4)) {
      const { matches } = compileGlob(pattern);
      const legacy = legacyRegExp(pattern);
      for (const path of paths) {
        const expected = referenceMatch(pattern, path);
        expect(legacy.test(path), `legacy ${JSON.stringify(pattern)} ${JSON.stringify(path)}`).toBe(
          expected
        );
        expect(matches(path), `${JSON.stringify(pattern)} ${JSON.stringify(path)}`).toBe(expected);
      }
    }
  });

  test('matches nested instruction globs across directories', () => {
    const deepPath = `${Array.from({ length: 60 }, (_, index) => `d${index}`).join('/')}/other.md`;
    const budgetMs = 500;
    for (const groups of [8, 12, 32, 128]) {
      const { matches } = compileGlob(`${'**/'.repeat(groups)}NEVER-EXIST.md`);
      expect(matches(deepPath)).toBe(false);
      const started = performance.now();
      expect(matches(deepPath)).toBe(false);
      expect(performance.now() - started).toBeLessThan(budgetMs);
    }
  });

  test('matches a path several levels deep', () => {
    const deepPath = Array.from({ length: 200 }, (_, index) => `d${index}`).join('/');
    const { matches } = compileGlob(`${'**/'.repeat(32)}${deepPath}.md`);
    expect(matches(`${deepPath}.md`)).toBe(true);
    const started = performance.now();
    expect(matches(`${deepPath}.md`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test('matches a long file name', () => {
    const { matches } = compileGlob(`${'*a'.repeat(16)}*x.md`);
    const path = `${'a'.repeat(4000)}x.md`;
    expect(matches(path)).toBe(true);
    const started = performance.now();
    for (let index = 0; index < 1000; index += 1) matches(path);
    // 1000 matches of a 4004-character path by a 17-token glob.
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
