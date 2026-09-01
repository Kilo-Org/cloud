import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock, type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FileDiffMetadata } from '@pierre/diffs';
import type { WorktreeFileViewMode } from './workspace-tabs';
import type {
  GetWorktreeFileOutput,
  WorktreeChangesSnapshot,
  WorktreeFileRecord,
} from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import type { WorktreeFileHighlighterResult } from './WorktreeFileRenderer';

const require = createRequire(import.meta.url);
const {
  MAX_WORKTREE_CONTENT_BYTES,
  MAX_WORKTREE_CONTENT_LINES,
  MAX_WORKTREE_FILE_BYTES,
  MAX_WORKTREE_PATCH_LINES,
  worktreeFileOmissionReasonSchema,
  worktreeFileRecordSchema,
}: typeof import('@kilocode/worker-utils/cloud-agent-worktree-changes') = require('@kilocode/worker-utils/cloud-agent-worktree-changes');
const {
  DiffHunksRenderer,
  FileRenderer,
  SPLIT_WITH_NEWLINES,
  preloadHighlighter,
  registerCustomLanguage,
  registerCustomTheme,
}: typeof import('@pierre/diffs') = require('@pierre/diffs');
const {
  default: WorktreeFileRenderer,
  parseSavedWorktreePatch,
  prepareWorktreeFileHighlighter,
}: typeof import('./WorktreeFileRenderer') = require('./WorktreeFileRenderer');
const {
  getSavedWorktreeFileState,
  getWorktreeFileViewMode,
}: typeof import('./worktree-file') = require('./worktree-file');
const {
  getWorktreeDiffExpansion,
}: typeof import('./worktree-file-diff') = require('./worktree-file-diff');

const patch = `diff --git a/src/example.ts b/src/example.ts
index 1234567..abcdef0 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,3 +1,3 @@
 first
-old value
+new value
 last
`;
const file: WorktreeFileRecord = {
  schemaVersion: 1,
  revision: 3,
  path: 'src/example.ts',
  diff: { status: 'available', patch },
  content: { status: 'available', source: 'current', text: 'first\nnew value\nlast\n' },
};
const snapshot: WorktreeChangesSnapshot = {
  schemaVersion: 1,
  revision: 3,
  capturedAt: '2026-08-28T10:00:00Z',
  comparison: {
    baseRef: 'refs/remotes/origin/main',
    mergeBase: 'a'.repeat(40),
    head: 'b'.repeat(40),
  },
  files: [
    {
      path: file.path,
      status: 'modified',
      additions: 1,
      deletions: 1,
      binary: false,
      tracked: true,
      countsComplete: true,
    },
  ],
  truncated: false,
};
const available: GetWorktreeFileOutput = {
  status: 'available',
  file,
  capturedAt: snapshot.capturedAt,
  comparison: snapshot.comparison,
};

function renderFile(record: WorktreeFileRecord, mode: WorktreeFileViewMode) {
  return renderToStaticMarkup(createElement(WorktreeFileRenderer, { file: record, mode }));
}

function gitFixture(
  t: TestContext,
  {
    before,
    current,
    context = 10,
    path = 'fixture.txt',
    modeChange = false,
  }: {
    before: string | null;
    current: string | null;
    context?: 0 | 10;
    path?: string;
    modeChange?: boolean;
  }
) {
  const directory = mkdtempSync(join(tmpdir(), 'worktree-file-diff-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  if (before !== null) {
    writeFileSync(join(directory, 'before'), before);
    chmodSync(join(directory, 'before'), 0o644);
  }
  if (current !== null) {
    writeFileSync(join(directory, 'current'), current);
    chmodSync(join(directory, 'current'), modeChange ? 0o755 : 0o644);
  }
  const result = spawnSync(
    'git',
    [
      '-c',
      'core.autocrlf=false',
      '-c',
      'core.attributesFile=/dev/null',
      'diff',
      '--no-index',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--no-renames',
      '--diff-algorithm=myers',
      '--no-indent-heuristic',
      `--unified=${context}`,
      '--',
      before === null ? '/dev/null' : 'before',
      current === null ? '/dev/null' : 'current',
    ],
    {
      cwd: directory,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
        ),
        NODE_ENV: 'test',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_ATTR_NOSYSTEM: '1',
      },
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: MAX_WORKTREE_FILE_BYTES,
    }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  const record: WorktreeFileRecord = {
    ...file,
    path,
    diff: { status: 'available', patch: result.stdout },
    content: {
      status: 'available',
      source: current === null ? 'deleted-original' : 'current',
      text: current ?? before ?? '',
    },
  };
  assert.equal(worktreeFileRecordSchema.safeParse(record).success, true);
  const parsed = parseSavedWorktreePatch(result.stdout, path);
  assert.ok(parsed);
  return { record, parsed };
}

function assertExpanded(
  { record, parsed }: ReturnType<typeof gitFixture>,
  before: string,
  current: string
) {
  const original = structuredClone(parsed);
  const result = getWorktreeDiffExpansion(record, parsed);
  assert.ok(result.status === 'available');
  const { diff } = result;
  assert.notEqual(diff, parsed);
  assert.equal(diff.isPartial, false);
  assert.equal(diff.name, record.path);
  assert.equal(diff.prevName, undefined);
  assert.equal(diff.cacheKey, undefined);
  assert.deepEqual(Buffer.from(diff.deletionLines.join('')), Buffer.from(before));
  assert.deepEqual(Buffer.from(diff.additionLines.join('')), Buffer.from(current));
  assert.equal(diff.hunks.length, parsed.hunks.length);
  for (const key of ['type', 'mode', 'prevMode', 'prevObjectId', 'newObjectId'] as const) {
    assert.equal(diff[key], parsed[key]);
  }
  for (const [index, hunk] of parsed.hunks.entries()) {
    const hydrated = diff.hunks[index];
    assert.ok(hydrated);
    for (const key of [
      'additionStart',
      'additionCount',
      'deletionStart',
      'deletionCount',
      'hunkSpecs',
      'hunkContext',
      'noEOFCRAdditions',
      'noEOFCRDeletions',
    ] as const) {
      assert.equal(hydrated[key], hunk[key]);
    }
  }
  assert.deepEqual(parsed, original);
  return diff;
}

async function createDiffRenderer(t: TestContext) {
  await preloadHighlighter({ langs: ['text'], themes: ['pierre-dark'] });
  const renderer = new DiffHunksRenderer({
    theme: 'pierre-dark',
    disableFileHeader: true,
    diffStyle: 'unified',
    diffIndicators: 'classic',
    hunkSeparators: 'line-info',
    collapsedContextThreshold: 0,
    lineDiffType: 'none',
    overflow: 'wrap',
  });
  t.after(() => renderer.cleanUp());
  return renderer;
}

