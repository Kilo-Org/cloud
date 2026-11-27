import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { LEGACY_AUTH_REQUIRED, run } from './import-signup-history';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('import-signup-history preflight', () => {
  it.each([[[]], [['2026-11-01T00:00:00Z']]])(
    'refuses without --bouncer-legacy-auth before any request (args %j)',
    async args => {
      const fetchSpy = jest.spyOn(global, 'fetch');
      const error = await run(...args).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(LEGACY_AUTH_REQUIRED);
      expect(LEGACY_AUTH_REQUIRED).toContain('STS_AUTH=sts');
      expect(LEGACY_AUTH_REQUIRED).toContain('ci-bouncer-signup-import GitHub OIDC workflow');
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  );

  it('rejects more than one start timestamp before any request', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    await expect(
      run('--bouncer-legacy-auth', '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z')
    ).rejects.toThrow('Pass at most one start timestamp');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
