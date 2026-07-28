import { describe, expect, it } from 'vitest';

import {
  buildSubmitReviewInput,
  reviewSubmitBlockReason,
} from '@/lib/pr-review/build-submit-review-input';
import { type PendingReviewItem } from '@/lib/pr-review/pending-review-provider';

function makeItem(overrides: Partial<PendingReviewItem> = {}): PendingReviewItem {
  return {
    id: 'id-1',
    path: 'src/lib.ts',
    side: 'RIGHT',
    line: 7,
    body: 'Looks good.',
    commitSha: 'head-1',
    ...overrides,
  };
}

describe('buildSubmitReviewInput', () => {
  it('maps a single-line comment without a summary', () => {
    const input = buildSubmitReviewInput({
      owner: 'kilocode',
      repo: 'kilo',
      number: 42,
      event: 'COMMENT',
      commitSha: 'head-2',
      items: [makeItem()],
    });
    expect(input).toEqual({
      owner: 'kilocode',
      repo: 'kilo',
      number: 42,
      event: 'COMMENT',
      commitSha: 'head-2',
      comments: [
        {
          path: 'src/lib.ts',
          line: 7,
          side: 'RIGHT',
          body: 'Looks good.',
        },
      ],
    });
  });

  it('includes startLine and startSide together for multi-line comments', () => {
    const item = makeItem({ startLine: 5, line: 7, side: 'RIGHT' });
    const input = buildSubmitReviewInput({
      owner: 'kilocode',
      repo: 'kilo',
      number: 42,
      event: 'COMMENT',
      commitSha: 'head-2',
      items: [item],
    });
    expect(input.comments?.[0]).toEqual({
      path: 'src/lib.ts',
      line: 7,
      side: 'RIGHT',
      startLine: 5,
      startSide: 'RIGHT',
      body: 'Looks good.',
    });
  });

  it('omits startLine/startSide for single-line comments', () => {
    const item = makeItem({ side: 'LEFT' });
    const input = buildSubmitReviewInput({
      owner: 'kilocode',
      repo: 'kilo',
      number: 42,
      event: 'COMMENT',
      commitSha: 'head-2',
      items: [item],
    });
    const comment = input.comments?.[0];
    expect(comment).not.toHaveProperty('startLine');
    expect(comment).not.toHaveProperty('startSide');
    expect(comment).toEqual({
      path: 'src/lib.ts',
      line: 7,
      side: 'LEFT',
      body: 'Looks good.',
    });
  });

  it('includes a non-empty review body', () => {
    const input = buildSubmitReviewInput({
      owner: 'kilocode',
      repo: 'kilo',
      number: 42,
      event: 'APPROVE',
      body: 'Nice work.',
      commitSha: 'head-2',
      items: [],
    });
    expect(input.body).toBe('Nice work.');
    expect(input.comments).toBeUndefined();
  });

  it('omits an empty review body', () => {
    const input = buildSubmitReviewInput({
      owner: 'kilocode',
      repo: 'kilo',
      number: 42,
      event: 'APPROVE',
      body: '   ',
      commitSha: 'head-2',
      items: [makeItem()],
    });
    expect(input).not.toHaveProperty('body');
  });

  it('omits comments when the queue is empty', () => {
    const input = buildSubmitReviewInput({
      owner: 'kilocode',
      repo: 'kilo',
      number: 42,
      event: 'APPROVE',
      commitSha: 'head-2',
      items: [],
    });
    expect(input.comments).toBeUndefined();
  });

  it('maps the full queue in order, retaining all items for the submit attempt', () => {
    const items = [
      makeItem({ id: 'a', path: 'a.ts', line: 1 }),
      makeItem({ id: 'b', path: 'b.ts', line: 2, startLine: 1 }),
    ];
    const input = buildSubmitReviewInput({
      owner: 'kilocode',
      repo: 'kilo',
      number: 42,
      event: 'REQUEST_CHANGES',
      commitSha: 'head-2',
      items,
    });
    expect(input.comments).toHaveLength(2);
    // On a successful submit, the caller clears the queue; on failure, the
    // queue is retained because the input is built from the current items
    // without mutating them.
    expect(items).toHaveLength(2);
  });
});

describe('reviewSubmitBlockReason', () => {
  it('allows APPROVE with neither summary nor comments', () => {
    expect(
      reviewSubmitBlockReason({ event: 'APPROVE', hasSummary: false, commentCount: 0 })
    ).toBeNull();
  });

  it('allows APPROVE with a summary and no comments', () => {
    expect(
      reviewSubmitBlockReason({ event: 'APPROVE', hasSummary: true, commentCount: 0 })
    ).toBeNull();
  });

  it('blocks REQUEST_CHANGES with neither summary nor comments', () => {
    const reason = reviewSubmitBlockReason({
      event: 'REQUEST_CHANGES',
      hasSummary: false,
      commentCount: 0,
    });
    expect(reason).toBe('Add a summary or at least one comment to request changes.');
  });

  it('allows REQUEST_CHANGES with a summary and no comments', () => {
    expect(
      reviewSubmitBlockReason({
        event: 'REQUEST_CHANGES',
        hasSummary: true,
        commentCount: 0,
      })
    ).toBeNull();
  });

  it('allows REQUEST_CHANGES with a comment and no summary', () => {
    expect(
      reviewSubmitBlockReason({
        event: 'REQUEST_CHANGES',
        hasSummary: false,
        commentCount: 1,
      })
    ).toBeNull();
  });

  it('blocks COMMENT with neither summary nor comments, with distinct wording', () => {
    const reason = reviewSubmitBlockReason({
      event: 'COMMENT',
      hasSummary: false,
      commentCount: 0,
    });
    expect(reason).toBe('Add a summary or at least one comment to post a comment review.');
    expect(reason).not.toBe(
      reviewSubmitBlockReason({
        event: 'REQUEST_CHANGES',
        hasSummary: false,
        commentCount: 0,
      })
    );
  });

  it('allows COMMENT with a summary and no comments', () => {
    expect(
      reviewSubmitBlockReason({ event: 'COMMENT', hasSummary: true, commentCount: 0 })
    ).toBeNull();
  });

  it('allows COMMENT with a comment and no summary', () => {
    expect(
      reviewSubmitBlockReason({ event: 'COMMENT', hasSummary: false, commentCount: 1 })
    ).toBeNull();
  });
});