function silenceConsole() {
  return (['log', 'info', 'warn', 'error', 'debug'] as const).map(method =>
    mock.method(console, method, () => {})
  );
}

function assertSilentAsyncWork(t: TestContext) {
  const consoles = silenceConsole();
  let unhandledRejections = 0;
  const onUnhandled = () => {
    unhandledRejections++;
  };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => {
    process.off('unhandledRejection', onUnhandled);
    assert.equal(unhandledRejections, 0);
    for (const log of consoles) assert.equal(log.mock.callCount(), 0);
  });
}

afterEach(() => mock.restoreAll());

describe('saved worktree patch acceptance', () => {
  it('uses strict parsing and preserves the authoritative path, not the patch filename', () => {
    const exactPath = ' odd/Unicode-λ\tname.MD ';
    const result = parseSavedWorktreePatch(patch, exactPath);
    assert.ok(result);
    assert.equal(result.name, exactPath);
    assert.equal(result.prevName, undefined);
    assert.equal(result.isPartial, true);
    assert.equal(result.hunks.length, 1);
    assert.deepEqual(result.additionLines, ['first\n', 'new value\n', 'last\n']);
    assert.deepEqual(result.deletionLines, ['first\n', 'old value\n', 'last\n']);
  });

  const metadataPatches = [
    {
      name: 'mode-only changes',
      patch: 'diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n',
    },
    {
      name: 'empty added files',
      patch: 'diff --git a/empty b/empty\nnew file mode 100644\nindex 0000000..e69de29\n',
    },
    {
      name: 'empty deleted files',
      patch: 'diff --git a/empty b/empty\ndeleted file mode 100644\nindex e69de29..0000000\n',
    },
    {
      name: 'SHA-256 empty files',
      patch: 'diff --git a/empty b/empty\nnew file mode 100644\nindex 0000000..473a0f4\n',
    },
  ];
  for (const fixture of metadataPatches) {
    it(`accepts canonical zero-hunk ${fixture.name}`, () => {
      const result = parseSavedWorktreePatch(fixture.patch, file.path);
      assert.ok(result);
      assert.equal(result.hunks.length, 0);
      const html = renderFile(
        { ...file, diff: { status: 'available', patch: fixture.patch } },
        'diff'
      );
      assert.match(html, /Metadata-only change/);
      assert.doesNotMatch(html, /could not be rendered/);
    });
  }

  for (const fixture of [
    {
      name: 'added file',
      patch:
        'diff --git a/new b/new\nnew file mode 100644\nindex 0000000..1234567\n--- /dev/null\n+++ b/new\n@@ -0,0 +1 @@\n+new\n',
    },
    {
      name: 'deleted file',
      patch:
        'diff --git a/old b/old\ndeleted file mode 100644\nindex 1234567..0000000\n--- a/old\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n',
    },
    {
      name: 'no-newline markers on both changed sides',
      patch:
        'diff --git a/f b/f\nindex 1234567..abcdef0 100644\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n',
    },
    {
      name: 'no-newline marker on shared context',
      patch:
        'diff --git a/f b/f\nindex 1234567..abcdef0 100644\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-old\n+new\n last\n\\ No newline at end of file\n',
    },
    {
      name: 'separate saved hunks with uncaptured context between them',
      patch: patch + '@@ -30 +30 @@\n-old\n+new\n',
    },
  ]) {
    it(`accepts canonical ${fixture.name}`, () => {
      assert.ok(parseSavedWorktreePatch(fixture.patch, file.path));
    });
  }

  const invalidPatches = [
    ['empty input', ''],
    ['non-patch text', 'PRIVATE_SENTINEL\n'],
    ['missing file metadata', 'diff --git a/f b/f\n'],
    [
      'invalid file header',
      patch.replace('diff --git a/src/example.ts b/src/example.ts', 'diff --git bad'),
    ],
    ['truncated hunk', patch.replace(' last\n', '')],
    ['truncated last line', patch.slice(0, -1)],
    ['missing hunks', patch.slice(0, patch.indexOf('@@'))],
    [
      'truncated new-file metadata',
      'diff --git a/new b/new\nnew file mode 100644\nindex 0000000..1234567\n',
    ],
    [
      'truncated deleted-file metadata',
      'diff --git a/old b/old\ndeleted file mode 100644\nindex 1234567..0000000\n',
    ],
    [
      'truncated mode and text change',
      'diff --git a/f b/f\nold mode 100644\nnew mode 100755\nindex 1234567..abcdef0\n',
    ],
    ['malformed hunk header', patch.replace('@@ -1,3 +1,3 @@', '@@ -bad +1,3 @@')],
    ['invalid hunk line', patch.replace(' last\n', 'PRIVATE_SENTINEL\n')],
    ['excess hunk body', patch + '+PRIVATE_SENTINEL\n'],
    ['unparsed trailer', patch + 'PRIVATE_SENTINEL\n'],
    ['format-patch trailer', patch + '-- \n'],
    ['multiple files', patch + patch.replaceAll('src/example.ts', 'src/other.ts')],
    ['partial first result before a bad second file', patch + 'diff --git PRIVATE_SENTINEL\n'],
    ['unsupported preamble', 'PRIVATE_SENTINEL\n' + patch],
    ['invalid newline marker', patch + '\\ PRIVATE_SENTINEL\n'],
    [
      'out-of-range line numbers',
      patch.replace('@@ -1,3 +1,3 @@', '@@ -9007199254740993,3 +1,3 @@'),
    ],
  ];
  for (const [name, invalidPatch] of invalidPatches) {
    it(`rejects ${name} without logging or partially rendering the body`, () => {
      const consoles = silenceConsole();
      assert.equal(parseSavedWorktreePatch(invalidPatch, file.path), null);
      const html = renderFile(
        { ...file, diff: { status: 'available', patch: invalidPatch } },
        'diff'
      );
      assert.match(html, /This saved diff could not be rendered/);
      assert.doesNotMatch(html, /PRIVATE_SENTINEL|old value|new value/);
      for (const log of consoles) assert.equal(log.mock.callCount(), 0);
    });
  }
});

