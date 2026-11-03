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
      { allocation: getSandboxAllocationRequest('cloudflare-single') },
      {
        allocation: getSandboxAllocationRequest('vercel-small'),
        repositoryUnavailableReason: 'Vercel sandboxes support GitHub repositories only',
      },
      {
        allocation: getSandboxAllocationRequest('cloudflare-shared'),
        unavailableReason: 'Cloudflare is down',
      },
      { allocation: getSandboxAllocationRequest('cloudflare-containers-standard-4') },
      { allocation: getSandboxAllocationRequest('cloudflare-containers-standard-3') },
    ],
  };
}

describe('settings-options', () => {
  test('names the default sandbox with its provider and capacity', () => {
    expect(describeDefaultSandbox(getSandboxAllocationRequest('cloudflare-single'))).toEqual({
      summary: 'Cloudflare · 2 vCPU / 6 GiB',
      full: 'Cloudflare · 2 vCPU / 6 GiB · Small',
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
      'cloudflare-single',
      'cloudflare-containers-standard-4',
      'cloudflare-containers-standard-3',
    ]);
  });

  test('offers nothing when selection is disabled', () => {
    expect(getEligibleAllocationChoices({ enabled: false, options: [] })).toEqual([]);
    expect(getEligibleAllocationChoices(undefined)).toEqual([]);
  });

  test('names the provider without the account and keeps the tier out of the summary', () => {
    const shared = getEligibleAllocationChoices({
      enabled: true,
      options: [{ allocation: getSandboxAllocationRequest('cloudflare-shared') }],
    })[0];
    expect(shared.provider).toBe('Cloudflare');
    expect(shared.instance).toContain('Large · Shared');
    expect(shared.summary.startsWith('Cloudflare · ')).toBe(true);
    expect(shared.summary).not.toContain('Shared');
  });

  test('groups choices by provider in the order they are offered', () => {
    const groups = groupChoicesByProvider(getEligibleAllocationChoices(capabilities()));
    expect(
      groups.map(group => [group.provider, group.choices.map(choice => choice.allocation)])
    ).toEqual([
      ['Cloudflare', ['cloudflare-single']],
      [
        'Cloudflare Containers',
        ['cloudflare-containers-standard-4', 'cloudflare-containers-standard-3'],
      ],
    ]);
  });

  test('keeps the offered list when the saved allocation is already offered or empty', () => {
    const choices = getEligibleAllocationChoices(capabilities());
    expect(withSavedChoice(choices, 'cloudflare-single', 'ignored')).toBe(choices);
    expect(withSavedChoice(choices, null, undefined)).toBe(choices);
    expect(withSavedChoice(choices, 'not-an-allocation', undefined)).toBe(choices);
  });

  test('adds a saved allocation that is no longer offered as an unavailable choice', () => {
    const choices = getEligibleAllocationChoices(capabilities());
    const withSaved = withSavedChoice(
      choices,
      'vercel-small',
      'Vercel sandboxes support GitHub repositories only'
    );
    expect(withSaved).toHaveLength(choices.length + 1);
    expect(withSaved.at(-1)).toMatchObject({
      allocation: 'vercel-small',
      provider: 'Vercel',
      unavailableReason: 'Vercel sandboxes support GitHub repositories only',
    });
    expect(withSavedChoice(choices, 'vercel-small', undefined).at(-1)?.unavailableReason).toBe(
      'This sandbox is unavailable'
    );
  });

  test('groups an unavailable saved allocation with its provider', () => {
    const choices = getEligibleAllocationChoices(capabilities());
    const groups = groupChoicesByProvider(
      withSavedChoice(choices, 'cloudflare-shared', 'Cloudflare is down')
    );
    expect(groups[0].provider).toBe('Cloudflare');
    expect(groups[0].choices.map(choice => choice.allocation)).toEqual([
      'cloudflare-single',
      'cloudflare-shared',
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
    const option = capabilities().options[0];
    expect(getSandboxAllocation(option.allocation)).toBe('cloudflare-single');
  });
});
