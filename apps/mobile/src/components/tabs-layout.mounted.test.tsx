import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CountSurfaces,
  kiloclawVisible,
  routerReplace,
} from '@/components/agents/agents-tab-badge.test-helpers';
import { i18n } from '@/i18n';
import { type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

type Mount = Awaited<ReturnType<typeof renderWithProviders>>;
const mounts: Mount[] = [];

vi.mock('@/components/agents/session-preview-overlay', () => ({
  SessionPreviewOverlay: () => null,
}));

function isHostType(item: ReactTestInstance, type: string) {
  return typeof item.type === 'string' && item.type === type;
}

function screenOptions(renderer: Mount['renderer']) {
  return renderer.root.find(item => isHostType(item, 'Tabs')).props.screenOptions as {
    tabBarHideOnKeyboard: boolean;
    tabBarShowLabel: boolean;
    tabBarStyle: { display?: string };
  };
}

describe('Tabs layout with the keyboard raised', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    kiloclawVisible.value = false;
    routerReplace.mockClear();
  });

  afterEach(() => {
    for (const result of mounts) {
      result.unmount();
    }
    mounts.length = 0;
  });

  it('steps the whole bar out of the IME’s way instead of leaving a clipped icon strip', async () => {
    const result = await renderWithProviders(createElement(CountSurfaces));
    mounts.push(result);
    const options = screenOptions(result.renderer);

    // The bar is absolutely positioned, so the keyboard covers its lower half and
    // only the icon row peeks out above it (explorer finding, agents-search-empty).
    // Hide-on-keyboard is the navigator's own IME handling: it watches the same
    // platform keyboard events the rest of the app pads for and animates the bar
    // out of the way, leaving no half-covered strip.
    expect(options.tabBarHideOnKeyboard).toBe(true);
    // Labels stay configured, so the bar comes back whole when the IME is gone.
    expect(options.tabBarShowLabel).toBe(true);
    // The resting presentation is unchanged: the bar renders in place.
    expect(options.tabBarStyle.display).toBe('flex');
  });

  it.each([false, true])('always shows Chat with KiloClaw visibility %s', async visible => {
    kiloclawVisible.value = visible;
    const result = await renderWithProviders(createElement(CountSurfaces));
    mounts.push(result);
    const chatTab = result.renderer.root.findByProps({ name: '(4_chat)' });
    const options = chatTab.props.options as {
      href?: string | null;
      tabBarAccessibilityLabel: string;
    };

    expect(options.href).toBeUndefined();
    expect(options.tabBarAccessibilityLabel).toBe(
      i18n.t('tabs.position', {
        name: i18n.t('common.chat'),
        position: visible ? 4 : 3,
        total: visible ? 5 : 4,
      })
    );
    expect(routerReplace).not.toHaveBeenCalled();
    const kiloclawTab = result.renderer.root.findByProps({ name: '(1_kiloclaw)' });
    const kiloclawOptions = kiloclawTab.props.options as { href?: string | null };
    expect(kiloclawOptions.href).toBe(visible ? undefined : null);
  });
});