describe('saved diff expansion', () => {
  beforeEach(t => {
    assert.ok('after' in t);
    assertSilentAsyncWork(t);
  });

  const lines = Array.from(
    { length: 160 },
    (_, index) => `line_${String(index + 1).padStart(3, '0')}\n`
  );
  const before = lines.join('');
  const current = [
    ...lines.slice(0, 25),
    'inserted_one\n',
    'inserted_two\n',
    ...lines.slice(26, 105),
    'replacement\n',
    ...lines.slice(108),
  ].join('');

  it('reconstructs sparse unequal U10 hunks byte-exactly without mutating frozen metadata', t => {
    const fixture = gitFixture(t, {
      before,
      current,
      path: ' odd/Unicode-λ\tname.MD ',
      modeChange: true,
    });
    assert.equal(fixture.parsed.hunks.length, 2);
    assert.ok(fixture.parsed.hunks.every(hunk => hunk.additionCount !== hunk.deletionCount));
    for (const hunk of fixture.parsed.hunks) {
      hunk.hunkContent.forEach(Object.freeze);
      Object.freeze(hunk.hunkContent);
      Object.freeze(hunk);
    }
    Object.freeze(fixture.parsed.hunks);
    Object.freeze(fixture.parsed.additionLines);
    Object.freeze(fixture.parsed.deletionLines);
    Object.freeze(fixture.parsed);
    const diff = assertExpanded(fixture, before, current);
    assert.notEqual(diff.hunks, fixture.parsed.hunks);
    assert.notEqual(diff.additionLines, fixture.parsed.additionLines);
    assert.notEqual(diff.deletionLines, fixture.parsed.deletionLines);
    assert.equal(diff.unifiedLineCount, 163);
  });

  it('uses native hunk expansion for leading, middle, trailing, and all unchanged lines', async t => {
    const fixture = gitFixture(t, { before, current });
    const diff = assertExpanded(fixture, before, current);
    const renderer = await createDiffRenderer(t);
    const collapsed = renderer.renderDiff(diff);
    assert.ok(collapsed);
    const savedRows = fixture.parsed.hunks.reduce(
      (count, hunk) => count + hunk.unifiedLineCount,
      0
    );
    assert.equal(collapsed.rowCount - collapsed.hunkData.length, savedRows);
    assert.doesNotMatch(renderer.renderFullHTML(collapsed), /line_001|line_070|line_160/);
    assert.equal(collapsed.hunkData.filter(hunk => hunk.expandable).length, 3);

    renderer.expandHunk(0, 'down', 5);
    const leading = renderer.renderDiff(diff);
    assert.ok(leading);
    assert.equal(leading.rowCount - leading.hunkData.length, savedRows + 5);
    assert.match(renderer.renderFullHTML(leading), /line_015/);
    assert.doesNotMatch(renderer.renderFullHTML(leading), /line_001/);

    renderer.expandHunk(1, 'both', 3);
    renderer.expandHunk(diff.hunks.length, 'up', 4);
    const chunked = renderer.renderDiff(diff);
    assert.ok(chunked);
    assert.equal(chunked.rowCount - chunked.hunkData.length, savedRows + 15);

    renderer.mergeOptions({ expandUnchanged: true });
    const expanded = renderer.renderDiff(diff);
    assert.ok(expanded);
    assert.equal(expanded.rowCount, 163);
    const html = renderer.renderFullHTML(expanded);
    for (const marker of ['line_001', 'line_070', 'line_160', 'inserted_one', 'replacement']) {
      assert.ok(html.includes(marker));
    }
    assert.match(html, /data-line-type="context-expanded"/);
    assert.match(html, /data-line-type="change-addition"/);
    assert.match(html, /data-line-type="change-deletion"/);
    assert.equal(expanded.hunkData.filter(hunk => hunk.expandable).length, 0);
  });

  const boundaryLines = lines.slice(0, 60);
  const boundaryBefore = boundaryLines.join('');
  for (const position of [0, 30, 60]) {
    for (const context of [0, 10] as const) {
      it(`preserves insertion boundaries at ${position} with Git U${context}`, async t => {
        const after = [
          ...boundaryLines.slice(0, position),
          'inserted\n',
          ...boundaryLines.slice(position),
        ].join('');
        const fixture = gitFixture(t, { before: boundaryBefore, current: after, context });
        if (context === 0) {
          assert.equal(fixture.parsed.hunks[0].deletionStart, position);
          assert.equal(fixture.parsed.hunks[0].deletionCount, 0);
          assert.equal(fixture.parsed.hunks[0].additionStart, position + 1);
        }
        const diff = assertExpanded(fixture, boundaryBefore, after);
        const renderer = await createDiffRenderer(t);
        renderer.mergeOptions({ expandUnchanged: true });
        const result = renderer.renderDiff(diff);
        assert.ok(result);
        assert.equal(result.rowCount, 61);
        assert.match(renderer.renderFullHTML(result), /line_001/);
        assert.match(renderer.renderFullHTML(result), /line_060/);
      });
    }
  }
  for (const position of [0, 30, 59]) {
    for (const context of [0, 10] as const) {
      it(`preserves deletion boundaries at ${position} with Git U${context}`, async t => {
        const after = [
          ...boundaryLines.slice(0, position),
          ...boundaryLines.slice(position + 1),
        ].join('');
        const fixture = gitFixture(t, { before: boundaryBefore, current: after, context });
        if (context === 0) {
          assert.equal(fixture.parsed.hunks[0].additionStart, position);
          assert.equal(fixture.parsed.hunks[0].additionCount, 0);
          assert.equal(fixture.parsed.hunks[0].deletionStart, position + 1);
        }
        const diff = assertExpanded(fixture, boundaryBefore, after);
        const renderer = await createDiffRenderer(t);
        renderer.mergeOptions({ expandUnchanged: true });
        const result = renderer.renderDiff(diff);
        assert.ok(result);
        assert.equal(result.rowCount, 60);
        assert.match(renderer.renderFullHTML(result), /line_001/);
        assert.match(renderer.renderFullHTML(result), /line_060/);
      });
    }
  }

  for (const fixture of [
    {
      name: 'CRLF and a leading BOM',
      before: `\uFEFF${before.replaceAll('\n', '\r\n')}`,
      current: `\uFEFF${current.replaceAll('\n', '\r\n')}`,
    },
    { name: 'a changed BOM line', before: `\uFEFFold\n${before}`, current: `\uFEFFnew\n${before}` },
    {
      name: 'an unchanged tail without a final newline',
      before: before.slice(0, -1),
      current: current.slice(0, -1),
    },
    {
      name: 'only the old side missing a final newline',
      before: `${before}old`,
      current: `${before}new\n`,
    },
    {
      name: 'only the current side missing a final newline',
      before: `${before}old\n`,
      current: `${before}new`,
    },
    {
      name: 'both changed sides missing a final newline',
      before: `${before}old`,
      current: `${before}new`,
    },
    {
      name: 'shared EOF context missing a final newline',
      before: `${before}old\nshared`,
      current: `${before}new\nshared`,
    },
    { name: 'a newline-only EOF change', before: `${before}last`, current: `${before}last\n` },
    {
      name: 'CRLF and BOM without final newlines',
      before: `\uFEFF${before.replaceAll('\n', '\r\n')}old`,
      current: `\uFEFF${before.replaceAll('\n', '\r\n')}new`,
    },
    { name: 'mixed line endings', before: `${before}old\r\n`, current: `${before}new\n` },
  ]) {
    it(`preserves bytes and native metadata for ${fixture.name}`, async t => {
      const saved = gitFixture(t, fixture);
      const diff = assertExpanded(saved, fixture.before, fixture.current);
      const renderer = await createDiffRenderer(t);
      renderer.mergeOptions({ expandUnchanged: true });
      const result = renderer.renderDiff(diff);
      assert.ok(result);
      if (diff.hunks.some(hunk => hunk.noEOFCRAdditions || hunk.noEOFCRDeletions)) {
        assert.match(renderer.renderFullHTML(result), /No newline at end of file/);
      }
    });
  }

  for (const fixture of [
    { name: 'old', before: `${before}old\r`, current: `${before}new\n` },
    { name: 'current', before: `${before}old\n`, current: `${before}new\r` },
    { name: 'shared', before: `${before}old\nlast\r`, current: `${before}new\nlast\r` },
  ]) {
    it(`rejects lossy lone-CR ${fixture.name} EOF expansion but preserves the partial patch`, async t => {
      const { record, parsed } = gitFixture(t, fixture);
      const original = structuredClone(parsed);
      assert.deepEqual(getWorktreeDiffExpansion(record, parsed), {
        status: 'unavailable',
        reason: 'inconsistent',
      });
      assert.deepEqual(parsed, original);
      const renderer = await createDiffRenderer(t);
      const result = renderer.renderDiff(parsed);
      assert.ok(result);
      assert.ok(result.rowCount > 0);
      assert.doesNotMatch(renderer.renderFullHTML(result), /line_001/);
    });
  }

  for (const fixture of [
    { name: 'added files', before: null, current: 'new\n' },
    { name: 'deleted originals', before: 'old\n', current: null },
    { name: 'empty added files', before: null, current: '' },
    { name: 'empty deleted files', before: '', current: null },
    { name: 'changes from empty text', before: '', current: 'new\n' },
    { name: 'changes to empty text', before: 'old\n', current: '' },
    { name: 'fully covered changes', before: 'first\nold\nlast\n', current: 'first\nnew\nlast\n' },
  ]) {
    it(`reports ${fixture.name} as complete, with no unchanged regions to expand`, t => {
      const { record, parsed } = gitFixture(t, fixture);
      assert.deepEqual(getWorktreeDiffExpansion(record, parsed), { status: 'complete' });
      assert.deepEqual(
        Buffer.from(parsed.deletionLines.join('')),
        Buffer.from(fixture.before ?? '')
      );
      assert.deepEqual(
        Buffer.from(parsed.additionLines.join('')),
        Buffer.from(fixture.current ?? '')
      );
      if (parsed.type === 'new' || parsed.type === 'deleted') {
        assert.deepEqual(
          getWorktreeDiffExpansion(
            { ...record, content: { status: 'unavailable', reason: 'too_large' } },
            parsed
          ),
          { status: 'complete' }
        );
      }
    });
  }

  it('hydrates nonempty mode-only text without inventing a hunk', t => {
    const fixture = gitFixture(t, { before, current: before, modeChange: true });
    const diff = assertExpanded(fixture, before, before);
    assert.deepEqual(diff.hunks, []);
    assert.equal(diff.prevMode, '100644');
    assert.equal(diff.mode, '100755');
  });

  it('reports empty mode-only text as complete', t => {
    const { record, parsed } = gitFixture(t, { before: '', current: '', modeChange: true });
    assert.deepEqual(getWorktreeDiffExpansion(record, parsed), { status: 'complete' });
  });

  for (const fixture of [
    { name: '9,999 terminated lines', text: 'x\n'.repeat(9_999), rows: 10_000 },
    { name: '10,000 terminated lines', text: 'x\n'.repeat(10_000), rows: 10_001 },
    { name: '10,000 unterminated lines', text: 'x\n'.repeat(9_999) + 'x', rows: 10_000 },
  ]) {
    it(`enforces the native File row budget for mode-only ${fixture.name}`, async t => {
      const saved = gitFixture(t, {
        before: fixture.text,
        current: fixture.text,
        modeChange: true,
      });
      const original = structuredClone(saved);
      assert.equal(saved.parsed.hunks.length, 0);
      await preloadHighlighter({ langs: ['text'], themes: ['pierre-dark'] });
      const renderer = new FileRenderer({ theme: 'pierre-dark', disableFileHeader: true });
      t.after(() => renderer.cleanUp());
      const rendered = renderer.renderFile({
        name: saved.record.path,
        contents: fixture.text,
        lang: 'text',
      });
      assert.ok(rendered);
      assert.equal(rendered.totalLines, fixture.rows);
      if (fixture.rows > MAX_WORKTREE_PATCH_LINES) {
        const expansion = getWorktreeDiffExpansion(saved.record, saved.parsed);
        assert.equal(expansion.status, 'unavailable');
        assert.deepEqual(expansion, { status: 'unavailable', reason: 'line_limit' });
        assert.equal(saved.parsed.isPartial, true);
        const html = renderFile(saved.record, 'expanded');
        assert.match(html, /Metadata-only change/);
        assert.match(html, /100644/);
        assert.match(html, /100755/);
        assert.doesNotMatch(html, /Loading saved file viewer|Hide unchanged lines/);
      } else {
        assertExpanded(saved, fixture.text, fixture.text);
      }
      assert.deepEqual(saved, original);
    });
  }

  it('preserves omission reasons rather than manufacturing missing full text', t => {
    const { record, parsed } = gitFixture(t, { before, current });
    for (const reason of worktreeFileOmissionReasonSchema.options) {
      assert.deepEqual(
        getWorktreeDiffExpansion({ ...record, content: { status: 'unavailable', reason } }, parsed),
        { status: 'unavailable', reason }
      );
    }
  });

  it('never uses deleted-original content as the current side of a changed file', t => {
    const { record, parsed } = gitFixture(t, { before, current });
    assert.deepEqual(
      getWorktreeDiffExpansion(
        { ...record, content: { status: 'available', source: 'deleted-original', text: current } },
        parsed
      ),
      { status: 'unavailable', reason: 'inconsistent' }
    );
  });

  it('keeps the saved partial patch usable when the current hunk text mismatches', async t => {
    const { record, parsed } = gitFixture(t, { before, current });
    const mismatched: WorktreeFileRecord = {
      ...record,
      content: {
        status: 'available',
        source: 'current',
        text: current.replace('inserted_one', 'PRIVATE_SENTINEL'),
      },
    };
    const original = structuredClone(parsed);
    assert.deepEqual(getWorktreeDiffExpansion(mismatched, parsed), {
      status: 'unavailable',
      reason: 'inconsistent',
    });
    assert.deepEqual(parsed, original);
    const renderer = await createDiffRenderer(t);
    renderer.mergeOptions({ expandUnchanged: true });
    const result = renderer.renderDiff(parsed);
    assert.ok(result);
    assert.equal(
      result.rowCount - result.hunkData.length,
      parsed.hunks.reduce((count, hunk) => count + hunk.unifiedLineCount, 0)
    );
    const html = renderer.renderFullHTML(result);
    assert.match(html, /inserted_one/);
    assert.doesNotMatch(html, /PRIVATE_SENTINEL|line_001|line_160/);
    for (const mode of ['diff', 'expanded'] as const) {
      assert.doesNotMatch(
        renderFile(mismatched, mode),
        /PRIVATE_SENTINEL|This saved diff could not be rendered/
      );
    }
  });

  for (const fixture of [
    { name: 'changed hunk context', text: current.replace('line_020', 'different') },
    { name: 'different line endings', text: current.replaceAll('\n', '\r\n') },
    { name: 'a truncated current side', text: current.slice(0, 100) },
  ]) {
    it(`rejects ${fixture.name}`, t => {
      const { record, parsed } = gitFixture(t, { before, current });
      assert.deepEqual(
        getWorktreeDiffExpansion(
          { ...record, content: { status: 'available', source: 'current', text: fixture.text } },
          parsed
        ),
        { status: 'unavailable', reason: 'inconsistent' }
      );
    });
  }

  it('rejects a current tail that would follow an unterminated old EOF line', t => {
    const { record, parsed } = gitFixture(t, { before: `${before}old`, current: `${before}new\n` });
    assert.deepEqual(
      getWorktreeDiffExpansion(
        {
          ...record,
          content: { status: 'available', source: 'current', text: `${before}new\nextra\n` },
        },
        parsed
      ),
      { status: 'unavailable', reason: 'inconsistent' }
    );
  });

  for (const fixture of [
    {
      name: 'negative start',
      mutate(diff: FileDiffMetadata) {
        diff.hunks[0].additionStart = -1;
      },
    },
    {
      name: 'unsafe start',
      mutate(diff: FileDiffMetadata) {
        diff.hunks[0].deletionStart = Number.MAX_SAFE_INTEGER + 1;
      },
    },
    {
      name: 'fractional count',
      mutate(diff: FileDiffMetadata) {
        diff.hunks[0].additionCount += 0.5;
      },
    },
    {
      name: 'nonempty zero start',
      mutate(diff: FileDiffMetadata) {
        diff.hunks[0].additionStart = 0;
      },
    },
    {
      name: 'unequal unchanged gaps',
      mutate(diff: FileDiffMetadata) {
        diff.hunks[1].deletionStart++;
      },
    },
    {
      name: 'overlapping current hunks',
      mutate(diff: FileDiffMetadata) {
        diff.hunks[1].additionStart = diff.hunks[0].additionStart;
      },
    },
    {
      name: 'overlapping old hunks',
      mutate(diff: FileDiffMetadata) {
        diff.hunks[1].deletionStart = diff.hunks[0].deletionStart;
      },
    },
    {
      name: 'out-of-order hunks',
      mutate(diff: FileDiffMetadata) {
        diff.hunks.reverse();
      },
    },
    {
      name: 'invalid compact addition index',
      mutate(diff: FileDiffMetadata) {
        diff.hunks[1].additionLineIndex++;
      },
    },
    {
      name: 'invalid compact deletion index',
      mutate(diff: FileDiffMetadata) {
        diff.hunks[1].deletionLineIndex++;
      },
    },
    {
      name: 'truncated old chunks',
      mutate(diff: FileDiffMetadata) {
        diff.deletionLines.pop();
      },
    },
    {
      name: 'unclaimed compact lines',
      mutate(diff: FileDiffMetadata) {
        diff.additionLines.push('extra\n');
      },
    },
    {
      name: 'internally unterminated old chunks',
      mutate(diff: FileDiffMetadata) {
        diff.deletionLines[0] = diff.deletionLines[0].slice(0, -1);
      },
    },
  ]) {
    it(`rejects ${fixture.name} without mutating the parsed input`, t => {
      const { record, parsed } = gitFixture(t, { before, current });
      fixture.mutate(parsed);
      const original = structuredClone(parsed);
      assert.deepEqual(getWorktreeDiffExpansion(record, parsed), {
        status: 'unavailable',
        reason: 'inconsistent',
      });
      assert.deepEqual(parsed, original);
    });
  }

  it('catches native hydration failures as a generic unavailable result', t => {
    const { record, parsed } = gitFixture(t, { before, current });
    const nonPartial = { ...parsed, isPartial: false };
    assert.deepEqual(getWorktreeDiffExpansion(record, nonPartial), {
      status: 'unavailable',
      reason: 'inconsistent',
    });
    assert.equal(nonPartial.isPartial, false);
  });

  for (const lineCount of [9_999, 10_000]) {
    it(`enforces the expanded unified budget with ${lineCount} current lines plus a deletion`, async t => {
      const prefix = 'x\n'.repeat(4_500);
      const suffix = 'x\n'.repeat(lineCount - 4_501);
      const fixture = gitFixture(t, {
        before: `${prefix}old\n${suffix}`,
        current: `${prefix}new\n${suffix}`,
      });
      assert.ok(lineCount <= MAX_WORKTREE_CONTENT_LINES);
      assert.ok(fixture.record.diff.status === 'available');
      assert.ok(
        fixture.record.diff.patch.split(SPLIT_WITH_NEWLINES).length <= MAX_WORKTREE_PATCH_LINES
      );
      const expansion = getWorktreeDiffExpansion(fixture.record, fixture.parsed);
      if (lineCount === 10_000) {
        assert.deepEqual(expansion, { status: 'unavailable', reason: 'line_limit' });
        assert.equal(fixture.parsed.isPartial, true);
      } else {
        assert.ok(expansion.status === 'available');
        const renderer = await createDiffRenderer(t);
        renderer.mergeOptions({ expandUnchanged: true });
        const result = renderer.renderDiff(expansion.diff);
        assert.ok(result);
        assert.equal(result.rowCount, 10_000);
      }
    });
  }

  for (const lineCount of [9_997, 9_998]) {
    it(`includes native EOF metadata rows in the ${lineCount}-line expansion budget`, async t => {
      const prefix = 'x\n'.repeat(lineCount - 1);
      const fixture = gitFixture(t, { before: `${prefix}old`, current: `${prefix}new` });
      const expansion = getWorktreeDiffExpansion(fixture.record, fixture.parsed);
      if (lineCount === 9_998) {
        assert.deepEqual(expansion, { status: 'unavailable', reason: 'line_limit' });
      } else {
        assert.ok(expansion.status === 'available');
        const renderer = await createDiffRenderer(t);
        renderer.mergeOptions({ expandUnchanged: true });
        const result = renderer.renderDiff(expansion.diff);
        assert.ok(result);
        assert.equal(result.rowCount, 10_000);
      }
    });
  }
});

