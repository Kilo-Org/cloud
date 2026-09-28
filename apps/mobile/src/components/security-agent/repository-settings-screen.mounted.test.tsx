// Security Agent repository picker: the repositories mount through FlashList
// (one virtualized scroller instead of every RepoToggleRow inside the screen's
// ScrollView), selection is a Set lookup, and the loading / error / empty /
// validation branches keep rendering exactly where they did before.

import { createElement, Fragment, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { act, type TestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { RepositorySettingsScreen } from './repository-settings-screen';

type RepoRow = { id: number; fullName: string; private: boolean };

const config = vi.hoisted(() => ({
  data: null as Record<string, unknown> | null,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}));
const repositories = vi.hoisted(() => ({
  data: undefined as readonly RepoRow[] | undefined,
  isLoading: false,
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
}));
const capability = vi.hoisted(() => ({ canManage: true }));
const save = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }));
const saveButton = vi.hoisted(() => ({ onSave: null as (() => Promise<void>) | null }));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: 'View',
  Pressable: 'Pressable',
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
  useNavigation: () => ({ isFocused: () => true }),
  useFocusEffect: () => undefined,
}));
// The FlashList stub renders the header, every item through `renderItem`, and
// the footer, so the mounted tree matches what the real list would mount.
vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: {
    data?: readonly unknown[];
    renderItem: (info: { item: unknown }) => ReactNode;
    keyExtractor?: (item: never) => string;
    getItemType?: (item: unknown) => string;
    style?: unknown;
    contentContainerStyle?: unknown;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
  }) => {
    const data = props.data ?? [];
    return createElement(
      'FlashList',
      {
        data,
        keyExtractor: props.keyExtractor,
        getItemType: props.getItemType,
        style: props.style,
        contentContainerStyle: props.contentContainerStyle,
      },
      props.ListHeaderComponent,
      data.map((item, index) =>
        createElement(Fragment, { key: index }, props.renderItem({ item }))
      ),
      props.ListFooterComponent
    );
  },
}));
vi.mock('@/lib/hooks/use-security-agent', () => ({
  useSecurityAgentCapability: () => capability,
  useSecurityAgentConfig: () => config,
  useSecurityAgentRepositories: () => repositories,
  useSaveSecurityAgentConfig: () => save,
}));
vi.mock('@/lib/hooks/use-settings-back-guard', () => ({
  useSecurityAgentSettingsRedirect: () => undefined,
  useSettingsBackGuard: () => ({ onBack: () => undefined, skipNextGuardRef: { current: false } }),
}));
vi.mock('@/lib/trpc', () => ({
  trpcClient: { githubApps: { mintInstallState: { mutate: vi.fn() } } },
}));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/tab-screen', () => ({ useTabBarBottomPadding: () => 12 }));
vi.mock('@/components/security-agent/settings-save-button', () => ({
  SettingsSaveButton: (props: { onSave: () => Promise<void> }) => {
    saveButton.onSave = props.onSave;
    return null;
  },
}));
vi.mock('@/components/repo-toggle-row', () => ({ RepoToggleRow: 'RepoToggleRow' }));
vi.mock('@/components/platform-error-screen', () => ({
  PlatformErrorScreen: 'PlatformErrorScreen',
}));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
// `headerRight` is a prop, not a child: the stub renders it so the Save button
// (the screen's only save path) actually mounts.
vi.mock('@/components/screen-header', () => ({
  ScreenHeader: (props: { headerRight?: ReactNode }) =>
    createElement(Fragment, null, props.headerRight),
}));
vi.mock('@/components/ui/icons', () => ({ FolderGit2: 'FolderGit2' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/choice-row', () => ({ ChoiceRow: 'ChoiceRow' }));
vi.mock('@/components/ui/radio-group', () => ({ RadioGroup: 'RadioGroup' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

const THREE_REPOS: readonly [RepoRow, RepoRow, RepoRow] = [
  { id: 1, fullName: 'acme/one', private: false },
  { id: 2, fullName: 'acme/two', private: true },
  { id: 3, fullName: 'acme/three', private: false },
];

function configData(mode: 'all' | 'selected', selectedRepositoryIds: number[] = []) {
  return { isEnabled: true, repositorySelectionMode: mode, selectedRepositoryIds };
}

const mounts: Awaited<ReturnType<typeof renderWithProviders>>[] = [];

async function mount() {
  const mounted = await renderWithProviders(
    createElement(RepositorySettingsScreen, { scope: 'personal' })
  );
  mounts.push(mounted);
  return mounted;
}

function listOf(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.find(node => String(node.type) === 'FlashList');
}

function repoRows(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(node => String(node.type) === 'RepoToggleRow');
}

function repoRow(renderer: TestRenderer.ReactTestRenderer, index: number) {
  const row = repoRows(renderer)[index];
  if (!row) {
    throw new Error(`repository row ${index} not found`);
  }
  return row;
}

function textContents(renderer: TestRenderer.ReactTestRenderer): unknown[] {
  return renderer.root
    .findAll(node => String(node.type) === 'Text')
    .map(node => (node.props as { children?: unknown }).children);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  config.data = configData('selected');
  config.isLoading = false;
  config.isError = false;
  repositories.data = THREE_REPOS;
  repositories.isLoading = false;
  repositories.isError = false;
  repositories.isFetching = false;
  capability.canManage = true;
  save.isPending = false;
  save.mutateAsync.mockReset();
  save.mutateAsync.mockResolvedValue({});
  saveButton.onSave = null;
});

afterEach(() => {
  for (const mounted of mounts) {
    mounted.unmount();
  }
  mounts.length = 0;
});

describe('RepositorySettingsScreen repository picker', () => {
  it('mounts the repositories through one FlashList instead of a ScrollView', async () => {
    const { renderer } = await mount();
    const list = listOf(renderer);

    expect(repoRows(renderer).map(row => (row.props as { repo: RepoRow }).repo.id)).toEqual([
      1, 2, 3,
    ]);
    expect((list.props as { data: RepoRow[] }).data).toHaveLength(3);
    // One constant item type: the rows are homogeneous.
    expect((list.props as { getItemType: (item: unknown) => string }).getItemType('repo')).toBe(
      'repo'
    );
    const keyExtractor = (list.props as { keyExtractor: (item: RepoRow) => string }).keyExtractor;
    expect(keyExtractor(THREE_REPOS[0])).toBe('1');
    // The old ScrollView content inset (`px-6 pt-4` plus the tab-bar band) is
    // now the list's content container, so the last row still clears the bar.
    expect(list.props as { contentContainerStyle: unknown }).toMatchObject({
      contentContainerStyle: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 12 },
    });
    expect((list.props as { style: unknown }).style).toEqual({ flex: 1 });
  });

  it('adds the pressed repository to the selection and saves that id', async () => {
    const { renderer } = await mount();
    act(() => {
      (repoRow(renderer, 1).props as { onPress: () => void }).onPress();
    });

    const selected = repoRows(renderer).map(row => (row.props as { selected: boolean }).selected);
    expect(selected).toEqual([false, true, false]);

    await act(async () => {
      await saveButton.onSave?.();
    });
    expect(save.mutateAsync).toHaveBeenCalledWith({
      repositorySelectionMode: 'selected',
      selectedRepositoryIds: [2],
    });
  });

  it('keeps the loading skeletons in the header without mounting rows', async () => {
    repositories.isLoading = true;
    repositories.data = undefined;
    const { renderer } = await mount();

    expect(renderer.root.findAll(node => String(node.type) === 'Skeleton')).toHaveLength(2);
    expect(repoRows(renderer)).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'EmptyState')).toHaveLength(0);
  });

  it('keeps the retryable QueryError in the header without mounting rows', async () => {
    repositories.isError = true;
    const { renderer } = await mount();

    const error = renderer.root.find(node => String(node.type) === 'QueryError');
    expect((error.props as { placement: string }).placement).toBe('top');
    expect(typeof (error.props as { onRetry: unknown }).onRetry).toBe('function');
    expect(repoRows(renderer)).toHaveLength(0);
  });

  it('keeps the EmptyState with Manage access in the header', async () => {
    repositories.data = [];
    const { renderer } = await mount();

    const empty = renderer.root.find(node => String(node.type) === 'EmptyState');
    expect((empty.props as { placement: string }).placement).toBe('top');
    expect(empty.props as { action: unknown }).toHaveProperty('action');
    expect(repoRows(renderer)).toHaveLength(0);
  });

  it('keeps the EmptyState out while the repository query has no data yet', async () => {
    // TanStack Query reports this shape while an enabled query is paused (the
    // device is offline on first load): not loading, not errored, and `data`
    // is still undefined. That must not read as zero repositories.
    repositories.data = undefined;
    repositories.isLoading = false;
    repositories.isError = false;
    const { renderer } = await mount();

    expect(renderer.root.findAll(node => String(node.type) === 'EmptyState')).toHaveLength(0);
    expect(repoRows(renderer)).toHaveLength(0);
  });

  it('shows the selectAtLeastOne validation only with an empty selection', async () => {
    const { renderer } = await mount();
    const validation = i18n.t('securityAgent.repositories.selectAtLeastOne');
    expect(textContents(renderer)).toContain(validation);

    act(() => {
      (repoRow(renderer, 0).props as { onPress: () => void }).onPress();
    });
    expect(textContents(renderer)).not.toContain(validation);
  });

  it('mounts no repository rows outside selected mode', async () => {
    config.data = configData('all');
    const { renderer } = await mount();

    expect(repoRows(renderer)).toHaveLength(0);
    expect(textContents(renderer)).not.toContain(
      i18n.t('securityAgent.repositories.selectAtLeastOne')
    );
    // The mode choice itself still renders.
    expect(renderer.root.findAll(node => String(node.type) === 'ChoiceRow')).toHaveLength(2);
  });
});
