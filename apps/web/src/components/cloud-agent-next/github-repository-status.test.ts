import { describe, expect, it } from '@jest/globals';
import {
  getGitHubRepositoryNotices,
  githubIntegrationSettingsHref,
} from './github-repository-status';

const settingsHref = '/organizations/org-1/integrations/github';

describe('getGitHubRepositoryNotices', () => {
  it('says nothing about a complete list from a connected installation', () => {
    expect(
      getGitHubRepositoryNotices(
        { integrationInstalled: true, errorMessage: undefined, partial: undefined },
        settingsHref
      )
    ).toEqual([]);
  });

  it('names the reconnect step with the reason the list is unavailable', () => {
    expect(
      getGitHubRepositoryNotices(
        {
          integrationInstalled: false,
          errorMessage: 'GitHub integration is suspended',
          unavailableReason: 'suspended',
        },
        settingsHref
      )
    ).toEqual([
      {
        kind: 'reconnect',
        message: 'GitHub integration is suspended',
        settingsHref,
      },
    ]);
  });

  it('falls back to generic reconnect guidance when no reason message is sent', () => {
    expect(
      getGitHubRepositoryNotices(
        { integrationInstalled: false, unavailableReason: 'not_configured' },
        settingsHref
      )
    ).toEqual([
      {
        kind: 'reconnect',
        message: 'GitHub integration needs to be reconnected',
        settingsHref,
      },
    ]);
  });

  it('keeps a plain missing integration separate from an unavailable one', () => {
    expect(getGitHubRepositoryNotices({ integrationInstalled: false }, settingsHref)).toEqual([]);
  });

  it('reports a partial list that still shows rows', () => {
    expect(
      getGitHubRepositoryNotices({ integrationInstalled: true, partial: true }, settingsHref)
    ).toEqual([
      {
        kind: 'partial',
        message: 'Some GitHub installations could not be loaded. Refresh to try again.',
      },
    ]);
  });
});

describe('githubIntegrationSettingsHref', () => {
  it('points organization sessions at the organization connection settings', () => {
    expect(githubIntegrationSettingsHref('org-1')).toBe(settingsHref);
  });

  it('points personal sessions at the personal connection settings', () => {
    expect(githubIntegrationSettingsHref(undefined)).toBe('/integrations/github');
  });
});
