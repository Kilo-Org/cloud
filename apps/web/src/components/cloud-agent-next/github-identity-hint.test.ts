import {
  GITHUB_IDENTITY_HINT_DISMISSED_STORAGE_KEY,
  getGitHubIdentityHint,
  getGitHubIdentityHintDismissed,
  markGitHubIdentityHintDismissed,
  parseGitHubIdentityHintDismissed,
} from './github-identity-hint';

const visibleHintOptions = {
  selectedRepo: 'kilo/example',
  selectedPlatform: 'github',
  authorization: { connected: false, githubLogin: null, revoked: false },
  isLoading: false,
  isError: false,
  isDismissed: false,
} satisfies Parameters<typeof getGitHubIdentityHint>[0];

function createMemoryStorage() {
  const values = new Map<string, string>();
  return {
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
    values,
  };
}

describe('GitHub identity hint dismissal storage', () => {
  it('uses one browser-local dismissal marker', () => {
    expect(GITHUB_IDENTITY_HINT_DISMISSED_STORAGE_KEY).toBe(
      'cloud-agent:github-identity-hint-dismissed'
    );
  });

  it('treats only true as dismissed', () => {
    expect(parseGitHubIdentityHintDismissed('true')).toBe(true);
    expect(parseGitHubIdentityHintDismissed('false')).toBe(false);
    expect(parseGitHubIdentityHintDismissed(null)).toBe(false);
  });

  it('persists and reloads browser-local dismissal', () => {
    const { storage, values } = createMemoryStorage();

    markGitHubIdentityHintDismissed(storage);

    expect(values.get(GITHUB_IDENTITY_HINT_DISMISSED_STORAGE_KEY)).toBe('true');
    expect(getGitHubIdentityHintDismissed(storage)).toBe(true);
  });
});

describe('getGitHubIdentityHint', () => {
  it('returns null when no repository is selected', () => {
    expect(getGitHubIdentityHint({ ...visibleHintOptions, selectedRepo: '' })).toBeNull();
  });

  it('returns null for a GitLab repository', () => {
    expect(getGitHubIdentityHint({ ...visibleHintOptions, selectedPlatform: 'gitlab' })).toBeNull();
  });

  it('returns null when authorization status is missing', () => {
    expect(getGitHubIdentityHint({ ...visibleHintOptions, authorization: undefined })).toBeNull();
  });

  it('returns null while authorization status is loading', () => {
    expect(getGitHubIdentityHint({ ...visibleHintOptions, isLoading: true })).toBeNull();
  });

  it('returns null when authorization status fails to load', () => {
    expect(getGitHubIdentityHint({ ...visibleHintOptions, isError: true })).toBeNull();
  });

  it('returns null when a GitHub identity is connected', () => {
    expect(
      getGitHubIdentityHint({
        ...visibleHintOptions,
        authorization: { connected: true, githubLogin: 'octocat', revoked: false },
      })
    ).toBeNull();
  });

  it('returns null when a GitHub identity authorization was revoked', () => {
    expect(
      getGitHubIdentityHint({
        ...visibleHintOptions,
        authorization: { connected: false, githubLogin: 'octocat', revoked: true },
      })
    ).toBeNull();
  });

  it('returns null after the browser dismisses the awareness hint', () => {
    expect(getGitHubIdentityHint({ ...visibleHintOptions, isDismissed: true })).toBeNull();
  });

  it('returns subtle setup copy until dismissed or connected', () => {
    expect(getGitHubIdentityHint(visibleHintOptions)).toEqual({
      body: 'Commit as yourself instead of the Kilo bot.',
      linkLabel: 'Set up identity',
      href: '/integrations/github#github-identity',
    });
  });
});