describe('saved file highlighter initialization', () => {
  for (const mode of ['expanded', 'diff'] as const) {
    for (const fault of ['language', 'theme'] as const) {
      it(`catches ${mode} ${fault} loader rejection without publishing an error payload`, async t => {
        assertSilentAsyncWork(t);
        const name = `worktree-file-${mode}-${fault}-failure`;
        const error = new Error('PRIVATE_FAULT_SENTINEL');
        let path = 'file.txt';
        let preload = preloadHighlighter;
        if (fault === 'language') {
          path = `file.${name}`;
          registerCustomLanguage(name, async () => {
            throw error;
          }, [name]);
        } else {
          registerCustomTheme(name, async () => {
            throw error;
          });
          preload = options => preloadHighlighter({ ...options, themes: [name] });
        }
        const result = await new Promise<WorktreeFileHighlighterResult>(resolve => {
          t.after(prepareWorktreeFileHighlighter(path, resolve, preload));
        });
        await setImmediate();
        assert.deepEqual(result, { status: 'error' });
      });
    }
  }

  it('catches synchronous initialization failures as the same generic state', async t => {
    assertSilentAsyncWork(t);
    const result = await new Promise<WorktreeFileHighlighterResult>(resolve => {
      t.after(
        prepareWorktreeFileHighlighter(file.path, resolve, () => {
          throw new Error('PRIVATE_FAULT_SENTINEL');
        })
      );
    });
    await setImmediate();
    assert.deepEqual(result, { status: 'error' });
  });

  for (const fixture of [
    { path: file.path, lang: 'typescript' },
    { path: 'README.unsupported-saved-file', lang: 'text' },
    { path: 'constructor', lang: 'text' },
  ]) {
    it(`prepares ${fixture.path} before synchronous mode-only expansion and diff rendering`, async t => {
      assertSilentAsyncWork(t);
      const result = await new Promise<WorktreeFileHighlighterResult>(resolve => {
        t.after(prepareWorktreeFileHighlighter(fixture.path, resolve));
      });
      assert.equal(result.status, 'ready');
      if (result.status !== 'ready') return;
      assert.equal(result.lang, fixture.lang);

      const contents = 'first\nnew value\nlast\n';
      const modeOnly = gitFixture(t, {
        before: contents,
        current: contents,
        path: fixture.path,
        modeChange: true,
      });
      const expanded = assertExpanded(modeOnly, contents, contents);
      const fileRenderer = new FileRenderer({ theme: 'pierre-dark', disableFileHeader: true });
      const fileInitialize = mock.method(fileRenderer, 'initializeHighlighter', async () => {
        throw new Error('Unexpected asynchronous mode-only initialization');
      });
      t.after(() => fileRenderer.cleanUp());
      const unchanged = {
        name: expanded.name,
        contents: expanded.additionLines.join(''),
        lang: result.lang,
      };
      fileRenderer.hydrate(unchanged);
      const fileResult = fileRenderer.renderFile(unchanged);
      assert.ok(fileResult);
      assert.equal(fileResult.totalLines, unchanged.contents.split('\n').length);
      const fileHtml = fileRenderer.renderFullHTML(fileResult);
      assert.match(fileHtml, /first/);
      assert.match(fileHtml, /new/);
      assert.match(fileHtml, /last/);
      assert.equal(fileInitialize.mock.callCount(), 0);

      const parsed = parseSavedWorktreePatch(patch, fixture.path);
      assert.ok(parsed);
      const diff = { ...parsed, lang: result.lang };
      const diffRenderer = new DiffHunksRenderer({
        theme: 'pierre-dark',
        disableFileHeader: true,
        diffStyle: 'unified',
        overflow: 'wrap',
        diffIndicators: 'classic',
      });
      const diffInitialize = mock.method(diffRenderer, 'initializeHighlighter', async () => {
        throw new Error('Unexpected asynchronous diff initialization');
      });
      t.after(() => diffRenderer.cleanUp());
      diffRenderer.hydrate(diff);
      const diffResult = diffRenderer.renderDiff(diff);
      assert.ok(diffResult);
      assert.equal(diffResult.rowCount, 4);
      const diffHtml = diffRenderer.renderFullHTML(diffResult);
      assert.match(diffHtml, /first/);
      assert.match(diffHtml, /old/);
      assert.match(diffHtml, /new/);
      assert.match(diffHtml, /last/);
      assert.equal(diffInitialize.mock.callCount(), 0);
      await setImmediate();
    });
  }

  it('renders complete near-limit mode-only expansion and diff payloads after initialization', async t => {
    assertSilentAsyncWork(t);
    const path = 'limit.txt';
    const result = await new Promise<WorktreeFileHighlighterResult>(resolve => {
      t.after(prepareWorktreeFileHighlighter(path, resolve));
    });
    assert.equal(result.status, 'ready');
    if (result.status !== 'ready') return;

    const fileEnd = 'UNCHANGED_EOF';
    const contents = 'x'.repeat(MAX_WORKTREE_CONTENT_BYTES - fileEnd.length - 1) + fileEnd;
    assert.equal(new TextEncoder().encode(contents).byteLength, MAX_WORKTREE_CONTENT_BYTES - 1);
    const modeOnly = gitFixture(t, { before: contents, current: contents, path, modeChange: true });
    const expanded = assertExpanded(modeOnly, contents, contents);
    const fileRenderer = new FileRenderer({ theme: 'pierre-dark', disableFileHeader: true });
    t.after(() => fileRenderer.cleanUp());
    const fileResult = fileRenderer.renderFile({
      name: path,
      contents: expanded.additionLines.join(''),
      lang: result.lang,
    });
    assert.ok(fileResult);
    assert.match(fileRenderer.renderFullHTML(fileResult), /UNCHANGED_EOF/);

    const lineLength = (MAX_WORKTREE_FILE_BYTES - 2048) / 2;
    const largePatch = `diff --git a/limit.txt b/limit.txt\nindex 1234567..abcdef0 100644\n--- a/limit.txt\n+++ b/limit.txt\n@@ -1 +1 @@\n-${'a'.repeat(lineLength)}OLD_EOF\n+${'b'.repeat(lineLength)}NEW_EOF\n`;
    const record: WorktreeFileRecord = {
      ...file,
      path,
      diff: { status: 'available', patch: largePatch },
      content: { status: 'unavailable', reason: 'too_large' },
    };
    assert.equal(worktreeFileRecordSchema.safeParse(record).success, true);
    const encodedBytes = new TextEncoder().encode(JSON.stringify(record)).byteLength;
    assert.ok(encodedBytes <= MAX_WORKTREE_FILE_BYTES);
    assert.ok(encodedBytes > MAX_WORKTREE_FILE_BYTES - 2048);
    const parsed = parseSavedWorktreePatch(largePatch, path);
    assert.ok(parsed);
    const diffRenderer = new DiffHunksRenderer({
      theme: 'pierre-dark',
      disableFileHeader: true,
      diffStyle: 'unified',
      overflow: 'wrap',
    });
    t.after(() => diffRenderer.cleanUp());
    const diffResult = diffRenderer.renderDiff({ ...parsed, lang: result.lang });
    assert.ok(diffResult);
    assert.equal(diffResult.rowCount, 2);
    const html = diffRenderer.renderFullHTML(diffResult);
    assert.match(html, /OLD_EOF/);
    assert.match(html, /NEW_EOF/);
    await setImmediate();
  });

  for (const change of ['path', 'revision', 'mode', 'unmount'] as const) {
    for (const completion of ['resolve', 'reject'] as const) {
      it(`ignores late ${completion} after ${change} cleanup`, async t => {
        assertSilentAsyncWork(t);
        const pending = Promise.withResolvers<void>();
        const oldResults: WorktreeFileHighlighterResult[] = [];
        const stop = prepareWorktreeFileHighlighter(
          file.path,
          result => oldResults.push(result),
          () => pending.promise
        );
        assert.deepEqual(oldResults, []);
        stop();

        const currentResults: WorktreeFileHighlighterResult[] = [];
        if (change !== 'unmount') {
          const currentPath = change === 'path' ? 'next.sql' : file.path;
          const current = await new Promise<WorktreeFileHighlighterResult>(resolve => {
            t.after(
              prepareWorktreeFileHighlighter(currentPath, result => {
                currentResults.push(result);
                resolve(result);
              })
            );
          });
          assert.equal(current.status, 'ready');
        }
        if (completion === 'resolve') pending.resolve();
        else pending.reject(new Error('PRIVATE_FAULT_SENTINEL'));
        await setImmediate();
        assert.deepEqual(oldResults, []);
        assert.equal(currentResults.length, change === 'unmount' ? 0 : 1);
      });
    }
  }

  for (const completion of ['resolve', 'reject'] as const) {
    it(`keeps effect replay safe when a shared preload promise will ${completion}`, async t => {
      assertSilentAsyncWork(t);
      const pending = Promise.withResolvers<void>();
      const first: WorktreeFileHighlighterResult[] = [];
      const current: WorktreeFileHighlighterResult[] = [];
      const stop = prepareWorktreeFileHighlighter(
        file.path,
        result => first.push(result),
        () => pending.promise
      );
      if (completion === 'resolve') pending.resolve();
      else pending.reject(new Error('PRIVATE_FAULT_SENTINEL'));
      stop();
      t.after(
        prepareWorktreeFileHighlighter(
          file.path,
          result => current.push(result),
          () => pending.promise
        )
      );
      await setImmediate();
      assert.deepEqual(first, []);
      assert.deepEqual(
        current,
        completion === 'resolve' ? [{ status: 'ready', lang: 'typescript' }] : [{ status: 'error' }]
      );
    });
  }

  it('publishes readiness only after the full initialization promise settles', async t => {
    assertSilentAsyncWork(t);
    const pending = Promise.withResolvers<void>();
    const results: WorktreeFileHighlighterResult[] = [];
    t.after(
      prepareWorktreeFileHighlighter(
        file.path,
        result => results.push(result),
        () => pending.promise
      )
    );
    await setImmediate();
    assert.deepEqual(results, []);
    pending.resolve();
    await setImmediate();
    assert.deepEqual(results, [{ status: 'ready', lang: 'typescript' }]);
  });
});

