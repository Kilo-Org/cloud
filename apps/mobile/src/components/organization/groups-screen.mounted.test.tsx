// The Groups list is the surface that knows the count, so it is where the cap
// has to show: at the organization's last group the header loses its `+` and
// the list states the cap, and below it the action comes back. A role that can
// neither create nor delete — a billing manager — gets no cap notice at all.
import { MAX_ORGANIZATION_GROUPS } from '@kilocode/app-shared/organizations';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders, type RenderWithProvidersResult } from '@/test/render-with-providers';
import { OrganizationGroupsScreen } from './groups-screen';

const harness = vi.hoisted(() => ({
  push: vi.fn(),
  groupsQuery: {
    data: undefined as unknown,
    isPending: false,
    isError: false,
    error: null as unknown,
    isFetching: false,
    refetch: vi.fn(),
  },
  boundary: {
    organizationId: 'org-1',
    role: 'owner' as string | undefined,
    org: { organizationId: 'org-1', plan: 'enterprise' as string | undefined },
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
// The header's action is a prop, so the double draws it where the real one
// does: inside the header. A host stub would drop the create control entirely.
vi.mock('@/components/screen-header', () => ({
  ScreenHeader: (props: { headerRight?: ReactNode }) => props.headerRight ?? null,
}));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'TabScreenScrollView' }));
vi.mock('@/components/empty-state', () => ({
  EmptyState: 'EmptyState',
  StateAction: 'StateAction',
}));
vi.mock('@/components/ui/card', () => ({ Card: 'Card' }));
vi.mock('@/components/ui/icon-button', () => ({ IconButton: 'IconButton' }));
vi.mock('@/components/ui/section', () => ({ Section: 'Section' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
// The header's create control and the rows' chevron come from the icon barrel;
// the real lucide deep imports cannot load in this project.
vi.mock('@/components/ui/icons', () => ({
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  Plus: 'Plus',
  Users: 'Users',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000000', mutedForeground: '#666666' }),
}));
vi.mock('@/lib/hooks/use-org-groups-queries', () => ({ useOrgGroups: () => harness.groupsQuery }));
vi.mock('@/lib/hooks/use-organization-queries', () => ({ useOrgBoundary: () => harness.boundary }));

const mounted: RenderWithProvidersResult[] = [];

/** Mount the screen over a manager list of `groupCount` groups, for `role`. */
async function renderScreen(groupCount: number, role = 'owner') {
  harness.boundary.role = role;
  harness.groupsQuery.data = {
    access: 'manager',
    groups: Array.from({ length: groupCount }, (_, index) => ({
      id: `group-${index}`,
      name: `Group ${index + 1}`,
      description: null,
      memberIds: [],
      policies: [],
    })),
  };
  const view = await renderWithProviders(createElement(OrganizationGroupsScreen));
  mounted.push(view);
  return view.renderer;
}

/** The list's cap notice's text, from a tree the caller just rendered. */
function noticeText(renderer: ReactTestRenderer): unknown {
  return renderer.root.findAllByType('Text').find(node => node.props.testID === 'org-groups-limit')
    ?.props.children;
}

afterEach(() => {
  for (const view of mounted.splice(0)) {
    act(() => {
      view.renderer.unmount();
    });
  }
  harness.push.mockClear();
});

describe('OrganizationGroupsScreen at the group cap', () => {
  it('drops the create action and states the cap once the list is full', async () => {
    const renderer = await renderScreen(MAX_ORGANIZATION_GROUPS);

    expect(renderer.root.findAllByType('IconButton')).toHaveLength(0);
    expect(noticeText(renderer)).toBe(
      i18n.t('organization.groups.limitReached', { max: MAX_ORGANIZATION_GROUPS })
    );
  });

  // A billing manager can neither create nor delete a group, so the cap is not
  // its problem to fix: the notice would name an action it cannot take.
  it('shows no cap notice to a billing manager at the cap', async () => {
    const renderer = await renderScreen(MAX_ORGANIZATION_GROUPS, 'billing_manager');

    expect(renderer.root.findAllByType('IconButton')).toHaveLength(0);
    expect(noticeText(renderer)).toBeUndefined();
  });

  it('keeps the create action and no notice below the cap', async () => {
    const renderer = await renderScreen(MAX_ORGANIZATION_GROUPS - 1);

    const create = renderer.root.findAllByType('IconButton').at(0);
    expect(create?.props.accessibilityLabel).toBe(i18n.t('organization.groups.create'));
    expect(noticeText(renderer)).toBeUndefined();
  });

  it('opens the create form from the header below the cap', async () => {
    const renderer = await renderScreen(1);

    const onPress: unknown = renderer.root.findAllByType('IconButton').at(0)?.props.onPress;
    expect(typeof onPress).toBe('function');
    act(() => {
      (onPress as () => void)();
    });

    expect(harness.push).toHaveBeenCalledWith({
      pathname: '/(app)/(tabs)/(3_profile)/organization/group-form',
      params: {},
    });
  });
});
