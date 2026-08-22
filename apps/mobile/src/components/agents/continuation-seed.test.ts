import { describe, expect, it, vi } from 'vitest';

import { resolveContinuationResolution } from './continuation-seed';

vi.mock('@/components/ui/icons', () => ({
  Bug: 'Bug',
  Code: 'Code',
  HelpCircle: 'HelpCircle',
  NotebookPen: 'NotebookPen',
  Workflow: 'Workflow',
}));

// ---------------------------------------------------------------------------
// resolveContinuationResolution
// ---------------------------------------------------------------------------

describe('resolveContinuationResolution', () => {
  const GIT_URL = 'https://github.com/owner/repo.git';
  const REPOS = [{ fullName: 'owner/repo' }];
  const MODELS = [{ id: 'test-model', variants: ['default'] }];

  it('returns the cloud-agent resolution when repo and model resolve', () => {
    const result = resolveContinuationResolution({
      gitUrl: GIT_URL,
      mode: 'code',
      model: 'test-model',
      variant: 'default',
      repositories: REPOS,
      models: MODELS,
    });

    expect(result).toEqual({
      kind: 'cloud-agent',
      repo: 'owner/repo',
      model: 'test-model',
      variant: 'default',
    });
  });

  it('returns unmatched-repository when gitUrl is null', () => {
    const result = resolveContinuationResolution({
      gitUrl: null,
      mode: 'code',
      model: 'test-model',
      variant: 'default',
      repositories: REPOS,
      models: MODELS,
    });

    expect(result).toEqual({ kind: 'unmatched-repository' });
  });

  it('returns unmatched-repository when gitUrl is not a GitHub URL', () => {
    const result = resolveContinuationResolution({
      gitUrl: 'https://gitlab.com/owner/repo.git',
      mode: 'code',
      model: 'test-model',
      variant: 'default',
      repositories: REPOS,
      models: MODELS,
    });

    expect(result).toEqual({ kind: 'unmatched-repository' });
  });

  it('returns unmatched-repository when the repo is absent from repositories', () => {
    const result = resolveContinuationResolution({
      gitUrl: GIT_URL,
      mode: 'code',
      model: 'test-model',
      variant: 'default',
      repositories: [],
      models: MODELS,
    });

    expect(result).toEqual({ kind: 'unmatched-repository' });
  });

  it('returns unresolved-model when the repo matches but the model is missing', () => {
    const result = resolveContinuationResolution({
      gitUrl: GIT_URL,
      mode: 'code',
      model: 'test-model',
      variant: 'default',
      repositories: REPOS,
      models: [],
    });

    expect(result).toEqual({ kind: 'unresolved-model' });
  });
});