describe('saved file view modes', () => {
  function button(html: string, label: string) {
    const control = html
      .match(/<button\b[^>]*>/g)
      ?.find(tag => tag.includes(`aria-label="${label}"`));
    assert.ok(control, `Missing ${label} control`);
    return control;
  }

  it('defaults every file to Diff and makes Markdown Preview explicit', () => {
    assert.equal(getWorktreeFileViewMode(file, undefined), 'diff');
    for (const path of ['README.md', 'README.MD', 'guide.Markdown', 'guide.MARKDOWN']) {
      assert.equal(getWorktreeFileViewMode({ ...file, path }, undefined), 'diff');
      assert.equal(getWorktreeFileViewMode({ ...file, path }, 'preview'), 'preview');
    }
    assert.equal(getWorktreeFileViewMode({ ...file, path: 'guide.mdx' }, 'preview'), 'diff');
    assert.equal(getWorktreeFileViewMode(file, 'preview'), 'diff');
  });

  it('keeps one diff view with Show all lines rather than a Diff/Source switch', t => {
    const before = 'unchanged\n'.repeat(40) + 'old\n';
    const current = 'unchanged\n'.repeat(40) + 'new\n';
    const { record } = gitFixture(t, { before, current });
    assert.equal(getWorktreeFileViewMode(record, 'expanded'), 'expanded');
    const collapsed = renderFile(record, 'diff');
    assert.match(button(collapsed, 'Show all lines'), /aria-disabled="false"/);
    assert.match(button(collapsed, 'Show all lines'), /aria-pressed="false"/);
    const expanded = renderFile(record, 'expanded');
    assert.match(button(expanded, 'Hide unchanged lines'), /aria-pressed="true"/);
    for (const html of [collapsed, expanded]) {
      assert.doesNotMatch(html, /role="tablist"|aria-label="(?:Source|Diff)"|>Source<|>Diff</);
      assert.doesNotMatch(html, /aria-label="Preview Markdown"/);
    }
  });

  it('disables expansion for a complete diff instead of replacing it with source text', () => {
    const html = renderFile(file, 'expanded');
    assert.match(button(html, 'Show all lines'), /aria-disabled="true"/);
    assert.match(button(html, 'Show all lines'), /aria-pressed="false"/);
  });

  it('keeps mode metadata visible and loads unchanged mode-only text only when expanded', t => {
    const { record } = gitFixture(t, {
      before: 'unchanged\n',
      current: 'unchanged\n',
      modeChange: true,
    });
    const collapsed = renderFile(record, 'diff');
    assert.match(collapsed, /100644/);
    assert.match(collapsed, /100755/);
    assert.doesNotMatch(collapsed, /Loading saved file viewer/);
    const expanded = renderFile(record, 'expanded');
    assert.match(expanded, /100644/);
    assert.match(expanded, /100755/);
    assert.match(expanded, /Loading saved file viewer/);
    assert.match(button(expanded, 'Hide unchanged lines'), /aria-pressed="true"/);
  });

  it('treats empty full text as available without enabling expansion', t => {
    const { record } = gitFixture(t, {
      before: '',
      current: '',
      path: 'README.md',
      modeChange: true,
    });
    assert.equal(getWorktreeFileViewMode(record, undefined), 'diff');
    assert.equal(getWorktreeFileViewMode(record, 'preview'), 'preview');
    assert.equal(getWorktreeFileViewMode(record, 'diff'), 'diff');
    assert.match(button(renderFile(record, 'diff'), 'Show all lines'), /aria-disabled="true"/);
    assert.match(renderFile(record, 'preview'), /This saved file is empty/);
  });

  it('falls back to Diff when the next capture drops full text', () => {
    const omitted: WorktreeFileRecord = {
      ...file,
      revision: 4,
      path: 'README.md',
      content: { status: 'unavailable', reason: 'budget_exhausted' },
    };
    assert.equal(getWorktreeFileViewMode(omitted, 'preview'), 'diff');
    assert.equal(getWorktreeFileViewMode(omitted, 'expanded'), 'diff');
    assert.equal(getWorktreeFileViewMode(omitted, undefined), 'diff');
    const html = renderFile(omitted, 'expanded');
    assert.match(button(html, 'Show all lines'), /aria-disabled="true"/);
    assert.match(button(html, 'Preview Markdown'), /aria-disabled="true"/);
    assert.doesNotMatch(html, /new value|Hide unchanged lines/);
  });

  it('falls back to the partial diff when saved current text is inconsistent', () => {
    const html = renderFile(
      { ...file, content: { status: 'available', source: 'current', text: 'different\n' } },
      'expanded'
    );
    assert.match(button(html, 'Show all lines'), /aria-disabled="true"/);
    assert.match(button(html, 'Show all lines'), /aria-pressed="false"/);
    assert.doesNotMatch(html, /This saved diff could not be rendered|different/);
  });

  it('previews deleted Markdown as the original without enabling diff expansion', t => {
    const { record } = gitFixture(t, {
      before: '# Deleted original\n',
      current: null,
      path: 'README.md',
    });
    assert.equal(getWorktreeFileViewMode(record, undefined), 'diff');
    const html = renderFile(record, 'preview');
    assert.match(html, /<h1>Deleted original<\/h1>/);
    assert.match(button(html, 'Show all lines'), /aria-disabled="true"/);
    assert.match(button(html, 'Preview Markdown'), /aria-pressed="true"/);
  });
});

