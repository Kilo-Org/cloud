import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type {
  EnvironmentRepositoryEntry,
  SetupSecretRequestInput,
} from '@kilocode/cloud-agent-profile';
import type { verifySecretReferences as verifySecretReferencesType } from './secret-references';

let verifySecretReferences: typeof verifySecretReferencesType;

const mockGetIntegration = jest.fn<(owner: unknown, platform: string) => Promise<unknown>>();
const mockGenerateToken = jest.fn<(...args: unknown[]) => Promise<{ token: string }>>();
const mockFetchDefaultBranch = jest.fn<(params: unknown) => Promise<string>>();
const mockFetchFile = jest.fn<(params: unknown) => Promise<string | null>>();

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationForOwner: (...args: Parameters<typeof mockGetIntegration>) =>
    mockGetIntegration(...args),
}));

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  generateGitHubInstallationToken: (...args: Parameters<typeof mockGenerateToken>) =>
    mockGenerateToken(...args),
  fetchGitHubRepositoryDefaultBranch: (...args: Parameters<typeof mockFetchDefaultBranch>) =>
    mockFetchDefaultBranch(...args),
  fetchGitHubRootTextFileAtRef: (...args: Parameters<typeof mockFetchFile>) =>
    mockFetchFile(...args),
}));

beforeAll(async () => {
  ({ verifySecretReferences } = await import('./secret-references'));
});

beforeEach(() => {
  jest.clearAllMocks();
});

const owner = { type: 'user' as const, id: 'user-1' };
const repositories: EnvironmentRepositoryEntry[] = [
  { platform: 'github', repoFullName: 'acme/widgets' },
];
const requests: SetupSecretRequestInput[] = [
  {
    key: 'API_KEY',
    reason: 'Used by the tests',
    references: [{ repoFullName: 'acme/widgets', path: '.env.example', line: 1 }],
  },
];

function configureIntegration() {
  mockGetIntegration.mockResolvedValue({
    id: 'integration-1',
    platform_installation_id: 'installation-1',
    github_app_type: 'standard',
  });
  mockGenerateToken.mockResolvedValue({ token: 'github-token' });
  mockFetchDefaultBranch.mockResolvedValue('main');
}

describe('verifySecretReferences', () => {
  it('marks a reference verified when the file contains the key', async () => {
    configureIntegration();
    mockFetchFile.mockResolvedValue('API_KEY=\nOTHER=1\n');

    const result = await verifySecretReferences(owner, repositories, requests);
    expect(result[0].references[0].verified).toBe(true);
    expect(mockGenerateToken).toHaveBeenCalledWith(
      'installation-1',
      'standard',
      'integration-1',
      'agent'
    );
    expect(mockFetchFile).toHaveBeenCalledWith({
      token: 'github-token',
      owner: 'acme',
      repo: 'widgets',
      path: '.env.example',
      ref: 'main',
    });
  });

  it('marks a reference unverified when the file does not contain the key', async () => {
    configureIntegration();
    mockFetchFile.mockResolvedValue('OTHER=1\n');

    const result = await verifySecretReferences(owner, repositories, requests);

    expect(result[0].references[0].verified).toBe(false);
  });

  it('leaves references unverified when the integration is missing', async () => {
    mockGetIntegration.mockResolvedValue(null);

    const result = await verifySecretReferences(owner, repositories, requests);

    expect(result[0].references[0].verified).toBeUndefined();
    expect(mockGenerateToken).not.toHaveBeenCalled();
  });

  it('leaves references unverified when the fetch fails', async () => {
    configureIntegration();
    mockFetchFile.mockRejectedValue(new Error('github unavailable'));

    const result = await verifySecretReferences(owner, repositories, requests);

    expect(result[0].references[0].verified).toBeUndefined();
  });

  it('ignores references outside the draft GitHub repositories', async () => {
    configureIntegration();

    const result = await verifySecretReferences(owner, repositories, [
      {
        key: 'API_KEY',
        reason: 'Used elsewhere',
        references: [{ repoFullName: 'other/repo', path: '.env.example', line: 1 }],
      },
    ]);

    expect(result[0].references[0].verified).toBeUndefined();
    expect(mockGetIntegration).not.toHaveBeenCalled();
    expect(mockFetchFile).not.toHaveBeenCalled();
  });
});
