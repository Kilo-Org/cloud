import { describe, expect, it } from 'vitest';

import {
  environmentBlocksStart,
  environmentChoiceKey,
  environmentRepositoryCount,
  type EnvironmentSelection,
  type EnvironmentSummaryRow,
  requestedEnvironmentForSelection,
  requiresEnvironmentChoice,
  selectedEnvironment,
  selectEnvironment,
  toEnvironmentRepositoryInput,
} from './environment-selection';

function environment(id: string, repositories?: number): EnvironmentSummaryRow {
  const base = {
    id,
    name: `Environment ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    plainVarCount: 0,
    secretCount: 0,
    commandCount: 0,
    configurationRevision: 1,
    sandboxAllocation: null,
  };
  return (
    repositories === undefined
      ? {
          ...base,
          platform: 'github',
          repoFullName: 'acme/widgets',
          gitlabCloneUrl: null,
          bitbucketWorkspaceUuid: null,
          bitbucketRepositoryUuid: null,
        }
      : {
          ...base,
          repositories: Array.from({ length: repositories }, (_, index) => ({
            platform: 'github' as const,
            repoFullName: `acme/widgets-${index}`,
            gitlabCloneUrl: null,
            bitbucketWorkspaceUuid: null,
            bitbucketRepositoryUuid: null,
          })),
        }
  ) as EnvironmentSummaryRow;
}

describe('toEnvironmentRepositoryInput', () => {
  it('maps each provider to the identity the list query compares', () => {
    expect(
      toEnvironmentRepositoryInput({
        platform: 'github',
        fullName: 'acme/widgets',
        isPrivate: false,
      })
    ).toEqual({ platform: 'github', fullName: 'acme/widgets' });
    expect(
      toEnvironmentRepositoryInput({
        platform: 'gitlab',
        fullName: 'group/sub/project',
        isPrivate: true,
      })
    ).toEqual({ platform: 'gitlab', projectPath: 'group/sub/project' });
    expect(
      toEnvironmentRepositoryInput({
        platform: 'bitbucket',
        fullName: 'acme/widgets',
        isPrivate: true,
        workspaceUuid: 'ws',
        repositoryUuid: 'repo',
      })
    ).toEqual({ platform: 'bitbucket', workspaceUuid: 'ws', repositoryUuid: 'repo' });
  });

  it('lists nothing for no repository or a Bitbucket row without its uuid pair', () => {
    expect(toEnvironmentRepositoryInput(null)).toBeNull();
    expect(
      toEnvironmentRepositoryInput({
        platform: 'bitbucket',
        fullName: 'acme/widgets',
        isPrivate: true,
      })
    ).toBeNull();
  });
});

describe('environmentChoiceKey', () => {
  const repository = {
    platform: 'github' as const,
    fullName: 'Acme/Widgets',
    isPrivate: false,
  };

  it('keeps the scope and the provider apart', () => {
    const personal = environmentChoiceKey(undefined, repository);
    const organization = environmentChoiceKey('org-1', repository);
    const gitlab = environmentChoiceKey(undefined, {
      ...repository,
      platform: 'gitlab',
    });
    expect(new Set([personal, organization, gitlab]).size).toBe(3);
    expect(personal).toContain('acme/widgets');
  });
});

describe('environmentRepositoryCount', () => {
  it('counts the members of a multi-repository environment and one otherwise', () => {
    expect(environmentRepositoryCount(environment('v1'))).toBe(1);
    expect(environmentRepositoryCount(environment('v2', 3))).toBe(3);
  });
});

describe('selectEnvironment', () => {
  it('waits while the list loads and reads an idle load as unknown', () => {
    expect(selectEnvironment(undefined, null, true)).toEqual({ status: 'loading' });
    expect(selectEnvironment(undefined, null, false)).toEqual({ status: 'unknown' });
  });

  it('needs no choice for one match and no environment for none', () => {
    expect(selectEnvironment([], null, false)).toEqual({ status: 'none' });
    expect(selectEnvironment([environment('a')], null, false)).toEqual({
      status: 'selected',
      environment: environment('a'),
      chosen: false,
    });
  });

  it('asks for a choice among several unless the remembered one is still there', () => {
    expect(selectEnvironment([environment('a'), environment('b')], null, false)).toEqual({
      status: 'choose',
      environments: [environment('a'), environment('b')],
    });
    expect(selectEnvironment([environment('a'), environment('b')], 'b', false)).toEqual({
      status: 'selected',
      environment: environment('b'),
      chosen: true,
    });
    // A remembered environment the list no longer contains is not a choice.
    expect(selectEnvironment([environment('a'), environment('b')], 'gone', false)).toEqual({
      status: 'choose',
      environments: [environment('a'), environment('b')],
    });
  });
});

describe('selectedEnvironment', () => {
  it('resolves nothing, the selected environment, or "not known yet"', () => {
    expect(selectedEnvironment({ status: 'none' })).toBeNull();
    expect(
      selectedEnvironment({ status: 'selected', environment: environment('a'), chosen: true })
    ).toEqual(environment('a'));
    for (const selection of [
      { status: 'idle' },
      { status: 'loading' },
      { status: 'unknown' },
      { status: 'choose', environments: [environment('a'), environment('b')] },
    ] satisfies EnvironmentSelection[]) {
      expect(selectedEnvironment(selection)).toBeUndefined();
    }
  });
});

describe('environmentBlocksStart', () => {
  it('blocks while loading and until a choice is made, never on a failed load', () => {
    expect(environmentBlocksStart({ status: 'loading' })).toBe(true);
    expect(
      environmentBlocksStart({
        status: 'choose',
        environments: [environment('a'), environment('b')],
      })
    ).toBe(true);
    expect(environmentBlocksStart({ status: 'unknown' })).toBe(false);
    expect(environmentBlocksStart({ status: 'none' })).toBe(false);
    expect(environmentBlocksStart({ status: 'idle' })).toBe(false);
    expect(
      environmentBlocksStart({ status: 'selected', environment: environment('a'), chosen: false })
    ).toBe(false);
  });
});

describe('the create body fields', () => {
  it('names the environment only when the person chose it', () => {
    expect(
      requestedEnvironmentForSelection({
        status: 'selected',
        environment: environment('a'),
        chosen: true,
      })
    ).toEqual({ id: 'a' });
    expect(
      requestedEnvironmentForSelection({
        status: 'selected',
        environment: environment('a'),
        chosen: false,
      })
    ).toBeUndefined();
    expect(
      requestedEnvironmentForSelection({
        status: 'choose',
        environments: [environment('a'), environment('b')],
      })
    ).toBeUndefined();
  });

  it('claims a picker only once the list is known', () => {
    expect(requiresEnvironmentChoice({ status: 'idle' })).toBe(false);
    expect(requiresEnvironmentChoice({ status: 'unknown' })).toBe(false);
    expect(requiresEnvironmentChoice({ status: 'loading' })).toBe(true);
    expect(requiresEnvironmentChoice({ status: 'none' })).toBe(true);
  });
});
