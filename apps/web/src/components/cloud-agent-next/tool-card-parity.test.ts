import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ToolPart } from './types';
import type * as ToolCardShellModule from './ToolCardShell';

let mockExpanded = false;

jest.mock('./ToolCardShell', () => {
  const actual = jest.requireActual<typeof ToolCardShellModule>('./ToolCardShell');
  return {
    ToolCardShell: (props: React.ComponentProps<typeof actual.ToolCardShell>) =>
      React.createElement(actual.ToolCardShell, {
        ...props,
        defaultExpanded: mockExpanded ? true : props.defaultExpanded,
      }),
  };
});
jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('pre', null, children),
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }));

import { ReadToolCard } from './ReadToolCard';
import { ListToolCard } from './ListToolCard';
import { GlobToolCard } from './GlobToolCard';
import { GrepToolCard } from './GrepToolCard';
import { WebFetchToolCard } from './WebFetchToolCard';
import { WebSearchToolCard } from './WebSearchToolCard';
import { TodoWriteToolCard } from './TodoWriteToolCard';
import { SkillToolCard } from './SkillToolCard';

Object.assign(globalThis, { React });

function toolPart(
  tool: string,
  input: Record<string, unknown> = {},
  output = '',
  metadata: Record<string, unknown> = {}
): ToolPart {
  return {
    id: 'part-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: 'call-1',
    tool,
    state: {
      status: 'completed',
      input,
      output,
      metadata,
      title: tool,
      time: { start: 1, end: 2 },
    },
  };
}

function renderCard(
  Card: React.ComponentType<{ toolPart: ToolPart }>,
  part: ToolPart,
  expanded = false
): string {
  mockExpanded = expanded;
  return renderToStaticMarkup(React.createElement(Card, { toolPart: part }));
}

describe('file context tool cards', () => {
  it.each([
    [{ offset: 0, limit: 2 }, 'file.ts offset=0 limit=2'],
    [{ offset: 12 }, 'file.ts offset=12'],
    [{ limit: 4 }, 'file.ts limit=4'],
    [{}, 'file.ts'],
  ])('shows actual read arguments without inventing a line range: %j', (args, summary) => {
    const html = renderCard(
      ReadToolCard,
      toolPart('read', { filePath: '/repo/src/file.ts', ...args }, 'Private file content')
    );
    expect(html).toContain(summary);
    expect(html).toContain('title="/repo/src/file.ts"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('Private file content');
    expect(html).not.toContain('<a ');
  });

  it('retains escaped raw read contents and the shared copy control on expansion', () => {
    const html = renderCard(
      ReadToolCard,
      toolPart('read', { filePath: '/repo/file.html' }, '<main>File contents</main>\n  next line'),
      true
    );
    expect(html).toContain('&lt;main&gt;File contents&lt;/main&gt;\n  next line');
    expect(html).toContain('aria-label="Copy content"');
    expect(html).not.toContain('<main>');
  });

  it.each([
    {
      tool: 'list',
      Card: ListToolCard,
      input: { path: '/repo/src' },
      summary: 'src',
      output: '/repo/src/\n  file.ts\n  nested/',
    },
    {
      tool: 'glob',
      Card: GlobToolCard,
      input: { path: '/repo/src', pattern: '**/*.ts' },
      summary: 'src pattern=**/*.ts',
      output: '/repo/src/file.ts\n/repo/src/other.ts',
    },
    {
      tool: 'grep',
      Card: GrepToolCard,
      input: { path: '/repo/src', pattern: 'needle', include: '*.ts' },
      summary: 'src pattern=needle include=*.ts',
      output: 'Found 2 matches\n/repo/src/file.ts:\n  Line 12: needle\n  Line 18: another needle',
    },
  ])('preserves $tool native output without parsing result counts or file links', testCase => {
    const part = toolPart(testCase.tool, testCase.input, testCase.output);
    const collapsed = renderCard(testCase.Card, part);
    expect(collapsed).toContain(testCase.summary);
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).not.toMatch(/\d+ (?:entries|files|in \d+ files)/);

    const expanded = renderCard(testCase.Card, part, true);
    expect(expanded).toContain(testCase.output);
    expect(expanded).not.toContain('<a ');
  });

  it.each([
    {
      tool: 'read',
      Card: ReadToolCard,
      input: { filePath: '/repo/file.ts' },
      empty: '(empty file)',
    },
    { tool: 'list', Card: ListToolCard, input: { path: '/repo' }, empty: 'No entries returned' },
    { tool: 'glob', Card: GlobToolCard, input: { pattern: '*.ts' }, empty: 'No matches found' },
    { tool: 'grep', Card: GrepToolCard, input: { pattern: 'needle' }, empty: 'No matches found' },
  ])('keeps the $tool empty state readable', ({ tool, Card, input, empty }) => {
    expect(renderCard(Card, toolPart(tool, input), true)).toContain(empty);
  });

  it.each([
    { status: 'pending', input: { pattern: 'needle' }, raw: '' },
    { status: 'running', input: { pattern: 'needle' }, time: { start: 1 } },
    {
      status: 'error',
      input: { pattern: 'needle' },
      error: 'Permission denied',
      time: { start: 1, end: 2 },
    },
  ] satisfies ToolPart['state'][])('does not mistake $status output for an empty search', state => {
    const html = renderCard(GrepToolCard, { ...toolPart('grep'), state }, true);
    expect(html).not.toContain('No matches found');
    expect(html).toContain(
      state.status === 'error'
        ? 'Permission denied'
        : state.status === 'running'
          ? 'Searching content...'
          : 'Waiting to search...'
    );
  });
});

