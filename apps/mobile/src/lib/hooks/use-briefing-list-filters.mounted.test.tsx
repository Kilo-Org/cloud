import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type BriefingListFilters, useBriefingListFilters } from './use-briefing-list-filters';

const navigation = vi.hoisted(() => {
  const params: { via?: string } = {};
  const state = { clearsParam: true };
  return {
    params,
    state,
    router: {
      setParams: vi.fn((next: { via?: string }) => {
        // The real call goes through the navigation container, which merges the
        // params of the route that handles the action. `state.clearsParam`
        // models the case where this screen's own route never receives it.
        if (state.clearsParam) {
          params.via = next.via;
        }
      }),
    },
  };
});
vi.mock('expo-router', () => ({
  useRouter: () => navigation.router,
  useLocalSearchParams: () => navigation.params,
}));

const published: { current?: BriefingListFilters } = {};
function Harness() {
  published.current = useBriefingListFilters();
  return null;
}

function filters() {
  if (!published.current) {
    throw new Error('filter hook was not mounted');
  }
  return published.current;
}

function mount() {
  const holder: { current?: TestRenderer.ReactTestRenderer } = {};
  act(() => {
    holder.current = TestRenderer.create(createElement(Harness));
  });
  if (!holder.current) {
    throw new Error('renderer was not created');
  }
  return holder.current;
}

describe('briefing notification entry', () => {
  beforeEach(() => {
    navigation.params.via = undefined;
    navigation.state.clearsParam = true;
    navigation.router.setParams.mockClear();
    published.current = undefined;
  });

  it('resets a reused organization-filtered history route to all available reports', () => {
    const renderer = mount();
    act(() => {
      filters().setHistory(true);
      filters().setOrganizationId('org-1');
    });
    expect(filters().history).toBe(true);
    expect(filters().organizationId).toBe('org-1');
    navigation.params.via = 'push';
    act(() => {
      renderer.update(createElement(Harness));
    });
    expect(filters().history).toBe(false);
    expect(filters().organizationId).toBeUndefined();
    expect(navigation.router.setParams).toHaveBeenCalledWith({ via: undefined });
    renderer.unmount();
  });

  it('consumes the marker so subsequent push entries reset the same mounted route again', () => {
    const renderer = mount();
    for (const organizationId of ['org-1', 'org-2']) {
      act(() => {
        filters().setHistory(true);
        filters().setOrganizationId(organizationId);
      });
      navigation.params.via = 'push';
      act(() => {
        renderer.update(createElement(Harness));
      });
      expect(filters().history).toBe(false);
      expect(filters().organizationId).toBeUndefined();
      expect(navigation.params.via).toBeUndefined();
    }
    expect(navigation.router.setParams).toHaveBeenCalledTimes(2);
    renderer.unmount();
  });

  it('keeps the chips live when the marker never clears from this route', () => {
    navigation.state.clearsParam = false;
    const renderer = mount();
    navigation.params.via = 'push';
    act(() => {
      renderer.update(createElement(Harness));
    });
    // The entry still opens on the whole current window...
    expect(filters().organizationId).toBeUndefined();
    expect(filters().history).toBe(false);
    // ...and the controls stay effective afterwards, even though the route
    // still carries the marker.
    expect(navigation.params.via).toBe('push');
    act(() => {
      filters().setOrganizationId('org-1');
      filters().setHistory(true);
    });
    expect(filters().organizationId).toBe('org-1');
    expect(filters().history).toBe(true);
    act(() => {
      filters().setOrganizationId(null);
    });
    expect(filters().organizationId).toBeNull();
    act(() => {
      filters().setOrganizationId(undefined);
    });
    expect(filters().organizationId).toBeUndefined();
    renderer.unmount();
  });

  it('dispatches the marker clear once while the marker stays set', () => {
    navigation.state.clearsParam = false;
    const renderer = mount();
    navigation.params.via = 'push';
    act(() => {
      renderer.update(createElement(Harness));
    });
    act(() => {
      filters().setOrganizationId('org-1');
    });
    act(() => {
      renderer.update(createElement(Harness));
    });
    expect(navigation.router.setParams).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });
});
