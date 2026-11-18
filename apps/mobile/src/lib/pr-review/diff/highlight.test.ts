import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearHighlightCacheForTests,
  highlightCacheStatsForTests,
  highlightLine,
  type HighlightToken,
  languageForPath,
} from './highlight';

function classes(tokens: HighlightToken[]): (string | null)[] {
  return tokens.map(t => t.className);
}

function texts(tokens: HighlightToken[]): string[] {
  return tokens.map(t => t.text);
}

describe('languageForPath', () => {
  it('maps common file extensions to languages', () => {
    expect(languageForPath('src/index.ts')).toBe('typescript');
    expect(languageForPath('src/component.tsx')).toBe('typescript');
    expect(languageForPath('script.js')).toBe('javascript');
    expect(languageForPath('main.py')).toBe('python');
    expect(languageForPath('main.go')).toBe('go');
    expect(languageForPath('lib.rs')).toBe('rust');
    expect(languageForPath('app.rb')).toBe('ruby');
    expect(languageForPath('config.json')).toBe('json');
    expect(languageForPath('README.md')).toBe('markdown');
    expect(languageForPath('run.sh')).toBe('bash');
    expect(languageForPath('style.css')).toBe('css');
    expect(languageForPath('index.html')).toBe('xml');
    expect(languageForPath('ci.yml')).toBe('yaml');
    expect(languageForPath('Cargo.toml')).toBe('ini');
  });

  it('uses the last extension for compound names like foo.test.ts', () => {
    expect(languageForPath('src/foo.test.ts')).toBe('typescript');
    expect(languageForPath('src/component.test.tsx')).toBe('typescript');
  });

  it('is case-insensitive on the extension', () => {
    expect(languageForPath('Script.PY')).toBe('python');
    expect(languageForPath('App.TS')).toBe('typescript');
  });

  it('returns null for unknown extensions and dotfiles', () => {
    expect(languageForPath('README')).toBeNull();
    expect(languageForPath('.gitignore')).toBeNull();
    expect(languageForPath('foo.unknown')).toBeNull();
  });

  it('returns null for null / undefined input', () => {
    expect(languageForPath(null)).toBeNull();
    expect(languageForPath(undefined)).toBeNull();
  });

  it('handles a path with a dot in a directory segment', () => {
    expect(languageForPath('packages/foo.app/index.ts')).toBe('typescript');
  });
});

describe('highlightLine', () => {
  beforeEach(() => {
    clearHighlightCacheForTests();
  });

  it('returns a single plain-text token for an unknown language', () => {
    const tokens = highlightLine('hello world', null);
    expect(tokens).toEqual([{ text: 'hello world', className: null }]);
  });

  it('returns plain text for an empty line', () => {
    const tokens = highlightLine('', 'typescript');
    expect(texts(tokens).join('')).toBe('');
  });

  it('tags a TypeScript const declaration with the keyword + identifier classes', () => {
    const tokens = highlightLine('const x = 1;', 'typescript');
    // We don't pin the exact class split (highlight.js may emit
    // different sub-tokens across versions), but the keyword class
    // must be present.
    expect(classes(tokens)).toContain('keyword');
    // And the entire line text must be preserved (no token dropped).
    expect(texts(tokens).join('')).toBe('const x = 1;');
  });

  it('tags a string literal as string in TypeScript', () => {
    const tokens = highlightLine('const greeting = "hello";', 'typescript');
    expect(classes(tokens)).toContain('string');
    expect(texts(tokens).join('')).toBe('const greeting = "hello";');
  });

  it('tags a single-line comment as comment in TypeScript', () => {
    const tokens = highlightLine('// hello', 'typescript');
    expect(classes(tokens)).toContain('comment');
    expect(texts(tokens).join('')).toBe('// hello');
  });

  it('falls back to plain text when the highlighter throws', () => {
    // unknown language — lowlight throws and we recover.
    const tokens = highlightLine('hello world', 'not-a-real-language');
    expect(tokens).toEqual([{ text: 'hello world', className: null }]);
  });

  it('preserves the full line text across tokens (no characters dropped)', () => {
    const line = 'function add(a: number, b: number): number { return a + b; }';
    const tokens = highlightLine(line, 'typescript');
    expect(texts(tokens).join('')).toBe(line);
  });

  it('handles JSON keys + string values', () => {
    const tokens = highlightLine('"name": "kilo"', 'json');
    expect(classes(tokens)).toContain('string');
    expect(texts(tokens).join('')).toBe('"name": "kilo"');
  });

  it('still caches a normal line, and a repeated call is a hit', () => {
    highlightLine('const x = 1;', 'typescript');
    const afterFirstCall = highlightCacheStatsForTests();
    expect(afterFirstCall.entries).toBe(1);
    expect(afterFirstCall.characters).toBeGreaterThan(0);

    highlightLine('const x = 1;', 'typescript');
    // A hit re-inserts the entry for recency; it must not add its weight again.
    expect(highlightCacheStatsForTests()).toEqual(afterFirstCall);
  });

  it('highlights a line longer than the cache threshold without caching it', () => {
    const line = `const bundled = "${'a'.repeat(4096)}";`;
    const tokens = highlightLine(line, 'typescript');
    expect(texts(tokens).join('')).toBe(line);
    expect(highlightCacheStatsForTests()).toEqual({ entries: 0, characters: 0 });

    // Not cached means highlighted again, with the same result.
    expect(texts(highlightLine(line, 'typescript')).join('')).toBe(line);
    expect(highlightCacheStatsForTests()).toEqual({ entries: 0, characters: 0 });
  });

  it('keeps retained characters within the cache budget for many large lines', () => {
    const filler = 'x'.repeat(1880);
    for (let index = 0; index < 1000; index += 1) {
      highlightLine(`const v${index} = "${filler}";`, 'typescript');
    }
    const stats = highlightCacheStatsForTests();
    // 1,000 lines of ~1.9k characters weigh ~3.8M characters together, so the
    // budget evicts most of them.
    expect(stats.entries).toBeGreaterThan(0);
    expect(stats.entries).toBeLessThanOrEqual(1000);
    expect(stats.characters).toBeLessThanOrEqual(1_000_000);

    // The newest line — the one the current render just asked for — survives.
    const charactersBefore = stats.characters;
    highlightLine(`const v999 = "${filler}";`, 'typescript');
    expect(highlightCacheStatsForTests().characters).toBe(charactersBefore);
  });
});
