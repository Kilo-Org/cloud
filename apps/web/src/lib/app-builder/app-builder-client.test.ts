jest.mock('@/lib/config.server', () => ({
  APP_BUILDER_URL: 'https://app-builder.example.com',
  APP_BUILDER_AUTH_TOKEN: 'worker-auth-token',
}));

import { AppBuilderError, migrateToGithub } from './app-builder-client';

const request = {
  githubRepo: 'owner/repo',
  userId: '00000000-0000-4000-8000-000000000000',
};

describe('migrateToGithub', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns a typed failure envelope for a non-2xx response', async () => {
    const failure = {
      success: false as const,
      error: 'push_failed' as const,
      message: 'push rejected https://oauth2:secret-token@github.com/owner/repo.git',
    };
    jest.spyOn(global, 'fetch').mockResolvedValue(Response.json(failure, { status: 500 }));

    await expect(migrateToGithub('project-1', request)).resolves.toEqual(failure);
  });

  it('does not attach an untrusted response body to parsing errors', async () => {
    const sensitiveBody = 'https://oauth2:secret-token@github.com/owner/repo.git';
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(sensitiveBody, { status: 502 }));

    const error = await migrateToGithub('project-1', request).catch(value => value);

    expect(error).toBeInstanceOf(AppBuilderError);
    expect(String(error)).not.toContain(sensitiveBody);
  });
});
