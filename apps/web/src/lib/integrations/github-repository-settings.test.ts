import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PlatformIntegration, RepositoryCustomization } from '@kilocode/db/schema';
import type {
  resolveModelForGitHubRepository as ResolveModelForGitHubRepository,
  resolveRepositorySettings as ResolveRepositorySettings,
} from './github-repository-settings';

const mockGetRepositoryCustomization =
  jest.fn<
    (integrationId: string, repositoryId: string) => Promise<RepositoryCustomization | null>
  >();

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getRepositoryCustomization: mockGetRepositoryCustomization,
}));

let resolveRepositorySettings: typeof ResolveRepositorySettings;
let resolveModelForGitHubRepository: typeof ResolveModelForGitHubRepository;

beforeAll(async () => {
  const mod = await import('./github-repository-settings');
  resolveRepositorySettings = mod.resolveRepositorySettings;
  resolveModelForGitHubRepository = mod.resolveModelForGitHubRepository;
});

describe('resolveRepositorySettings', () => {
  it('uses the installation default model and review mode when there is no override', () => {
    const settings = resolveRepositorySettings({
      metadata: { model_slug: 'model-a', pr_review_mode: 'on' },
    });

    expect(settings).toEqual({ modelSlug: 'model-a', prReviewMode: 'on' });
  });

  it('applies a repository override independently per field', () => {
    const settings = resolveRepositorySettings(
      { metadata: { model_slug: 'model-a', pr_review_mode: 'on' } },
      { bot_mention_model_slug: 'model-b', pr_review_mode: null }
    );

    // model overridden; review mode still inherits the installation default.
    expect(settings).toEqual({ modelSlug: 'model-b', prReviewMode: 'on' });
  });

  it('falls back to the bot default model when the installation has none set', () => {
    const settings = resolveRepositorySettings({ metadata: {} });

    expect(settings.modelSlug).toBeTruthy();
  });

  it('defaults to on when the installation has no recognized review mode', () => {
    expect(resolveRepositorySettings({ metadata: {} }).prReviewMode).toBe('on');
    expect(resolveRepositorySettings({ metadata: { pr_review_mode: 'manual' } }).prReviewMode).toBe(
      'on'
    );
    expect(resolveRepositorySettings({ metadata: null }).prReviewMode).toBe('on');
  });

  it('treats a JSON literal null metadata the same as SQL null', () => {
    // Some legacy rows may have stored the JSON literal `null` rather than SQL NULL.
    const settings = resolveRepositorySettings({ metadata: null });

    expect(settings.prReviewMode).toBe('on');
  });
});

describe('resolveModelForGitHubRepository', () => {
  const integration = {
    id: 'integration-1',
    metadata: { model_slug: 'installation-default-model' },
    repositories: [
      { id: 1, name: 'cloud', full_name: 'kilocode/cloud', private: true },
      { id: 2, name: 'extension', full_name: 'kilocode/extension', private: false },
    ],
  } as unknown as PlatformIntegration;

  beforeEach(() => {
    mockGetRepositoryCustomization.mockReset();
  });

  it('returns the repository override model when one exists', async () => {
    mockGetRepositoryCustomization.mockResolvedValue({
      bot_mention_model_slug: 'repo-override-model',
      pr_review_mode: null,
    } as RepositoryCustomization);

    const model = await resolveModelForGitHubRepository(integration, 'kilocode/cloud');

    expect(model).toBe('repo-override-model');
    expect(mockGetRepositoryCustomization).toHaveBeenCalledWith('integration-1', '1');
  });

  it('matches the repository full name case-insensitively', async () => {
    mockGetRepositoryCustomization.mockResolvedValue({
      bot_mention_model_slug: 'repo-override-model',
      pr_review_mode: null,
    } as RepositoryCustomization);

    await resolveModelForGitHubRepository(integration, 'KiloCode/Cloud');

    expect(mockGetRepositoryCustomization).toHaveBeenCalledWith('integration-1', '1');
  });

  it('falls back to the installation default when the repository has no override', async () => {
    mockGetRepositoryCustomization.mockResolvedValue(null);

    const model = await resolveModelForGitHubRepository(integration, 'kilocode/cloud');

    expect(model).toBe('installation-default-model');
  });

  it('falls back to the installation default when the repository is not in the cached list', async () => {
    const model = await resolveModelForGitHubRepository(integration, 'kilocode/missing');

    expect(model).toBe('installation-default-model');
    expect(mockGetRepositoryCustomization).not.toHaveBeenCalled();
  });

  it('falls back to the installation default when the integration has no cached repositories', async () => {
    const integrationWithoutRepos = {
      ...integration,
      repositories: null,
    } as unknown as PlatformIntegration;

    const model = await resolveModelForGitHubRepository(integrationWithoutRepos, 'kilocode/cloud');

    expect(model).toBe('installation-default-model');
    expect(mockGetRepositoryCustomization).not.toHaveBeenCalled();
  });
});
