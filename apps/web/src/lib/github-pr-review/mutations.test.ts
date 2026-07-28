/**
 * @jest-environment node
 */
import { z } from 'zod';

import {
  AUTO_MERGE_METHODS,
  AutoMergeMethodSchema,
  CommentPositionSchema,
  MERGE_METHODS,
  MergeMethodSchema,
  REACTION_CONTENTS,
  ReactionContentSchema,
  REVIEW_EVENTS,
  ReviewEventSchema,
  ReviewSideSchema,
  buildAddReactionVariables,
  buildCreateReviewCommentParams,
  buildDeleteRefParams,
  buildDisableAutoMergeVariables,
  buildEnableAutoMergeVariables,
  buildMergePullRequestParams,
  buildRemoveReactionVariables,
  buildReplyToCommentParams,
  buildResolveThreadVariables,
  buildSubmitReviewParams,
  buildUnresolveThreadVariables,
  buildUpdateBranchParams,
} from './mutations';

describe('GitHub PR review mutation enums', () => {
  it('matches the GitHub reaction content enum', () => {
    expect([...REACTION_CONTENTS].sort()).toEqual(
      ['CONFUSED', 'EYES', 'HEART', 'HOORAY', 'LAUGH', 'ROCKET', 'THUMBS_DOWN', 'THUMBS_UP'].sort()
    );
  });

  it('matches the three review events', () => {
    expect([...REVIEW_EVENTS].sort()).toEqual(['APPROVE', 'COMMENT', 'REQUEST_CHANGES']);
  });

  it('matches the three merge methods (lowercase REST casing)', () => {
    expect([...MERGE_METHODS].sort()).toEqual(['merge', 'rebase', 'squash']);
  });

  it('matches the three auto-merge methods (uppercase GraphQL casing)', () => {
    expect([...AUTO_MERGE_METHODS].sort()).toEqual(['MERGE', 'REBASE', 'SQUASH']);
  });

  it('rejects reaction content outside the enum', () => {
    expect(ReactionContentSchema.safeParse('STAR').success).toBe(false);
    expect(ReactionContentSchema.safeParse('THUMBS_UP').success).toBe(true);
  });

  it('rejects unsupported review events', () => {
    expect(ReviewEventSchema.safeParse('APPROVE').success).toBe(true);
    expect(ReviewEventSchema.safeParse('PENDING').success).toBe(false);
  });

  it('rejects unsupported merge methods', () => {
    expect(MergeMethodSchema.safeParse('squash').success).toBe(true);
    expect(MergeMethodSchema.safeParse('SQUASH').success).toBe(false);
  });

  it('rejects unsupported auto-merge methods', () => {
    expect(AutoMergeMethodSchema.safeParse('MERGE').success).toBe(true);
    expect(AutoMergeMethodSchema.safeParse('merge').success).toBe(false);
  });

  it('accepts only LEFT/RIGHT for review side', () => {
    expect(ReviewSideSchema.safeParse('LEFT').success).toBe(true);
    expect(ReviewSideSchema.safeParse('right').success).toBe(false);
  });
});

