import { describe, expect, it } from 'vitest';
import { isGitPath, toRepoRelativePath } from '../../src/paths';

describe('repository path normalization', () => {
  it('strips /workspace and leading slashes', () => {
    expect(toRepoRelativePath('/workspace/src/foo.ts')).toBe('src/foo.ts');
    expect(toRepoRelativePath('/src/foo.ts')).toBe('src/foo.ts');
    expect(toRepoRelativePath('src/foo.ts')).toBe('src/foo.ts');
  });

  it('rejects empty, root-only, and parent-escaping paths', () => {
    expect(toRepoRelativePath('')).toBeUndefined();
    expect(toRepoRelativePath('/workspace')).toBeUndefined();
    expect(toRepoRelativePath('/workspace/../etc/passwd')).toBeUndefined();
    expect(toRepoRelativePath('..')).toBeUndefined();
  });

  it('detects .git paths under the repo root', () => {
    expect(isGitPath('/workspace/.git/objects/pack')).toBe(true);
    expect(isGitPath('/workspace/src/foo.ts')).toBe(false);
  });
});
