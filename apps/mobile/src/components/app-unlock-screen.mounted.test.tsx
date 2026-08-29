/* eslint-disable typescript-eslint/no-deprecated -- Use the repository's DOM-free mounted renderer. */
import {
  announcements,
  catalogs,
  expectFeedback,
  expectHidden,
  flush,
  lifecycle,
  native,
  nestedUnlockScenes,
  platform,
  resetUnlockMocks,
  storage,
  text,
} from '@/components/app-unlock-screen.test-helpers';
import { PreferencesScreen } from '@/components/preferences-screen';
import { QueryClientProvider } from '@tanstack/react-query';
import { type ReactElement } from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import fr from '@/i18n/locales/fr.json';
import AppLayout from '@/app/(app)/_layout';
import KiloClawLayout from '@/app/(app)/(tabs)/(1_kiloclaw)/_layout';
import OrganizationLayout from '@/app/(app)/(tabs)/(3_profile)/organization/_layout';
import SecurityAgentScopeLayout from '@/app/(app)/(tabs)/(3_profile)/security-agent/[scope]/_layout';
import PrReviewNumberLayout from '@/app/(app)/pr-review/[owner]/[repo]/[number]/_layout';
import { AppRootProviders } from '@/components/app-root-providers';
import { AppUnlockProvider } from '@/lib/app-unlock-context';
import { renderWithProviders } from '@/test/render-with-providers';

let view: Awaited<ReturnType<typeof renderWithProviders>> | undefined = undefined;
function root() {
  if (!view) {
    throw new Error('Scene not mounted');
  }
  return view.renderer.root;
}
async function mount(ui: ReactElement = <KiloClawLayout />, languageReady = true) {
  view = await renderWithProviders(
    <AppRootProviders languageReady={languageReady}>{ui}</AppRootProviders>
  );
  await flush();
}
function rerender(ui: ReactElement) {
  view?.renderer.update(
    <QueryClientProvider client={view.queryClient}>
      <AppRootProviders languageReady>{ui}</AppRootProviders>
    </QueryClientProvider>
  );
}
function retry() {
  return root().findAllByType('Pressable')[0];
}
beforeEach(resetUnlockMocks);
afterEach(async () => {
  view?.unmount();
  view = undefined;
  vi.restoreAllMocks();
  i18n.removeResourceBundle('fr', 'translation');
  await i18n.changeLanguage('en');
  vi.unstubAllGlobals();
});

it.each([false, true])(
  'waits for language across all five layouts; catalog failure=%s',
  async failed => {
    catalogs.fr.mockImplementation(() => {
      if (failed) {
        throw new Error('catalog failed');
      }
      // Reuse existing French text as a distinct catalog fixture, not a new translation.
      return { preferences: { biometricUnlock: fr.common.retry } };
    });
    const auth = Promise.withResolvers<unknown>();
    native.authenticateAsync.mockReturnValueOnce(auth.promise);
    const layouts = [
      AppLayout,
      KiloClawLayout,
      PrReviewNumberLayout,
      OrganizationLayout,
      SecurityAgentScopeLayout,
    ];
    const ui = (
      <>
        {layouts.map(Layout => (
          <Layout key={Layout.name} />
        ))}
      </>
    );
    await mount(ui, false);
    const provider = root().findByType(AppUnlockProvider);
    expect(provider.parent?.type).toBe('AuthProvider');
    expectHidden(root(), true);
    for (const Layout of layouts) {
      expect(root().findByType(Layout).findAllByType('Scene')).toHaveLength(1);
    }
    for (const Layout of [OrganizationLayout, SecurityAgentScopeLayout]) {
      const wrapper = root().findByType(Layout).findByProps({ pointerEvents: 'none' });
      expect(wrapper.findAllByType('PrivacyCover')).toHaveLength(1);
    }
    const observer = root().findByType('SecurityAgentCommandObserver');
    const draft = root().findByType(KiloClawLayout).findByType('Draft');
    await flush(() => {
      (draft.props.onChange as (value: string) => void)('unsent work');
    });
    expect(native.authenticateAsync).not.toHaveBeenCalled();
    await act(async () => {
      await i18n.changeLanguage('fr');
    });
    expect(native.authenticateAsync).not.toHaveBeenCalled();
    await flush(() => {
      rerender(ui);
    });
    expectHidden(root(), true);
    expect(retry()?.props).toMatchObject({ disabled: true, accessibilityState: { busy: true } });
    expect(root().findAllByType('ActivityIndicator').length).toBeGreaterThan(0);
    await flush(() => {
      auth.resolve({ success: true });
    });
    expectHidden(root(), false);
    await act(async () => {
      await i18n.changeLanguage('en');
    });
    expectHidden(root(), false);
    expect(root().findAllByType('Pressable')).toHaveLength(0);
    expect(draft.props.value).toBe('unsent work');
    expect(root().findByType('SecurityAgentCommandObserver')).toBe(observer);
    expect(root().findByType(AppUnlockProvider)).toBe(provider);
    expect(root().findAllByType(AppUnlockProvider)).toHaveLength(1);
    expect(announcements).not.toHaveBeenCalled();
    expect(native.authenticateAsync).toHaveBeenCalledTimes(1);
    expect(native.authenticateAsync).toHaveBeenCalledWith({
      promptMessage: failed ? 'Unlock with biometrics' : fr.common.retry,
      disableDeviceFallback: false,
    });
  }
);

