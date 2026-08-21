import { describe, expect, it, vi } from 'vitest';

import { resolveContinuationDestinations } from './continuation-seed';

vi.mock('@/components/ui/icons', () => ({
  Bug: 'Bug',
  Code: 'Code',
  HelpCircle: 'HelpCircle',
  NotebookPen: 'NotebookPen',
  Workflow: 'Workflow',
}));

// ---------------------------------------------------------------------------
// resolveContinuationDestinations
// ---------------------------------------------------------------------------

describe('resolveContinuationDestinations', () => {
  const GIT_URL = 'https://github.com/owner/repo.git';
  const REPOS = [{ fullName: 'owner/repo' }];
  const MODELS = [{ id: 'test-model', variants: ['default'] }];

  it('returns the cloud destination when repo and model resolve', () => {
    const result = resolveContinuationDestinations({
      gitUrl: GIT_URL,
      mode: 'code',
      model: 'test-model',
      variant: 'default',
      repositories: REPOS,
      models: MODELS,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: 'cloud-agent',
      repo: 'owner/repo',
      model: 'test-model',
      variant: 'default',
    });
  });

  it('omits the cloud destination when repo is absent from repositories', () => {
    const result = resolveContinuationDestinations({
      gitUrl: GIT_URL,
      mode: 'code',
      model: 'test-model',
      variant: 'default',
      // repo "owner/repo" is not listed.
      repositories: [],
      models: MODELS,
    });

    expect(result).toEqual([]);
  });

  it('omits the cloud destination when gitUrl is null', () => {
    const result = resolveContinuationDestinations({
      gitUrl: null,
      mode: 'code',
      model: 'test-model',
      variant: 'default',
      repositories: REPOS,
      models: MODELS,
    });

    expect(result).toEqual([]);
  });

  it('omits the cloud destination when model is absent from models', () => {
    const result = resolveContinuationDestinations({
      gitUrl: GIT_URL,
      mode: 'code',
      model: 'test-model',
      variant: 'default',
      repositories: REPOS,
      // model not found.
      models: [],
    });

    expect(result).toEqual([]);
  });

  it('returns an empty array when everything is empty', () => {
    const result = resolveContinuationDestinations({
      gitUrl: null,
      mode: 'code',
      model: '',
      variant: '',
      repositories: [],
      models: [],
    });

    expect(result).toEqual([]);
  });
});
