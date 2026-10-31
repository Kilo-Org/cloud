import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act } from '@/test/renderer';
import { i18n } from '@/i18n';
import { resetFormDraftsForTests } from '@/lib/form-draft';
import { ProfileAgentsScreen } from '@/components/profiles/profile-agents-screen';
import { type AgentSource } from '@/components/profiles/profile-agents-model';
import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

const h = vi.hoisted(() => ({
  confirm: vi.fn(),
  query: {
    data: undefined as AgentSource[] | undefined,
    isError: false,
    isPending: false,
    isRefetching: false,
    refetch: vi.fn(),
  },
  mutations: {
    createAgent: { mutateAsync: vi.fn(), isPending: false },
    updateAgent: { mutateAsync: vi.fn(), isPending: false },
    deleteAgent: { mutateAsync: vi.fn(), isPending: false },
  },
}));

vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfileAgents: () => h.query,
  useAgentProfileSectionMutations: () => h.mutations,
}));
vi.mock('@/lib/hooks/use-can-manage-profiles', () => ({
  useCanManageOrganizationProfiles: () => true,
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('react-native', () => ({
  View: 'View',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#000000', destructive: '#FF0000' }),
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: h.confirm, dialog: null }),
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  Bot: 'Bot',
  Pencil: 'Pencil',
  Trash2: 'Trash2',
}));
vi.mock('@/components/profiles/agent-form-sheet', () => ({ AgentFormSheet: 'AgentFormSheet' }));

function agent(id: string, mode: AgentSource['config']['mode']): AgentSource {
  return { id, slug: id, name: id, config: mode === undefined ? {} : { mode } };
}

/** How many form sheets the screen currently renders. */
function sheetCount(root: ReactTestInstance): number {
  return root.findAll(node => String(node.type) === 'AgentFormSheet').length;
}

/** Press the row control whose accessibility label starts with `prefix`. */
function pressRow(root: ReactTestInstance, prefix: string): void {
  const control = root.findAll(
    node =>
      String(node.type) === 'Pressable' &&
      typeof node.props.onPress === 'function' &&
      String(node.props.accessibilityLabel).startsWith(prefix)
  )[0];
  // The test renderer exposes host props untyped; the screen passes this handler.
  const onPress = control?.props.onPress as (() => void) | undefined;
  act(() => {
    onPress?.();
  });
}

describe('ProfileAgentsScreen mode badge', () => {
  it('renders the localized short label for every visibility mode', async () => {
    await i18n.changeLanguage('hi');
    h.query.data = [agent('alpha', 'primary'), agent('beta', 'subagent'), agent('gamma', 'all')];
    const { renderer, unmount } = await renderWithProviders(
      createElement(ProfileAgentsScreen, { profileId: 'profile-1' })
    );

    const labels = renderer.root
      .findAll(node => String(node.type) === 'Text')
      .filter(node => String(node.props.className ?? '').includes('uppercase'))
      .map(node => node.props.children as string);

    expect(labels).toEqual([
      i18n.t('profiles.agents.modePrimary'),
      i18n.t('profiles.agents.modeSubagent'),
      i18n.t('profiles.agents.modeAll'),
    ]);
    expect(labels).not.toContain('primary');
    expect(new Set(labels).size).toBe(3);

    unmount();
    await i18n.changeLanguage('en');
  });

  it('falls back to the primary mode label when the config carries none', async () => {
    await i18n.changeLanguage('hi');
    h.query.data = [agent('alpha', undefined)];
    const { renderer, unmount } = await renderWithProviders(
      createElement(ProfileAgentsScreen, { profileId: 'profile-1' })
    );

    const labels = renderer.root
      .findAll(node => String(node.type) === 'Text')
      .filter(node => String(node.props.className ?? '').includes('uppercase'))
      .map(node => node.props.children as string);

    expect(labels).toEqual([i18n.t('profiles.agents.modePrimary')]);

    unmount();
    await i18n.changeLanguage('en');
  });

  it('drops the row presses of the burst that closed the sheet', async () => {
    h.query.data = [agent('alpha', 'primary')];
    const { renderer, unmount } = await renderWithProviders(
      createElement(ProfileAgentsScreen, { profileId: 'profile-1' })
    );

    pressRow(renderer.root, 'Edit');
    const sheet = renderer.root.find(node => String(node.type) === 'AgentFormSheet');
    // The test renderer exposes host props untyped; the screen passes this handler.
    const closeSheet = sheet.props.onClose as () => void;
    act(() => {
      closeSheet();
    });

    pressRow(renderer.root, 'Delete');
    pressRow(renderer.root, 'Edit');

    expect(sheetCount(renderer.root)).toBe(0);
    expect(h.confirm).not.toHaveBeenCalled();

    unmount();
  });
});

type PressableProps = { onPress: () => void; onClose?: () => void };

/** Fire one handler a host stub carries; the stubs keep props untyped. */
function press(node: { props: unknown }): void {
  const props = node.props as PressableProps;
  act(() => {
    props.onPress();
  });
}

function pressClose(sheet: { props: unknown }): void {
  const props = sheet.props as PressableProps;
  const onClose = props.onClose;
  if (typeof onClose !== 'function') {
    throw new TypeError('the sheet rendered no onClose');
  }
  act(() => {
    onClose();
  });
}

describe('ProfileAgentsScreen form draft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFormDraftsForTests();
  });

  it('reopens the add sheet after a remount', async () => {
    h.query.data = [agent('alpha', 'primary')];
    const first = await renderWithProviders(
      createElement(ProfileAgentsScreen, { profileId: 'profile-1' })
    );
    const addButton = first.renderer.root.findAll(node => String(node.type) === 'Button')[0];
    if (!addButton) {
      throw new Error('the add button was not rendered');
    }
    press(addButton);
    expect(
      first.renderer.root.findAll(node => String(node.type) === 'AgentFormSheet')
    ).toHaveLength(1);
    first.unmount();

    const second = await renderWithProviders(
      createElement(ProfileAgentsScreen, { profileId: 'profile-1' })
    );
    expect(
      second.renderer.root.findAll(node => String(node.type) === 'AgentFormSheet')
    ).toHaveLength(1);
    second.unmount();
  });

  it('keeps the add sheet closed after the form was cancelled', async () => {
    h.query.data = [agent('alpha', 'primary')];
    const first = await renderWithProviders(
      createElement(ProfileAgentsScreen, { profileId: 'profile-1' })
    );
    const addButton = first.renderer.root.findAll(node => String(node.type) === 'Button')[0];
    if (!addButton) {
      throw new Error('the add button was not rendered');
    }
    press(addButton);
    const sheet = first.renderer.root.findAll(node => String(node.type) === 'AgentFormSheet')[0];
    if (!sheet) {
      throw new Error('the sheet was not rendered');
    }
    pressClose(sheet);
    first.unmount();

    const second = await renderWithProviders(
      createElement(ProfileAgentsScreen, { profileId: 'profile-1' })
    );
    expect(
      second.renderer.root.findAll(node => String(node.type) === 'AgentFormSheet')
    ).toHaveLength(0);
    second.unmount();
  });
});

