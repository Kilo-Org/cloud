import { matchesGlob } from './match';

describe('matchesGlob', () => {
  it.each([
    ['ls', 'ls', true],
    ['ls -la', 'ls', false],
    ['xls', 'ls', false],
    ['git push origin', 'git push *', true],
    ['git push', 'git push *', true],
    ['git pushx', 'git push *', false],
    ['git status', 'git *', true],
    ['a\nb', 'a*b', true],
    ['a\nb', 'a?b', true],
    ['ab', 'a?b', false],
    ['C:\\Users\\x', 'C:/Users/*', true],
    ['C:/Users/x', 'C:\\Users\\*', true],
    ['a.b', 'a.b', true],
    ['axb', 'a.b', false],
    ['(x)+[y]^$|{}', '(x)+[y]^$|{}', true],
    ['echo hi > f', '*>*', true],
    ['echo hi', '*>*', false],
    ['', '*', true],
    ['', '', true],
    ['x', '', false],
    ['abc', '***', true],
    ['git push --force', 'git push * --force*', false],
    ['git push o --force-with-lease', 'git push * --force*', true],
    ['héllo', 'h?llo', true],
    ['😀x', '?x', false],
    ['😀x', '??x', true],
  ])('%j against %j is %s', (input, pattern, expected) => {
    expect(matchesGlob(input, pattern)).toBe(expected);
  });

  it('stays fast on adversarial inputs', () => {
    const input = 'a'.repeat(20_000);
    const pattern = `${'*a'.repeat(250)}b`;
    const started = performance.now();
    expect(matchesGlob(input, pattern)).toBe(false);
    expect(matchesGlob(`${input}b`, pattern)).toBe(true);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
