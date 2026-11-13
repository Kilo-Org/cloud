import { describe, expect, it } from 'vitest';

import {
  MAX_WORKTREE_REVIEW_COMMENT_LENGTH,
  WORKTREE_REVIEW_PROMPT_INTRO,
  addWorktreeReviewComment,
  createWorktreeReviewAnchorFromPatch,
  deriveWorktreeReviewRange,
  getWorktreeReviewAnchorError,
  getWorktreeReviewCommentsError,
  removeWorktreeReviewComment,
  sameWorktreeReviewCapture,
  serializeWorktreeReview,
  updateWorktreeReviewComment,
  type WorktreeReviewCapture,
  type WorktreeReviewComment,
} from './index';

const capture: WorktreeReviewCapture = {
  userId: 'user-one',
  organizationId: undefined,
  workspaceScope: 'worktree:one',
  sourceCloudAgentSessionId: 'workspace_00000000-0000-4000-8000-000000000000',
  revision: 7,
  capturedAt: '2026-11-12T10:00:00.000Z',
  comparison: {
    baseRef: 'main',
    mergeBase: 'a'.repeat(40),
    head: 'b'.repeat(40),
  },
};

const PATCH = [
  'diff --git a/src/app.ts b/src/app.ts',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,4 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' const d = 5;',
  '',
].join('\n');

function comment(id: string, anchor = anchorFor(2, 'additions').anchor): WorktreeReviewComment {
  return { id, anchor, text: `feedback ${id}` };
}

function anchorFor(lineNumber: number, side: 'deletions' | 'additions') {
  const result = createWorktreeReviewAnchorFromPatch({
    capture,
    path: 'src/app.ts',
    patch: PATCH,
    line: { side, lineNumber },
  });
  if (!result.ok) throw new Error(result.error);
  return { ok: true as const, anchor: result.value };
}

