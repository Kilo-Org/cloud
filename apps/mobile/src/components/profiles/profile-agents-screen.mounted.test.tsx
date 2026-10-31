import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
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

  it('does not print the slug beside the name', async () => {
    h.query.data = [
      { id: 'agent-a', slug: 'reviewer', name: 'Reviewer', config: { mode: 'primary' } },
      {
        id: 'agent-b',
        slug: 'release-auditor',
        name: 'Release auditor',
        config: { mode: 'subagent' },
      },
    ];
    const { renderer, unmount } = await renderWithProviders(
      createElement(ProfileAgentsScreen, { profileId: 'profile-1' })
    );

    const texts = renderer.root
      .findAll(node => String(node.type) === 'Text')
      .map(node => node.props.children);

    expect(texts).toContain('Reviewer');
    expect(texts).toContain('Release auditor');
    expect(texts).not.toContain('reviewer');
    expect(texts).not.toContain('release-auditor');

    unmount();
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
