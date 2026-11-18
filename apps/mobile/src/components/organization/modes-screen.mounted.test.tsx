// The modes list renders one row per stored mode, and mode names can repeat:
// the slug is the row's unique fact. This suite mounts the screen and reads
// the rows' accessible names, which must be `${name}, ${slug}` so two rows
// with the same name stay distinct for a screen reader.
import { createElement } from 'react';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { renderWithProviders, type RenderWithProvidersResult } from '@/test/render-with-providers';
import { OrganizationModesScreen } from './modes-screen';

const harness = vi.hoisted(() => ({
  push: vi.fn(),
  // Two stored modes with the same name and different slugs: the pair the
  // accessible name must keep distinct.
  modesQuery: {
    data: {
      modes: [
        { id: 'mode-1', name: 'مراجعة الكود', slug: 'review', config: { description: '' } },
        { id: 'mode-2', name: 'مراجعة الكود', slug: 'code-review', config: { description: '' } },
      ],
    },
    isPending: false,
    isError: false,
    error: null as unknown,
    isFetching: false,
    refetch: vi.fn(),
  },
  boundary: {
    organizationId: 'org-1',
    org: { organizationId: 'org-1', organizationName: 'Acme' },
    isResolving: false,
  },
}));

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: harness.push }) }));
vi.mock('@/components/organization/organization-boundary', () => ({
  OrganizationBoundary: 'OrganizationBoundary',
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'TabScreenScrollView' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState', StateAction: 'StateAction' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icon-button', () => ({ IconButton: 'IconButton' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
// The row's chevron and the header icons come from the icon barrel; the real
// lucide deep imports cannot load in this project (see `vitest.setup.ts`).
vi.mock('@/components/ui/icons', () => ({
  ChevronRight: 'ChevronRight',
  Plus: 'Plus',
  SlidersHorizontal: 'SlidersHorizontal',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000000', mutedForeground: '#666666' }),
}));
vi.mock('@/lib/hooks/use-org-modes-queries', () => ({ useOrgModes: () => harness.modesQuery }));
vi.mock('@/lib/hooks/use-organization-queries', () => ({ useOrgBoundary: () => harness.boundary }));

const mounted: RenderWithProvidersResult[] = [];

async function renderScreen() {
  const view = await renderWithProviders(createElement(OrganizationModesScreen));
  mounted.push(view);
  return view.renderer;
}

// The row Pressables are the `OrgRecordRow` buttons; the header's IconButton
// is mocked away, so every Pressable here is a mode row.
function rowLabels(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType('Pressable')
    .filter(node => node.props.accessibilityRole === 'button')
    .map(node => node.props.accessibilityLabel as string);
}

afterEach(() => {
  for (const view of mounted.splice(0)) {
    act(() => {
      view.renderer.unmount();
    });
  }
});

describe('OrganizationModesScreen accessible names', () => {
  it('names every row by its name and slug', async () => {
    const renderer = await renderScreen();

    // The list body rendered, not the org boundary or an error view.
    expect(renderer.root.findByType('ScreenHeader').props.title).toBe(
      i18n.t('agentChat.modePicker.customModes')
    );
    expect(rowLabels(renderer)).toEqual(['مراجعة الكود, review', 'مراجعة الكود, code-review']);
  });

  it('keeps two rows with the same name distinct', async () => {
    const renderer = await renderScreen();

    const labels = rowLabels(renderer);
    expect(labels).toHaveLength(2);
    expect(new Set(labels).size).toBe(2);
  });
});
