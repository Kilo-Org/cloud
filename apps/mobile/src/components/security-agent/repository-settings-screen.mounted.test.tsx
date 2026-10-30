// Security Agent repository picker: the repositories mount through FlashList
// (one virtualized scroller instead of every RepoToggleRow inside the screen's
// ScrollView), selection is a Set lookup, the loading / error / empty /
// validation branches keep rendering where they did before, and the empty
// branch's Manage access launch is one shared fixture.
/* eslint-disable max-lines -- one native fixture for the picker's states; splitting it would duplicate the mocks */

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
const sideInsets = vi.hoisted(() => ({ left: 0, right: 0 }));
const manageAccess = vi.hoisted(() => ({
  openExternalUrl: vi.fn<(url: string, options?: unknown) => Promise<void>>(),
  mintInstallState: vi.fn<() => Promise<{ token: string }>>(),
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: 'View',
  Pressable: 'Pressable',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({
    top: 0,
    bottom: 0,
    left: sideInsets.left,
    right: sideInsets.right,
  }),
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
  useSettingsBackGuard: () => ({
    onBack: () => undefined,
    skipNextGuardRef: { current: false },
    dialog: null,
  }),
}));
vi.mock('@/lib/trpc', () => ({
  trpcClient: { githubApps: { mintInstallState: { mutate: manageAccess.mintInstallState } } },
}));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: manageAccess.openExternalUrl }));
vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://settings.test' }));
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

// The EmptyState stub receives the real `action` element; pressing it runs the
// screen's own handler. `onPress` is read through a guard rather than an
// assertion so a missing handler fails loudly instead of reading undefined.
function emptyStateAction(renderer: TestRenderer.ReactTestRenderer) {
  const action: unknown = renderer.root.find(node => String(node.type) === 'EmptyState').props
    .action;
  if (typeof action !== 'object' || action === null || !('props' in action)) {
    throw new TypeError('EmptyState action is not an element');
  }
  const { props } = action;
  if (typeof props !== 'object' || props === null || !('onPress' in props)) {
    throw new TypeError('EmptyState action has no onPress');
  }
  const { onPress } = props;
  if (typeof onPress !== 'function') {
    throw new TypeError('EmptyState action onPress is not callable');
  }
  return onPress as () => void;
}

// Presses the action and lets the mint → launch → refetch chain settle.
async function pressEmptyStateAction(renderer: TestRenderer.ReactTestRenderer) {
  const onPress = emptyStateAction(renderer);
  act(onPress);
  await vi.waitFor(() => {
    expect(manageAccess.mintInstallState).toHaveBeenCalled();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sideInsets.left = 0;
  sideInsets.right = 0;
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
  repositories.refetch.mockReset();
  repositories.refetch.mockResolvedValue(undefined);
  manageAccess.mintInstallState.mockReset();
  manageAccess.mintInstallState.mockResolvedValue({ token: 'install-state' });
  manageAccess.openExternalUrl.mockReset();
  manageAccess.openExternalUrl.mockResolvedValue(undefined);
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
      contentContainerStyle: {
        paddingTop: 16,
        paddingBottom: 12,
        paddingLeft: 24,
        paddingRight: 24,
      },
    });
    expect((list.props as { style: unknown }).style).toEqual({ flex: 1 });
  });

  it('keeps the picker rows inside the landscape side insets', async () => {
    sideInsets.left = 47;
    sideInsets.right = 59;
    const { renderer } = await mount();
    expect(listOf(renderer).props.contentContainerStyle).toEqual({
      paddingTop: 16,
      paddingLeft: 71,
      paddingRight: 83,
      paddingBottom: 12,
    });
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

  // With an empty grant there is nothing to select and nothing to sync in
  // either mode, so the mode choice must not be what hides the only control
  // that widens the app's access. The finding's owner had "all" stored.
  it('keeps the EmptyState with Manage access in all mode too', async () => {
    config.data = configData('all');
    repositories.data = [];
    const { renderer } = await mount();

    expect(renderer.root.findAll(node => String(node.type) === 'EmptyState')).toHaveLength(1);
    expect(repoRows(renderer)).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'ChoiceRow')).toHaveLength(2);
  });

  it('keeps the loading and error branches out of all mode', async () => {
    config.data = configData('all');
    repositories.data = undefined;
    repositories.isLoading = true;
    const loading = await mount();
    expect(loading.renderer.root.findAll(node => String(node.type) === 'Skeleton')).toHaveLength(0);
    expect(loading.renderer.root.findAll(node => String(node.type) === 'EmptyState')).toHaveLength(
      0
    );

    repositories.isLoading = false;
    repositories.isError = true;
    const failed = await mount();
    expect(failed.renderer.root.findAll(node => String(node.type) === 'QueryError')).toHaveLength(
      0
    );
  });

  it('reads the repositories again when the GitHub settings page closes', async () => {
    repositories.data = [];
    const { renderer } = await mount();

    await pressEmptyStateAction(renderer);

    expect(manageAccess.openExternalUrl).toHaveBeenCalledTimes(1);
    expect(repositories.refetch).toHaveBeenCalledTimes(1);
  });

  it('does not read the repositories when no settings page was opened', async () => {
    repositories.data = [];
    manageAccess.mintInstallState.mockRejectedValueOnce(new Error('mint refused'));
    const { renderer } = await mount();

    await pressEmptyStateAction(renderer);

    expect(manageAccess.openExternalUrl).not.toHaveBeenCalled();
    expect(repositories.refetch).not.toHaveBeenCalled();
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
