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
// The section header's action joins its eyebrow's display treatment, so the
// stub carries that constant beside the text primitive.
vi.mock('@/components/ui/text', () => ({ Text: 'Text', EYEBROW_LATIN_DISPLAY: 'uppercase' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
// The header action ends in the shared chevron; the suite reads whether it is
// there, not how it is painted.
vi.mock('@/components/ui/row-chevron', () => ({ RowChevron: 'RowChevron' }));
// The section-header action asks the interface direction for its display
// treatment, so the stub carries it (the same shape the briefing-card suite
// uses).
vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  I18nManager: { isRTL: false, getConstants: () => ({ isRTL: false }) },
}));

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
      // A handler is given on purpose: a read that cannot answer offers no
      // destination, so the header keeps its eyebrow alone and the grid stays
      // the informational one.
      const onPress = vi.fn<() => void>();
      const { renderer, unmount } = await renderWithProviders(
        createElement(OrgUsageStats, { organizationId: 'org-1', onPress })
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
      // No destination: no header action copy and no chevron beside it.
      expect(text).not.toContain(i18n.t('usage.title'));
      expect(renderer.root.findAllByType('RowChevron' as never)).toHaveLength(0);
      expect(renderer.root.findAllByType('Pressable')).toHaveLength(0);
      // The offline wording only when the device is confirmed offline.
      expect(text).toContain(
        i18n.t(state === 'offline' ? 'queryError.offlineTitle' : 'common.somethingWentWrong')
      );
      const retry = renderer.root.findByType('Button');
      act(() => {
        (retry.props.onPress as () => void)();
      });
      expect(query.refetch).toHaveBeenCalledOnce();
      expect(onPress).not.toHaveBeenCalled();
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

    // Two controls, one destination: the header link and the grid it names.
    const pressables = renderer.root.findAllByType('Pressable');
    expect(pressables).toHaveLength(2);
    const button = pressables.find(node => node.props.accessibilityLabel !== i18n.t('usage.title'));
    if (button === undefined) {
      throw new Error('the grid is not one pressable');
    }
    expect(button.props.accessibilityRole).toBe('button');
    expect(button.props.accessibilityHint).toBe(i18n.t('usage.viewDetails'));
    expect(button.findAllByType('Text').length).toBeGreaterThan(0);
    // The chevron belongs to the header link, not to the grid it names.
    expect(button.findAllByType('RowChevron' as never)).toHaveLength(0);
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

    // No header link either: the informational grid keeps the header it had.
    expect(renderer.root.findAllByType('Pressable')).toHaveLength(0);
    expect(renderer.root.findAllByType('RowChevron' as never)).toHaveLength(0);
    const text = renderer.root.findAllByType('Text').map(node => node.props.children);
    expect(text).not.toContain(i18n.t('usage.title'));
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

    const button = renderer.root
      .findAllByType('Pressable')
      .find(node => node.props.accessibilityHint === i18n.t('usage.viewDetails'));
    if (button === undefined) {
      throw new Error('the grid is not one pressable');
    }
    expect(button.props.accessibilityRole).toBe('button');
    expect(button.props.accessibilityHint).toBe(i18n.t('usage.viewDetails'));
    // The button names the four totals alone: the section eyebrow names the
    // scope beside it, so the scope must not lead the button's name.
    expect(button.props.accessibilityLabel).toBe(
      'Cost, \u2066$2\u2069, Requests, 12, Input tokens, compact:34, Output tokens, compact:56'
    );
    // That eyebrow is a sibling of the button, not its child: the reader hears
    // the scope once as a heading, then the button's totals.
    const scope = i18n.t('organization.usageStats.orgLast30Days');
    expect(button.findAllByType('Text').some(node => node.props.children === scope)).toBe(false);
    expect(renderer.root.findAllByType('Text').some(node => node.props.children === scope)).toBe(
      true
    );
    // The enclosing button speaks the tiles, so no tile is an element itself.
    expect(
      button.findAllByType('View').filter(node => node.props.accessible === true)
    ).toHaveLength(0);
    act(() => {
      (button.props.onPress as () => void)();
    });
    expect(onPress).toHaveBeenCalledOnce();
    unmount();
  });

  it('paints the grid destination as a header link, chevron and all, for a sighted member too', async () => {
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

    const pressables = renderer.root.findAllByType('Pressable');
    const action = pressables.find(node => node.props.accessibilityLabel === i18n.t('usage.title'));
    if (action === undefined) {
      throw new Error('the section header carries no usage link');
    }
    expect(action.props.accessibilityRole).toBe('button');
    expect(action.props.testID).toBe('org-usage-action');
    // The copy is painted, not only announced: that is the affordance a
    // sighted member needed. It is the screen's own title, short enough to stay
    // on the eyebrow's line at 360 dp.
    expect(
      action.findAllByType('Text').some(node => node.props.children === i18n.t('usage.title'))
    ).toBe(true);
    // The link ends in the chevron the hub's other destinations carry, and the
    // grid it names does not: the mark belongs to the header alone.
    expect(action.findAllByType('RowChevron' as never)).toHaveLength(1);
    expect(
      pressables
        .filter(node => node !== action)
        .flatMap(node => node.findAllByType('RowChevron' as never))
    ).toHaveLength(0);
    // The link sits in the header, before the grid it names in render order,
    // and it does not wrap it: the grid keeps its own button.
    expect(pressables[0]).toBe(action);
    expect(action.findAllByType('Pressable').filter(node => node !== action)).toHaveLength(0);
    act(() => {
      (action.props.onPress as () => void)();
    });
    expect(onPress).toHaveBeenCalledOnce();
    unmount();
  });
});
