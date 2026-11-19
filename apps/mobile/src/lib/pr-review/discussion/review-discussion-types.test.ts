import { beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

import {
  type ReviewThread,
  selectCommentAuthorName,
  selectThreadAnchorLabel,
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
    diffHunk: null,
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
  beforeAll(async () => {
    // Catalogs load lazily; English is the default language but the instance
    // still resolves it through the backend on first use.
    await i18n.changeLanguage('en');
  });

  it('renders an active line anchor with side', () => {
    expect(selectThreadAnchorLabel(makeThread({ line: 10, diffSide: 'RIGHT' }))).toBe(
      'src/index.ts L10 (Right side)'
    );
  });

  it('renders an active range anchor with start/end', () => {
    expect(selectThreadAnchorLabel(makeThread({ line: 12, startLine: 10, diffSide: 'LEFT' }))).toBe(
      'src/index.ts L10–L12 (Left side)'
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
    ).toBe('Outdated on src/index.ts L5–L8 (Left side)');
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
    ).toBe('Outdated on src/index.ts (Right side)');
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
    ).toBe('Outdated on src/index.ts L8 (Right side)');
  });

  it('omits side when diffSide is null', () => {
    expect(selectThreadAnchorLabel(makeThread({ diffSide: null, line: 10 }))).toBe(
      'src/index.ts L10'
    );
  });

  it('renders side-less range anchor with no side sentence slot', () => {
    expect(selectThreadAnchorLabel(makeThread({ diffSide: null, line: 12, startLine: 10 }))).toBe(
      'src/index.ts L10–L12'
    );
  });

  it('renders side-less outdated range anchor without side', () => {
    expect(
      selectThreadAnchorLabel(
        makeThread({
          isOutdated: true,
          line: null,
          startLine: null,
          originalLine: 8,
          originalStartLine: 5,
          diffSide: null,
        })
      )
    ).toBe('Outdated on src/index.ts L5–L8');
  });

  it('renders side-less outdated single-line anchor without path', () => {
    expect(
      selectThreadAnchorLabel(
        makeThread({
          isOutdated: true,
          path: null,
          line: null,
          startLine: null,
          originalLine: 8,
          originalStartLine: null,
          diffSide: null,
        })
      )
    ).toBe('Outdated on L8');
  });

  it('renders side-bearing outdated single-line anchor without path', () => {
    expect(
      selectThreadAnchorLabel(
        makeThread({
          isOutdated: true,
          path: null,
          line: null,
          startLine: null,
          originalLine: 8,
          originalStartLine: null,
          diffSide: 'RIGHT',
        })
      )
    ).toBe('Outdated on L8 (Right side)');
  });

  it('renders side-bearing path-only outdated anchor with the side slot', () => {
    expect(
      selectThreadAnchorLabel(
        makeThread({
          isOutdated: true,
          line: null,
          startLine: null,
          originalLine: null,
          originalStartLine: null,
          diffSide: 'LEFT',
        })
      )
    ).toBe('Outdated on src/index.ts (Left side)');
  });

  it('renders side-bearing bare outdated anchor with the side slot', () => {
    expect(
      selectThreadAnchorLabel(
        makeThread({
          isOutdated: true,
          path: null,
          line: null,
          startLine: null,
          originalLine: null,
          originalStartLine: null,
          diffSide: 'RIGHT',
        })
      )
    ).toBe('Outdated (Right side)');
  });

  it('renders a file-level label without path', () => {
    expect(selectThreadAnchorLabel(makeThread({ subjectType: 'FILE', path: null }))).toBe(
      'File comment'
    );
  });

  it('renders the left-side label for a single-line thread without path', () => {
    expect(selectThreadAnchorLabel(makeThread({ path: null, line: 10, diffSide: 'LEFT' }))).toBe(
      'L10 (Left side)'
    );
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