describe('web tool cards', () => {
  it.each(['https://example.com/docs', 'http://localhost:3000/docs'])(
    'links safely to %s without a content disclosure',
    url => {
      const html = renderCard(
        WebFetchToolCard,
        toolPart('webfetch', { url }, 'Fetched page contents')
      );
      expect(html).toContain(`href="${url}"`);
      expect(html).toContain('target="_blank"');
      expect(html).toContain('rel="noopener noreferrer"');
      expect(html).toContain('Completed');
      expect(html).not.toContain('<button');
      expect(html).not.toContain('Fetched page contents');
    }
  );

  it.each([
    'javascript:alert(1)',
    'data:text/html,unsafe',
    'ftp://example.com',
    '//example.com',
    '',
    undefined,
    {},
  ])('does not link an unsafe or missing fetch URL: %j', url => {
    const html = renderCard(WebFetchToolCard, toolPart('webfetch', { url }));
    expect(html).not.toContain('href=');
    expect(html).not.toContain('<button');
  });

  it('labels blank fetch URLs without guessing a destination', () => {
    const html = renderCard(WebFetchToolCard, toolPart('webfetch', { url: ' \n ' }));
    expect(html).toContain('URL unavailable');
    expect(html).not.toContain('href=');
  });

  it.each(['websearch', 'codesearch'])('uses the %s name and query with collapsed links', tool => {
    const html = renderCard(
      WebSearchToolCard,
      toolPart(tool, { query: 'tool rendering' }, 'https://example.com/docs')
    );
    expect(html).toContain(tool === 'codesearch' ? 'CodeSearch' : 'WebSearch');
    expect(html).toContain('tool rendering');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('href=');
  });

  it('renders deduplicated URLs rather than author, date, or snippet guesses', () => {
    const output =
      'Title: Guessed title\nURL: https://example.com/docs\nAuthor: A person\nPublished Date: 2026-08-29\n[Again](https://example.com/docs). http://example.org/code\njavascript:alert(1)';
    const html = renderCard(
      WebSearchToolCard,
      toolPart('codesearch', { query: 'tools' }, output),
      true
    );
    expect(html.match(/href=/g)).toHaveLength(2);
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('href="http://example.org/code"');
    expect(html).not.toContain('Guessed title');
    expect(html).not.toContain('A person');
    expect(html).not.toContain('2026-08-29');
    expect(html).not.toContain('javascript:');
  });

  it.each([
    ['', 'No results found'],
    [' \n ', 'No results found'],
    ['Search completed without URLs', 'No links found in search output'],
  ])('keeps the search empty/no-links distinction: %j', (output, message) => {
    expect(
      renderCard(WebSearchToolCard, toolPart('websearch', { query: 'tools' }, output), true)
    ).toContain(message);
  });
});

describe('todo and skill cards', () => {
  const todos = [
    { content: 'Earlier task', status: 'completed', priority: 'low' },
    { content: 'Active task', status: 'in_progress', priority: 'high' },
    { content: 'Later task', status: 'cancelled', priority: 'medium' },
  ];

  it('keeps completed todo progress collapsed and honors the compact metadata view on expansion', () => {
    const part = toolPart(
      'todowrite',
      { todos: [{ content: 'Stale input', status: 'pending' }] },
      '',
      {
        todos,
        view: { mode: 'compact', todos: [todos[1]], hiddenBefore: 1, hiddenAfter: 1 },
      }
    );
    const collapsed = renderCard(TodoWriteToolCard, part);
    expect(collapsed).toContain('1/3');
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).not.toContain('Active task');

    const expanded = renderCard(TodoWriteToolCard, part, true);
    expect(expanded).toContain('1 earlier to-do hidden');
    expect(expanded).toContain('1 later to-do hidden');
    expect(expanded).toContain('Active task');
    expect(expanded).toContain('(high)');
    expect(expanded).not.toContain('Earlier task');
    expect(expanded).not.toContain('Later task');
    expect(expanded).not.toContain('Stale input');
    expect(expanded).not.toContain('<input');
  });

  it('keeps completed and cancelled statuses distinguishable without interactive checkboxes', () => {
    const html = renderCard(TodoWriteToolCard, toolPart('todowrite', { todos }), true);
    expect(html).toContain('Completed: ');
    expect(html).toContain('In progress: ');
    expect(html).toContain('Cancelled: ');
    expect(html).not.toContain('<input');
  });

  it('renders an honest empty todo view instead of falling back to hidden rows', () => {
    const html = renderCard(
      TodoWriteToolCard,
      toolPart('todowrite', { todos }, '', { view: { todos: [] } }),
      true
    );
    expect(html).toContain('No todos to display');
    expect(html).not.toContain('Earlier task');
  });

  it('uses a skill metadata name without rendering skill contents', () => {
    const html = renderCard(
      SkillToolCard,
      toolPart('skill', {}, 'Private skill contents', { name: 'code-quality' })
    );
    expect(html).toContain('code-quality');
    expect(html).not.toContain('Private skill contents');
    expect(html).not.toContain('<button');
  });
});
