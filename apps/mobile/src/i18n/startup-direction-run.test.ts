import { describe, expect, it, type Mock, vi } from 'vitest';

import {
  type LanguageStartupDeps,
  retryLanguageStartupDirectionAsync,
  runLanguageStartupDirectionAsync,
  runLanguageStartupDirectionGuardedAsync,
} from './startup-direction-run';

type Effects = LanguageStartupDeps & {
  calls: string[];
  readAttempt: Mock;
  writeAttempt: Mock;
  clearAttempt: Mock;
  reload: Mock;
  syncRtl: Mock;
};

function effects(
  overrides: Partial<Pick<LanguageStartupDeps, 'readAttempt' | 'writeAttempt' | 'reload'>> = {}
): Effects {
  const calls: string[] = [];
  const deps = {
    calls,
    syncRtl: vi.fn((language: string) => {
      calls.push(`syncRtl:${language}`);
      return true;
    }),
    readAttempt: vi.fn(() => {
      calls.push('readAttempt');
      return Promise.resolve(null);
    }),
    writeAttempt: vi.fn((language: string) => {
      calls.push(`writeAttempt:${language}`);
      return Promise.resolve(true);
    }),
    clearAttempt: vi.fn(() => {
      calls.push('clearAttempt');
      return Promise.resolve();
    }),
    reload: vi.fn(() => {
      calls.push('reload');
      return Promise.resolve();
    }),
    ...overrides,
  };
  return deps as Effects;
}

describe('runLanguageStartupDirectionAsync', () => {
  it('applies in place and drops the stale attempt record', async () => {
    const deps = effects();

    await expect(
      runLanguageStartupDirectionAsync({ language: 'en', isRtl: false, shouldBeRtl: false }, deps)
    ).resolves.toBe('applied');

    expect(deps.calls).toEqual(['readAttempt', 'clearAttempt']);
  });

  it('relaunches once, recording the attempt before the direction is forced', async () => {
    const deps = effects();

    await expect(
      runLanguageStartupDirectionAsync({ language: 'ar', isRtl: false, shouldBeRtl: true }, deps)
    ).resolves.toBe('reloaded');

    expect(deps.calls).toEqual(['readAttempt', 'writeAttempt:ar', 'syncRtl:ar', 'reload']);
  });

  it('refuses a second relaunch for the same untaken direction', async () => {
    const deps = effects({ readAttempt: vi.fn(() => Promise.resolve('ar' as const)) });

    await expect(
      runLanguageStartupDirectionAsync({ language: 'ar', isRtl: false, shouldBeRtl: true }, deps)
    ).resolves.toBe('retry');

    expect(deps.reload).not.toHaveBeenCalled();
    expect(deps.syncRtl).not.toHaveBeenCalled();
  });

  it('keeps the current direction when the attempt record cannot be written', async () => {
    const deps = effects({ writeAttempt: vi.fn(() => Promise.resolve(false)) });

    await expect(
      runLanguageStartupDirectionAsync({ language: 'ar', isRtl: false, shouldBeRtl: true }, deps)
    ).resolves.toBe('retry');

    // Without the record the next launch cannot tell the direction was already
    // attempted, so the relaunch that would loop must not run.
    expect(deps.reload).not.toHaveBeenCalled();
    expect(deps.syncRtl).not.toHaveBeenCalled();
  });

  it('reports a failed relaunch so the caller shows the retry screen', async () => {
    const deps = effects({
      reload: vi.fn(() => Promise.reject(new Error('reload failed'))),
    });

    await expect(
      runLanguageStartupDirectionAsync({ language: 'ur', isRtl: false, shouldBeRtl: true }, deps)
    ).resolves.toBe('retry');

    expect(deps.writeAttempt).toHaveBeenCalledWith('ur');
  });
});

describe('runLanguageStartupDirectionGuardedAsync', () => {
  it('turns a rejected step into the retry outcome and reports it once', async () => {
    const failure = new Error('direction switch unavailable');
    const deps = effects({
      readAttempt: vi.fn(() => Promise.reject(failure)),
    });
    const onFailure = vi.fn<(error: unknown) => void>();

    await expect(
      runLanguageStartupDirectionGuardedAsync(
        { language: 'en', isRtl: false, shouldBeRtl: false },
        deps,
        onFailure
      )
    ).resolves.toBe('retry');

    expect(onFailure).toHaveBeenCalledExactlyOnceWith(failure);
    // The failure happened at the first read: no effect ran, so nothing was
    // forced or relaunched.
    expect(deps.syncRtl).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it('turns a thrown synchronous direction switch into the retry outcome', async () => {
    const failure = new Error('I18nManager unavailable');
    const deps = effects();
    deps.syncRtl = vi.fn(() => {
      throw failure;
    });
    const onFailure = vi.fn<(error: unknown) => void>();

    await expect(
      runLanguageStartupDirectionGuardedAsync(
        { language: 'ar', isRtl: false, shouldBeRtl: true },
        deps,
        onFailure
      )
    ).resolves.toBe('retry');

    // The direction record was written before the switch threw, so the next
    // cold start does not relaunch again for the same direction.
    expect(deps.writeAttempt).toHaveBeenCalledExactlyOnceWith('ar');
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(failure);
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it('passes a settled outcome through without reporting', async () => {
    const deps = effects();
    const onFailure = vi.fn<(error: unknown) => void>();

    await expect(
      runLanguageStartupDirectionGuardedAsync(
        { language: 'en', isRtl: false, shouldBeRtl: false },
        deps,
        onFailure
      )
    ).resolves.toBe('applied');

    expect(onFailure).not.toHaveBeenCalled();
    expect(deps.calls).toEqual(['readAttempt', 'clearAttempt']);
  });
});

describe('retryLanguageStartupDirectionAsync', () => {
  it('drops the record before relaunching', async () => {
    const calls: string[] = [];
    await expect(
      retryLanguageStartupDirectionAsync({
        clearAttempt: () => {
          calls.push('clearAttempt');
          return Promise.resolve();
        },
        reload: () => {
          calls.push('reload');
          return Promise.resolve();
        },
      })
    ).resolves.toBe(true);

    expect(calls).toEqual(['clearAttempt', 'reload']);
  });

  it('still drops the record when the relaunch fails, and reports the screen stays', async () => {
    const clearAttempt = vi.fn(() => Promise.resolve());
    await expect(
      retryLanguageStartupDirectionAsync({
        clearAttempt,
        reload: () => Promise.reject(new Error('reload failed')),
      })
    ).resolves.toBe(false);

    expect(clearAttempt).toHaveBeenCalledTimes(1);
  });
});