describe('CommentPositionSchema', () => {
  it('accepts a single-line position', () => {
    const result = CommentPositionSchema.safeParse({
      path: 'src/foo.ts',
      line: 10,
      side: 'RIGHT',
    });
    expect(result.success).toBe(true);
  });

  it('rejects startLine > line for a multi-line position', () => {
    const result = CommentPositionSchema.safeParse({
      path: 'src/foo.ts',
      line: 5,
      side: 'RIGHT',
      startLine: 10,
    });
    expect(result.success).toBe(false);
  });

  it('accepts a multi-line position with startLine <= line', () => {
    const result = CommentPositionSchema.safeParse({
      path: 'src/foo.ts',
      line: 20,
      side: 'RIGHT',
      startLine: 15,
      startSide: 'RIGHT',
    });
    expect(result.success).toBe(true);
  });

  it('rejects startLine without startSide (partial multi-line range)', () => {
    const result = CommentPositionSchema.safeParse({
      path: 'src/foo.ts',
      line: 20,
      side: 'RIGHT',
      startLine: 15,
    });
    expect(result.success).toBe(false);
  });

  it('rejects startSide without startLine (partial multi-line range)', () => {
    const result = CommentPositionSchema.safeParse({
      path: 'src/foo.ts',
      line: 20,
      side: 'RIGHT',
      startSide: 'RIGHT',
    });
    expect(result.success).toBe(false);
  });

  it('enforces the pairing rule through the submitReview batch (.extend) shape', () => {
    const batchComment = CommentPositionSchema.extend({
      body: z.string().min(1),
    }).strict();
    const partial = batchComment.safeParse({
      path: 'src/foo.ts',
      line: 20,
      side: 'RIGHT',
      startLine: 15,
      body: 'x',
    });
    expect(partial.success).toBe(false);
    const paired = batchComment.safeParse({
      path: 'src/foo.ts',
      line: 20,
      side: 'RIGHT',
      startLine: 15,
      startSide: 'RIGHT',
      body: 'x',
    });
    expect(paired.success).toBe(true);
  });
});

describe('buildCreateReviewCommentParams', () => {
  it('maps to the REST field names', () => {
    const params = buildCreateReviewCommentParams({
      owner: 'octocat',
      repo: 'hello',
      number: 7,
      body: 'nit',
      commitSha: '0'.repeat(40),
      path: 'src/foo.ts',
      line: 12,
      side: 'RIGHT',
    });
    expect(params).toEqual({
      owner: 'octocat',
      repo: 'hello',
      pull_number: 7,
      body: 'nit',
      commit_id: '0'.repeat(40),
      path: 'src/foo.ts',
      line: 12,
      side: 'RIGHT',
    });
  });

  it('forwards multi-line start fields when present', () => {
    const params = buildCreateReviewCommentParams({
      owner: 'o',
      repo: 'r',
      number: 1,
      body: 'b',
      commitSha: '0'.repeat(40),
      path: 'p',
      line: 5,
      side: 'LEFT',
      startLine: 3,
      startSide: 'LEFT',
    });
    expect(params).toMatchObject({ start_line: 3, start_side: 'LEFT' });
  });

  it('omits multi-line start fields when not provided', () => {
    const params = buildCreateReviewCommentParams({
      owner: 'o',
      repo: 'r',
      number: 1,
      body: 'b',
      commitSha: '0'.repeat(40),
      path: 'p',
      line: 5,
      side: 'RIGHT',
    });
    expect(params).not.toHaveProperty('start_line');
    expect(params).not.toHaveProperty('start_side');
  });
});

describe('buildReplyToCommentParams', () => {
  it('maps to the REST field names', () => {
    expect(
      buildReplyToCommentParams({
        owner: 'octocat',
        repo: 'hello',
        number: 7,
        commentId: 99,
        body: 'thanks',
      })
    ).toEqual({
      owner: 'octocat',
      repo: 'hello',
      pull_number: 7,
      comment_id: 99,
      body: 'thanks',
    });
  });
});

describe('buildSubmitReviewParams', () => {
  it('omits body and comments when neither is provided', () => {
    const params = buildSubmitReviewParams({
      owner: 'o',
      repo: 'r',
      number: 1,
      event: 'APPROVE',
      commitSha: '0'.repeat(40),
    });
    expect(params).toEqual({
      owner: 'o',
      repo: 'r',
      pull_number: 1,
      event: 'APPROVE',
      commit_id: '0'.repeat(40),
    });
    expect(params).not.toHaveProperty('body');
    expect(params).not.toHaveProperty('comments');
  });

  it('passes a batch of inline comments with multi-line fields when set', () => {
    const params = buildSubmitReviewParams({
      owner: 'o',
      repo: 'r',
      number: 1,
      event: 'REQUEST_CHANGES',
      body: 'see below',
      commitSha: '0'.repeat(40),
      comments: [
        { path: 'a.ts', line: 5, side: 'RIGHT', body: 'one' },
        { path: 'b.ts', line: 10, side: 'RIGHT', startLine: 8, startSide: 'RIGHT', body: 'two' },
      ],
    });
    expect(params.comments).toHaveLength(2);
    expect(params.comments?.[1]).toMatchObject({ start_line: 8, start_side: 'RIGHT' });
  });
});

