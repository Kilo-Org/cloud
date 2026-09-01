import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DiffEditorProps } from '@monaco-editor/react';
import { ApplyPatchToolCard } from './ApplyPatchToolCard';
import { EditToolCard } from './EditToolCard';
import { WriteToolCard } from './WriteToolCard';
import { ToolDiff } from './ToolDiff';
import { MAX_TOOL_DIFF_CHARACTERS, MAX_TOOL_DIFF_LINES } from './toolDiffUtils';
import type { ToolPart } from './types';
import type * as ToolCardShellModule from './ToolCardShell';

jest.mock('react-markdown', () =>
  process.getBuiltinModule('module').createRequire(__filename)('react-markdown')
);
jest.mock('remark-gfm', () =>
  process.getBuiltinModule('module').createRequire(__filename)('remark-gfm')
);

Object.assign(globalThis, { React });

let expanded: boolean | undefined;

jest.mock('./ToolCardShell', () => {
  const actual = jest.requireActual<typeof ToolCardShellModule>('./ToolCardShell');
  return {
    ToolCardShell: (props: React.ComponentProps<typeof actual.ToolCardShell>) =>
      React.createElement(
        actual.ToolCardShell,
        expanded === undefined ? props : { ...props, defaultExpanded: expanded }
      ),
  };
});

jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: () =>
    function MockDiffEditor({ original, modified }: DiffEditorProps) {
      return React.createElement('div', {
        'data-monaco-diff': true,
        'data-original': original,
        'data-modified': modified,
      });
    },
}));

const filePath = '/workspace/src/file.ts';
const patch = [
  `--- ${filePath}`,
  `+++ ${filePath}`,
  '@@ -41,2 +41,2 @@',
  ' context',
  '-metadata before',
  '+metadata after',
  '',
].join('\n');
const rawPatch = '*** Begin Patch\n*** Add File: src/new.ts\n+new content\n*** End Patch';
const cards = { edit: EditToolCard, write: WriteToolCard, apply_patch: ApplyPatchToolCard };

function makePart(
  tool: keyof typeof cards,
  input: Record<string, unknown> = {},
  metadata: Record<string, unknown> = {},
  output = 'Done'
): ToolPart {
  return {
    id: 'part_file_change',
    sessionID: 'ses_test',
    messageID: 'msg_test',
    type: 'tool',
    callID: 'call_test',
    tool,
    state: {
      status: 'completed',
      input,
      output,
      title: 'Change file',
      metadata,
      time: { start: 1, end: 2 },
    },
  };
}

function renderTool(
  tool: keyof typeof cards,
  input: Record<string, unknown> = {},
  metadata: Record<string, unknown> = {},
  output = 'Done'
) {
  return renderToStaticMarkup(
    React.createElement(cards[tool], { toolPart: makePart(tool, input, metadata, output) })
  );
}

beforeEach(() => {
  expanded = true;
});

describe('file tool disclosures', () => {
  it.each(['edit', 'write', 'apply_patch'] as const)(
    '%s stays collapsed without mounting a diff',
    tool => {
      expanded = undefined;
      const html = renderTool(
        tool,
        {
          filePath,
          oldString: 'before',
          newString: 'after',
          content: 'written',
          patchText: rawPatch,
        },
        {
          files: [
            {
              filePath,
              relativePath: 'src/file.ts',
              type: 'update',
              patch,
              additions: 1,
              deletions: 1,
            },
          ],
        }
      );

      expect(html).toContain('aria-expanded="false"');
      expect(html).not.toContain('data-monaco-diff');
      expect(html).not.toContain('metadata after');
      expect(html).not.toContain('Patch input');
    }
  );
});