type MountedRenderer = Awaited<ReturnType<typeof renderWithProviders>>['renderer'];

/** The nodes of one host type; the stubs keep their props untyped. */
function nodesOfType(renderer: MountedRenderer, type: string) {
  return renderer.root.findAll(node => String(node.type) === type);
}

/** The open sheet, which the screen wires to its own save pipeline. */
function openSheet(renderer: MountedRenderer) {
  const sheet = nodesOfType(renderer, 'AgentFormSheet')[0];
  if (!sheet) {
    throw new Error('the sheet was not rendered');
  }
  return sheet;
}

function pressAdd(renderer: MountedRenderer): void {
  const button = nodesOfType(renderer, 'Button')[0];
  if (!button) {
    throw new Error('the add button was not rendered');
  }
  act(() => {
    (button.props as { onPress: () => void }).onPress();
  });
}

describe('ProfileAgentsScreen save ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFormDraftsForTests();
    h.query.data = [agent('alpha', 'primary')];
    h.query.isPending = false;
  });

  it('leaves the form opened after a refused save alone when that save settles', async () => {
    const pendingSave = Promise.withResolvers<unknown>();
    h.mutations.createAgent.mutateAsync.mockImplementation(() => pendingSave.promise);

    const { renderer, unmount } = await renderWithProviders(
      createElement(ProfileAgentsScreen, { profileId: 'profile-1' })
    );
    pressAdd(renderer);
    const first = openSheet(renderer);
    act(() => {
      (first.props.onSave as (payload: unknown) => void)({
        slug: 'first-agent',
        name: 'First agent',
        config: {},
      });
    });
    expect(h.mutations.createAgent.mutateAsync).toHaveBeenCalledTimes(1);

    // Dismiss that attempt and open a different form: the refusal of the first
    // save belongs to the first form and must not appear under the second.
    act(() => {
      (first.props.onClose as () => void)();
    });
    pressAdd(renderer);
    const second = openSheet(renderer);

    await act(async () => {
      pendingSave.reject({ data: { code: 'CONFLICT' } });
      await Promise.resolve();
    });

    expect(second.props.slugConflictFromServer).toBe(false);
    expect(nodesOfType(renderer, 'AgentFormSheet')).toHaveLength(1);
    unmount();
  });
});
