import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import {
  findAll,
  mountScreen,
  testProfile,
  type TestProfileDetail,
} from '@/components/profiles/profile-agents-screen.test-helpers';
import {
  agentVisibilityLabelKey,
  type AgentVisibilityLabelKey,
} from '@/components/profiles/profile-agents-screen';
import { type AgentSource, type AgentVisibility } from '@/components/profiles/profile-agents-model';

const h = vi.hoisted(() => ({
  query: {
    data: undefined as TestProfileDetail | undefined,
    isError: false,
    isPending: true,
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
  useAgentProfileMutations: () => h.mutations,
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
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), dialog: null }),
}));
vi.mock('@/components/ui/icons', () => ({ Bot: 'Bot', Pencil: 'Pencil', Trash2: 'Trash2' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/profiles/agent-form-sheet', () => ({ AgentFormSheet: 'AgentFormSheet' }));

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage('en');
});

/** One agent row source per mode, so the screen renders all three badges. */
function agentWithMode(mode: AgentVisibility, id: string): AgentSource {
  return {
    id,
    slug: `${mode}-agent`,
    name: `${mode} agent`,
    config: { mode },
  };
}

describe('ProfileAgentsScreen mode badge', () => {
  it('renders localized mode labels, not the raw mode values', async () => {
    h.query.data = testProfile([
      agentWithMode('primary', 'a-1'),
      agentWithMode('subagent', 'a-2'),
      agentWithMode('all', 'a-3'),
    ]);
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();

    const texts = findAll(renderer.root, 'Text').map(node => String(node.props.children ?? ''));
    expect(texts.filter(text => ['Primary', 'Subagent', 'All'].includes(text)).length).toBe(3);
    expect(texts.some(text => ['primary', 'subagent', 'all'].includes(text))).toBe(false);

    unmount();
  });

  it('localizes the mode badges in Hindi', async () => {
    await i18n.changeLanguage('hi');
    h.query.data = testProfile([
      agentWithMode('primary', 'a-1'),
      agentWithMode('subagent', 'a-2'),
      agentWithMode('all', 'a-3'),
    ]);
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();

    const texts = findAll(renderer.root, 'Text').map(node => String(node.props.children ?? ''));
    expect(texts).toContain('प्राथमिक');
    expect(texts).not.toContain('PRIMARY');
    expect(texts).not.toContain('primary');

    unmount();
    await i18n.changeLanguage('en');
  });
});

describe('agentVisibilityLabelKey resolution', () => {
  // `t(key, { lng })` does not trigger the lazy catalog backend, so each
  // sampled language loads through `changeLanguage` like the app does.
  const MODES: readonly AgentVisibility[] = ['primary', 'subagent', 'all'];

  it.each(['hi', 'de', 'ja', 'ar'] as const)(
    'resolves every mode to a short localized label in %s',
    async tag => {
      await i18n.changeLanguage(tag);
      for (const mode of MODES) {
        const key: AgentVisibilityLabelKey = agentVisibilityLabelKey(mode);
        const value = i18n.t(key);
        expect(value.trim().length, `${tag} ${mode}`).toBeGreaterThan(0);
        expect(value, `${tag} ${mode}`).not.toBe(i18n.t(key, { lng: 'en' }));
      }
    }
  );

  it('renders the English and Hindi mode badges exactly', async () => {
    await i18n.changeLanguage('en');
    expect(i18n.t(agentVisibilityLabelKey('primary'))).toBe('Primary');
    expect(i18n.t(agentVisibilityLabelKey('subagent'))).toBe('Subagent');
    expect(i18n.t(agentVisibilityLabelKey('all'))).toBe('All');
    await i18n.changeLanguage('hi');
    expect(i18n.t(agentVisibilityLabelKey('primary'))).toBe('प्राथमिक');
    expect(i18n.t(agentVisibilityLabelKey('subagent'))).toBe('सबएजेंट');
    expect(i18n.t(agentVisibilityLabelKey('all'))).toBe('सभी');
    await i18n.changeLanguage('en');
  });
});
