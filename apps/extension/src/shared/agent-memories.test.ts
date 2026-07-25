import { describe, expect, it } from 'vitest';
import {
  MEMORY_INDEX_ENTRY_COUNT,
  MEMORY_SEARCH_RESULT_COUNT,
  MAX_MEMORY_TEXT_LENGTH,
  buildPendingMemoryDraft,
  formatAgentMemoryIndex,
  searchAgentMemories,
  toAgentMemorySnippet,
} from './agent-memories';
import type { AgentMemory } from './agent-memories';

const memory = (
  overrides: Partial<AgentMemory> & Pick<AgentMemory, 'id' | 'text'>
): AgentMemory => ({
  createdAt: 1_700_000_000_000,
  pageTitle: 'Example',
  pageUrl: 'https://example.com/path',
  ...overrides,
});

describe('pending memory draft builder', () => {
  it('returns undefined for empty or whitespace selections', () => {
    expect(
      buildPendingMemoryDraft({
        now: 100,
        pageTitle: 'Title',
        pageUrl: 'https://example.com',
        selectionText: '',
      })
    ).toBeUndefined();
    expect(
      buildPendingMemoryDraft({
        now: 100,
        pageTitle: 'Title',
        pageUrl: 'https://example.com',
        selectionText: '   \n\t  ',
      })
    ).toBeUndefined();
    expect(
      buildPendingMemoryDraft({
        now: 100,
        pageTitle: 'Title',
        pageUrl: 'https://example.com',
        selectionText: undefined,
      })
    ).toBeUndefined();
  });

  it('trims text, sanitizes URL, stamps createdAt, and flags truncation', () => {
    const long = `${'a'.repeat(MAX_MEMORY_TEXT_LENGTH)}EXTRA`;
    expect(
      buildPendingMemoryDraft({
        now: 42,
        pageTitle: 'Docs',
        pageUrl: 'https://example.com/path?q=1#hash',
        selectionText: `  ${long}  `,
      })
    ).toStrictEqual({
      createdAt: 42,
      pageTitle: 'Docs',
      pageUrl: 'https://example.com/path',
      text: 'a'.repeat(MAX_MEMORY_TEXT_LENGTH),
      truncated: true,
    });
  });

  it('keeps empty pageUrl as empty and maps invalid URLs to the sanitizer fallback', () => {
    expect(
      buildPendingMemoryDraft({
        now: 1,
        pageTitle: 'T',
        pageUrl: '',
        selectionText: 'hello',
      })
    ).toMatchObject({ pageUrl: '', text: 'hello' });
    expect(
      buildPendingMemoryDraft({
        now: 1,
        pageTitle: 'T',
        pageUrl: 'not-a-url',
        selectionText: 'hello',
      })
    ).toMatchObject({ pageUrl: '[invalid URL]', text: 'hello' });
  });

  it('omits truncated when under the cap', () => {
    expect(
      buildPendingMemoryDraft({
        now: 9,
        pageTitle: 'T',
        pageUrl: 'https://example.com',
        selectionText: 'short',
      })
    ).toStrictEqual({
      createdAt: 9,
      pageTitle: 'T',
      pageUrl: 'https://example.com/',
      text: 'short',
    });
  });
});

describe('agent memory search', () => {
  const memories = [
    memory({
      createdAt: 30,
      id: 'a',
      note: 'alpha note',
      pageTitle: 'Alpha Title',
      pageUrl: 'https://alpha.example/path',
      text: 'first body',
    }),
    memory({
      createdAt: 20,
      id: 'b',
      pageTitle: 'Beta',
      pageUrl: 'https://beta.example',
      text: 'second body with alpha token',
    }),
    memory({
      createdAt: 10,
      id: 'c',
      pageTitle: 'Gamma',
      pageUrl: 'https://gamma.example',
      text: 'unrelated',
    }),
  ];

  it('requires every token and ranks by createdAt desc, capped at 10', () => {
    expect(searchAgentMemories(memories, 'alpha body').map(item => item.id)).toStrictEqual([
      'a',
      'b',
    ]);
    expect(searchAgentMemories(memories, 'beta.example').map(item => item.id)).toStrictEqual(['b']);

    const many = Array.from({ length: MEMORY_SEARCH_RESULT_COUNT + 5 }, (_unused, index) =>
      memory({
        createdAt: index,
        id: `m-${index}`,
        text: `shared token ${index}`,
      })
    );
    expect(searchAgentMemories(many, 'shared').map(item => item.id)).toHaveLength(
      MEMORY_SEARCH_RESULT_COUNT
    );
    expect(searchAgentMemories(many, 'shared')[0]?.id).toBe(`m-${MEMORY_SEARCH_RESULT_COUNT + 4}`);
  });

  it('returns no matches for empty or whitespace queries (no tokens)', () => {
    expect(searchAgentMemories(memories, '')).toStrictEqual([]);
    expect(searchAgentMemories(memories, '   ')).toStrictEqual([]);
  });
});

