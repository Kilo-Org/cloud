import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CountSurfaces,
  routerReplace,
  segments,
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
    tabBarButton: (props: Record<string, unknown>) => ReactTestInstance;
  };
}

describe('Tabs layout with the keyboard raised', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    routerReplace.mockClear();
  });

  afterEach(() => {
    // Module-level state: the wiring test installs the sheet segments and must
    // return the holder to its default however the test exits, or the remaining
    // suites render the layout in a state they were not written for.
    segments.current = ['(app)', '(tabs)', '(0_home)'];
    for (const result of mounts) {
      result.unmount();
    }
    mounts.length = 0;
  });

  // The wiring that hides the bar's entries under a presented form sheet: the
  // layout decides from its own segments at render time, and the entry the
  // navigator builds must carry the flag. Each state mounts fresh, because the
  // layout reads the segments during render. Pinning the render-prop result
  // keeps the device-proved behavior from silently regressing if the wiring is
  // dropped or reordered.
  it('hands the bar entries the form-sheet hiding flag from the current segments', async () => {
    const idle = await renderWithProviders(createElement(CountSurfaces));
    mounts.push(idle);
    const idleOptions = screenOptions(idle.renderer);
    expect(idleOptions.tabBarButton).toBeTypeOf('function');
    // Home segments: no sheet presented, the entry stays readable. The render
    // prop returns the `TabBarButton` element; its flag mapping to the native
    // accessibility props is covered by `tab-bar-button.mounted.test.tsx`.
    const idleEntry = idleOptions.tabBarButton({});
    expect(idleEntry.props.hiddenFromA11y).toBe(false);
    idle.unmount();
    mounts.length = 0;

    // The organization invite form sheet's segments: the entry hides itself
    // with the covered scene's presentation.
    segments.current = ['(app)', '(tabs)', '(3_profile)', 'organization', 'invite-member'];
    const covered = await renderWithProviders(createElement(CountSurfaces));
    mounts.push(covered);
    const coveredOptions = screenOptions(covered.renderer);
    const coveredEntry = coveredOptions.tabBarButton({});
    expect(coveredEntry.props.hiddenFromA11y).toBe(true);
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

  it('shows Chat third in the four-tab navigation', async () => {
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
        position: 3,
        total: 4,
      })
    );
    expect(routerReplace).not.toHaveBeenCalled();
    expect(
      result.renderer.root.findAll(tab => isHostType(tab, 'TabScreen')).map(tab => tab.props.name)
    ).toEqual(['(0_home)', '(2_agents)', '(4_chat)', '(3_profile)']);
  });
});
