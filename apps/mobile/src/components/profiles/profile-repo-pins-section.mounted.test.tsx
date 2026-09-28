import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { ProfileRepoPinsSection } from '@/components/profiles/profile-repo-pins-section';
import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

type TestBinding = {
  repoFullName: string;
  platform: string;
  profileId: string;
  profileName: string;
};
type TestRepoOption = { platform: 'github' | 'gitlab'; fullName: string; private: boolean };

const h = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  bindingsQuery: {
    bindings: [] as TestBinding[],
    isLoading: true,
    isError: false,
    isRefetching: false,
    refetch: vi.fn(),
  },
  mutations: {
    bind: { mutateAsync: vi.fn(), isPending: false },
    unbind: { mutateAsync: vi.fn(), isPending: false },
  },
  repoOptions: {
    repositories: [] as TestRepoOption[],
    isLoading: false,
    isError: false,
    isRefetching: false,
    refetch: vi.fn(),
  },
}));

vi.mock('@/lib/hooks/use-repo-bindings', () => ({
  useRepoBindings: () => h.bindingsQuery,
  useRepoBindingMutations: () => h.mutations,
  useRepoOptions: () => h.repoOptions,
}));
vi.mock('sonner-native', () => ({ toast: { success: h.success, error: h.error } }));
vi.mock('react-native', () => ({
  View: 'View',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  I18nManager: { isRTL: false },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    mutedForeground: '#000000',
    destructive: '#FF0000',
    primary: '#0000FF',
    foreground: '#111111',
  }),
}));
vi.mock('@/components/agents/session-page-sheet', () => ({
  SessionPageSheet: 'SessionPageSheet',
}));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  Check: 'Check',
  GitBranch: 'GitBranch',
  Link2: 'Link2',
  Lock: 'Lock',
  Plus: 'Plus',
  Search: 'Search',
  SearchX: 'SearchX',
  Trash2: 'Trash2',
  Unlock: 'Unlock',
}));

function findAll(root: ReactTestInstance, type: string): ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

function pressPressable(root: ReactTestInstance, label: string): void {
  const pressable = findAll(root, 'Pressable').find(
    node => node.props.accessibilityLabel === label
  );
  if (!pressable) {
    throw new Error(`pressable ${label} was not rendered`);
  }
  act(() => {
    (pressable.props as { onPress: () => void }).onPress();
  });
}

function pressButton(root: ReactTestInstance, label: string): void {
  const button = findAll(root, 'Button').find(node => node.props.accessibilityLabel === label);
  if (!button) {
    throw new Error(`button ${label} was not rendered`);
  }
  act(() => {
    (button.props as { onPress: () => void }).onPress();
  });
}

// eslint-disable-next-line typescript-eslint/promise-function-async -- returning the harness promise unchanged
function mountSection(organizationId?: string) {
  return renderWithProviders(
    createElement(ProfileRepoPinsSection, { profileId: 'profile-1', organizationId })
  );
}

describe('ProfileRepoPinsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(h.bindingsQuery, {
      bindings: [],
      isLoading: true,
      isError: false,
      isRefetching: false,
    });
    Object.assign(h.mutations.bind, { isPending: false });
    Object.assign(h.mutations.unbind, { isPending: false });
    Object.assign(h.repoOptions, {
      repositories: [
        { platform: 'github', fullName: 'acme/api', private: true },
        { platform: 'gitlab', fullName: 'acme/infra', private: false },
      ],
      isLoading: false,
      isError: false,
      isRefetching: false,
    });
  });

  it('loading: renders the card skeleton', async () => {
    const { renderer, unmount } = await mountSection();
    expect(findAll(renderer.root, 'Skeleton').length).toBeGreaterThan(0);
    unmount();
  });

  it('retryable: a bindings failure shows QueryError and Retry refetches', async () => {
    Object.assign(h.bindingsQuery, { isError: true, isLoading: false });
    const { renderer, unmount } = await mountSection();
    const queryError = findAll(renderer.root, 'QueryError')[0];
    if (!queryError) {
      throw new Error('QueryError was not rendered');
    }
    act(() => {
      (queryError.props as { onRetry: () => void }).onRetry();
    });
    expect(h.bindingsQuery.refetch).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('empty: shows Not pinned to any repositories.', async () => {
    Object.assign(h.bindingsQuery, { isLoading: false });
    const { renderer, unmount } = await mountSection();
    expect(findAll(renderer.root, 'Text').map(node => node.props.children)).toContain(
      'Not pinned to any repositories.'
    );
    unmount();
  });

  it('happy: lists only this profile’s bindings and unbinds one', async () => {
    Object.assign(h.bindingsQuery, {
      isLoading: false,
      bindings: [
        {
          repoFullName: 'acme/api',
          platform: 'github',
          profileId: 'profile-1',
          profileName: 'Mine',
        },
        {
          repoFullName: 'acme/other',
          platform: 'github',
          profileId: 'profile-2',
          profileName: 'Theirs',
        },
      ],
    });
    h.mutations.unbind.mutateAsync.mockResolvedValue({ success: true });

    const { renderer, unmount } = await mountSection();

    const texts = findAll(renderer.root, 'Text').map(node => node.props.children);
    expect(texts).toContain('acme/api');
    expect(texts).not.toContain('acme/other');

    pressPressable(renderer.root, 'Unbind');
    await waitFor(() => h.mutations.unbind.mutateAsync.mock.calls.length > 0);
    expect(h.mutations.unbind.mutateAsync.mock.calls[0]?.[0]).toEqual({
      repoFullName: 'acme/api',
      platform: 'github',
    });

    unmount();
  });

  it('happy: Pin a repo binds the picked repo to this profile', async () => {
    Object.assign(h.bindingsQuery, { isLoading: false });
    h.mutations.bind.mutateAsync.mockResolvedValue({ success: true });

    const { renderer, unmount } = await mountSection();
    expect(findAll(renderer.root, 'SessionPageSheet')).toHaveLength(0);
    pressButton(renderer.root, 'Pin a repo');
    expect(findAll(renderer.root, 'SessionPageSheet')).toHaveLength(1);
    pressPressable(renderer.root, 'acme/infra');

    await waitFor(() => h.mutations.bind.mutateAsync.mock.calls.length > 0);
    expect(h.mutations.bind.mutateAsync.mock.calls[0]?.[0]).toEqual({
      profileId: 'profile-1',
      repoFullName: 'acme/infra',
      platform: 'gitlab',
    });

    unmount();
  });
});
