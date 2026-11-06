describe('session-sync account-erasure destination', () => {
  const original = {
    VERCEL_ENV: process.env.VERCEL_ENV,
    VERCEL_TARGET_ENV: process.env.VERCEL_TARGET_ENV,
    SESSION_SYNC_WORKER_URL: process.env.SESSION_SYNC_WORKER_URL,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.each([
    {
      environment: 'production',
      target: 'production',
      expected: 'https://session-sync.kiloapps.io',
    },
    { environment: 'production', target: undefined, expected: 'https://session-sync.kiloapps.io' },
    { environment: 'production', target: 'staging', expected: '' },
    { environment: 'production', target: 'custom-test', expected: '' },
    { environment: 'preview', target: undefined, expected: '' },
    { environment: 'development', target: undefined, expected: '' },
    { environment: undefined, target: undefined, expected: '' },
  ])(
    'resolves deployment $environment/$target without crossing environments',
    ({ environment, target, expected }) => {
      delete process.env.SESSION_SYNC_WORKER_URL;
      if (environment === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = environment;
      if (target === undefined) delete process.env.VERCEL_TARGET_ENV;
      else process.env.VERCEL_TARGET_ENV = target;
      jest.isolateModules(() => {
        const config = jest.requireActual<{ SESSION_SYNC_WORKER_URL: string }>(
          './web-config.server'
        );
        expect(config.SESSION_SYNC_WORKER_URL).toBe(expected);
      });
    }
  );

  it('uses an explicitly configured isolated destination', () => {
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_TARGET_ENV = 'staging';
    process.env.SESSION_SYNC_WORKER_URL = 'http://127.0.0.1:8817';
    jest.isolateModules(() => {
      const config = jest.requireActual<{ SESSION_SYNC_WORKER_URL: string }>('./web-config.server');
      expect(config.SESSION_SYNC_WORKER_URL).toBe('http://127.0.0.1:8817');
    });
  });
});
