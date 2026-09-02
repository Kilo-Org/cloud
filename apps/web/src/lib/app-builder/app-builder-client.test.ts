jest.mock('@/lib/config.server', () => ({
  APP_BUILDER_URL: 'https://app-builder.example.com',
  APP_BUILDER_AUTH_TOKEN: 'test-token',
}));

import { AppBuilderError, migrateToGithub } from './app-builder-client';

describe('migrateToGithub', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns a typed failure envelope from a non-2xx response', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ success: false, error: 'push_failed', message: 'sensitive detail' }),
          { status: 502 }
        )
      );

    await expect(
      migrateToGithub('project-id', {
        githubRepo: 'kilocode/example',
        userId: 'user_2abc123',
      })
    ).resolves.toEqual({
      success: false,
      error: 'push_failed',
      message: 'sensitive detail',
    });
  });

  it('rejects a malformed non-2xx response', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ error: 'push_failed' }), { status: 502 }));

    const result = migrateToGithub('project-id', {
      githubRepo: 'kilocode/example',
      userId: 'user_2abc123',
    });

    await expect(result).rejects.toMatchObject({ statusCode: 502 });
    await expect(result).rejects.toBeInstanceOf(AppBuilderError);
  });

  it('rejects a non-JSON non-2xx response without exposing its body', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('sensitive detail', { status: 502 }));

    const result = migrateToGithub('project-id', {
      githubRepo: 'kilocode/example',
      userId: 'user_2abc123',
    });

    await expect(result).rejects.toMatchObject({ statusCode: 502 });
    await expect(result).rejects.not.toThrow('sensitive detail');
  });

  it('rejects a success envelope returned with a non-2xx status without exposing its body', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true, message: 'sensitive detail' }), {
        status: 500,
      })
    );

    const result = migrateToGithub('project-id', {
      githubRepo: 'kilocode/example',
      userId: 'user_2abc123',
    });

    await expect(result).rejects.toBeInstanceOf(AppBuilderError);
    await expect(result).rejects.not.toThrow('sensitive detail');
  });
});
