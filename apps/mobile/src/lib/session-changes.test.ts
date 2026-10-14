import { describe, expect, it } from 'vitest';

import { type SessionDiffFile, sessionDiffFileToPrReviewFile } from '@/lib/session-changes';

const patch = ['diff --git a/a.ts b/a.ts', '@@ -1 +1 @@', '-old', '+new'].join('\n');

function file(overrides: Partial<SessionDiffFile> = {}): SessionDiffFile {
  return { file: 'src/a.ts', patch, additions: 1, deletions: 1, ...overrides };
}

describe('sessionDiffFileToPrReviewFile', () => {
  it('maps deleted to the PR vocabulary and a missing status to modified', () => {
    expect(sessionDiffFileToPrReviewFile(file({ status: 'deleted' })).status).toBe('removed');
    expect(sessionDiffFileToPrReviewFile(file({ status: 'added' })).status).toBe('added');
    expect(sessionDiffFileToPrReviewFile(file({ status: 'modified' })).status).toBe('modified');
    expect(sessionDiffFileToPrReviewFile(file()).status).toBe('modified');
  });

  it('keeps a text patch and marks an empty (binary) patch missing', () => {
    expect(sessionDiffFileToPrReviewFile(file())).toMatchObject({
      path: 'src/a.ts',
      previousPath: null,
      patch,
      patchMissing: false,
    });
    expect(
      sessionDiffFileToPrReviewFile(file({ patch: '', additions: 0, deletions: 0 }))
    ).toMatchObject({ patch: null, patchMissing: true });
  });
});
