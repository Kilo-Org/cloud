import { describe, expect, it } from 'vitest';

import { buildFileItems } from '@/lib/pr-review/diff/pr-diff-list-builder';
import { type DiffFileSource, type ListItem } from '@/lib/pr-review/diff/pr-diff-list-items';
import { type PrReviewFile } from '@/lib/pr-review/diff/pr-review-file-types';

// The first hunk starts at line 5 and the file continues past it, so a PR
// build emits a leading and a trailing expand separator.
const patch = [
  'diff --git a/a.ts b/a.ts',
  '@@ -5,3 +5,3 @@',
  ' context line 5',
  '-old line 6',
  '+new line 6',
  ' context line 7',
].join('\n');

const textFile: PrReviewFile = {
  path: 'a.ts',
  previousPath: null,
  status: 'modified',
  additions: 1,
  deletions: 1,
  patch,
  patchMissing: false,
};

const binaryFile: PrReviewFile = {
  path: 'logo.png',
  previousPath: null,
  status: 'added',
  additions: 0,
  deletions: 0,
  patch: null,
  patchMissing: true,
};

const prSource: DiffFileSource = {
  kind: 'pr',
  owner: 'owner',
  repo: 'repo',
  number: 1,
  headSha: 'abc',
  expandedContext: {},
  viewed: () => false,
};

function build(source: DiffFileSource): ListItem[] {
  return buildFileItems({
    files: [textFile, binaryFile],
    expanded: { 'a.ts': true, 'logo.png': true },
    changedFiles: 2,
    source,
  });
}

function ofKind<K extends ListItem['kind']>(items: ListItem[], kind: K) {
  return items.filter((item): item is Extract<ListItem, { kind: K }> => item.kind === kind);
}

describe('buildFileItems diff source', () => {
  it('builds a session diff without expand separators, viewed state, or GitHub links', () => {
    const items = build({ kind: 'session' });
    expect(ofKind(items, 'expand-separator')).toHaveLength(0);
    expect(ofKind(items, 'file-header').map(item => item.viewed)).toEqual([null, null]);
    expect(ofKind(items, 'file-patch-missing')).toMatchObject([
      { file: { path: 'logo.png' }, viewed: null, githubUrl: null },
    ]);
    expect(ofKind(items, 'diff-line').length).toBeGreaterThan(0);
  });

  it('keeps expand separators, viewed state, and the GitHub link on a PR diff', () => {
    const items = build(prSource);
    expect(ofKind(items, 'expand-separator').length).toBeGreaterThan(0);
    expect(ofKind(items, 'file-header').map(item => item.viewed)).toEqual([false, false]);
    expect(ofKind(items, 'file-patch-missing')[0]?.githubUrl).toBe(
      'https://github.com/owner/repo/pull/1/files#diff-logo.png'
    );
  });
});