it.each([null, 'disabled'])('shows the scene without a prompt for %s', async raw => {
  storage.getItemAsync.mockResolvedValue(raw);
  await mount();
  expectHidden(root(), false);
  expect(text(root())).not.toContain('Unlock with biometrics');
  expect(announcements).not.toHaveBeenCalled();
  expect(native.authenticateAsync).not.toHaveBeenCalled();
});

it('hides scenes during preference loading and retries a failed read without disclosure', async () => {
  const read = Promise.withResolvers<string | null>();
  storage.getItemAsync.mockReturnValueOnce(read.promise);
  await mount();
  expectHidden(root(), true);
  expect(root().findAllByType('Skeleton')).toHaveLength(1);
  expect(root().findByProps({ accessibilityRole: 'progressbar' }).props.accessibilityState).toEqual(
    { busy: true }
  );
  expect(retry()).toBeUndefined();
  await flush(() => {
    read.reject(new Error('read failed'));
  });
  expectHidden(root(), true);
  expect(text(root())).toContain('Something went wrong');
  expect(retry()?.props.disabled).toBe(false);
  const reread = Promise.withResolvers<string | null>();
  storage.getItemAsync.mockReturnValueOnce(reread.promise);
  await flush(retry()?.props.onPress as () => void);
  expectHidden(root(), true);
  expect(root().findAllByType('Skeleton')).toHaveLength(1);
  await flush(() => {
    reread.resolve('disabled');
  });
  expectHidden(root(), false);
});

it.each(['user_cancel', 'authentication_failed', 'lockout'])(
  'retains the gate after %s and unlocks through Retry',
  async code => {
    native.authenticateAsync.mockResolvedValueOnce({ success: false, error: code });
    await mount();
    expectHidden(root(), true);
    expect(text(root())).toContain('Unlock with biometrics');
    expect(text(root()).includes('Something went wrong')).toBe(code !== 'user_cancel');
    expect(retry()?.props).toMatchObject({ disabled: false, accessibilityLabel: 'Retry' });
    await flush(retry()?.props.onPress as () => void);
    expectHidden(root(), false);
    expect(native.authenticateAsync).toHaveBeenCalledTimes(2);
  }
);

it.each([false, true])(
  'requires device setup with hardware=%s and rechecks capability on Retry',
  async hardware => {
    native.hasHardwareAsync.mockResolvedValue(hardware);
    native.isEnrolledAsync.mockResolvedValue(false);
    native.getEnrolledLevelAsync.mockResolvedValue(0);
    await mount();
    expectHidden(root(), true);
    expect(text(root())).toContain('Unavailable');
    expect(text(root())).toContain('Check your device security settings and try again.');
    expect(native.authenticateAsync).not.toHaveBeenCalled();
    native.getEnrolledLevelAsync.mockResolvedValue(1);
    await flush(retry()?.props.onPress as () => void);
    expectHidden(root(), false);
    expect(storage.setItemAsync).not.toHaveBeenCalled();
  }
);

