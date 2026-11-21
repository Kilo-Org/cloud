// Security Agent repository picker: the repositories mount through FlashList
// (one virtualized scroller instead of every RepoToggleRow inside the screen's
// ScrollView), each cell draws the grouped card's own rounded end and
// separator, selection is a Set lookup, the loading / error / empty /
// validation branches keep rendering where they did before, and the empty
// branch's Manage access launch is one shared fixture.
/* eslint-disable max-lines -- one native fixture for the picker's states; splitting it would duplicate the mocks */

import { createElement, Fragment, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { RowGroupItem } from '@/components/ui/row-group';
import { act, type TestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { RepositorySettingsScreen } from './repository-settings-screen';

type RepoRow = { id: number; fullName: string; private: boolean };

const config = vi.hoisted(() => ({
  data: null as Record<string, unknown> | null,
  isLoading: false,
  isError: false,
  isPending: false,
  fetchStatus: 'idle' as 'fetching' | 'paused' | 'idle',
  error: null as unknown,
  refetch: vi.fn(),
}));
const platformError = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
const repositories = vi.hoisted(() => ({
  data: undefined as readonly RepoRow[] | undefined,
  isLoading: false,
  isError: false,
  isFetching: false,
  fetchStatus: 'idle' as 'fetching' | 'paused' | 'idle',
  error: null as unknown,
  refetch: vi.fn(),
}));
const connectivity = vi.hoisted(() => ({ known: true }));
const configRetry = vi.hoisted(() => ({ retry: vi.fn(), isRetrying: false }));
const repositoriesRetry = vi.hoisted(() => ({ retry: vi.fn(), isRetrying: false }));
const capability = vi.hoisted(() => ({
  canManage: true,
  status: 'allowed' as 'loading' | 'error' | 'denied' | 'allowed',
  isPending: false,
  fetchStatus: 'idle' as 'fetching' | 'paused' | 'idle',
}));
const settingsRecovery = vi.hoisted(() => ({ retry: vi.fn(), isRetrying: false }));
const save = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }));
const saveButton = vi.hoisted(() => ({ onSave: null as (() => Promise<void>) | null }));
const sideInsets = vi.hoisted(() => ({ left: 0, right: 0 }));
const manageAccess = vi.hoisted(() => ({
  openAppShellHandoff: vi.fn<(target: unknown, options?: unknown) => Promise<void>>(),
}));

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false, doLeftAndRightSwapInRTL: true },
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
    renderItem: (info: { item: unknown; index: number }) => ReactNode;
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
        createElement(Fragment, { key: index }, props.renderItem({ item, index }))
      ),
      props.ListFooterComponent
    );
  },
}));
vi.mock('@/lib/hooks/use-security-agent', () => ({
  useRetrySecurityAgentConfig: () => configRetry,
  useRetrySecurityAgentRepositories: () => repositoriesRetry,
  useRetrySecurityAgentSettings: () => settingsRecovery,
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
vi.mock('@/lib/app-shell-handoff', () => ({
  openAppShellHandoff: manageAccess.openAppShellHandoff,
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  useCommittedConnectivityStatus: () => (connectivity.known ? 'online' : 'unknown'),
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/tab-screen', () => ({ useTabBarBottomPadding: () => 12 }));
vi.mock('@/components/security-agent/settings-save-button', () => ({
  SettingsSaveButton: (props: { onSave: () => Promise<void> }) => {
    saveButton.onSave = props.onSave;
    return null;
  },
}));
vi.mock('@/components/repo-toggle-row', () => ({ RepoToggleRow: 'RepoToggleRow' }));
vi.mock('@/components/security-agent/orphaned-findings-card', () => ({
  OrphanedFindingsCard: 'OrphanedFindingsCard',
}));
vi.mock('@/components/platform-error-screen', () => ({
  PlatformErrorScreen: (props: Record<string, unknown>) => {
    platformError.props = props;
    return null;
  },
}));
vi.mock('@/components/empty-state', () => ({
  EmptyState: 'EmptyState',
  StateAction: 'StateAction',
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/security-agent/settings-recovery-status', () => ({
  // A host string, so the suite can both count the status and read the props
  // its Retry is wired through.
  SettingsRecoveryStatus: 'SettingsRecoveryStatus',
}));
// `headerRight` is a prop, not a child: the stub renders it so the Save button
// (the screen's only save path) actually mounts.
vi.mock('@/components/screen-header', () => ({
  ScreenHeader: (props: { headerRight?: ReactNode }) =>
    createElement(Fragment, null, props.headerRight),
}));
vi.mock('@/lib/haptics', () => ({ selectionHaptic: () => undefined }));
vi.mock('@/components/ui/icons', () => ({
  ExternalLink: 'ExternalLink',
  FolderGit2: 'FolderGit2',
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/choice-row', () => ({ ChoiceRow: 'ChoiceRow' }));
vi.mock('@/components/ui/radio-group', () => ({ RadioGroup: 'RadioGroup' }));
vi.mock('@/components/ui/row-skeleton', () => ({ RowSkeleton: 'RowSkeleton' }));
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

async function mount(scope = 'personal') {
  const mounted = await renderWithProviders(createElement(RepositorySettingsScreen, { scope }));
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

// The reserve the loading branch paints: one `RowSkeleton` per repository the
// loaded list would show, at the same one-line frame.
function placeholderRows(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(node => String(node.type) === 'RowSkeleton');
}

// The picker's cells are one grouped card drawn by the list, so each carries
// its own rounded end: `first`/`middle`/`last` for a multi-row section.
function cellPositions(renderer: TestRenderer.ReactTestRenderer): unknown[] {
  return renderer.root
    .findAllByType(RowGroupItem)
    .map(node => (node.props as { position?: unknown }).position);
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

// With nothing to save in the header, the grant action is the one control the
// state exists to offer, so its label is part of this contract.
function emptyStateActionLabel(renderer: TestRenderer.ReactTestRenderer): unknown {
  const action: unknown = renderer.root.find(node => String(node.type) === 'EmptyState').props
    .action;
  if (typeof action !== 'object' || action === null || !('props' in action)) {
    throw new TypeError('EmptyState action is not an element');
  }
  const { props } = action;
  if (typeof props !== 'object' || props === null || !('label' in props)) {
    return undefined;
  }
  return props.label;
}

// Presses the action and lets the mint → launch → refetch chain settle.
async function pressEmptyStateAction(renderer: TestRenderer.ReactTestRenderer) {
  const onPress = emptyStateAction(renderer);
  act(onPress);
  await vi.waitFor(() => {
    expect(manageAccess.openAppShellHandoff).toHaveBeenCalled();
  });
}

// The permission-recovery row the screen renders, found as the host element its
// stub draws, so a case can tell one from none and read the props its Retry is
// wired through.
function recoveryStatuses(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(node => String(node.type) === 'SettingsRecoveryStatus');
}

// The orphaned-findings card's Clear is irreversible, so the grant its stub
// receives is part of the role read's contract; a missing or doubled card
// fails loudly instead of reading undefined.
function orphanedCardCanManage(renderer: TestRenderer.ReactTestRenderer): unknown {
  const cards = renderer.root.findAll(node => String(node.type) === 'OrphanedFindingsCard');
  const card = cards[0];
  if (cards.length !== 1 || !card) {
    throw new Error(`expected one orphaned-findings card, found ${cards.length}`);
  }
  const props: { canManage?: unknown } = card.props;
  return props.canManage;
}

// The banner's Retry is the screen's own handler; reading it through a guard
// makes a missing or non-callable handler fail loudly.
function queryErrorRetry(renderer: TestRenderer.ReactTestRenderer): () => void {
  const props: { onRetry?: unknown } = renderer.root.find(
    node => String(node.type) === 'QueryError'
  ).props;
  if (typeof props.onRetry !== 'function') {
    throw new TypeError('QueryError onRetry is not callable');
  }
  return props.onRetry as () => void;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sideInsets.left = 0;
  sideInsets.right = 0;
  config.data = configData('selected');
  config.isLoading = false;
  config.isError = false;
  config.isPending = false;
  config.fetchStatus = 'idle';
  config.error = null;
  platformError.props = null;
  repositories.data = THREE_REPOS;
  repositories.isLoading = false;
  repositories.isError = false;
  repositories.isFetching = false;
  repositories.fetchStatus = 'idle';
  repositories.error = null;
  connectivity.known = true;
  configRetry.retry.mockReset();
  configRetry.retry.mockResolvedValue(undefined);
  repositoriesRetry.retry.mockReset();
  repositoriesRetry.retry.mockResolvedValue(undefined);
  capability.canManage = true;
  capability.status = 'allowed';
  capability.isPending = false;
  capability.fetchStatus = 'idle';
  settingsRecovery.retry.mockReset();
  settingsRecovery.retry.mockResolvedValue(undefined);
  settingsRecovery.isRetrying = false;
  save.isPending = false;
  save.mutateAsync.mockReset();
  save.mutateAsync.mockResolvedValue({});
  saveButton.onSave = null;
  repositories.refetch.mockReset();
  repositories.refetch.mockResolvedValue(undefined);
  manageAccess.openAppShellHandoff.mockReset();
  manageAccess.openAppShellHandoff.mockResolvedValue(undefined);
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
    // The page gutter now lives on the rows and the header, so the list's
    // content container carries only the top pad, the tab-bar band and the
    // safe-area side insets.
    expect(list.props as { contentContainerStyle: unknown }).toMatchObject({
      contentContainerStyle: {
        paddingTop: 12,
        paddingBottom: 12,
        paddingLeft: 0,
        paddingRight: 0,
      },
    });
    expect((list.props as { style: unknown }).style).toEqual({ flex: 1 });
    // One grouped card: the first cell rounds the top, the last the bottom.
    expect(cellPositions(renderer)).toEqual(['first', 'middle', 'last']);
  });

  it('keeps the picker rows inside the landscape side insets', async () => {
    sideInsets.left = 47;
    sideInsets.right = 59;
    const { renderer } = await mount();
    expect(listOf(renderer).props.contentContainerStyle).toEqual({
      paddingTop: 12,
      paddingLeft: 47,
      paddingRight: 59,
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

  it('reserves the loading rows in the header without mounting rows', async () => {
    repositories.isLoading = true;
    repositories.data = undefined;
    const { renderer } = await mount();

    // The picker's rows are one-line rows inside one grouped card, so the
    // reserve is two rows of one bar each — not a second line the loaded row
    // never draws.
    const placeholders = placeholderRows(renderer);
    expect(placeholders).toHaveLength(2);
    expect(placeholders.every(row => row.props.subtitle !== true)).toBe(true);
    expect(repoRows(renderer)).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'EmptyState')).toHaveLength(0);
  });

  it('keeps the retryable QueryError in the header when nothing was delivered', async () => {
    // A failed read that delivered no rows is a body failure: the error owns
    // the section and no rows mount under it.
    repositories.data = undefined;
    repositories.isError = true;
    const { renderer } = await mount();

    const error = renderer.root.find(node => String(node.type) === 'QueryError');
    expect((error.props as { placement: string }).placement).toBe('top');
    expect(typeof (error.props as { onRetry: unknown }).onRetry).toBe('function');
    expect(repoRows(renderer)).toHaveLength(0);
  });

  it('keeps the delivered rows under a failed refetch with the banner above them', async () => {
    // A failed refetch that still holds the delivered row set must not blank
    // the picker: a tRPC answer proves the server was reachable, so the banner
    // keeps the system wording while the rows stay selectable.
    repositories.data = THREE_REPOS;
    repositories.isError = true;
    repositories.isFetching = false;
    repositories.error = Object.assign(new Error('boom'), {
      data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
    });
    const { renderer } = await mount();

    const error = renderer.root.find(node => String(node.type) === 'QueryError');
    expect((error.props as { variant: string }).variant).toBe('server');
    expect(repoRows(renderer)).toHaveLength(3);
    expect((listOf(renderer).props as { data: RepoRow[] }).data).toHaveLength(3);
    // The validation line belongs to the rows it is about, so it rides with
    // them instead of disappearing with the failure.
    expect(textContents(renderer)).toContain(i18n.t('securityAgent.repositories.selectAtLeastOne'));
  });

  it('keeps the failure banner above a stale empty grant', async () => {
    // A refetch that failed over a delivered `[]` must not pass the cached
    // empty grant off as current: the banner names the failure above the
    // EmptyState, whose grant action stays the way out.
    repositories.data = [];
    repositories.isError = true;
    repositories.error = Object.assign(new Error('boom'), {
      data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
    });
    const { renderer } = await mount();

    const errors = renderer.root.findAll(node => String(node.type) === 'QueryError');
    expect(errors).toHaveLength(1);
    const banner = errors[0];
    if (!banner) {
      throw new Error('stale empty grant rendered no failure banner');
    }
    const props: { variant?: unknown } = banner.props;
    expect(props.variant).toBe('server');
    expect(renderer.root.findAll(node => String(node.type) === 'EmptyState')).toHaveLength(1);
    expect(emptyStateActionLabel(renderer)).toBe(i18n.t('securityAgent.repositories.manageAccess'));

    act(queryErrorRetry(renderer));
    expect(repositoriesRetry.retry).toHaveBeenCalledTimes(1);
  });

  it('names the connection on a failed refetch that never reached the server', async () => {
    // A transport rejection carries no server answer, so the banner names the
    // connection — and the delivered rows still mount under it.
    repositories.data = THREE_REPOS;
    repositories.isError = true;
    repositories.isFetching = false;
    repositories.error = new TypeError('Network request failed');
    const { renderer } = await mount();

    const error = renderer.root.find(node => String(node.type) === 'QueryError');
    expect((error.props as { variant: string }).variant).toBe('offline');
    expect(repoRows(renderer)).toHaveLength(3);
  });

  it('keeps the EmptyState with Manage access in the header', async () => {
    repositories.data = [];
    const { renderer } = await mount();

    const empty = renderer.root.find(node => String(node.type) === 'EmptyState');
    expect((empty.props as { placement: string }).placement).toBe('top');
    expect(empty.props as { action: unknown }).toHaveProperty('action');
    // The grant is the only way out of this state, so it is the state's one
    // primary action, named by its own label.
    expect(emptyStateActionLabel(renderer)).toBe(i18n.t('securityAgent.repositories.manageAccess'));
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
    const modeRows = renderer.root.findAll(node => String(node.type) === 'ChoiceRow');
    expect(modeRows).toHaveLength(2);
    // Nothing to choose between with an empty grant: both modes stay visible so
    // the setting keeps its two names, but neither claims a choice the reader
    // cannot make.
    expect(modeRows.map(row => row.props.disabled)).toEqual([true, true]);
    // The state keeps the shared bubble: a rounded-square tile was the only
    // off-contract empty state in the app.
    expect(
      renderer.root.find(node => String(node.type) === 'EmptyState').props.iconContainerClassName
    ).toBeUndefined();
  });

  it('keeps the loading and error branches out of all mode', async () => {
    config.data = configData('all');
    repositories.data = undefined;
    repositories.isLoading = true;
    const loading = await mount();
    expect(placeholderRows(loading.renderer)).toHaveLength(0);
    expect(loading.renderer.root.findAll(node => String(node.type) === 'EmptyState')).toHaveLength(
      0
    );

    // A read that delivered nothing under a failed refetch is not the settled
    // empty grant: the section must not render a label with no state and no
    // control under it. (`[]` is delivered data, so it renders the EmptyState
    // with Manage access — a control — which is not what this case asserts.)
    repositories.data = undefined;
    repositories.isLoading = false;
    repositories.isError = true;
    const failed = await mount();
    expect(failed.renderer.root.findAll(node => String(node.type) === 'QueryError')).toHaveLength(
      0
    );
    expect(failed.renderer.root.findAll(node => String(node.type) === 'EmptyState')).toHaveLength(
      0
    );
    expect(textContents(failed.renderer)).not.toContain(i18n.t('common.repositories'));
  });

  it('reads the repositories again when the GitHub settings page closes', async () => {
    repositories.data = [];
    const { renderer } = await mount();

    await pressEmptyStateAction(renderer);

    expect(manageAccess.openAppShellHandoff).toHaveBeenCalledTimes(1);
    expect(manageAccess.openAppShellHandoff).toHaveBeenCalledWith(
      { page: 'github-app' },
      expect.any(Object)
    );
    await vi.waitFor(() => {
      expect(repositories.refetch).toHaveBeenCalledTimes(1);
    });
  });

  it('names the organization on the hand-off target', async () => {
    repositories.data = [];
    const { renderer } = await mount('org_123');

    await pressEmptyStateAction(renderer);

    expect(manageAccess.openAppShellHandoff).toHaveBeenCalledWith(
      { page: 'github-app', organizationId: 'org_123' },
      expect.any(Object)
    );
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

  it('names the connection with Retry when the repository read is paused', async () => {
    // A read paused by lost connectivity delivered nothing: it must not read as
    // "No repositories", and it names its cause with a Retry.
    repositories.data = undefined;
    repositories.isLoading = false;
    repositories.isError = false;
    repositories.fetchStatus = 'paused';
    const { renderer } = await mount();

    expect(renderer.root.findAll(node => String(node.type) === 'EmptyState')).toHaveLength(0);
    const error = renderer.root.find(node => String(node.type) === 'QueryError');
    expect((error.props as { variant: string }).variant).toBe('offline');
    expect(placeholderRows(renderer)).toHaveLength(0);
  });

  it('retries a paused repository read through one deliberate attempt', async () => {
    // A read with no data reuses its paused promise on `refetch()`, so the
    // banner's Retry must run the deliberate attempt instead.
    repositories.data = undefined;
    repositories.isLoading = false;
    repositories.isError = false;
    repositories.fetchStatus = 'paused';
    const { renderer } = await mount();

    act(queryErrorRetry(renderer));

    expect(repositoriesRetry.retry).toHaveBeenCalledTimes(1);
    expect(repositories.refetch).not.toHaveBeenCalled();
  });

  it('retries a failed refetch over delivered rows through one deliberate attempt', async () => {
    repositories.data = THREE_REPOS;
    repositories.isError = true;
    const { renderer } = await mount();

    act(queryErrorRetry(renderer));

    expect(repositoriesRetry.retry).toHaveBeenCalledTimes(1);
    expect(repositories.refetch).not.toHaveBeenCalled();
  });

  it('keeps the skeleton for a paused read whose connectivity is unsettled', async () => {
    connectivity.known = false;
    repositories.data = undefined;
    repositories.isLoading = false;
    repositories.isError = false;
    repositories.fetchStatus = 'paused';
    const { renderer } = await mount();

    expect(renderer.root.findAll(node => String(node.type) === 'EmptyState')).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'QueryError')).toHaveLength(0);
    expect(placeholderRows(renderer)).toHaveLength(2);
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

  // The section label repeated the screen title above a state that already
  // says "No repositories", so it is only worth its line when rows follow it.
  it('leaves the section label off the empty state and keeps it above the rows', async () => {
    repositories.data = [];
    const empty = await mount();
    expect(textContents(empty.renderer)).not.toContain(i18n.t('common.repositories'));

    repositories.data = THREE_REPOS;
    const filled = await mount();
    expect(textContents(filled.renderer)).toContain(i18n.t('common.repositories'));
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

describe('config load failure', () => {
  it('names the connection for a paused config read instead of holding the skeleton', async () => {
    // A paused read is pending without loading and has no data, so the
    // skeleton gate would hold it until connectivity returns.
    config.data = null;
    config.isLoading = false;
    config.isPending = true;
    config.fetchStatus = 'paused';

    await mount();

    const error = platformError.props;
    if (!error) {
      throw new Error('paused first read did not render the failure screen');
    }
    expect(error.variant).toBe('offline');
    expect(error.errorTitle).toBe(i18n.t('securityAgent.repositories.couldNotLoad'));
    const onRetry: unknown = error.onRetry;
    if (typeof onRetry !== 'function') {
      throw new TypeError('paused first read has no retry');
    }
    act(onRetry as () => void);
    expect(configRetry.retry).toHaveBeenCalledTimes(1);
  });

  it('titles the failure with the screen and leaves the description to the variant', async () => {
    config.data = null;
    config.isError = true;
    config.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };

    await mount();

    const error = platformError.props;
    if (!error) {
      throw new Error('failed first read did not render the failure screen');
    }
    // The failed read is named once, in the error's own title. A message here
    // would repeat the same words above the variant's cause.
    expect(error.errorTitle).toBe(i18n.t('securityAgent.repositories.couldNotLoad'));
    expect(error.message).toBeUndefined();
    expect(error.variant).toBe('server');
  });
});

describe('role read states', () => {
  // A non-personal scope is the only one whose capability comes from the role
  // read: the personal scope short-circuits to `allowed`, so these states do
  // not exist there.
  const ORG_SCOPE = 'org_role_fixture';

  it('offers Retry and keeps the controls usable when the role read fails', async () => {
    // A failed role read is not a refusal: it must name its cause with a Retry
    // instead of claiming the viewer may not change these settings.
    capability.canManage = false;
    capability.status = 'error';
    const { renderer } = await mount(ORG_SCOPE);

    const statuses = recoveryStatuses(renderer);
    expect(statuses).toHaveLength(1);
    const onRetry: unknown = statuses[0]?.props.onRetry;
    if (typeof onRetry !== 'function') {
      throw new TypeError('recovery status onRetry is not callable');
    }
    act(onRetry as () => void);
    expect(settingsRecovery.retry).toHaveBeenCalledTimes(1);

    expect(textContents(renderer)).not.toContain(i18n.t('securityAgent.sla.permissionNote'));
    // The header keeps its save path and the rows keep their controls: the
    // server enforces the permission, so an unanswered question must not lock
    // the screen.
    expect(typeof saveButton.onSave).toBe('function');
    expect(repoRows(renderer).map(row => (row.props as { disabled: boolean }).disabled)).toEqual([
      false,
      false,
      false,
    ]);
    const modeRows = renderer.root.findAll(node => String(node.type) === 'ChoiceRow');
    expect(modeRows.map(row => row.props.disabled)).toEqual([false, false]);
  });

  it('keeps the controls usable while a paused first role read names the connection', async () => {
    // A first role read the online manager paused can never finish: it names the
    // connection with Retry rather than reading as a refusal.
    capability.status = 'loading';
    capability.isPending = true;
    capability.fetchStatus = 'paused';
    connectivity.known = true;
    const { renderer } = await mount(ORG_SCOPE);

    expect(recoveryStatuses(renderer)).toHaveLength(1);
    expect(textContents(renderer)).not.toContain(i18n.t('securityAgent.sla.permissionNote'));
  });

  it('offers the Clear action only on a settled grant', async () => {
    // The card's Clear is irreversible, so the controls staying usable on an
    // unanswered role read does not extend to it: only a settled grant opens it.
    capability.canManage = false;
    capability.status = 'error';
    const failed = await mount(ORG_SCOPE);
    expect(orphanedCardCanManage(failed.renderer)).toBe(false);

    capability.status = 'loading';
    capability.isPending = true;
    capability.fetchStatus = 'paused';
    const paused = await mount(ORG_SCOPE);
    expect(orphanedCardCanManage(paused.renderer)).toBe(false);

    capability.status = 'allowed';
    capability.canManage = true;
    capability.isPending = false;
    capability.fetchStatus = 'idle';
    const allowed = await mount(ORG_SCOPE);
    expect(orphanedCardCanManage(allowed.renderer)).toBe(true);

    capability.status = 'denied';
    capability.canManage = false;
    const denied = await mount(ORG_SCOPE);
    expect(orphanedCardCanManage(denied.renderer)).toBe(false);
  });

  it('locks the controls and names the rule only on a settled denial', async () => {
    capability.canManage = false;
    capability.status = 'denied';
    const { renderer } = await mount(ORG_SCOPE);

    expect(recoveryStatuses(renderer)).toHaveLength(0);
    expect(textContents(renderer)).toContain(i18n.t('securityAgent.sla.permissionNote'));
    expect(saveButton.onSave).toBeNull();
    expect(repoRows(renderer).map(row => (row.props as { disabled: boolean }).disabled)).toEqual([
      true,
      true,
      true,
    ]);
  });
});
