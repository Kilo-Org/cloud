/* eslint-disable typescript-eslint/no-deprecated -- Use the repository's DOM-free mounted renderer. */
import {
  announcements,
  catalogs,
  expectFeedback,
  expectHidden,
  flush,
  lifecycle,
  mount,
  native,
  nestedUnlockScenes,
  platform,
  rerender,
  resetUnlockMocks,
  retry,
  unlockRoot as root,
  storage,
  text,
  unmountUnlock,
} from '@/components/app-unlock-screen.test-helpers';
import { appUnlockScreenLayout } from '@/components/app-unlock-screen';
import { PickerSheet } from '@/components/picker-sheet';
import { PreferencesScreen } from '@/components/preferences-screen';
import { SheetHeader } from '@/components/sheet-header';
import { type ElementType } from 'react';
import { ScrollView } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import fr from '@/i18n/locales/fr.json';
import AppLayout from '@/app/(app)/_layout';
import KiloClawLayout from '@/app/(app)/(tabs)/(1_kiloclaw)/_layout';
import OrganizationLayout from '@/app/(app)/(tabs)/(3_profile)/organization/_layout';
import SecurityAgentScopeLayout from '@/app/(app)/(tabs)/(3_profile)/security-agent/[scope]/_layout';
import PrReviewNumberLayout from '@/app/(app)/pr-review/[owner]/[repo]/[number]/_layout';
import { AppUnlockProvider } from '@/lib/app-unlock-context';

beforeEach(resetUnlockMocks);
afterEach(unmountUnlock);

it.each([false, true])(
  'waits for language across all five layouts and retains the draft on relock; catalog failure=%s',
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
      const boundary = root().findByType(Layout);
      expect(boundary.findAllByType('Scene' as ElementType)).toHaveLength(1);
    }
    for (const Layout of [OrganizationLayout, SecurityAgentScopeLayout]) {
      const wrapper = root().findByType(Layout).findByProps({ pointerEvents: 'none' });
      expect(wrapper.findAllByType('PrivacyCover' as ElementType)).toHaveLength(1);
    }
    const observer = root().findByType('SecurityAgentCommandObserver' as ElementType);
    const scene = root().findByType(KiloClawLayout);
    const draft = scene.findByType('Draft' as ElementType);
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
    expect(root().findAllByType('ActivityIndicator' as ElementType).length).toBeGreaterThan(0);
    await flush(() => {
      auth.resolve({ success: true });
    });
    expectHidden(root(), false);
    native.authenticateAsync.mockResolvedValueOnce({ success: false, error: 'user_cancel' });
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    await flush(() => {
      lifecycle.change?.('background');
      now.mockReturnValue(300_000);
      lifecycle.change?.('active');
    });
    expectHidden(root(), true);
    await flush(retry()?.props.onPress as () => void);
    await act(async () => {
      await i18n.changeLanguage('en');
    });
    expectHidden(root(), false);
    expect(root().findAllByType('Pressable' as ElementType)).toHaveLength(0);
    expect(scene.findByType('Draft' as ElementType)).toBe(draft);
    expect(draft.props.value).toBe('unsent work');
    expect(root().findByType('SecurityAgentCommandObserver' as ElementType)).toBe(observer);
    expect(root().findByType(AppUnlockProvider)).toBe(provider);
    expect(root().findAllByType(AppUnlockProvider)).toHaveLength(1);
    expect(announcements).not.toHaveBeenCalled();
    expect(native.authenticateAsync).toHaveBeenCalledTimes(3);
    expect(native.authenticateAsync).toHaveBeenCalledWith({
      promptMessage: failed ? 'Unlock with biometrics' : fr.common.retry,
      disableDeviceFallback: false,
    });
  }
);

it.each([true, false])('keeps native sheet siblings; scrollable=%s', async scrollable => {
  const children = (
    <PickerSheet title="Sheet" onDone={vi.fn<() => void>()} scrollable={scrollable}>
      {scrollable ? null : <ScrollView />}
    </PickerSheet>
  );
  await mount(appUnlockScreenLayout({ children }));
  const sheet = root().findByType(PickerSheet);
  expect(sheet.parent?.props).toEqual({
    children,
    className: 'flex-1',
    pointerEvents: 'auto',
    accessibilityElementsHidden: false,
    importantForAccessibility: 'auto',
  });
  expect(sheet.parent?.parent?.type).not.toBe('View');
  expect(sheet.children).toMatchObject([{ type: SheetHeader }, { type: 'ScrollView' }]);
});

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
  expect(root().findAllByType('Skeleton' as ElementType)).toHaveLength(1);
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
  expect(root().findAllByType('Skeleton' as ElementType)).toHaveLength(1);
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
