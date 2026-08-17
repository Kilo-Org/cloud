import { describe, expect, it } from 'vitest';
import { highlightScriptLine } from './workflow-script-highlight';

describe('workflow script line highlighting', () => {
  it('marks keywords and numbers', () => {
    expect(highlightScriptLine('const x = 1;')).toStrictEqual([
      { text: 'const', token: 'keyword' },
      { text: ' x = ', token: 'plain' },
      { text: '1', token: 'number' },
      { text: ';', token: 'plain' },
    ]);
  });

  it('marks both string quote forms', () => {
    expect(highlightScriptLine(`page.fill('#a', "b")`)).toStrictEqual([
      { text: 'page.fill(', token: 'plain' },
      { text: "'#a'", token: 'string' },
      { text: ', ', token: 'plain' },
      { text: '"b"', token: 'string' },
      { text: ')', token: 'plain' },
    ]);
  });

  it('marks backtick strings', () => {
    expect(highlightScriptLine('const sel = `#row-1`;')).toStrictEqual([
      { text: 'const', token: 'keyword' },
      { text: ' sel = ', token: 'plain' },
      { text: '`#row-1`', token: 'string' },
      { text: ';', token: 'plain' },
    ]);
  });

  it('honours backslash escapes inside strings', () => {
    expect(highlightScriptLine(`const label = 'it\\'s';`)).toStrictEqual([
      { text: 'const', token: 'keyword' },
      { text: ' label = ', token: 'plain' },
      { text: "'it\\'s'", token: 'string' },
      { text: ';', token: 'plain' },
    ]);
  });

  it('marks line and block comments', () => {
    expect(highlightScriptLine('// note')).toStrictEqual([{ text: '// note', token: 'comment' }]);
    expect(highlightScriptLine('/* note */')).toStrictEqual([
      { text: '/* note */', token: 'comment' },
    ]);
    expect(highlightScriptLine('const a = 1; /* trailing */')).toStrictEqual([
      { text: 'const', token: 'keyword' },
      { text: ' a = ', token: 'plain' },
      { text: '1', token: 'number' },
      { text: '; ', token: 'plain' },
      { text: '/* trailing */', token: 'comment' },
    ]);
  });

  it('merges plain text into one span when no token separates it', () => {
    expect(highlightScriptLine('result')).toStrictEqual([{ text: 'result', token: 'plain' }]);
    expect(highlightScriptLine(`page.textAll('.row')`)).toStrictEqual([
      { text: 'page.textAll(', token: 'plain' },
      { text: "'.row'", token: 'string' },
      { text: ')', token: 'plain' },
    ]);
  });

  it('runs an unterminated quote to the end of the line without throwing', () => {
    expect(highlightScriptLine("const s = 'oops")).toStrictEqual([
      { text: 'const', token: 'keyword' },
      { text: ' s = ', token: 'plain' },
      { text: "'oops", token: 'string' },
    ]);
  });
});
