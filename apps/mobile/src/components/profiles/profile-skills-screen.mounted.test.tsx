import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import {
  changeText,
  confirmAlert,
  findAll,
  findField,
  findOne,
  mountScreen,
  pressEmptyAction,
  pressPressable,
  pressSheetDone,
  rerenderScreen,
  type TestAlertMock,
  testProfile,
  testSkill,
} from '@/components/profiles/profile-skills-screen.test-helpers';
import { act } from '@/test/renderer';
import { waitFor } from '@/test/render-with-providers';

const h = vi.hoisted(() => ({
  alert: vi.fn(),
  error: vi.fn(),
  query: {
    data: undefined as unknown,
    isError: false,
    isPending: true,
    isRefetching: false,
    refetch: vi.fn(),
  },
  mutations: {
    createCustomSkill: { mutateAsync: vi.fn(), isPending: false },
    updateSkill: { mutateAsync: vi.fn(), isPending: false },
    deleteSkill: { mutateAsync: vi.fn(), isPending: false },
    setSkillEnabled: { mutate: vi.fn(), isPending: false },
  },
}));

vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfile: () => h.query,
  useAgentProfileMutations: () => h.mutations,
}));
vi.mock('sonner-native', () => ({ toast: { error: h.error } }));
vi.mock('react-native', () => ({
  View: 'View',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  Switch: 'Switch',
  Alert: { alert: h.alert },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    mutedForeground: '#000000',
    destructive: '#FF0000',
    primaryForeground: '#000000',
  }),
}));
vi.mock('@/components/agents/session-page-sheet', () => ({
  SessionPageSheet: 'SessionPageSheet',
}));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  Pencil: 'Pencil',
  Sparkles: 'Sparkles',
  Trash2: 'Trash2',
}));

