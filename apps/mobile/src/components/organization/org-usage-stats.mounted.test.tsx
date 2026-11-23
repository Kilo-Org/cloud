import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';
import { i18n } from '@/i18n';
import { OrgUsageStats } from './org-usage-stats';

const query = vi.hoisted(() => ({
  data: undefined as
    | undefined
    | {
        totalCost: number;
        totalRequestCount: number;
        totalInputTokens: number;
        totalOutputTokens: number;
      },
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
}));
// The read no longer pauses (`SETTLE_WHILE_OFFLINE`); the offline wording keys
// off the committed connectivity state, so the harness carries that instead.
const connectivity = vi.hoisted(() => ({ value: 'offline' as 'online' | 'offline' | 'unknown' }));

vi.mock('@/lib/hooks/use-organization-queries', () => ({ useOrgUsageStats: () => query }));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  useCommittedConnectivityStatus: () => connectivity.value,
}));
vi.mock('@kilocode/app-shared/utils', () => ({ fromMicrodollars: (value: number) => value / 1e6 }));
vi.mock('@/lib/format', () => ({
  formatPrefixedMoney: (value: number) => `$${value}`,
  // The token tiles ask for compact notation; anything else stays the plain
  // digit string the money and requests assertions already expect.
  formatNumber: (value: number, _locale: string, options?: Intl.NumberFormatOptions) =>
    options?.notation === 'compact' ? `compact:${value}` : String(value),
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('react-native', () => ({ View: 'View', Pressable: 'Pressable' }));

beforeEach(() => {
  query.data = undefined;
  query.isError = false;
  connectivity.value = 'online';
  query.refetch.mockClear();
});

describe('Organization usage availability', () => {
  it('fills every value slot with a loading block before the first totals arrive', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(OrgUsageStats, { organizationId: 'org-1' })
    );
    const text = renderer.root.findAllByType('Text').map(node => node.props.children);
    for (const key of [
      'common.cost',
      'organization.usageStats.requests',
      'organization.usageStats.inputTokens',
      'organization.usageStats.outputTokens',
    ] as const) {
      expect(text).toContain(i18n.t(key));
    }
    expect(text).not.toContain('—');
    expect(renderer.root.findAllByType('Skeleton')).toHaveLength(4);
    unmount();
  });
  it.each([
    { label: 'offline', connectivity: 'offline' as const, isError: false },
    { label: 'failed', connectivity: 'online' as const, isError: true },
    { label: 'failed offline', connectivity: 'offline' as const, isError: true },
  ])(
    'keeps labeled placeholders and recovery when the read $label',
    async ({ connectivity: state, isError }) => {
      connectivity.value = state;
      query.isError = isError;
      const { renderer, unmount } = await renderWithProviders(
        createElement(OrgUsageStats, { organizationId: 'org-1' })
      );
      const text = renderer.root.findAllByType('Text').map(node => node.props.children);
      for (const key of [
        'common.cost',
        'organization.usageStats.requests',
        'organization.usageStats.inputTokens',
        'organization.usageStats.outputTokens',
      ] as const) {
        expect(text).toContain(i18n.t(key));
      }
      expect(text.filter(value => value === '—')).toHaveLength(4);
      // The offline wording only when the device is confirmed offline.
      expect(text).toContain(
        i18n.t(state === 'offline' ? 'queryError.offlineTitle' : 'common.somethingWentWrong')
      );
      const retry = renderer.root.findByType('Button');
      act(() => {
        (retry.props.onPress as () => void)();
      });
      expect(query.refetch).toHaveBeenCalledOnce();
      unmount();
    }
  );

  it('retains cached totals through a failed refetch', async () => {
    query.isError = true;
    query.data = {
      totalCost: 2_000_000,
      totalRequestCount: 12,
      totalInputTokens: 34,
      totalOutputTokens: 56,
    };
    const { renderer, unmount } = await renderWithProviders(
      createElement(OrgUsageStats, { organizationId: 'org-1' })
    );
    const text = renderer.root.findAllByType('Text').map(node => node.props.children);
    // The cost keeps its own left-to-right run, so its symbol cannot move
    // behind the number in a right-to-left paragraph.
    expect(text).toEqual(
      expect.arrayContaining(['\u2066$2\u2069', '12', 'compact:34', 'compact:56'])
    );
    expect(renderer.root.findAllByType('Button')).toHaveLength(0);
    unmount();
  });

  it('makes the whole grid one button for a role the usage screen answers organization-wide', async () => {
    query.data = {
      totalCost: 2_000_000,
      totalRequestCount: 12,
      totalInputTokens: 34,
      totalOutputTokens: 56,
    };
    const onPress = vi.fn<() => void>();
    const { renderer, unmount } = await renderWithProviders(
      createElement(OrgUsageStats, { organizationId: 'org-1', onPress })
    );

    const grid = renderer.root.findAllByType('Pressable');
    expect(grid).toHaveLength(1);
    const [button] = grid;
    if (button === undefined) {
      throw new Error('the grid is not one pressable');
    }
    expect(button.props.accessibilityRole).toBe('button');
    expect(button.props.accessibilityHint).toBe(i18n.t('usage.viewDetails'));
    expect(button.findAllByType('Text').length).toBeGreaterThan(0);
    act(() => {
      (button.props.onPress as () => void)();
    });
    expect(onPress).toHaveBeenCalledOnce();
    unmount();
  });

  it('prints the org token totals in the usage screens compact notation', async () => {
    query.data = {
      totalCost: 2_000_000,
      totalRequestCount: 12,
      totalInputTokens: 55_560_000,
      totalOutputTokens: 16_920_000,
    };
    const { renderer, unmount } = await renderWithProviders(
      createElement(OrgUsageStats, { organizationId: 'org-1' })
    );
    const text = renderer.root.findAllByType('Text').map(node => node.props.children);
    expect(text).toContain('compact:55560000');
    expect(text).toContain('compact:16920000');
    // The requests tile still prints its count in full.
    expect(text).toContain('12');
    unmount();
  });

  it('leaves the grid informational for a role the usage screen answers self-scoped', async () => {
    query.data = {
      totalCost: 2_000_000,
      totalRequestCount: 12,
      totalInputTokens: 34,
      totalOutputTokens: 56,
    };
    const { renderer, unmount } = await renderWithProviders(
      createElement(OrgUsageStats, { organizationId: 'org-1' })
    );

    expect(renderer.root.findAllByType('Pressable')).toHaveLength(0);
    const text = renderer.root.findAllByType('Text').map(node => node.props.children);
    expect(text).toEqual(
      expect.arrayContaining(['\u2066$2\u2069', '12', 'compact:34', 'compact:56'])
    );
    unmount();
  });
});

describe('Organization usage stats accessibility', () => {
  it('makes each informational tile one element reading its caption then its value', async () => {
    query.data = {
      totalCost: 2_000_000,
      totalRequestCount: 12,
      totalInputTokens: 34,
      totalOutputTokens: 56,
    };
    const { renderer, unmount } = await renderWithProviders(
      createElement(OrgUsageStats, { organizationId: 'org-1' })
    );

    const tiles = renderer.root
      .findAllByType('View')
      .filter(node => node.props.accessible === true);
    expect(tiles.map(tile => tile.props.accessibilityLabel)).toEqual([
      'Cost, \u2066$2\u2069',
      'Requests, 12',
      'Input tokens, compact:34',
      'Output tokens, compact:56',
    ]);
    // The painted lines read through no tree of their own: the tile says them.
    for (const tile of tiles) {
      const lines = tile.findAllByType('Text');
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line.props.accessible).toBe(false);
        expect(line.props.importantForAccessibility).toBe('no');
      }
    }
    unmount();
  });

  it('keeps a loading tile to its caption alone', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(OrgUsageStats, { organizationId: 'org-1' })
    );

    const tiles = renderer.root
      .findAllByType('View')
      .filter(node => node.props.accessible === true);
    expect(tiles.map(tile => tile.props.accessibilityLabel)).toEqual([
      'Cost',
      'Requests',
      'Input tokens',
      'Output tokens',
    ]);
    unmount();
  });

  it('makes the pressable grid one button that names every tile in grid order', async () => {
    query.data = {
      totalCost: 2_000_000,
      totalRequestCount: 12,
      totalInputTokens: 34,
      totalOutputTokens: 56,
    };
    const onPress = vi.fn<() => void>();
    const { renderer, unmount } = await renderWithProviders(
      createElement(OrgUsageStats, { organizationId: 'org-1', onPress })
    );

    const [button] = renderer.root.findAllByType('Pressable');
    if (button === undefined) {
      throw new Error('the grid is not one pressable');
    }
    expect(button.props.accessibilityRole).toBe('button');
    expect(button.props.accessibilityHint).toBe(i18n.t('usage.viewDetails'));
    expect(button.props.accessibilityLabel).toBe(
      'Cost, \u2066$2\u2069, Requests, 12, Input tokens, compact:34, Output tokens, compact:56'
    );
    // The enclosing button speaks the tiles, so no tile is an element itself.
    expect(
      renderer.root.findAllByType('View').filter(node => node.props.accessible === true)
    ).toHaveLength(0);
    act(() => {
      (button.props.onPress as () => void)();
    });
    expect(onPress).toHaveBeenCalledOnce();
    unmount();
  });
});