describe.each([
  ['edit', { filePath, oldString: 'before' }],
  ['write', { filePath }],
  ['apply_patch', { patchText: '*** Begin Patch\n' }],
] as const)('%s sparse completed results', (tool, partialInput) => {
  const output = `Completed ${tool} output retained: parity-${tool}-missing-input.`;

  it.each([{}, partialInput])(
    'retains the raw result alongside the unavailable notice: %p',
    input => {
      const html = renderTool(tool, input, {}, output);
      expect(html).toContain('unavailable');
      expect(html).toContain(output);
      expect(html).toContain('aria-label="Output"');
      expect(html).not.toContain('data-monaco-diff');
      expect(html).not.toContain('additions');
      expect(html).not.toContain('deletions');
    }
  );

  it.each(['', ' \n\t'])('does not add an empty result block: %p', emptyOutput => {
    const html = renderTool(tool, {}, {}, emptyOutput);
    expect(html).toContain('unavailable');
    expect(html).not.toContain('aria-label="Output"');
  });

  it('keeps retained results inside the individually collapsed details', () => {
    expanded = undefined;
    const html = renderTool(tool, {}, {}, output);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain(output);
    expect(html).not.toContain('aria-label="Copy output"');
  });

  it('does not duplicate success output when structured previews are available', () => {
    const metadata =
      tool === 'apply_patch'
        ? {
            files: [
              {
                filePath,
                relativePath: 'src/file.ts',
                type: 'update',
                patch,
                additions: 1,
                deletions: 1,
              },
            ],
          }
        : { filediff: { file: filePath, patch, additions: 1, deletions: 1 } };
    const html = renderTool(tool, {}, metadata, output);
    expect(html).toContain('metadata after');
    expect(html).not.toContain(output);
    expect(html).not.toContain('aria-label="Output"');
  });
});

describe('EditToolCard', () => {
  it('prefers metadata patches and counts over input snippets', () => {
    const html = renderTool(
      'edit',
      { filePath, oldString: 'snippet before', newString: 'snippet after', replaceAll: true },
      { filediff: { file: filePath, patch, additions: 4, deletions: 3 } }
    );

    expect(html).toContain('file.ts');
    expect(html).toContain('/workspace/src/');
    expect(html).toContain('replace all');
    expect(html).toContain('aria-label="4 additions"');
    expect(html).toContain('aria-label="3 deletions"');
    expect(html).toContain('@@ -41,2 +41,2 @@');
    expect(html).toContain('metadata after');
    expect(html).not.toContain('snippet after');
    expect(html).not.toContain('data-monaco-diff');
  });

  it.each([
    ['', 'after'],
    ['before', ''],
    ['', ''],
  ])('retains valid empty strings in snippet fallback: %p to %p', (original, modified) => {
    const html = renderTool('edit', { filePath, oldString: original, newString: modified });
    expect(html).toContain('Input snippets (not the full file)');
    expect(html).toContain(`data-original="${original}"`);
    expect(html).toContain(`data-modified="${modified}"`);
    expect(html).not.toContain('unavailable');
    expect(html).not.toContain('aria-label="Output"');
  });

  it.each([42, 'not a patch', rawPatch])(
    'uses valid snippets when the metadata patch is invalid: %p',
    value => {
      const html = renderTool(
        'edit',
        { filePath, oldString: 'before', newString: 'after' },
        { filediff: { file: filePath, patch: value, additions: 2, deletions: -1 } }
      );
      expect(html).toContain('data-original="before"');
      expect(html).toContain('data-modified="after"');
      expect(html).toContain('aria-label="2 additions"');
      expect(html).not.toContain('deletions');
    }
  );

  it.each([{ newString: 'after' }, { oldString: 'before' }, { oldString: 42, newString: 'after' }])(
    'does not turn absent or malformed snippets into empty strings: %p',
    input => {
      const html = renderTool('edit', { filePath, ...input }, { filediff: null });
      expect(html).toContain(filePath);
      expect(html).toContain('Diff preview unavailable');
      expect(html).not.toContain('data-monaco-diff');
      expect(html).not.toContain('Editing file');
    }
  );

  it('shows at most three validated diagnostics without file-navigation actions', () => {
    const html = renderTool(
      'edit',
      { filePath, oldString: '', newString: 'after' },
      {
        diagnostics: {
          [filePath]: [
            { severity: 2, message: 'hidden warning' },
            { severity: 1, message: 'first error', range: { start: { line: 1, character: 2 } } },
            { severity: 1, message: 42 },
            { severity: 1, message: 'second error' },
            { severity: 1, message: 'third error' },
            { severity: 1, message: 'hidden fourth error' },
          ],
        },
      }
    );
    expect(html).toContain('[2:3]');
    expect(html).toContain('first error');
    expect(html).toContain('second error');
    expect(html).toContain('third error');
    expect(html).not.toContain('hidden warning');
    expect(html).not.toContain('hidden fourth error');
    expect(html).not.toContain('href=');
  });
});

