import { describe, expect, it } from 'vitest';

import { type MarkdownRun, splitMarkdownFences } from './markdown-fences';

function textRuns(runs: readonly MarkdownRun[]): string[] {
  return runs.flatMap(run => (run.type === 'text' ? [run.raw] : []));
}

describe('splitMarkdownFences', () => {
  it('leaves a run without fences as one text run', () => {
    const value = 'First paragraph\n\n- one\n- two\n';
    expect(splitMarkdownFences(value)).toEqual([{ type: 'text', raw: value }]);
  });

  it('takes a fence out of the text around it', () => {
    const value = 'Before\n\n```ts\nconst a = 1;\n```\n\nAfter';
    const runs = splitMarkdownFences(value);

    expect(runs).toHaveLength(3);
    expect(runs[0]).toEqual({ type: 'text', raw: 'Before\n\n' });
    expect(runs[1]).toEqual({ type: 'code', code: 'const a = 1;', language: 'ts', closed: true });
    expect(runs[2]).toEqual({ type: 'text', raw: '\nAfter' });
  });

  it('keeps every line of a multi-line fence and drops only the closing fence', () => {
    const runs = splitMarkdownFences('```ts\nconst a = 1;\n\nreturn a;\n```');

    expect(runs).toEqual([
      { type: 'code', code: 'const a = 1;\n\nreturn a;', language: 'ts', closed: true },
    ]);
  });

  it('reports an unclosed fence to the end of the run, with no text tail', () => {
    const runs = splitMarkdownFences('```ts\nconst a = 1;\nret');

    expect(runs).toEqual([
      { type: 'code', code: 'const a = 1;\nret', language: 'ts', closed: false },
    ]);
  });

  it('accepts tilde fences and closes only on the same character', () => {
    const runs = splitMarkdownFences('~~~js\nconst a = 1;\n```\n~~~');

    expect(runs).toEqual([
      { type: 'code', code: 'const a = 1;\n```', language: 'js', closed: true },
    ]);
  });

  it('needs a closing fence at least as long as the opening one', () => {
    const closed = splitMarkdownFences('````\nconst a = 1;\n```\n````');
    expect(closed).toEqual([
      { type: 'code', code: 'const a = 1;\n```', language: null, closed: true },
    ]);

    const stillOpen = splitMarkdownFences('````\n```');
    expect(stillOpen).toEqual([{ type: 'code', code: '```', language: null, closed: false }]);
  });

  it('uses only the first token of the info string as the language', () => {
    const runs = splitMarkdownFences('```ts title="a.ts"\nconst a = 1;\n```');

    expect(runs[0]).toMatchObject({ language: 'ts', closed: true });
  });

  it('reads the info string of an empty fence', () => {
    expect(splitMarkdownFences('```\n```')).toEqual([
      { type: 'code', code: '', language: null, closed: true },
    ]);
  });

  it('leaves an indented fence inside the text run', () => {
    for (const value of [
      'Text\n\n  ```ts\n  const a = 1;\n  ```\n',
      'Text\n\n    ```ts\n    const a = 1;\n    ```\n',
      '- item\n\n  ```ts\n  const a = 1;\n  ```\n',
    ]) {
      expect(splitMarkdownFences(value)).toEqual([{ type: 'text', raw: value }]);
    }
  });

  it('leaves a blockquote fence inside the text run', () => {
    const value = '> ```ts\n> const a = 1;\n> ```';
    expect(splitMarkdownFences(value)).toEqual([{ type: 'text', raw: value }]);
  });

  it('does not read an inline code span as a fence', () => {
    const value = 'Run ```npm test``` now';
    expect(splitMarkdownFences(value)).toEqual([{ type: 'text', raw: value }]);
  });

  it('splits two adjacent fences with no text between them', () => {
    const runs = splitMarkdownFences('```a\nx\n```\n```b\ny\n```');

    expect(runs).toEqual([
      { type: 'code', code: 'x', language: 'a', closed: true },
      { type: 'code', code: 'y', language: 'b', closed: true },
    ]);
  });

  it('keeps a mermaid fence available to the diagram renderer', () => {
    const runs = splitMarkdownFences('```mermaid\ngraph TD;\nA-->B;\n```');

    expect(runs).toEqual([
      { type: 'code', code: 'graph TD;\nA-->B;', language: 'mermaid', closed: true },
    ]);
  });

  it('leaves everything outside the fences to the markdown renderer', () => {
    const value = '# Title\n\n```ts\nx\n```\n\n| a | b |\n| - | - |\n\n```\ny\n```\nTail';
    expect(textRuns(splitMarkdownFences(value))).toEqual([
      '# Title\n\n',
      '\n| a | b |\n| - | - |\n\n',
      'Tail',
    ]);
  });
});
