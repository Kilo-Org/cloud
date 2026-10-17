import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeClassifierInput } from './normalize';

// Differential test: the scan-based extraction must agree with the regex
// pipeline the previous implementation shipped, on every input. The previous
// pipeline is embedded verbatim below, as a shallow checkout does not carry
// the base revision's blob.
function previousCleanPromptText(): (text: string) => string {
  return function cleanPromptText(text) {
    const taskText = text.match(/<task>\s*([\s\S]*?)\s*<\/task>/i)?.[1] ?? text;

    return taskText
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, ' ')
      .replace(/<environment_details>[\s\S]*?<\/environment_details>/gi, ' ')
      .replace(/<file(?:\s[^>]*)?>[\s\S]*?<\/file>/gi, ' ')
      .replace(/<file_content(?:\s[^>]*)?>[\s\S]*?<\/file_content>/gi, ' ')
      .replace(/<read_file>[\s\S]*?<\/read_file>/gi, ' ')
      .replace(/<search_files>[\s\S]*?<\/search_files>/gi, ' ')
      .replace(/^\[[^\]]+\]\s+Result:\s*/i, ' ')
      .replace(/\[ERROR\][\s\S]*/i, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  };
}

function prefixFrom(text: string, clean: (t: string) => string): string | null {
  const cleaned = clean(text);
  return cleaned.length === 0 ? null : cleaned.slice(0, 1000);
}

function currentPrefix(text: string): string | null {
  const result = normalizeClassifierInput('chat_completions', {
    model: 'test/model',
    messages: [{ role: 'user', content: text }],
  });
  if (!result) throw new Error('normalization rejected the body');
  return result.userPromptPrefix;
}

function fixtureStrings(): string[] {
  const root = path.resolve(import.meta.dirname, '../../..');
  const strings: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === 'string') {
      strings.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value && typeof value === 'object') {
      Object.values(value).forEach(walk);
    }
  };
  for (const dir of ['apps/web/src/lib/utils/testdata', 'apps/web/src/tests/req_sample']) {
    const full = path.join(root, dir);
    let names: string[];
    try {
      names = readdirSync(full);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      walk(JSON.parse(readFileSync(path.join(full, name), 'utf-8')));
    }
  }
  return strings;
}

const WHITESPACE_RUNS = ['', ' ', '  \n\t ', '\n'.repeat(40), ' '.repeat(180)];
const TOKENS = [
  '<task>',
  '</task>',
  '<TASK>',
  '</Task>',
  '<thinking>',
  '</thinking>',
  '<environment_details>',
  '</environment_details>',
  '<file>',
  '<file path="a.txt">',
  '<file path="b.txt" mode="w">',
  '<file  >',
  '<file',
  '<file_content path="x">',
  '<file_content>',
  '</file_content>',
  '</file>',
  '<read_file>',
  '</read_file>',
  '<search_files>',
  '</search_files>',
  '[ERROR]',
  '[cmd] Result:',
  'text',
  'a b',
  '\u00a0',
  '\u3000',
  '\ufeff',
  '>',
  '<',
];

describe('cleanPromptText equivalence with the previous pipeline', () => {
  const previous = previousCleanPromptText();

  it('agrees on the request fixtures', () => {
    const strings = fixtureStrings();
    expect(strings.length).toBeGreaterThan(0);
    for (const text of strings) {
      expect(currentPrefix(text)).toBe(prefixFrom(text, previous));
    }
  });

  it('agrees on tag shapes with missing closers, attributes, and nesting', () => {
    const cases = [
      '',
      ' ',
      '<task>',
      '<task>x',
      '<task></task>',
      '<task> </task>',
      '<task>\n\nhello\n\n</task>',
      '<task>a</task><task>b</task>',
      '<task><task>a</task>',
      '</task><task>a</task>',
      '<task>a</task> trailing',
      '<task>\u00a0only-unicode-ws\u3000</task>',
      '<TASK>Case</TASK>',
      '<task>outer<thinking>inner</thinking></task>',
      '<thinking>a</thinking>',
      '<thinking>a<thinking>b</thinking>',
      '<thinking>'.repeat(3),
      '<file path="a">x</file>',
      '<file>a</file><file>b</file>',
      '<file_content path="a">x</file_content>',
      '<filea>x</filea>',
      '<file >a</file >',
      '<file_content',
      '<read_file>a</read_file>',
      '<search_files>a</search_files>',
      '[cmd] Result: payload',
      'x [ERROR] rest',
      '<environment_details>a</environment_details>b<environment_details>c</environment_details>',
    ];
    for (const text of cases) {
      expect(currentPrefix(text), JSON.stringify(text)).toBe(prefixFrom(text, previous));
    }
  });

  it('agrees on generated tag and whitespace combinations', () => {
    let seed = 123456789;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let index = 0; index < 4000; index++) {
      const parts: string[] = [];
      const count = 1 + Math.floor(random() * 12);
      for (let step = 0; step < count; step++) {
        parts.push(TOKENS[Math.floor(random() * TOKENS.length)]);
        parts.push(WHITESPACE_RUNS[Math.floor(random() * WHITESPACE_RUNS.length)]);
      }
      const text = parts.join('');
      expect(currentPrefix(text), JSON.stringify(text)).toBe(prefixFrom(text, previous));
    }
  });
});
