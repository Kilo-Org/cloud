import { describe, expect, it } from 'vitest';

import {
  groupThreadsByPath,
  type ReviewThread,
  selectCommentAuthorName,
  selectThreadAnchorLabel,
  selectThreadBadges,
} from './review-discussion-types';

function makeThread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    threadId: 'T1',
    isResolved: false,
    isOutdated: false,
    subjectType: 'LINE',
    path: 'src/index.ts',
    line: 10,
    startLine: null,
    originalLine: null,
    originalStartLine: null,
    diffSide: 'RIGHT',
    comments: [
      {
        commentId: 1,
        nodeId: 'C1',
        author: { login: 'alice', avatarUrl: 'https://example.com/a.png' },
        bodyMarkdown: 'hello',
        createdAt: '2024-01-01T00:00:00Z',
        reactions: [{ content: 'THUMBS_UP', count: 2, viewerHasReacted: false }],
      },
    ],
    ...overrides,
  };
}

describe('selectThreadAnchorLabel', () => {
  it('renders an active line anchor with side', () => {
    expect(selectThreadAnchorLabel(makeThread({ line: 10, diffSide: 'RIGHT' }))).toBe(
      'src/index.ts L10 (RIGHT)'
    );
  });

  it('renders an active range anchor with start/end', () => {
    expect(selectThreadAnchorLabel(makeThread({ line: 12, startLine: 10, diffSide: 'LEFT' }))).toBe(
      'src/index.ts L10–L12 (LEFT)'
    );
  });

  it('renders a file-level thread label when subjectType is FILE', () => {
    expect(selectThreadAnchorLabel(makeThread({ subjectType: 'FILE' }))).toBe(
      'File comment on src/index.ts'
    );
  });

  it('renders a file-level thread label when line is null', () => {
    expect(selectThreadAnchorLabel(makeThread({ line: null }))).toBe(
      'File comment on src/index.ts'
    );
  });

  it('renders an outdated thread label using originalLine', () => {
    expect(
      selectThreadAnchorLabel(
        makeThread({
          isOutdated: true,
          line: null,
          startLine: null,
          originalLine: 8,
          originalStartLine: 5,
          diffSide: 'LEFT',
        })
      )
    ).toBe('Outdated on src/index.ts L5–L8 (LEFT)');
  });

  it('renders an outdated label with a single line', () => {
    expect(
      selectThreadAnchorLabel(
        makeThread({
          isOutdated: true,
          line: null,
          startLine: null,
          originalLine: 8,
          originalStartLine: null,
          diffSide: null,
        })
      )
    ).toBe('Outdated on src/index.ts L8');
  });

  it('renders a path-only outdated label when originalLine is null (no dangling L)', () => {
    expect(
      selectThreadAnchorLabel(
        makeThread({
          isOutdated: true,
          line: null,
          startLine: null,
          originalLine: null,
          originalStartLine: null,
          diffSide: 'RIGHT',
        })
      )
    ).toBe('Outdated on src/index.ts (RIGHT)');
  });

  it('renders a bare Outdated label when both path and originalLine are null', () => {
    expect(
      selectThreadAnchorLabel(
        makeThread({
          isOutdated: true,
          path: null,
          line: null,
          startLine: null,
          originalLine: null,
          originalStartLine: null,
          diffSide: null,
        })
      )
    ).toBe('Outdated');
  });

  it('ignores a null originalStartLine and shows only the original line', () => {
    expect(
      selectThreadAnchorLabel(
        makeThread({
          isOutdated: true,
          line: null,
          originalLine: 8,
          originalStartLine: null,
        })
      )
    ).toBe('Outdated on src/index.ts L8 (RIGHT)');
  });

  it('omits side when diffSide is null', () => {
    expect(selectThreadAnchorLabel(makeThread({ diffSide: null, line: 10 }))).toBe(
      'src/index.ts L10'
    );
  });
});

describe('selectThreadBadges', () => {
  it('flags resolved + outdated + file-level independently', () => {
    expect(selectThreadBadges(makeThread({ isResolved: true }))).toEqual({
      resolved: true,
      outdated: false,
      fileLevel: false,
    });
    expect(selectThreadBadges(makeThread({ isOutdated: true }))).toEqual({
      resolved: false,
      outdated: true,
      fileLevel: false,
    });
    expect(selectThreadBadges(makeThread({ subjectType: 'FILE' }))).toEqual({
      resolved: false,
      outdated: false,
      fileLevel: true,
    });
    expect(selectThreadBadges(makeThread({ line: null }))).toEqual({
      resolved: false,
      outdated: false,
      fileLevel: true,
    });
  });
});

describe('selectCommentAuthorName', () => {
  it('returns the login when present', () => {
    expect(selectCommentAuthorName({ login: 'alice', avatarUrl: null })).toBe('alice');
  });

  it('returns the "deleted user" fallback when author is null', () => {
    expect(selectCommentAuthorName(null)).toBe('deleted user');
  });
});

describe('groupThreadsByPath', () => {
  it('groups threads by path, preserving insertion order', () => {
    const a = makeThread({ threadId: 'A', path: 'src/a.ts' });
    const b = makeThread({ threadId: 'B', path: 'src/b.ts' });
    const a2 = makeThread({ threadId: 'A2', path: 'src/a.ts' });
    const groups = groupThreadsByPath([a, b, a2]);
    expect(groups.map(g => g.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(groups[0]?.threads.map(t => t.threadId)).toEqual(['A', 'A2']);
    expect(groups[1]?.threads.map(t => t.threadId)).toEqual(['B']);
  });

  it('buckets null-path threads under "(no file)"', () => {
    const orphan = makeThread({ threadId: 'X', path: null });
    const a = makeThread({ threadId: 'A', path: 'src/a.ts' });
    const groups = groupThreadsByPath([a, orphan]);
    expect(groups.map(g => g.path)).toEqual(['src/a.ts', '(no file)']);
  });
});
