import { describe, expect, test } from '@jest/globals';

// Stub the chat-adapter Linear package to avoid pulling in network/runtime
// initialization. The real adapter just receives a config object.
jest.mock(
  '@chat-adapter/linear',
  () => ({
    createLinearAdapter: jest.fn((config: unknown) => ({
      __isStub: true,
      config,
      name: 'linear',
    })),
    LinearAdapter: class LinearAdapter {},
  }),
  { virtual: true }
);

// Force every Linear env var to the empty-string value getEnvVariable returns
// when the var is missing. config.server snapshots these at module load time.
jest.mock('@/lib/config.server', () => ({
  LINEAR_CLIENT_ID: '',
  LINEAR_CLIENT_SECRET: '',
  LINEAR_WEBHOOK_SECRET: '',
}));

describe('linear-adapter module', () => {
  test('imports without throwing when LINEAR_* env vars are unset', async () => {
    await expect(import('./linear-adapter')).resolves.toBeDefined();
  });

  test('exports a configured linearAdapter instance', async () => {
    const { linearAdapter } = await import('./linear-adapter');
    expect(linearAdapter).toBeDefined();
  });
});
