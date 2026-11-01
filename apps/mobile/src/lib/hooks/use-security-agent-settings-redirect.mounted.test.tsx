// A Security Agent settings screen that a link opens while its agent is
// disabled has to bounce to the settings overview, and it has to bounce again
// when the link's own navigation lands after the first replace and focuses the
// screen over the overview: a config-keyed effect would never run again for an
// unchanged config and would leave the reader on a screen that renders nothing.
import { act, createElement, useEffect } from 'react';
import { type ReactTestRenderer, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSecurityAgentSettingsRedirect } from './use-settings-back-guard';

const replace = vi.hoisted(() => vi.fn());
const navigation = vi.hoisted(() => ({ goBack: vi.fn() }));

// The router's focus state, kept where a suite can fire it by hand: the real
// `useFocusEffect` runs its callback on the screen's first focus and again on
// every later one, which is the event a late link navigation produces.
const focus = vi.hoisted(() => ({
  effect: null as (() => void) | null,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ replace }),
  // The redirect is the subject here; the guard half of the module only needs
  // its own imports to resolve.
  useNavigation: () => navigation,
  usePreventRemove: () => undefined,
  useFocusEffect: (effect: () => void) => {
    focus.effect = effect;
    useEffect(effect, [effect]);
  },
}));
// The guard's confirmation renders through the app dialog, which reaches a
// React Native native module this project cannot load.
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), dialog: null }),
}));

const OVERVIEW = '/(app)/security-agent/personal/settings';

function RedirectHarness({
  scope,
  isEnabled,
  skipRedirect,
  dirty,
}: Readonly<{
  scope: string;
  isEnabled: boolean | undefined;
  skipRedirect?: boolean;
  dirty?: boolean;
}>) {
  useSecurityAgentSettingsRedirect(scope, isEnabled, { skipRedirect, dirty });
  return null;
}

function mount(props: {
  scope: string;
  isEnabled: boolean | undefined;
  skipRedirect?: boolean;
  dirty?: boolean;
}): ReactTestRenderer {
  const mounted: { renderer?: ReactTestRenderer } = {};
  act(() => {
    mounted.renderer = TestRenderer.create(createElement(RedirectHarness, props));
  });
  if (!mounted.renderer) {
    throw new Error('redirect harness did not render');
  }
  return mounted.renderer;
}

/** A focus event the navigator delivers while the screen is already mounted. */
function fireFocus() {
  act(() => {
    focus.effect?.();
  });
}

describe('useSecurityAgentSettingsRedirect', () => {
  beforeEach(() => {
    replace.mockClear();
    focus.effect = null;
  });

  it('bounces a disabled settings screen to the settings overview', () => {
    mount({ scope: 'personal', isEnabled: false });

    expect(replace).toHaveBeenCalledWith(OVERVIEW);
  });

  it('bounces again when a late link navigation focuses the screen after the first replace', () => {
    mount({ scope: 'personal', isEnabled: false });
    expect(replace).toHaveBeenCalledTimes(1);

    fireFocus();

    expect(replace).toHaveBeenCalledTimes(2);
    expect(replace).toHaveBeenLastCalledWith(OVERVIEW);
  });

  it('does not bounce while the config is still loading', () => {
    const renderer = mount({ scope: 'personal', isEnabled: undefined });
    fireFocus();
    expect(replace).not.toHaveBeenCalled();

    act(() => {
      renderer.update(createElement(RedirectHarness, { scope: 'personal', isEnabled: false }));
    });

    expect(replace).toHaveBeenCalledWith(OVERVIEW);
  });

  it('does not bounce an enabled settings screen', () => {
    mount({ scope: 'personal', isEnabled: true });
    fireFocus();

    expect(replace).not.toHaveBeenCalled();
  });

  it('does not bounce the repositories screen, which opts out', () => {
    mount({ scope: 'personal', isEnabled: false, skipRedirect: true });
    fireFocus();

    expect(replace).not.toHaveBeenCalled();
  });

  it('retries the bounce once a dirty draft is undone', () => {
    // The dirty guard intercepts the removal the bounce asks for, so the retry
    // has to come from the redirect itself: `dirty` is a dependency of the
    // focus effect, and undoing the edit re-registers it.
    const renderer = mount({ scope: 'personal', isEnabled: false, dirty: true });
    expect(replace).toHaveBeenCalledTimes(1);
    replace.mockClear();

    act(() => {
      renderer.update(
        createElement(RedirectHarness, { scope: 'personal', isEnabled: false, dirty: false })
      );
    });

    expect(replace).toHaveBeenCalledWith(OVERVIEW);
  });
});