describe('saved Markdown safety', () => {
  it('renders GFM while leaving unsupported links inert and images as alt text only', () => {
    const html = renderFile(
      {
        ...file,
        path: 'README.md',
        content: {
          status: 'available',
          source: 'current',
          text: '# Saved\n\n[HTTPS](https://example.test/read) [HTTP](http://example.test/read) [Relative](./README.md) [Protocol-relative](//example.test/read) [Script](javascript:alert%281%29) [Data](data:text/html,bad) [Mail](mailto:user@example.test)\n\n![Image alt](https://example.test/tracker.png)\n\n<script>window.evil = true</script>\n\n<img src="https://example.test/raw.png" onerror="evil()" />\n\n<UnsafeComponent run={evil()} />\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n~~removed~~',
        },
      },
      'preview'
    );
    assert.match(html, /<h1>Saved<\/h1>/);
    assert.match(html, /<table>/);
    assert.match(html, /<del>removed<\/del>/);
    assert.match(
      html,
      /href="https:\/\/example.test\/read" target="_blank" rel="noopener noreferrer"/
    );
    assert.match(
      html,
      /href="http:\/\/example.test\/read" target="_blank" rel="noopener noreferrer"/
    );
    assert.match(html, /Image alt/);
    assert.match(html, /Relative/);
    assert.match(html, /Script/);
    assert.doesNotMatch(html, /<img|<script|<UnsafeComponent|onerror=|tracker\.png|raw\.png/);
    assert.doesNotMatch(html, /href="(?:\.\/|\/\/|javascript:|data:|mailto:)/);
  });
});

describe('saved file response identity', () => {
  const input = {
    snapshot,
    path: file.path,
    result: available,
    summaryError: false,
    fileError: false,
  };

  it('returns the matched record with its own saved timestamp and comparison', () => {
    assert.equal(getSavedWorktreeFileState(input), available);
  });

  it('never relabels an old record with the current revision', () => {
    assert.deepEqual(
      getSavedWorktreeFileState({ ...input, snapshot: { ...snapshot, revision: 4 } }),
      { status: 'stale' }
    );
  });

  it('does not display a record from another exact path', () => {
    assert.deepEqual(
      getSavedWorktreeFileState({
        ...input,
        result: { ...available, file: { ...file, path: 'src/other.ts' } },
      }),
      { status: 'error' }
    );
  });

  it('hides cached bodies when the file is no longer listed or no capture exists', () => {
    assert.deepEqual(
      getSavedWorktreeFileState({ ...input, snapshot: { ...snapshot, files: [] } }),
      { status: 'no_longer_listed' }
    );
    assert.deepEqual(getSavedWorktreeFileState({ ...input, snapshot: null }), {
      status: 'not_captured',
    });
    assert.deepEqual(getSavedWorktreeFileState({ ...input, snapshot: undefined }), {
      status: 'loading',
    });
  });

  it('shows read failures without exposing a cached body or error payload', () => {
    assert.deepEqual(getSavedWorktreeFileState({ ...input, summaryError: true }), {
      status: 'error',
    });
    assert.deepEqual(getSavedWorktreeFileState({ ...input, fileError: true }), { status: 'error' });
    assert.deepEqual(getSavedWorktreeFileState({ ...input, result: undefined }), {
      status: 'loading',
    });
  });

  it('preserves explicit stale, not-captured, no-longer-listed, and omitted results', () => {
    for (const status of ['stale', 'no_longer_listed'] as const) {
      assert.deepEqual(
        getSavedWorktreeFileState({ ...input, result: { status, currentRevision: 4 } }),
        { status }
      );
    }
    assert.deepEqual(getSavedWorktreeFileState({ ...input, result: { status: 'not_captured' } }), {
      status: 'not_captured',
    });
    const omitted: GetWorktreeFileOutput = {
      ...available,
      status: 'omitted',
      file: {
        ...file,
        diff: { status: 'omitted', reason: 'binary' },
        content: { status: 'unavailable', reason: 'binary' },
      },
    };
    assert.equal(getSavedWorktreeFileState({ ...input, result: omitted }), omitted);
    assert.match(renderFile(omitted.file, 'diff'), /Diff omitted\. This is a binary file/);
  });
});