describe('ProfileSkillsScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(h.query, {
      data: undefined,
      isError: false,
      isPending: true,
      isRefetching: false,
    });
    for (const mutation of Object.values(h.mutations)) {
      Object.assign(mutation, { isPending: false });
    }
  });

  it('loading: renders skeletons and no rows', async () => {
    const { renderer, unmount } = await mountScreen();

    expect(findAll(renderer.root, 'Skeleton').length).toBeGreaterThan(0);
    expect(findAll(renderer.root, 'Switch')).toHaveLength(0);

    unmount();
  });

  it('error: renders QueryError and Retry refetches', async () => {
    Object.assign(h.query, { isError: true, isPending: false });

    const { renderer, unmount } = await mountScreen();

    act(() => {
      (findOne(renderer.root, 'QueryError').props as { onRetry: () => void }).onRetry();
    });
    expect(h.query.refetch).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('empty: shows skillsEmpty and the add CTA opens the sheet', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();

    expect(findOne(renderer.root, 'EmptyState').props.title).toBe('No skills yet');
    pressEmptyAction(renderer);
    expect(findOne(renderer.root, 'SheetHeader')).toBeTruthy();

    unmount();
  });

  it('happy: a row shows the name, source type, and status; the switch toggles', async () => {
    h.query.data = testProfile([testSkill()]);
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();

    const texts = findAll(renderer.root, 'Text').map(node => node.props.children);
    expect(texts).toContain('code-review');
    expect(texts).toContain('custom');
    expect(texts).toContain('Enabled');

    const toggle = findOne(renderer.root, 'Switch');
    expect(toggle.props.accessibilityLabel).toBe('code-review');
    act(() => {
      (toggle.props as { onValueChange: (v: boolean) => void }).onValueChange(false);
    });
    expect(h.mutations.setSkillEnabled.mutate.mock.calls[0]?.[0]).toEqual({
      profileId: 'profile-1',
      skillId: 'skill-1',
      enabled: false,
    });

    unmount();
  });

  it('happy: the edit control opens the sheet seeded with the skill', async () => {
    h.query.data = testProfile([testSkill()]);
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();
    pressPressable(renderer.root, 'Edit skill');

    expect(findField(renderer.root, 'Skill name').props.defaultValue).toBe('code-review');
    expect(findField(renderer.root, 'Skill content').props.defaultValue).toBe('Body');

    unmount();
  });

  it('clears the stored description when frontmatter description is removed', async () => {
    h.query.data = testProfile([
      testSkill({
        rawMarkdown: '---\nname: code-review\ndescription: Old description\n---\nBody',
      }),
    ]);
    h.query.isPending = false;
    h.mutations.updateSkill.mutateAsync.mockResolvedValue({ success: true });
    const { renderer, unmount } = await mountScreen();
    pressPressable(renderer.root, 'Edit skill');
    changeText(renderer.root, 'Skill content', '---\nname: code-review\n---\nBody');
    pressSheetDone(renderer.root);
    await waitFor(() => h.mutations.updateSkill.mutateAsync.mock.calls.length > 0);
    expect(h.mutations.updateSkill.mutateAsync.mock.calls[0]?.[0]).toMatchObject({
      skillId: 'skill-1',
      description: null,
    });
    unmount();
  });

  it('happy: a valid add saves through createCustomSkill and closes the sheet', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;
    h.mutations.createCustomSkill.mutateAsync.mockResolvedValue({ id: 'skill-2' });

    const { renderer, unmount } = await mountScreen();
    pressEmptyAction(renderer);
    changeText(renderer.root, 'Skill name', 'my-skill');
    changeText(renderer.root, 'Skill content', 'Body');
    pressSheetDone(renderer.root);

    await waitFor(() => h.mutations.createCustomSkill.mutateAsync.mock.calls.length > 0);
    expect(h.mutations.createCustomSkill.mutateAsync.mock.calls[0]?.[0]).toEqual({
      profileId: 'profile-1',
      name: 'my-skill',
      rawMarkdown: 'Body',
    });
    await waitFor(() => findAll(renderer.root, 'SheetHeader').length === 0);

    unmount();
  });

  it('happy: frontmatter in the content prefills the name field', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();
    pressEmptyAction(renderer);
    changeText(
      renderer.root,
      'Skill content',
      ['---', 'name: pasted-skill', '---', 'Body'].join('\n')
    );

    expect(findField(renderer.root, 'Skill name').props.defaultValue).toBe('pasted-skill');

    unmount();
  });

  it('non-retryable: an empty name is refused and nothing persists', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();
    pressEmptyAction(renderer);
    pressSheetDone(renderer.root);

    expect(h.mutations.createCustomSkill.mutateAsync).not.toHaveBeenCalled();
    expect(findField(renderer.root, 'Skill name').props.error).toBe('Enter a skill name');
    expect(findOne(renderer.root, 'SheetHeader')).toBeTruthy();

    unmount();
  });

  it('retryable: a failure with no message toasts the fallback and keeps the sheet', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;
    const error = new Error('placeholder');
    error.message = '';
    h.mutations.createCustomSkill.mutateAsync.mockRejectedValue(error);

    const { renderer, unmount } = await mountScreen();
    pressEmptyAction(renderer);
    changeText(renderer.root, 'Skill name', 'my-skill');
    changeText(renderer.root, 'Skill content', 'Body');
    pressSheetDone(renderer.root);

    await waitFor(() => h.error.mock.calls.length > 0);
    expect(h.error).toHaveBeenCalledWith("Couldn't save skill");
    expect(findOne(renderer.root, 'SheetHeader')).toBeTruthy();

    unmount();
  });

  it('happy: confirming delete calls deleteSkill', async () => {
    h.query.data = testProfile([testSkill()]);
    h.query.isPending = false;
    h.mutations.deleteSkill.mutateAsync.mockResolvedValue({ success: true });

    const { renderer, unmount } = await mountScreen();
    pressPressable(renderer.root, 'Delete');
    await act(async () => {
      confirmAlert(h.alert as TestAlertMock);
      await Promise.resolve();
    });

    await waitFor(() => h.mutations.deleteSkill.mutateAsync.mock.calls.length > 0);
    expect(h.mutations.deleteSkill.mutateAsync.mock.calls[0]?.[0]).toEqual({
      profileId: 'profile-1',
      skillId: 'skill-1',
    });

    unmount();
  });

  it('keeps the rows while a refetch is in flight', async () => {
    h.query.data = testProfile([testSkill()]);
    h.query.isPending = false;

    const { renderer, queryClient, unmount } = await mountScreen();

    h.query.isRefetching = true;
    await act(async () => {
      rerenderScreen(renderer, queryClient);
      await Promise.resolve();
    });

    expect(findOne(renderer.root, 'Switch').props.accessibilityLabel).toBe('code-review');

    unmount();
  });
});
