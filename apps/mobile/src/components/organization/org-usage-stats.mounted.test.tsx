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
  isPaused: true,
  isFetching: false,
  refetch: vi.fn(),
}));

vi.mock('@/lib/hooks/use-organization-queries', () => ({ useOrgUsageStats: () => query }));
vi.mock('@kilocode/app-shared/utils', () => ({ fromMicrodollars: (value: number) => value / 1e6 }));
vi.mock('@/lib/format', () => ({
  formatMoney: (value: number) => `$${value}`,
  formatNumber: String,
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('react-native', () => ({ View: 'View' }));

beforeEach(() => {
  query.data = undefined;
  query.isError = false;
  query.isPaused = true;
  query.refetch.mockClear();
});

describe('Organization usage availability', () => {
  it('fills every value slot with a loading block before the first totals arrive', async () => {
    query.isPaused = false;

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
  it.each(['paused', 'failed'] as const)(
    'keeps labeled placeholders and recovery when %s',
    async state => {
      query.isPaused = state === 'paused';
      query.isError = state === 'failed';
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
      const retry = renderer.root.findByType('Button');
      act(() => {
        (retry.props.onPress as () => void)();
      });
      expect(query.refetch).toHaveBeenCalledOnce();
      unmount();
    }
  );

  it('retains cached totals through a paused refetch failure', async () => {
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
    expect(text).toEqual(expect.arrayContaining(['$2', '12', '34', '56']));
    expect(renderer.root.findAllByType('Button')).toHaveLength(0);
    unmount();
  });
});
