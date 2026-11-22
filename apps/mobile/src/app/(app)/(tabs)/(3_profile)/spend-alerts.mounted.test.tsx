import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SpendAlertsRoute from './spend-alerts';

const useLocalSearchParamsMock = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => ({
  useLocalSearchParams: useLocalSearchParamsMock,
}));

vi.mock('@/components/organization/spend-alerts-screen', () => ({
  SpendAlertsScreen: 'SpendAlertsScreen',
}));

let mounted: TestRenderer.ReactTestRenderer | undefined = undefined;

function mountRoute(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(SpendAlertsRoute));
  });
  if (!ref.current) {
    throw new Error('route did not render');
  }
  mounted = ref.current;
  return ref.current;
}

// The test renderer types host props as `unknown`; this names the props the
// route forwards to the screen.
type ScreenProps = { organizationId?: string; settingsTarget?: string };

function screenProps(): ScreenProps {
  const screens = mountRoute().root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === 'SpendAlertsScreen'
  );
  expect(screens).toHaveLength(1);
  return screens[0]?.props as ScreenProps;
}

beforeEach(() => {
  useLocalSearchParamsMock.mockReset();
});

// The renderer's unmount is what releases the tree it holds, as the sibling
// route suites do.
afterEach(() => {
  const renderer = mounted;
  mounted = undefined;
  if (renderer === undefined) {
    return;
  }
  act(() => {
    renderer.unmount();
  });
});

describe('SpendAlertsRoute organization scope', () => {
  it('keeps the single organization id the link names', () => {
    useLocalSearchParamsMock.mockReturnValue({ org: 'org-b' });

    expect(screenProps().organizationId).toBe('org-b');
  });

  it('takes the first id of a repeated org parameter', () => {
    useLocalSearchParamsMock.mockReturnValue({ org: ['org-b', 'org-c'] });

    expect(screenProps().organizationId).toBe('org-b');
  });

  it.each<(string | string[] | undefined)[]>([[undefined], [''], [['', 'org-b']], [[]]])(
    'opens the personal scope for %j',
    org => {
      useLocalSearchParamsMock.mockReturnValue({ org });

      expect(screenProps().organizationId).toBeUndefined();
    }
  );
});

describe('SpendAlertsRoute settings target', () => {
  it('forwards the target a settings-search result names', () => {
    useLocalSearchParamsMock.mockReturnValue({ settingsTarget: 'spendAlerts.threshold.window' });

    expect(screenProps().settingsTarget).toBe('spendAlerts.threshold.window');
  });

  it('forwards the target beside an organization scope', () => {
    useLocalSearchParamsMock.mockReturnValue({
      org: 'org-b',
      settingsTarget: 'spendAlerts.master',
    });

    expect(screenProps()).toEqual({
      organizationId: 'org-b',
      settingsTarget: 'spendAlerts.master',
    });
  });

  it('opens with no target when the route has none', () => {
    useLocalSearchParamsMock.mockReturnValue({});

    expect(screenProps().settingsTarget).toBeUndefined();
  });
});