describe.each(['ios', 'android'])('%s shared unlock announcements', os => {
  beforeEach(() => {
    platform.OS = os;
  });

  it('waits for localized read feedback and keeps one owner on rerender', async () => {
    storage.getItemAsync.mockRejectedValueOnce(new Error('read failed'));
    i18n.addResourceBundle('fr', 'translation', fr);
    const ui = nestedUnlockScenes(<KiloClawLayout />);
    await mount(ui, false);
    await act(async () => {
      await i18n.changeLanguage('fr');
    });
    expect(announcements).not.toHaveBeenCalled();
    await flush(() => {
      rerender(ui);
    });
    const message = fr.common.somethingWentWrong;
    expectFeedback(root(), message, 3);
    expect(announcements.mock.calls).toEqual(os === 'ios' ? [[message]] : []);
    await flush(() => {
      rerender(ui);
    });
    expect(announcements.mock.calls).toEqual(os === 'ios' ? [[message]] : []);
  });

  it.each([
    ['read', 'Something went wrong'],
    ['authentication_failed', 'Something went wrong'],
    ['setup', 'Check your device security settings and try again.'],
  ])('announces %s once across nested gates and again after Retry', async (code, message) => {
    if (code === 'read') {
      storage.getItemAsync.mockRejectedValueOnce(new Error('read failed'));
    } else if (code === 'setup') {
      native.getEnrolledLevelAsync.mockResolvedValue(0);
    } else {
      native.authenticateAsync.mockResolvedValueOnce({ success: false, error: code });
    }
    await mount(nestedUnlockScenes(<KiloClawLayout />));
    expectFeedback(root(), message, 3);
    expect(announcements.mock.calls).toEqual(os === 'ios' ? [[message]] : []);

    const pending = Promise.withResolvers<number>();
    if (code === 'read') {
      storage.getItemAsync.mockReturnValueOnce(pending.promise);
    } else {
      native.getEnrolledLevelAsync.mockReturnValueOnce(pending.promise);
      native.authenticateAsync.mockResolvedValueOnce({ success: false, error: code });
    }
    await flush(retry()?.props.onPress as () => void);
    expect(text(root())).not.toContain(message);
    await flush(() => {
      if (code === 'read') {
        pending.reject(new Error('read failed again'));
      } else {
        pending.resolve(code === 'setup' ? 0 : 3);
      }
    });
    expectFeedback(root(), message, 3);
    expect(announcements.mock.calls).toEqual(os === 'ios' ? [[message], [message]] : []);
  });

  it.each([false, true])('announces setting feedback once with locked=%s', async locked => {
    await mount(nestedUnlockScenes(<PreferencesScreen />));
    const preference = root().findByProps({ accessibilityLabel: 'Unlock with biometrics' });
    const save = Promise.withResolvers<undefined>();
    storage.setItemAsync.mockReturnValueOnce(save.promise);
    await flush(() => {
      (preference.props.onValueChange as (enabled: boolean) => void)(false);
    });
    expect(preference.props).toMatchObject({ value: true, accessibilityState: { busy: true } });
    expect(announcements).not.toHaveBeenCalled();
    if (locked) {
      const now = vi.spyOn(Date, 'now').mockReturnValue(0);
      await flush(() => {
        lifecycle.change?.('background');
        now.mockReturnValue(300_000);
        lifecycle.change?.('active');
      });
      expect(retry()?.props.disabled).toBe(true);
    }
    await flush(() => {
      save.reject(new Error('save failed'));
    });
    const message = 'Could not save setting';
    expectFeedback(root(), message, locked ? 3 : 1);
    expect(announcements.mock.calls).toEqual(os === 'ios' ? [[message]] : []);
    expect(preference.props).toMatchObject({ value: true, disabled: locked });
    if (locked) {
      expect(retry()?.props).toMatchObject({ disabled: false, accessibilityLabel: 'Retry' });
      await flush(retry()?.props.onPress as () => void);
      expect(preference.props.disabled).toBe(false);
      expect(text(root())).not.toContain(message);
      expect(announcements.mock.calls).toEqual(os === 'ios' ? [[message]] : []);
    }
  });
});