describe('createWorktreeReviewAnchorFromPatch', () => {
  it('quotes an added line with its trailing newline', () => {
    const anchor = anchorFor(2, 'additions').anchor;
    expect(anchor.range).toEqual({ side: 'additions', startLine: 2, endLine: 2 });
    expect(anchor.quote).toEqual({
      source: 'saved-patch',
      lines: [{ lineNumber: 2, kind: 'addition', text: 'const b = 3;\n' }],
    });
    expect(getWorktreeReviewAnchorError(anchor)).toBeUndefined();
  });

  it('anchors a context line to the new file number', () => {
    const anchor = anchorFor(1, 'additions').anchor;
    expect(anchor.quote.lines).toEqual([
      { lineNumber: 1, kind: 'context', text: 'const a = 1;\n' },
    ]);
    expect(anchor.range).toEqual({ side: 'additions', startLine: 1, endLine: 1 });
  });

  it('keeps a deleted line on the deletions side with its old number', () => {
    const anchor = anchorFor(2, 'deletions').anchor;
    expect(anchor.quote.lines).toEqual([
      { lineNumber: 2, kind: 'deletion', text: 'const b = 2;\n' },
    ]);
    expect(anchor.range).toEqual({ side: 'deletions', startLine: 2, endLine: 2 });
  });

  it('rejects a line the patch does not hold', () => {
    const result = createWorktreeReviewAnchorFromPatch({
      capture,
      path: 'src/app.ts',
      patch: PATCH,
      line: { side: 'additions', lineNumber: 99 },
    });
    expect(result).toEqual({
      ok: false,
      error: 'The selected lines are not fully available in this saved diff.',
    });
  });

  it('rejects an empty patch and an invalid path', () => {
    expect(
      createWorktreeReviewAnchorFromPatch({
        capture,
        path: 'src/app.ts',
        patch: '',
        line: { side: 'additions', lineNumber: 1 },
      }).ok
    ).toBe(false);
    expect(
      createWorktreeReviewAnchorFromPatch({
        capture,
        path: '../escape.ts',
        patch: PATCH,
        line: { side: 'additions', lineNumber: 1 },
      })
    ).toEqual({ ok: false, error: 'The saved review path is invalid.' });
  });

  it('drops the newline a no-newline marker takes away', () => {
    const patch = ['@@ -1 +1 @@', '-one', '+two', '\\ No newline at end of file', ''].join('\n');
    const result = createWorktreeReviewAnchorFromPatch({
      capture,
      path: 'note.txt',
      patch,
      line: { side: 'additions', lineNumber: 1 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.quote.lines[0]?.text).toBe('two');
  });
});

describe('serializeWorktreeReview', () => {
  it('writes the intro, a blank line, and the review payload', () => {
    const result = serializeWorktreeReview([comment('one')]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.startsWith(`${WORKTREE_REVIEW_PROMPT_INTRO}\n\n`)).toBe(true);
    const payload = JSON.parse(result.value.slice(WORKTREE_REVIEW_PROMPT_INTRO.length + 2));
    expect(payload.version).toBe(1);
    expect(payload.overall).toBeUndefined();
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0]).toMatchObject({
      id: 'one',
      contextStatus: 'current-saved-capture',
      text: 'feedback one',
    });
    expect(payload.comments[0].anchor.range).toEqual({
      side: 'additions',
      startLine: 2,
      endLine: 2,
    });
  });

  it('trims the overall comment into the payload', () => {
    const result = serializeWorktreeReview([comment('one')], { overall: '  please fix  ' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = JSON.parse(result.value.slice(WORKTREE_REVIEW_PROMPT_INTRO.length + 2));
    expect(payload.overall).toBe('please fix');
  });

  it('refuses an empty review and over-long feedback', () => {
    expect(serializeWorktreeReview([])).toEqual({
      ok: false,
      error: 'Add a comment before sending the review.',
    });
    const tooLong = { ...comment('one'), text: 'x'.repeat(MAX_WORKTREE_REVIEW_COMMENT_LENGTH + 1) };
    expect(serializeWorktreeReview([tooLong]).ok).toBe(false);
  });
});

describe('review comment collection', () => {
  it('rejects duplicate identifiers and mixed scopes', () => {
    const first = comment('one');
    expect(addWorktreeReviewComment([first], comment('one')).ok).toBe(false);
    const otherCapture = { ...capture, workspaceScope: 'worktree:two' };
    const otherAnchor = createWorktreeReviewAnchorFromPatch({
      capture: otherCapture,
      path: 'src/app.ts',
      patch: PATCH,
      line: { side: 'additions', lineNumber: 2 },
    });
    expect(otherAnchor.ok).toBe(true);
    if (!otherAnchor.ok) return;
    expect(
      getWorktreeReviewCommentsError([
        first,
        { id: 'two', anchor: otherAnchor.value, text: 'elsewhere' },
      ])
    ).toBe('Review comments must belong to the same account, organization, and worktree.');
  });

  it('adds, updates, and removes a comment immutably', () => {
    const added = addWorktreeReviewComment([], comment('one'));
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const updated = updateWorktreeReviewComment(added.value, 'one', 'new text');
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value[0]?.text).toBe('new text');
    expect(removeWorktreeReviewComment(updated.value, 'one')).toEqual([]);
    expect(updateWorktreeReviewComment(updated.value, 'missing', 'x')).toEqual({
      ok: false,
      error: 'This review comment no longer exists.',
    });
  });

  it('derives the additions side whenever a context line is in the quote', () => {
    expect(
      deriveWorktreeReviewRange([
        { lineNumber: 4, kind: 'deletion', text: 'a\n' },
        { lineNumber: 5, kind: 'context', text: 'b\n' },
      ])
    ).toEqual({ side: 'additions', startLine: 5, endLine: 5 });
  });

  it('compares captures by revision, scope, and comparison', () => {
    expect(sameWorktreeReviewCapture(capture, { ...capture })).toBe(true);
    expect(sameWorktreeReviewCapture(capture, { ...capture, revision: 8 })).toBe(false);
    expect(
      sameWorktreeReviewCapture(capture, {
        ...capture,
        comparison: { ...capture.comparison, head: 'c'.repeat(40) },
      })
    ).toBe(false);
  });
});