describe('agent memory index formatting', () => {
  it('returns undefined for an empty store', () => {
    expect(formatAgentMemoryIndex([])).toBeUndefined();
  });

  it('formats newest entries with escaped previews, domain, and UTC date', () => {
    const index = formatAgentMemoryIndex([
      memory({
        createdAt: Date.UTC(2026, 0, 2),
        id: 'old',
        pageTitle: 'Old',
        text: 'older text',
      }),
      memory({
        createdAt: Date.UTC(2026, 0, 5),
        id: 'new',
        note: 'note with <tag> & more',
        pageTitle: 'New',
        pageUrl: 'https://docs.example.com:8443/path?q=1',
        text: 'body ignored when note present',
      }),
    ]);

    expect(index).toBe(
      [
        '<memories count="2">',
        '- [new] note with &lt;tag&gt; &amp; more (docs.example.com, 2026-01-05)',
        '- [old] older text (example.com, 2026-01-02)',
        '</memories>',
      ].join('\n')
    );
  });

  it('omits domain for empty, invalid, and file URLs', () => {
    const createdAt = Date.UTC(2026, 5, 1);
    expect(
      formatAgentMemoryIndex([
        memory({ createdAt, id: 'empty', pageUrl: '', text: 'a' }),
        memory({ createdAt: createdAt + 1, id: 'bad', pageUrl: '[invalid URL]', text: 'b' }),
        memory({ createdAt: createdAt + 2, id: 'file', pageUrl: 'file:///tmp/x', text: 'c' }),
      ])
    ).toBe(
      [
        '<memories count="3">',
        '- [file] c (2026-06-01)',
        '- [bad] b (2026-06-01)',
        '- [empty] a (2026-06-01)',
        '</memories>',
      ].join('\n')
    );
  });

  it('caps listed entries at 20 and appends the remaining count', () => {
    const memories = Array.from({ length: MEMORY_INDEX_ENTRY_COUNT + 7 }, (_unused, index) =>
      memory({
        createdAt: index,
        id: `id-${index}`,
        text: `text ${index}`,
      })
    );
    const index = formatAgentMemoryIndex(memories);
    expect(index).toContain(`count="${MEMORY_INDEX_ENTRY_COUNT + 7}"`);
    expect(index).toContain('(7 more memories — use search_memories to find them.)');
    expect(index?.split('\n').filter(line => line.startsWith('- ['))).toHaveLength(
      MEMORY_INDEX_ENTRY_COUNT
    );
    expect(index).toContain('- [id-26]');
    expect(index).not.toContain('- [id-0]');
  });

  it('truncates long previews to about 80 characters', () => {
    const long = 'word '.repeat(40).trim();
    const index = formatAgentMemoryIndex([memory({ id: 'long', text: long })]);
    expect(index).toMatch(/^- \[long\] .{80} \(example\.com, \d{4}-\d{2}-\d{2}\)$/m);
  });
});

describe('agent memory snippets', () => {
  it('single-lines and truncates text to about 200 characters', () => {
    const long = `${'x'.repeat(250)}\nmore`;
    expect(toAgentMemorySnippet(memory({ id: 's', text: long }))).toBe('x'.repeat(200));
    expect(toAgentMemorySnippet(memory({ id: 's', text: '  hello\nworld  ' }))).toBe('hello world');
  });
});
