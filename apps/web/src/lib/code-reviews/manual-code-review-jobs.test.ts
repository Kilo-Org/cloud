const mockGetAgentConfigForOwner = jest.fn();
const mockGetAllIntegrationsForOwner = jest.fn();
const mockGenerateGitHubInstallationToken = jest.fn();

jest.mock('@/lib/agent-config/db/agent-configs', () => ({
  getAgentConfigForOwner: (...args: unknown[]) => mockGetAgentConfigForOwner(...args),
}));
jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getAllIntegrationsForOwner: (...args: unknown[]) => mockGetAllIntegrationsForOwner(...args),
}));
jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  generateGitHubInstallationToken: (...args: unknown[]) =>
    mockGenerateGitHubInstallationToken(...args),
}));
jest.mock('@/lib/code-reviews/dispatch/dispatch-pending-reviews', () => ({
  tryDispatchPendingReviews: jest.fn(),
}));

import { createDefaultCodeReviewConfig } from './core/default-config';
import {
  getManualCodeReviewAgentConfig,
  normalizeManualInstructions,
  resolveConnectedGitHubSource,
} from './manual-code-review-jobs';

const owner = { type: 'user' as const, id: 'oauth/github/human', userId: 'oauth/github/human' };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getManualCodeReviewAgentConfig', () => {
  it.each([null, { config: {} }, { config: { review_style: 'unsupported' } }])(
    'uses the shared default factory for a missing or invalid config: %j',
    async saved => {
      mockGetAgentConfigForOwner.mockResolvedValue(saved);
      const result = await getManualCodeReviewAgentConfig(owner, 'github');
      expect(result).toEqual(createDefaultCodeReviewConfig());
      expect(mockGetAgentConfigForOwner).toHaveBeenCalledWith(owner, 'code_review', 'github');
      result.focus_areas.push('mutated');
      expect((await getManualCodeReviewAgentConfig(owner, 'github')).focus_areas).toEqual([]);
    }
  );

  it('returns a parsed snapshot without changing saved settings', async () => {
    const config = {
      ...createDefaultCodeReviewConfig(),
      review_style: 'roast',
      custom_instructions: 'Keep saved instructions',
      thinking_effort: 'max',
      focus_areas: ['security', 'correctness'],
      repository_model_overrides: [
        { repository_id: 42, repo_full_name: 'owner/repo', model_slug: 'repo-model' },
      ],
      unknown_setting: true,
    };
    mockGetAgentConfigForOwner.mockResolvedValue({ config });
    const result = await getManualCodeReviewAgentConfig(owner, 'github');
    expect(result).toMatchObject({ review_style: 'roast', thinking_effort: 'max' });
    expect(result).not.toHaveProperty('unknown_setting');
    result.focus_areas.push('performance');
    expect(config.focus_areas).toEqual(['security', 'correctness']);
  });
});

describe('normalizeManualInstructions', () => {
  it.each([undefined, '', ' \n\t '])('normalizes empty input %j to null', value => {
    expect(normalizeManualInstructions(value)).toBeNull();
  });

  it('trims without replacing saved instructions or changing multiline text', () => {
    expect(normalizeManualInstructions(' \nCheck auth\nThen billing\t ')).toBe(
      'Check auth\nThen billing'
    );
  });
});

describe('resolveConnectedGitHubSource', () => {
  const integration = {
    id: 'integration-1',
    platform: 'github',
    integration_status: 'active',
    platform_installation_id: '1234',
    github_app_type: 'standard',
    suspended_at: null,
  };
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    mockGetAllIntegrationsForOwner.mockResolvedValue([integration]);
    mockGenerateGitHubInstallationToken.mockResolvedValue({ token: 'installation-token' });
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        number: 42,
        html_url: 'https://github.com/Owner/Repo/pull/42',
        title: 'Review this',
        state: 'open',
        draft: false,
        user: { login: 'contributor', id: 12 },
        base: { ref: 'main', sha: 'b'.repeat(40), repo: { full_name: 'Owner/Repo' } },
        head: { ref: 'fork-feature', sha: 'a'.repeat(40) },
      })
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('retains the selected integration, installation, app and base tip without credentials', async () => {
    const result = await resolveConnectedGitHubSource(
      owner,
      'https://github.com/Owner/Repo/pull/42'
    );
    expect(result).toMatchObject({
      repoFullName: 'Owner/Repo',
      prNumber: 42,
      integrationId: 'integration-1',
      installationId: '1234',
      appType: 'standard',
      baseRef: 'main',
      baseTipSha: 'b'.repeat(40),
      headRef: 'refs/pull/42/head',
      headSha: 'a'.repeat(40),
    });
    expect(JSON.stringify(result)).not.toContain('installation-token');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.github.com/repos/Owner/Repo/pulls/42',
      expect.objectContaining({ redirect: 'error' })
    );
  });

  it('keeps legacy integrations on the standard app', async () => {
    mockGetAllIntegrationsForOwner.mockResolvedValue([{ ...integration, github_app_type: null }]);
    expect(
      await resolveConnectedGitHubSource(owner, 'https://github.com/Owner/Repo/pull/42')
    ).toMatchObject({ appType: 'standard' });
    expect(mockGenerateGitHubInstallationToken).toHaveBeenCalledWith('1234', 'standard');
  });

  it('does not bypass the connected-source requirement for public repositories', async () => {
    mockGetAllIntegrationsForOwner.mockResolvedValue([]);
    await expect(
      resolveConnectedGitHubSource(owner, 'https://github.com/Owner/Repo/pull/42')
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not silently change the canonical standard-app requirement', async () => {
    mockGetAllIntegrationsForOwner.mockResolvedValue([{ ...integration, github_app_type: 'lite' }]);
    await expect(
      resolveConnectedGitHubSource(owner, 'https://github.com/Owner/Repo/pull/42')
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mockGenerateGitHubInstallationToken).not.toHaveBeenCalled();
  });
});
