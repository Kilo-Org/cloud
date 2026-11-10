import { describe, test, expect } from '@jest/globals';
import {
  getSandboxAllocation,
  getSandboxAllocationRequest,
  type SandboxSelectionCapabilities,
} from '@kilocode/worker-utils/sandbox-allocation';
import {
  describeDefaultSandbox,
  describeUnavailableSandbox,
  excludeListedRepositories,
  getEligibleAllocationChoices,
  groupChoicesByProvider,
  splitRepositoryName,
  withSavedChoice,
} from './settings-options';

function capabilities(): SandboxSelectionCapabilities {
  return {
    enabled: true,
    options: [
      {
        allocation: getSandboxAllocationRequest('vercel-small'),
        repositoryUnavailableReason: 'Vercel sandboxes support GitHub repositories only',
      },
      {
        allocation: getSandboxAllocationRequest('cloudflare-containers-standard-4'),
        unavailableReason: 'Cloudflare is down',
      },
      { allocation: getSandboxAllocationRequest('cloudflare-containers-standard-3') },
    ],
  };
}

describe('settings-options', () => {
  test('names the default sandbox with its provider and capacity', () => {
    expect(
      describeDefaultSandbox(getSandboxAllocationRequest('cloudflare-containers-standard-3'))
    ).toEqual({
      summary: 'Cloudflare Containers · 2 vCPU / 8 GiB',
      full: 'Cloudflare Containers · 2 vCPU / 8 GiB · Medium',
    });
  });

  test('names a provider-chosen default without a capacity', () => {
    expect(
      describeDefaultSandbox({
        provider: { id: 'vercel', account: 'byoc' },
        instanceType: 'default',
      })
    ).toEqual({ summary: 'Vercel · Provider default', full: 'Vercel · Provider default' });
  });

  test('has nothing to name without a default destination', () => {
    expect(describeDefaultSandbox(undefined)).toBeUndefined();
  });

  test('offers only options without an unavailability reason', () => {
    expect(getEligibleAllocationChoices(capabilities()).map(c => c.allocation)).toEqual([
      'cloudflare-containers-standard-3',
    ]);
  });

  test('offers nothing when selection is disabled', () => {
    expect(getEligibleAllocationChoices({ enabled: false, options: [] })).toEqual([]);
    expect(getEligibleAllocationChoices(undefined)).toEqual([]);
  });

  test('names the provider without the account and keeps the tier out of the summary', () => {
    const medium = getEligibleAllocationChoices({
      enabled: true,
      options: [{ allocation: getSandboxAllocationRequest('cloudflare-containers-standard-3') }],
    })[0];
    expect(medium.provider).toBe('Cloudflare Containers');
    expect(medium.instance).toContain('Medium');
    expect(medium.summary.startsWith('Cloudflare Containers · ')).toBe(true);
    expect(medium.summary).not.toContain('Medium');
  });

  test('groups choices by provider in the order they are offered', () => {
    const groups = groupChoicesByProvider(
      getEligibleAllocationChoices({
        enabled: true,
        options: [
          { allocation: getSandboxAllocationRequest('cloudflare-containers-standard-3') },
          { allocation: getSandboxAllocationRequest('vercel-large') },
        ],
      })
    );
    expect(
      groups.map(group => [group.provider, group.choices.map(choice => choice.allocation)])
    ).toEqual([
      ['Vercel', ['vercel-large']],
      ['Cloudflare Containers', ['cloudflare-containers-standard-3']],
    ]);
  });

  test('keeps the offered list when the saved allocation is already offered or empty', () => {
    const choices = getEligibleAllocationChoices(capabilities());
    expect(withSavedChoice(choices, 'cloudflare-containers-standard-3', 'ignored')).toBe(choices);
    expect(withSavedChoice(choices, null, undefined)).toBe(choices);
    expect(withSavedChoice(choices, 'not-an-allocation', undefined)).toBe(choices);
    expect(withSavedChoice(choices, 'cloudflare-shared', 'retired')).toBe(choices);
  });

  test('adds a saved allocation that is no longer offered as an unavailable choice', () => {
    const choices = getEligibleAllocationChoices(capabilities());
    const withSaved = withSavedChoice(
      choices,
      'vercel-large',
      'Vercel sandboxes support GitHub repositories only'
    );
    expect(withSaved).toHaveLength(choices.length + 1);
    expect(withSaved.at(-1)).toMatchObject({
      allocation: 'vercel-large',
      provider: 'Vercel',
      unavailableReason: 'Vercel sandboxes support GitHub repositories only',
    });
    expect(withSavedChoice(choices, 'vercel-large', undefined).at(-1)?.unavailableReason).toBe(
      'This sandbox is unavailable'
    );
  });

  test('groups an unavailable saved allocation with its provider', () => {
    const choices = getEligibleAllocationChoices(capabilities());
    const groups = groupChoicesByProvider(
      withSavedChoice(choices, 'cloudflare-containers-standard-4', 'Cloudflare is down')
    );
    expect(groups[0].provider).toBe('Cloudflare Containers');
    expect(groups[0].choices.map(choice => choice.allocation)).toEqual([
      'cloudflare-containers-standard-3',
      'cloudflare-containers-standard-4',
    ]);
  });

  test('describes an unavailable sandbox with the fallback outcome', () => {
    expect(describeUnavailableSandbox('Cloudflare is down')).toBe(
      'Cloudflare is down. Sessions use the next available default.'
    );
    expect(describeUnavailableSandbox('Cloudflare is down.')).toBe(
      'Cloudflare is down. Sessions use the next available default.'
    );
  });

  test('splits a repository name at its last slash', () => {
    expect(splitRepositoryName('acme/api')).toEqual({ owner: 'acme/', name: 'api' });
    expect(splitRepositoryName('group/sub/project')).toEqual({
      owner: 'group/sub/',
      name: 'project',
    });
    expect(splitRepositoryName('standalone')).toEqual({ owner: '', name: 'standalone' });
  });

  test('excludes repositories already present, case-insensitively and per platform', () => {
    const repositories = [
      { fullName: 'Acme/Web', platform: 'github' as const },
      { fullName: 'acme/web', platform: 'gitlab' as const },
      { fullName: 'acme/api', platform: 'github' as const },
    ];
    const remaining = excludeListedRepositories(repositories, [
      { repositoryFullName: 'ACME/web', repositoryPlatform: 'github' },
    ]);
    expect(remaining.map(repo => `${repo.platform}:${repo.fullName}`)).toEqual([
      'gitlab:acme/web',
      'github:acme/api',
    ]);
  });

  test('keeps every repository when nothing is listed', () => {
    const repositories = [{ fullName: 'acme/web', platform: 'github' as const }];
    expect(excludeListedRepositories(repositories, [])).toEqual(repositories);
  });

  test('the chosen key round-trips through the capability option', () => {
    const option = capabilities().options.at(-1)!;
    expect(getSandboxAllocation(option.allocation)).toBe('cloudflare-containers-standard-3');
  });
});