describe('WriteToolCard', () => {
  it('uses the metadata patch even when input content is absent', () => {
    const html = renderTool(
      'write',
      {},
      { filediff: { file: filePath, patch, additions: 1, deletions: 2 } }
    );
    expect(html).toContain(filePath);
    expect(html).toContain('metadata after');
    expect(html).toContain('aria-label="2 deletions"');
    expect(html).not.toContain('data-monaco-diff');
  });

  it('does not replace a metadata patch with the written content', () => {
    const html = renderTool(
      'write',
      { filePath, content: 'input content' },
      { filediff: { patch } }
    );
    expect(html).toContain('metadata after');
    expect(html).not.toContain('input content');
  });

  it('keeps the labelled empty-file comparison without claiming file change counts', () => {
    const html = renderTool('write', { filePath, content: 'one\ntwo\n' });
    expect(html).toContain('data-original=""');
    expect(html).toContain('data-modified="one\ntwo\n"');
    expect(html).not.toContain('additions');
    expect(html).not.toContain('deletions');
    expect(html).toContain('compared with an empty file');
    expect(html).not.toContain('aria-label="Output"');
  });

  it('retains empty content as a valid preview without inferring zero changes', () => {
    const html = renderTool('write', { filePath, content: '' });
    expect(html).toContain('data-original=""');
    expect(html).toContain('data-modified=""');
    expect(html).not.toContain('additions');
    expect(html).not.toContain('deletions');
    expect(html).toContain('Empty content.');
    expect(html).not.toContain('unavailable');
    expect(html).not.toContain('aria-label="Output"');
  });

  it('does not claim additions or deletions in a collapsed content-only write', () => {
    expanded = undefined;
    const html = renderTool('write', { filePath, content: 'one\ntwo\n' });
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('additions');
    expect(html).not.toContain('deletions');
  });

  it.each([
    { additions: 3, deletions: 2 },
    { additions: 0, deletions: 0 },
  ])('retains supplied metadata counts in the collapsed header: %p', filediff => {
    expanded = undefined;
    const html = renderTool('write', { filePath, content: 'one\ntwo\n' }, { filediff });
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(`aria-label="${filediff.additions} additions"`);
    expect(html).toContain(`aria-label="${filediff.deletions} deletions"`);
  });

  it('does not infer a missing count when the other count is supplied', () => {
    expanded = undefined;
    const html = renderTool(
      'write',
      { filePath, content: 'one\ntwo\n' },
      { filediff: { deletions: 0 } }
    );
    expect(html).toContain('aria-label="0 deletions"');
    expect(html).not.toContain('additions');
  });

  it.each([undefined, null, 42])(
    'keeps an honest unavailable state for invalid content: %p',
    content => {
      const html = renderTool('write', { filePath, content }, { filediff: { patch: null } });
      expect(html).toContain(filePath);
      expect(html).toContain('Diff preview unavailable');
      expect(html).not.toContain('data-monaco-diff');
      expect(html).not.toContain('Writing file');
      expect(html).not.toContain('0 additions');
    }
  );
});

