/* eslint-disable sort-keys -- expected diff shapes mirror the plan's `{ kind: 'hunks', hunks }` contract */
import { describe, expect, it } from 'vitest';
import { buildUnifiedScriptDiff, DIFF_CONTEXT_LINES, MAX_DIFF_LINES } from './workflow-script-diff';

describe('workflow script unified diff', () => {
  it('returns unchanged for identical scripts', () => {
    const script = 'const a = 1;\nconst b = 2;';
    expect(buildUnifiedScriptDiff(script, script)).toStrictEqual({ kind: 'unchanged' });
  });

  it('builds one hunk with a git-style header and three context lines for a one-line edit', () => {
    const oldScript = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n');
    const newScript = ['a', 'b', 'c', 'd', 'E', 'f', 'g', 'h', 'i', 'j'].join('\n');

    expect(buildUnifiedScriptDiff(oldScript, newScript)).toStrictEqual({
      kind: 'hunks',
      hunks: [
        {
          header: '@@ -2,7 +2,7 @@',
          lines: [
            { kind: 'context', text: 'b' },
            { kind: 'context', text: 'c' },
            { kind: 'context', text: 'd' },
            { kind: 'del', text: 'e' },
            { kind: 'add', text: 'E' },
            { kind: 'context', text: 'f' },
            { kind: 'context', text: 'g' },
            { kind: 'context', text: 'h' },
          ],
        },
      ],
    });
  });

  it('splits two distant edits into two hunks', () => {
    const oldScript = [
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
      'h',
      'i',
      'j',
      'k',
      'l',
      'm',
      'n',
      'o',
      'p',
      'q',
      'r',
      's',
      't',
    ].join('\n');
    const newScript = [
      'a',
      'b',
      'c',
      'd',
      'E',
      'f',
      'g',
      'h',
      'i',
      'j',
      'k',
      'l',
      'm',
      'n',
      'O',
      'p',
      'q',
      'r',
      's',
      't',
    ].join('\n');

    expect(buildUnifiedScriptDiff(oldScript, newScript)).toStrictEqual({
      kind: 'hunks',
      hunks: [
        {
          header: '@@ -2,7 +2,7 @@',
          lines: [
            { kind: 'context', text: 'b' },
            { kind: 'context', text: 'c' },
            { kind: 'context', text: 'd' },
            { kind: 'del', text: 'e' },
            { kind: 'add', text: 'E' },
            { kind: 'context', text: 'f' },
            { kind: 'context', text: 'g' },
            { kind: 'context', text: 'h' },
          ],
        },
        {
          header: '@@ -12,7 +12,7 @@',
          lines: [
            { kind: 'context', text: 'l' },
            { kind: 'context', text: 'm' },
            { kind: 'context', text: 'n' },
            { kind: 'del', text: 'o' },
            { kind: 'add', text: 'O' },
            { kind: 'context', text: 'p' },
            { kind: 'context', text: 'q' },
            { kind: 'context', text: 'r' },
          ],
        },
      ],
    });
  });

  it('merges two edits whose context runs touch into one hunk', () => {
    const oldScript = [
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
      'h',
      'i',
      'j',
      'k',
      'l',
      'm',
      'n',
      'o',
      'p',
      'q',
      'r',
      's',
      't',
    ].join('\n');
    const newScript = [
      'a',
      'b',
      'c',
      'd',
      'E',
      'f',
      'g',
      'h',
      'i',
      'j',
      'K',
      'l',
      'm',
      'n',
      'o',
      'p',
      'q',
      'r',
      's',
      't',
    ].join('\n');

    expect(buildUnifiedScriptDiff(oldScript, newScript)).toStrictEqual({
      kind: 'hunks',
      hunks: [
        {
          header: '@@ -2,13 +2,13 @@',
          lines: [
            { kind: 'context', text: 'b' },
            { kind: 'context', text: 'c' },
            { kind: 'context', text: 'd' },
            { kind: 'del', text: 'e' },
            { kind: 'add', text: 'E' },
            { kind: 'context', text: 'f' },
            { kind: 'context', text: 'g' },
            { kind: 'context', text: 'h' },
            { kind: 'context', text: 'i' },
            { kind: 'context', text: 'j' },
            { kind: 'del', text: 'k' },
            { kind: 'add', text: 'K' },
            { kind: 'context', text: 'l' },
            { kind: 'context', text: 'm' },
            { kind: 'context', text: 'n' },
          ],
        },
      ],
    });
  });

  it('builds a pure addition at the end of the script', () => {
    expect(buildUnifiedScriptDiff('a\nb\nc\nd', 'a\nb\nc\nd\ne')).toStrictEqual({
      kind: 'hunks',
      hunks: [
        {
          header: '@@ -2,3 +2,4 @@',
          lines: [
            { kind: 'context', text: 'b' },
            { kind: 'context', text: 'c' },
            { kind: 'context', text: 'd' },
            { kind: 'add', text: 'e' },
          ],
        },
      ],
    });
  });

  it('builds a pure deletion at the start of the script', () => {
    expect(buildUnifiedScriptDiff('x\na\nb\nc\nd', 'a\nb\nc\nd')).toStrictEqual({
      kind: 'hunks',
      hunks: [
        {
          header: '@@ -1,4 +1,3 @@',
          lines: [
            { kind: 'del', text: 'x' },
            { kind: 'context', text: 'a' },
            { kind: 'context', text: 'b' },
            { kind: 'context', text: 'c' },
          ],
        },
      ],
    });
  });

  it('prints -0,0 for a hunk whose old side is empty', () => {
    expect(buildUnifiedScriptDiff('', 'a\nb')).toStrictEqual({
      kind: 'hunks',
      hunks: [
        {
          header: '@@ -0,0 +1,2 @@',
          lines: [
            { kind: 'add', text: 'a' },
            { kind: 'add', text: 'b' },
          ],
        },
      ],
    });
  });

  it('returns tooLarge when a script exceeds the line ceiling', () => {
    const bigScript = Array.from(
      { length: MAX_DIFF_LINES + 1 },
      (_unused, index) => `line ${index}`
    ).join('\n');

    expect(buildUnifiedScriptDiff(bigScript, 'small')).toStrictEqual({ kind: 'tooLarge' });
    expect(buildUnifiedScriptDiff('small', bigScript)).toStrictEqual({ kind: 'tooLarge' });
  });

  it('still reports identical oversized scripts as unchanged', () => {
    const bigScript = Array.from(
      { length: MAX_DIFF_LINES + 1 },
      (_unused, index) => `line ${index}`
    ).join('\n');

    expect(buildUnifiedScriptDiff(bigScript, bigScript)).toStrictEqual({ kind: 'unchanged' });
  });

  it('reports a trailing-newline-only difference as exactly one changed line', () => {
    expect(buildUnifiedScriptDiff('const a = 1;', 'const a = 1;\n')).toStrictEqual({
      kind: 'hunks',
      hunks: [
        {
          header: '@@ -1,1 +1,2 @@',
          lines: [
            { kind: 'context', text: 'const a = 1;' },
            { kind: 'add', text: '' },
          ],
        },
      ],
    });

    expect(buildUnifiedScriptDiff('const a = 1;\n', 'const a = 1;')).toStrictEqual({
      kind: 'hunks',
      hunks: [
        {
          header: '@@ -1,2 +1,1 @@',
          lines: [
            { kind: 'context', text: 'const a = 1;' },
            { kind: 'del', text: '' },
          ],
        },
      ],
    });
  });

  it('pins the exported context and ceiling constants', () => {
    expect(DIFF_CONTEXT_LINES).toBe(3);
    expect(MAX_DIFF_LINES).toBe(1200);
  });
});
