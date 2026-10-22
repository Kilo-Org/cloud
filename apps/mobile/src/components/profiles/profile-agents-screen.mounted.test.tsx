import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { ProfileAgentsScreen } from '@/components/profiles/profile-agents-screen';
import { type AgentSource } from '@/components/profiles/profile-agents-model';
import { renderWithProviders } from '@/test/render-with-providers';

const h = vi.hoisted(() => ({
  query: {
    data: undefined as { id: string; agents: AgentSource[] } | undefined,
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
  useAgentProfile: () => h.query,
  useAgentProfileSectionMutations: () => h.mutations,
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
  useConfirmDialog: () => ({ confirm: vi.fn(), dialog: null }),
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

describe('ProfileAgentsScreen mode badge', () => {
  it('renders the localized short label for every visibility mode', async () => {
    await i18n.changeLanguage('hi');
    h.query.data = {
      id: 'profile-1',
      agents: [agent('alpha', 'primary'), agent('beta', 'subagent'), agent('gamma', 'all')],
    };
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
    h.query.data = { id: 'profile-1', agents: [agent('alpha', undefined)] };
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
});
