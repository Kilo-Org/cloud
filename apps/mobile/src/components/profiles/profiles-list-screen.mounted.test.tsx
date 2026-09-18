import { createElement } from 'react';
import { act, type ReactTestInstance } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { ProfilesListScreen } from '@/components/profiles/profiles-list-screen';
import { renderWithProviders } from '@/test/render-with-providers';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

type ListResult = {
  orgProfiles: ProfileSummary[];
  personalProfiles: ProfileSummary[];
  effectiveDefaultId: string | null;
  isLoading: boolean;
  isError: boolean;
  isRefetching: boolean;
  refetch: () => void;
};

type ProfileSummary = {
  id: string;
  name: string;
  isDefault: boolean;
  varCount: number;
  commandCount: number;
  skillCount: number;
  ownerType?: 'organization' | 'user';
};

const refetchFn = vi.hoisted(() => vi.fn());
const routerPush = vi.hoisted(() => vi.fn());
const organizationState = vi.hoisted(() => ({ organizationId: 'org-1' as string | null }));
const listState = vi.hoisted<ListResult>(() => ({
  orgProfiles: [],
  personalProfiles: [],
  effectiveDefaultId: null,
  isLoading: true,
  isError: false,
  isRefetching: false,
  refetch: () => {
    refetchFn();
  },
}));

vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfileList: () => listState,
}));

vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({
    organizationId: organizationState.organizationId,
    isLoaded: true,
  }),
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: routerPush }),
}));

vi.mock('@/lib/profile-agent-navigation', () => ({
  getProfileOverviewPath: (profileId: string, organizationId?: string) =>
    organizationId ? `/profiles/${profileId}?org=${organizationId}` : `/profiles/${profileId}`,
}));

vi.mock('react-native', () => ({
  View: 'View',
}));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    primary: '#4F5A10',
    primaryForeground: '#FFFFFF',
    mutedForeground: '#6F6A61',
  }),
}));

vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/configure-row', () => ({ ConfigureRow: 'ConfigureRow' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/refresh-control', () => ({ RefreshControl: 'RefreshControl' }));
vi.mock('@/components/ui/icons', () => ({
  Building2: 'Building2',
  Plus: 'Plus',
  SlidersHorizontal: 'SlidersHorizontal',
  Star: 'Star',
  User: 'User',
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function profile(overrides: Partial<ProfileSummary> & { id: string }): ProfileSummary {
  return {
    name: 'Backend debugging',
    isDefault: false,
    varCount: 0,
    commandCount: 0,
    skillCount: 0,
    ...overrides,
  };
}

function findAll(root: ReactTestInstance, type: string): ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

function findOne(root: ReactTestInstance, type: string): ReactTestInstance {
  const node = findAll(root, type)[0];
  if (!node) {
    throw new Error(`${type} was not rendered`);
  }
  return node;
}

function rowTitles(root: ReactTestInstance): string[] {
  return findAll(root, 'ConfigureRow').map(row => String(row.props.title));
}

function textChildren(root: ReactTestInstance): string[] {
  return findAll(root, 'Text').map(node => String(node.props.children));
}

async function mount() {
  const result = await renderWithProviders(createElement(ProfilesListScreen));
  return result;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ProfilesListScreen', () => {
  beforeEach(() => {
    refetchFn.mockReset();
    routerPush.mockReset();
    organizationState.organizationId = 'org-1';
    Object.assign(listState, {
      orgProfiles: [],
      personalProfiles: [],
      effectiveDefaultId: null,
      isLoading: false,
      isError: false,
      isRefetching: false,
    });
  });

  it('loading: renders content-shaped skeleton rows and no profile rows', async () => {
    listState.isLoading = true;

    const { renderer, unmount } = await mount();

    // 3 placeholder rows x (icon tile + title bar + subtitle bar).
    expect(findAll(renderer.root, 'Skeleton')).toHaveLength(9);
    expect(findAll(renderer.root, 'ConfigureRow')).toHaveLength(0);

    unmount();
  });

  it('error: renders QueryError and Retry refetches', async () => {
    listState.isError = true;

    const { renderer, unmount } = await mount();

    const queryError = findOne(renderer.root, 'QueryError');
    expect(queryError.props.title).toBe("Couldn't load profiles");
    act(() => {
      (queryError.props as { onRetry: () => void }).onRetry();
    });
    expect(refetchFn).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('empty: renders EmptyState with the create CTA', async () => {
    organizationState.organizationId = null;

    const { renderer, unmount } = await mount();

    const emptyState = findOne(renderer.root, 'EmptyState');
    expect(emptyState.props.title).toBe('No profiles yet');

    const action = emptyState.props.action as { props: { onPress: () => void } };
    act(() => {
      action.props.onPress();
    });
    expect(routerPush).toHaveBeenCalledWith('/(app)/(tabs)/(3_profile)/profiles/new');

    unmount();
  });

  it('happy: renders org then personal rows, marks the effective default, and opens a profile', async () => {
    listState.orgProfiles = [
      profile({ id: 'org-1-profile', name: 'Org profile', varCount: 1, ownerType: 'organization' }),
    ];
    listState.personalProfiles = [
      profile({ id: 'personal-1', name: 'Personal profile', commandCount: 2, isDefault: true }),
    ];
    listState.effectiveDefaultId = 'personal-1';

    const { renderer, unmount } = await mount();

    expect(textChildren(renderer.root)).toContain('Organization');
    expect(textChildren(renderer.root)).toContain('Personal');
    expect(rowTitles(renderer.root)).toEqual(['Org profile', 'Personal profile']);

    const personalRow = findAll(renderer.root, 'ConfigureRow').find(
      row => row.props.title === 'Personal profile'
    );
    if (!personalRow) {
      throw new Error('personal row missing');
    }
    expect(personalRow.props.subtitle).toBe('2c');
    const star = personalRow.props.trailing as {
      type: string;
      props: { accessibilityLabel: string };
    };
    expect(star.type).toBe('Star');
    expect(star.props.accessibilityLabel).toBe('Personal profile, Default profile');

    const orgRow = findAll(renderer.root, 'ConfigureRow').find(
      row => row.props.title === 'Org profile'
    );
    if (!orgRow) {
      throw new Error('org row missing');
    }
    expect(orgRow.props.subtitle).toBe('1v');
    // The row's leading icon names its owner.
    expect(orgRow.props.icon).toBe('Building2');
    expect(personalRow.props.icon).toBe('User');
    // Only the resolved effective default gets the filled star.
    expect(orgRow.props.trailing).toBeUndefined();
    act(() => {
      (orgRow.props as { onPress: () => void }).onPress();
    });
    // An org-owned profile carries its organization id into the editor.
    expect(routerPush).toHaveBeenCalledWith('/profiles/org-1-profile?org=org-1');

    act(() => {
      (personalRow.props as { onPress: () => void }).onPress();
    });
    // A personal profile keeps no owner context, even from an org list.
    expect(routerPush).toHaveBeenCalledWith('/profiles/personal-1');

    // The persistent create CTA is present once profiles exist.
    const buttons = findAll(renderer.root, 'Button');
    const createButton = buttons.at(-1);
    if (!createButton) {
      throw new Error('create button was not rendered');
    }
    act(() => {
      (createButton.props as { onPress: () => void }).onPress();
    });
    expect(routerPush).toHaveBeenCalledWith('/(app)/(tabs)/(3_profile)/profiles/new');

    unmount();
  });

  it('personal context: renders one untitled section', async () => {
    organizationState.organizationId = null;
    listState.personalProfiles = [profile({ id: 'personal-1', name: 'Personal profile' })];

    const { renderer, unmount } = await mount();

    expect(rowTitles(renderer.root)).toEqual(['Personal profile']);
    expect(textChildren(renderer.root)).not.toContain('Organization');
    // `agentProfiles.list` does not tag owner, so every row is personal.
    expect(findOne(renderer.root, 'ConfigureRow').props.icon).toBe('User');

    unmount();
  });
});