describe('ApplyPatchToolCard', () => {
  it('shows add, update, delete, and move summaries with aggregate changes and distinct move paths', () => {
    const html = renderTool(
      'apply_patch',
      {},
      {
        files: [
          {
            filePath: '/workspace/src/add.ts',
            relativePath: 'src/add.ts',
            type: 'add',
            patch,
            additions: 2,
            deletions: 0,
          },
          {
            filePath,
            relativePath: 'src/file.ts',
            type: 'update',
            patch,
            additions: 3,
            deletions: 1,
          },
          {
            filePath: '/workspace/src/delete.ts',
            relativePath: 'src/delete.ts',
            type: 'delete',
            patch,
            additions: 0,
            deletions: 2,
          },
          {
            filePath: '/workspace/src/old.ts',
            relativePath: 'src/new.ts',
            movePath: '/workspace/src/new.ts',
            type: 'move',
            patch,
            additions: 1,
            deletions: 1,
          },
        ],
      }
    );
    expect(html).toContain('4 files');
    expect(html).toContain('aria-label="6 additions"');
    expect(html).toContain('aria-label="4 deletions"');
    for (const label of ['Added', 'Updated', 'Deleted', 'Moved']) expect(html).toContain(label);
    expect(html).toContain('From: <code class="break-all">/workspace/src/old.ts</code>');
    expect(html).toContain('To: <code class="break-all">/workspace/src/new.ts</code>');
    expect(html).not.toContain('From: <code class="break-all">src/new.ts</code>');
    expect(html).not.toContain('data-monaco-diff');
    expect(html).not.toContain('href=');
  });

  it('uses the relative destination for a move without movePath, never as the source', () => {
    const html = renderTool(
      'apply_patch',
      {},
      {
        files: [{ relativePath: 'src/new.ts', type: 'move', additions: 0, deletions: 0 }],
      }
    );
    expect(html).toContain('new.ts');
    expect(html).toContain('Unknown source');
    expect(html).toContain('To: <code class="break-all">src/new.ts</code>');
    expect(html).toContain('Diff preview unavailable');
    expect(html).not.toContain('aria-label="Output"');
  });

  it.each([undefined, '', 42, 'not a unified patch'])(
    'falls back to legacy file.diff when patch is unusable: %p',
    value => {
      const html = renderTool(
        'apply_patch',
        {},
        {
          files: [
            {
              relativePath: 'src/file.ts',
              type: 'update',
              patch: value,
              diff: patch,
              additions: 1,
              deletions: 1,
            },
          ],
        }
      );
      expect(html).toContain('metadata after');
      expect(html).not.toContain('unavailable');
    }
  );

  it('keeps valid file summaries despite sparse, missing, or malformed patches and neighboring entries', () => {
    const html = renderTool(
      'apply_patch',
      {},
      {
        files: [
          null,
          { relativePath: 'src/omitted.ts', type: 'add', additions: 1, deletions: 0 },
          {
            relativePath: 'src/sparse.ts',
            type: 'update',
            patch: '--- a\n+++ a\n@@ -1 +1 @@\n',
            additions: 3,
            deletions: 2,
          },
          {
            relativePath: 'src/malformed.ts',
            type: 'delete',
            patch: { text: patch },
            additions: 0,
            deletions: 4,
          },
        ],
      }
    );
    expect(html).toContain('3 files');
    expect(html).toContain('src/omitted.ts');
    expect(html).toContain('src/sparse.ts');
    expect(html).toContain('src/malformed.ts');
    expect(html).toContain('aria-label="4 additions"');
    expect(html).toContain('aria-label="6 deletions"');
    expect(html.match(/Diff preview unavailable/g)).toHaveLength(3);
  });

  it('keeps raw patch input separate from an applied diff without pretending completion is pending', () => {
    const html = renderTool('apply_patch', { patchText: rawPatch }, { files: 'invalid' });
    expect(html).toContain('Patch input (not an applied diff)');
    expect(html).toContain('*** Begin Patch');
    expect(html).toContain('no usable file metadata was provided');
    expect(html).not.toContain('Unified patch');
    expect(html).not.toContain('data-monaco-diff');
    expect(html).not.toContain('Applying patch');
    expect(html).not.toContain('Waiting to apply');
  });

  it('shows pending patch input without interpreting it as unified history', () => {
    const toolPart = makePart('apply_patch');
    toolPart.state = { status: 'pending', input: { patchText: rawPatch }, raw: '' };
    const html = renderToStaticMarkup(React.createElement(ApplyPatchToolCard, { toolPart }));
    expect(html).toContain('Waiting to apply patch');
    expect(html).toContain('Patch input (not an applied diff)');
    expect(html).not.toContain('Unified patch');
    expect(html).not.toContain('data-monaco-diff');
  });

  it('keeps summaries and reported counts when a patch is too large', () => {
    const html = renderTool(
      'apply_patch',
      {},
      {
        files: [
          {
            relativePath: 'src/large.ts',
            type: 'update',
            patch: `${patch}+${'x'.repeat(MAX_TOOL_DIFF_CHARACTERS)}`,
            additions: 5,
            deletions: 2,
          },
        ],
      }
    );
    expect(html).toContain('src/large.ts');
    expect(html).toContain('aria-label="5 additions"');
    expect(html).toContain('too large to display inline');
    expect(html).not.toContain('metadata after');
  });
});

