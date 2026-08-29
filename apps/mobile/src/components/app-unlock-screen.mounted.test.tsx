/* eslint-disable typescript-eslint/no-deprecated -- Use the repository's DOM-free mounted renderer. */
import { catalogs, native, storage } from '@/components/app-unlock-screen.test-helpers';
import { QueryClientProvider } from '@tanstack/react-query';
import { type ReactElement } from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
async function flush(update?: () => void) {
  await act(async () => {
    update?.();
    await vi.dynamicImportSettled();
  });
}
async function mount(ui: ReactElement = <KiloClawLayout />, languageReady = true) {
  view = await renderWithProviders(
    <AppRootProviders languageReady={languageReady}>{ui}</AppRootProviders>
  );
  await flush();
}
function expectHidden(hidden: boolean) {
  const scenes = root().findAllByType('Scene');
  expect(scenes.length).toBeGreaterThan(0);
  for (const scene of scenes) {
    const wrapper = scene.find(
      node => node.type === 'View' && node.props.pointerEvents !== undefined
    );
    expect(wrapper.props).toMatchObject({
      pointerEvents: hidden ? 'none' : 'auto',
      accessibilityElementsHidden: hidden,
      importantForAccessibility: hidden ? 'no-hide-descendants' : 'auto',
    });
    expect((wrapper.props.className as string).includes('opacity-0')).toBe(hidden);
    expect(wrapper.findAllByType('Draft')).toHaveLength(1);
  }
}
function retry() {
  return root().findAllByType('Pressable')[0];
}
function text() {
  const texts = root().findAllByType('Text');
  return texts.map(node => node.props.children).join('\n');
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('__DEV__', true);
  vi.resetAllMocks();
  storage.getItemAsync.mockResolvedValue('enabled');
  native.hasHardwareAsync.mockResolvedValue(true);
  native.isEnrolledAsync.mockResolvedValue(true);
  native.getEnrolledLevelAsync.mockResolvedValue(3);
  native.authenticateAsync.mockResolvedValue({ success: true });
});
afterEach(async () => {
  view?.unmount();
  view = undefined;
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
    expectHidden(true);
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
      view?.renderer.update(
        <QueryClientProvider client={view.queryClient}>
          <AppRootProviders languageReady>{ui}</AppRootProviders>
        </QueryClientProvider>
      );
    });
    expectHidden(true);
    expect(retry()?.props).toMatchObject({ disabled: true, accessibilityState: { busy: true } });
    expect(root().findAllByType('ActivityIndicator').length).toBeGreaterThan(0);
    await flush(() => {
      auth.resolve({ success: true });
    });
    expectHidden(false);
    await act(async () => {
      await i18n.changeLanguage('en');
    });
    expectHidden(false);
    expect(root().findAllByType('Pressable')).toHaveLength(0);
    expect(draft.props.value).toBe('unsent work');
    expect(root().findByType('SecurityAgentCommandObserver')).toBe(observer);
    expect(root().findByType(AppUnlockProvider)).toBe(provider);
    expect(root().findAllByType(AppUnlockProvider)).toHaveLength(1);
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
  expectHidden(false);
  expect(text()).not.toContain('Unlock with biometrics');
  expect(native.authenticateAsync).not.toHaveBeenCalled();
});

it('hides scenes during preference loading and retries a failed read without disclosure', async () => {
  const read = Promise.withResolvers<string | null>();
  storage.getItemAsync.mockReturnValueOnce(read.promise);
  await mount();
  expectHidden(true);
  expect(root().findAllByType('Skeleton')).toHaveLength(1);
  expect(root().findByProps({ accessibilityRole: 'progressbar' }).props.accessibilityState).toEqual(
    { busy: true }
  );
  expect(retry()).toBeUndefined();
  await flush(() => {
    read.reject(new Error('read failed'));
  });
  expectHidden(true);
  expect(text()).toContain('Something went wrong');
  expect(retry()?.props.disabled).toBe(false);
  const reread = Promise.withResolvers<string | null>();
  storage.getItemAsync.mockReturnValueOnce(reread.promise);
  await flush(retry()?.props.onPress as () => void);
  expectHidden(true);
  expect(root().findAllByType('Skeleton')).toHaveLength(1);
  await flush(() => {
    reread.resolve('disabled');
  });
  expectHidden(false);
});

it.each(['user_cancel', 'authentication_failed', 'lockout'])(
  'retains the gate after %s and unlocks through Retry',
  async code => {
    native.authenticateAsync.mockResolvedValueOnce({ success: false, error: code });
    await mount();
    expectHidden(true);
    expect(text()).toContain('Unlock with biometrics');
    expect(text().includes('Something went wrong')).toBe(code !== 'user_cancel');
    expect(retry()?.props).toMatchObject({ disabled: false, accessibilityLabel: 'Retry' });
    await flush(retry()?.props.onPress as () => void);
    expectHidden(false);
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
    expectHidden(true);
    expect(text()).toContain('Unavailable');
    expect(text()).toContain('Check your device security settings and try again.');
    expect(native.authenticateAsync).not.toHaveBeenCalled();
    native.getEnrolledLevelAsync.mockResolvedValue(1);
    await flush(retry()?.props.onPress as () => void);
    expectHidden(false);
    expect(storage.setItemAsync).not.toHaveBeenCalled();
  }
);
