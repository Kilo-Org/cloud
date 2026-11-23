import { describe, expect, it } from 'vitest';

import { buildFileItems } from '@/lib/pr-review/diff/pr-diff-list-builder';
import { type DiffFileSource, type ListItem } from '@/lib/pr-review/diff/pr-diff-list-items';
import { type PrReviewFile } from '@/lib/pr-review/diff/pr-review-file-types';
import { providerPrFileUrl, type ProviderPrLink } from '@/lib/pr-review/provider-pr-ref';

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
  patchMissingCause: null,
};

const binaryFile: PrReviewFile = {
  path: 'logo.png',
  previousPath: null,
  status: 'added',
  additions: 0,
  deletions: 0,
  patch: null,
  patchMissingCause: 'binary',
};

const githubLink: ProviderPrLink = {
  ref: { platform: 'github', owner: 'owner', repo: 'repo', number: 1 },
  serverWebUrl: null,
};

const prSource: DiffFileSource = {
  kind: 'pr',
  owner: 'owner',
  repo: 'repo',
  number: 1,
  headSha: 'abc',
  expandedContext: {},
  viewed: () => false,
  link: path => {
    const url = providerPrFileUrl(githubLink, path);
    return url === null ? null : { url, provider: 'github' };
  },
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
  it('builds a session diff without expand separators, viewed state, or provider links', () => {
    const items = build({ kind: 'session' });
    expect(ofKind(items, 'expand-separator')).toHaveLength(0);
    expect(ofKind(items, 'file-header').map(item => item.viewed)).toEqual([null, null]);
    expect(ofKind(items, 'file-patch-missing')).toMatchObject([
      { file: { path: 'logo.png' }, link: null },
    ]);
    expect(ofKind(items, 'diff-line').length).toBeGreaterThan(0);
  });

  it('keeps expand separators, viewed state, and the provider link on a PR diff', () => {
    const items = build(prSource);
    expect(ofKind(items, 'expand-separator').length).toBeGreaterThan(0);
    expect(ofKind(items, 'file-header').map(item => item.viewed)).toEqual([false, false]);
    expect(ofKind(items, 'file-patch-missing')[0]?.link).toEqual({
      url: 'https://github.com/owner/repo/pull/1/files#diff-logo.png',
      provider: 'github',
    });
    // The card carries no viewed flag of its own: the file header row above it
    // owns the mark-viewed toggle.
    expect(Object.keys(ofKind(items, 'file-patch-missing')[0] ?? {}).sort()).toEqual([
      'file',
      'key',
      'kind',
      'link',
    ]);
  });

  it('passes the file path to the injected link callback', () => {
    const linked: string[] = [];
    build({
      ...prSource,
      link: path => {
        linked.push(path);
        return null;
      },
    });
    expect(linked).toEqual(['logo.png']);
  });

  it('explains a patch-less file while it is collapsed', () => {
    // The row cannot expand, so a cause hidden behind the expand control would
    // never paint: the explanation belongs to the collapsed list.
    const items = buildFileItems({
      files: [binaryFile],
      expanded: {},
      changedFiles: 1,
      source: prSource,
    });
    expect(ofKind(items, 'file-patch-missing')).toMatchObject([
      { file: { path: 'logo.png', patchMissingCause: 'binary' } },
    ]);
    expect(ofKind(items, 'file-header')[0]?.hasDiff).toBe(false);
  });
});
