import { describe, expect, it } from 'vitest';

import { cloudAgentFileLabel } from '@/lib/cloud-agent-path';

describe('cloudAgentFileLabel', () => {
  it('strips a personal session workspace root', () => {
    expect(
      cloudAgentFileLabel(
        '/workspace/a7e4d40b-c28c-4df1-9a1e-f88e7eb467f1/sessions/ses_abc/README.md'
      )
    ).toBe('README.md');
  });

  it('strips an organization-scoped session workspace root', () => {
    expect(cloudAgentFileLabel('/workspace/org-1/user-1/sessions/ses_abc/src/nested/a.ts')).toBe(
      'src/nested/a.ts'
    );
  });

  it('strips a worktree workspace root', () => {
    expect(
      cloudAgentFileLabel('/workspace/user-1/worktrees/worktree_9b1deb4d/src/cli.test.ts')
    ).toBe('src/cli.test.ts');
  });

  it('strips the isolated container root', () => {
    expect(cloudAgentFileLabel('/workspace/app/src/a.ts')).toBe('src/a.ts');
  });

  it('strips a relative session or worktree prefix', () => {
    expect(cloudAgentFileLabel('sessions/ses_abc/src/a.ts')).toBe('src/a.ts');
    expect(cloudAgentFileLabel('worktrees/worktree_9b1deb4d/src/a.ts')).toBe('src/a.ts');
  });

  it('normalizes Windows separators', () => {
    expect(
      cloudAgentFileLabel(String.raw`/workspace/user-1/sessions/ses_abc\src\nested\a.ts`)
    ).toBe('src/nested/a.ts');
  });

  it('leaves an already repo-relative path untouched', () => {
    expect(cloudAgentFileLabel('src/a.ts')).toBe('src/a.ts');
  });

  it('leaves a path outside a cloud workspace untouched', () => {
    expect(cloudAgentFileLabel('/Users/me/project/src/a.ts')).toBe('/Users/me/project/src/a.ts');
  });
});
