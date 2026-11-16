import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { requestDeviceLanguageFollow } from './device-language-follow';

const mocks = vi.hoisted(() => ({
  applyDeviceLanguage: vi.fn(),
  captureException: vi.fn(),
  preference: 'device' as 'device' | 'es',
}));

vi.mock('@sentry/react-native', () => ({ captureException: mocks.captureException }));
vi.mock('@/i18n/apply-language', () => ({ applyDeviceLanguage: mocks.applyDeviceLanguage }));
vi.mock('@/lib/hooks/use-language-preference', () => ({
  getLanguagePreference: () => mocks.preference,
}));

/**
 * Flush the microtasks an admitted request runs on. The lazy catalog backend
 * reads synchronously, so one macrotask boundary settles whatever the queue
 * started; a request that applies nothing leaves nothing running.
 */
async function drainFollowQueue(): Promise<void> {
  const flushed = Promise.withResolvers<undefined>();
  setImmediate(() => {
    flushed.resolve(undefined);
  });
  await flushed.promise;
}

describe('requestDeviceLanguageFollow', () => {
  beforeEach(async () => {
    mocks.preference = 'device';
    mocks.applyDeviceLanguage.mockReset();
    mocks.applyDeviceLanguage.mockImplementation(async (language: string) => {
      await i18n.changeLanguage(language);
      return { kind: 'applied-ltr' };
    });
    mocks.captureException.mockReset();
    await i18n.changeLanguage('en');
  });

  it('applies the device language while the stored preference is device', async () => {
    requestDeviceLanguageFollow('es');
    await vi.waitFor(() => {
      expect(mocks.applyDeviceLanguage).toHaveBeenCalledWith('es');
    });

    expect(mocks.applyDeviceLanguage).toHaveBeenCalledTimes(1);
    expect(i18n.resolvedLanguage).toBe('es');
  });

  it('applies nothing when the person stored an explicit language', async () => {
    mocks.preference = 'es';

    requestDeviceLanguageFollow('fr');
    await drainFollowQueue();

    expect(mocks.applyDeviceLanguage).not.toHaveBeenCalled();
    expect(i18n.resolvedLanguage).toBe('en');
  });

  it('applies nothing when the device language is already active', async () => {
    requestDeviceLanguageFollow('en');
    await drainFollowQueue();

    expect(mocks.applyDeviceLanguage).not.toHaveBeenCalled();
  });

  it('reports a failed apply to Sentry, keeps the language, and keeps following', async () => {
    mocks.applyDeviceLanguage.mockResolvedValueOnce({ kind: 'catalog-failed' });

    expect(() => {
      requestDeviceLanguageFollow('es');
    }).not.toThrow();
    await vi.waitFor(() => {
      expect(mocks.captureException).toHaveBeenCalledTimes(1);
    });

    const [reported, options] = mocks.captureException.mock.calls[0] ?? [];
    expect(reported).toBeInstanceOf(Error);
    expect(options).toEqual({
      tags: { 'error.subsystem': 'startup', 'error.operation': 'language_follow' },
    });
    expect(i18n.resolvedLanguage).toBe('en');

    // The failed step must not break the chain for the next device change.
    requestDeviceLanguageFollow('es');
    await vi.waitFor(() => {
      expect(i18n.resolvedLanguage).toBe('es');
    });
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
  });

  it('applies a repeated request for the same language once', async () => {
    const firstApply = Promise.withResolvers<undefined>();
    mocks.applyDeviceLanguage.mockImplementationOnce(async (language: string) => {
      await firstApply.promise;
      await i18n.changeLanguage(language);
      return { kind: 'applied-ltr' };
    });

    requestDeviceLanguageFollow('es');
    requestDeviceLanguageFollow('es');
    firstApply.resolve(undefined);
    await vi.waitFor(() => {
      expect(i18n.resolvedLanguage).toBe('es');
    });

    expect(mocks.applyDeviceLanguage.mock.calls).toEqual([['es']]);
  });

  it('applies two device changes in order, newest last, without overlapping', async () => {
    const firstApply = Promise.withResolvers<undefined>();
    mocks.applyDeviceLanguage.mockImplementationOnce(async (language: string) => {
      await firstApply.promise;
      await i18n.changeLanguage(language);
      return { kind: 'applied-ltr' };
    });

    requestDeviceLanguageFollow('es');
    requestDeviceLanguageFollow('fr');

    // The second request waits behind the first apply, so no two
    // `changeLanguage` calls ever interleave.
    await drainFollowQueue();
    expect(mocks.applyDeviceLanguage.mock.calls).toEqual([['es']]);

    firstApply.resolve(undefined);
    await vi.waitFor(() => {
      expect(i18n.resolvedLanguage).toBe('fr');
    });

    expect(mocks.applyDeviceLanguage.mock.calls).toEqual([['es'], ['fr']]);
  });
});
