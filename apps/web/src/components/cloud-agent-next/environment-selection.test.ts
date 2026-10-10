import { describe, expect, it } from '@jest/globals';
import {
  environmentIdentityKey,
  resolveEnvironmentSelection,
  type EnvironmentSelectionState,
} from './environment-selection';

const repoA = { platform: 'github', fullName: 'Kilo-Org/kilocode' } as const;
const repoB = { platform: 'github', fullName: 'Kilo-Org/other' } as const;

describe('environmentIdentityKey', () => {
  it('normalizes a GitHub full name case-insensitively', () => {
    expect(environmentIdentityKey(repoA)).toBe('github:kilo-org/kilocode');
  });

  it('keeps the GitLab project path as sent', () => {
    expect(environmentIdentityKey({ platform: 'gitlab', projectPath: 'Group/Repo' })).toBe(
      'gitlab:Group/Repo'
    );
  });

  it('keys a Bitbucket repository by its UUID pair', () => {
    expect(
      environmentIdentityKey({ platform: 'bitbucket', workspaceUuid: 'WS', repositoryUuid: 'Repo' })
    ).toBe('bitbucket:ws:repo');
  });
});

describe('resolveEnvironmentSelection', () => {
  const previous: EnvironmentSelectionState = {
    id: 'env-1',
    identity: environmentIdentityKey(repoA),
  };

  it('keeps the selection when a successful list still contains it', () => {
    expect(
      resolveEnvironmentSelection(previous, {
        identity: previous.identity,
        environments: [{ id: 'env-1' }, { id: 'env-2' }],
        status: 'success',
      })
    ).toBe(previous);
  });

  it('clears the selection when a successful list lacks it', () => {
    expect(
      resolveEnvironmentSelection(previous, {
        identity: previous.identity,
        environments: [{ id: 'env-2' }],
        status: 'success',
      })
    ).toEqual({ id: null, identity: previous.identity });
  });

  it('clears the selection on an empty successful list', () => {
    expect(
      resolveEnvironmentSelection(previous, {
        identity: previous.identity,
        environments: [],
        status: 'success',
      })
    ).toEqual({ id: null, identity: previous.identity });
  });

  it('preserves the selection while loading', () => {
    expect(
      resolveEnvironmentSelection(previous, {
        identity: previous.identity,
        environments: undefined,
        status: 'loading',
      })
    ).toBe(previous);
  });

  it('preserves the selection on error, even with cached data', () => {
    expect(
      resolveEnvironmentSelection(previous, {
        identity: previous.identity,
        environments: [],
        status: 'error',
      })
    ).toBe(previous);
  });

  it('clears the selection when the repository identity changes', () => {
    expect(
      resolveEnvironmentSelection(previous, {
        identity: environmentIdentityKey(repoB),
        environments: [{ id: 'env-1' }],
        status: 'success',
      })
    ).toEqual({ id: null, identity: environmentIdentityKey(repoB) });
  });

  it('clears the selection when no repository is selected', () => {
    expect(
      resolveEnvironmentSelection(previous, {
        identity: null,
        environments: [{ id: 'env-1' }],
        status: 'success',
      })
    ).toEqual({ id: null, identity: null });
  });

  it('leaves a fresh identity without a selection alone', () => {
    const empty: EnvironmentSelectionState = { id: null, identity: null };
    expect(
      resolveEnvironmentSelection(empty, {
        identity: environmentIdentityKey(repoA),
        environments: undefined,
        status: 'loading',
      })
    ).toEqual({ id: null, identity: environmentIdentityKey(repoA) });
  });

  it('preserves a persisted id+identity on remount and clears it on a repository change', () => {
    const persisted: EnvironmentSelectionState = {
      id: 'env-1',
      identity: environmentIdentityKey(repoA),
    };

    // A remount starts from the persisted identity rather than a fresh ref, so
    // the selection survives until the repository actually changes.
    expect(
      resolveEnvironmentSelection(persisted, {
        identity: persisted.identity,
        environments: [{ id: 'env-1' }],
        status: 'success',
      })
    ).toBe(persisted);

    expect(
      resolveEnvironmentSelection(persisted, {
        identity: environmentIdentityKey(repoB),
        environments: [{ id: 'env-1' }],
        status: 'success',
      })
    ).toEqual({ id: null, identity: environmentIdentityKey(repoB) });
  });
});