describe('buildMergePullRequestParams', () => {
  it('maps to the REST merge field names', () => {
    const params = buildMergePullRequestParams({
      owner: 'o',
      repo: 'r',
      number: 1,
      method: 'squash',
      expectedHeadSha: 'a'.repeat(40),
    });
    expect(params).toEqual({
      owner: 'o',
      repo: 'r',
      pull_number: 1,
      merge_method: 'squash',
      sha: 'a'.repeat(40),
    });
  });

  it('forwards commit title/message when provided', () => {
    const params = buildMergePullRequestParams({
      owner: 'o',
      repo: 'r',
      number: 1,
      method: 'merge',
      expectedHeadSha: 'a'.repeat(40),
      commitTitle: 'Title (#1)',
      commitMessage: 'Body',
    });
    expect(params).toMatchObject({ commit_title: 'Title (#1)', commit_message: 'Body' });
  });
});

describe('buildDeleteRefParams', () => {
  it('prefixes heads/ on the ref', () => {
    expect(buildDeleteRefParams({ owner: 'o', repo: 'r', headRef: 'feature/x' })).toEqual({
      owner: 'o',
      repo: 'r',
      ref: 'heads/feature/x',
    });
  });
});

describe('buildUpdateBranchParams', () => {
  it('maps to expected_head_sha', () => {
    expect(
      buildUpdateBranchParams({
        owner: 'o',
        repo: 'r',
        number: 1,
        expectedHeadSha: 'a'.repeat(40),
      })
    ).toEqual({
      owner: 'o',
      repo: 'r',
      pull_number: 1,
      expected_head_sha: 'a'.repeat(40),
    });
  });
});

describe('GraphQL variable builders', () => {
  it('builds enableAutoMerge variables with optional headline/body', () => {
    expect(
      buildEnableAutoMergeVariables({
        prNodeId: 'PR_1',
        method: 'SQUASH',
        commitTitle: 'Title',
        commitMessage: 'Body',
      })
    ).toEqual({
      input: {
        pullRequestId: 'PR_1',
        mergeMethod: 'SQUASH',
        commitHeadline: 'Title',
        commitBody: 'Body',
      },
    });
  });

  it('builds enableAutoMerge variables without optional fields', () => {
    expect(buildEnableAutoMergeVariables({ prNodeId: 'PR_1', method: 'MERGE' })).toEqual({
      input: { pullRequestId: 'PR_1', mergeMethod: 'MERGE' },
    });
  });

  it('builds disableAutoMerge variables', () => {
    expect(buildDisableAutoMergeVariables({ prNodeId: 'PR_1' })).toEqual({
      input: { pullRequestId: 'PR_1' },
    });
  });

  it('builds resolve/unresolve thread variables', () => {
    expect(buildResolveThreadVariables({ threadId: 'T_1' })).toEqual({
      input: { threadId: 'T_1' },
    });
    expect(buildUnresolveThreadVariables({ threadId: 'T_1' })).toEqual({
      input: { threadId: 'T_1' },
    });
  });

  it('builds add/remove reaction variables with the comment node id and content', () => {
    expect(buildAddReactionVariables({ commentNodeId: 'C_1', content: 'THUMBS_UP' })).toEqual({
      input: { subjectId: 'C_1', content: 'THUMBS_UP' },
    });
    expect(buildRemoveReactionVariables({ commentNodeId: 'C_1', content: 'HEART' })).toEqual({
      input: { subjectId: 'C_1', content: 'HEART' },
    });
  });
});