describe('ToolDiff bounds and escaping', () => {
  it('styles header-like changed content inside every hunk without coloring file headers', () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolDiff, {
        patch: [
          '--- src/file.md',
          '+++ src/file.md',
          '@@ -1,2 +1,2 @@',
          '--- removed value',
          '----',
          '+++ added value',
          '+---',
          '@@ -20 +20 @@',
          '--- another removal',
          '+++ another addition',
          '',
        ].join('\n'),
      })
    );
    const classesByLine = new Map(
      Array.from(html.matchAll(/<span class="([^"]*)">([^<]*)<\/span>/g), match => [
        match[2],
        match[1],
      ])
    );

    for (const line of ['--- removed value', '----', '--- another removal']) {
      expect(classesByLine.get(line)).toContain('text-diff-delete-text');
    }
    for (const line of ['+++ added value', '+---', '+++ another addition']) {
      expect(classesByLine.get(line)).toContain('text-diff-add-text');
    }
    for (const line of ['--- src/file.md', '+++ src/file.md']) {
      expect(classesByLine.get(line)).toContain('text-muted-foreground');
      expect(classesByLine.get(line)).not.toContain('text-diff-');
    }
  });

  it.each(['diff --git a/src/next.md b/src/next.md', 'Index: src/next.md'])(
    'resets header styling at a standard file boundary: %s',
    boundary => {
      const html = renderToStaticMarkup(
        React.createElement(ToolDiff, {
          patch: [
            patch,
            boundary,
            '--- src/next.md',
            '+++ src/next.md',
            '@@ -1 +1 @@',
            '--- next removal',
            '+++ next addition',
            '',
          ].join('\n'),
        })
      );
      const classesByLine = new Map(
        Array.from(html.matchAll(/<span class="([^"]*)">([^<]*)<\/span>/g), match => [
          match[2],
          match[1],
        ])
      );

      for (const line of [boundary, '--- src/next.md', '+++ src/next.md']) {
        expect(classesByLine.get(line)).toContain('text-muted-foreground');
        expect(classesByLine.get(line)).not.toContain('text-diff-');
      }
      expect(classesByLine.get('--- next removal')).toContain('text-diff-delete-text');
      expect(classesByLine.get('+++ next addition')).toContain('text-diff-add-text');
    }
  );

  it('renders patch text as escaped code rather than HTML', () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolDiff, {
        patch: '--- src/a.ts\n+++ src/a.ts\n@@ -1 +1 @@\n-safe\n+<script>alert(1)</script>\n',
      })
    );
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('bg-diff-add-surface');
    expect(html).toContain('bg-diff-delete-surface');
  });

  it('renders CRLF patches without extra carriage-return lines', () => {
    const lf = renderToStaticMarkup(React.createElement(ToolDiff, { patch }));
    const crlf = renderToStaticMarkup(
      React.createElement(ToolDiff, { patch: patch.replaceAll('\n', '\r\n') })
    );
    expect(crlf).toBe(lf);
  });

  it.each([
    { original: '', modified: 'x'.repeat(MAX_TOOL_DIFF_CHARACTERS + 1) },
    { original: '', modified: 'x\n'.repeat(MAX_TOOL_DIFF_LINES + 1) },
    { patch: `${patch}${'+line\n'.repeat(MAX_TOOL_DIFF_LINES)}` },
  ])('does not create a model or a large patch DOM for oversized content', props => {
    const html = renderToStaticMarkup(React.createElement(ToolDiff, props));
    expect(html).toContain('too large to display inline');
    expect(html).not.toContain('data-monaco-diff');
    expect(html).not.toContain('<pre');
  });
});
