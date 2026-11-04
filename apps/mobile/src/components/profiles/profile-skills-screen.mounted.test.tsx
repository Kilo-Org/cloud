/* eslint-disable max-lines -- one mounted case per skills screen state: loading, error, empty, rows, edit, add, validation, refused saves, and delete */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  changeText,
  confirmRequest,
  findAll,
  findField,
  findOne,
  mountScreen,
  pressAddButton,
  pressEmptyAction,
  pressPressable,
  pressSheetCancel,
  pressSheetDone,
  rerenderScreen,
  type TestConfirmMock,
  testSkill,
  testSkills,
} from '@/components/profiles/profile-skills-screen.test-helpers';
import { i18n } from '@/i18n';
import { MAX_PROFILE_SKILLS, SKILL_NAME_MAX_LENGTH } from '@/lib/agent-profile-forms';
import { act, type ReactTestInstance } from '@/test/renderer';
import { waitFor } from '@/test/render-with-providers';
import { resetFormDraftsForTests } from '@/lib/form-draft';

/** The props a mocked Switch host element exposes, which the renderer keeps untyped. */
type ToggleProps = { onValueChange: (value: boolean) => void };

/** The rendered text node whose content is exactly `copy`. */
function lineWith(root: ReactTestInstance, copy: string): ReactTestInstance {
  const node = findAll(root, 'Text').find(candidate => candidate.props.children === copy);
  if (!node) {
    throw new Error(`no line renders ${copy}`);
  }
  return node;
}

const h = vi.hoisted(() => ({
  confirm: vi.fn(),
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

const permissionState = vi.hoisted(() => ({ canManage: true }));

vi.mock('@/lib/hooks/use-can-manage-profiles', () => ({
  useCanManageOrganizationProfiles: () => permissionState.canManage,
}));

vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfileSkills: () => h.query,
  useAgentProfileOverview: () => ({ data: { name: 'Team profile' } }),
  useAgentProfileMutations: () => h.mutations,
}));
vi.mock('sonner-native', () => ({ toast: { error: h.error } }));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  useColorScheme: () => 'light',
  View: 'View',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  Switch: 'Switch',
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
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: h.confirm, dialog: null }),
}));
vi.mock('@/components/agents/session-page-sheet', () => ({
  SessionPageSheet: 'SessionPageSheet',
}));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
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
    resetFormDraftsForTests();
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
    h.query.data = testSkills();
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();

    expect(findOne(renderer.root, 'EmptyState').props.title).toBe('No skills yet');
    pressEmptyAction(renderer);
    expect(findOne(renderer.root, 'SheetHeader')).toBeTruthy();

    unmount();
  });

  it('happy: a row shows the name and source type; the switch toggles', async () => {
    h.query.data = testSkills([testSkill()]);
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();

    const texts = findAll(renderer.root, 'Text').map(node => node.props.children);
    expect(texts).toContain('code-review');
    expect(texts).toContain('Custom');

    const toggle = findOne(renderer.root, 'Switch');
    expect(toggle.props.accessibilityLabel).toBe('code-review');
    expect(toggle.props.value).toBe(true);
    // The visible name is painted only, so the switch is the row's single stop
    // that speaks it.
    expect(lineWith(renderer.root, 'code-review').props).toMatchObject({
      accessible: false,
      importantForAccessibility: 'no',
    });
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

  it('hides the edit control for skills.sh references but keeps the toggle and delete', async () => {
    h.query.data = testSkills([testSkill({ sourceType: 'skills-sh', rawMarkdown: '' })]);
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();

    const pressableLabels = findAll(renderer.root, 'Pressable').map(
      node => node.props.accessibilityLabel
    );
    expect(pressableLabels).not.toContain('Edit skill code-review');
    expect(pressableLabels).toContain('Delete skill code-review');
    expect(findOne(renderer.root, 'Switch').props.accessibilityLabel).toBe('code-review');
    const texts = findAll(renderer.root, 'Text').map(node => node.props.children);
    expect(texts).toContain('skills.sh');
    expect(texts).not.toContain('skills-sh');

    unmount();
  });

  it('happy: the edit control opens the sheet seeded with the skill', async () => {
    h.query.data = testSkills([testSkill()]);
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();
    pressPressable(renderer.root, 'Edit skill code-review');

    expect(findField(renderer.root, 'Skill name').props.defaultValue).toBe('code-review');
    expect(findField(renderer.root, 'Skill content').props.defaultValue).toBe('Body');

    unmount();
  });

  it('clears the stored description when frontmatter description is removed', async () => {
    h.query.data = testSkills([
      testSkill({
        rawMarkdown: '---\nname: code-review\ndescription: Old description\n---\nBody',
      }),
    ]);
    h.query.isPending = false;
    h.mutations.updateSkill.mutateAsync.mockResolvedValue({ success: true });
    const { renderer, unmount } = await mountScreen();
    pressPressable(renderer.root, 'Edit skill code-review');
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
    h.query.data = testSkills();
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
    h.query.data = testSkills();
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
    h.query.data = testSkills();
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();
    pressEmptyAction(renderer);
    pressSheetDone(renderer.root);

    expect(h.mutations.createCustomSkill.mutateAsync).not.toHaveBeenCalled();
    expect(findField(renderer.root, 'Skill name').props.error).toBe('Enter a skill name');
    expect(findOne(renderer.root, 'SheetHeader')).toBeTruthy();

    unmount();
  });

  it('non-retryable: a name over the server length bound is refused under the field', async () => {
    h.query.data = testSkills();
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();
    pressEmptyAction(renderer);
    changeText(renderer.root, 'Skill name', 'a'.repeat(120));
    changeText(renderer.root, 'Skill content', 'Body');
    pressSheetDone(renderer.root);

    expect(h.mutations.createCustomSkill.mutateAsync).not.toHaveBeenCalled();
    expect(findField(renderer.root, 'Skill name').props.error).toBe(
      i18n.t('profiles.skillNameTooLong', { max: SKILL_NAME_MAX_LENGTH })
    );
    expect(findOne(renderer.root, 'SheetHeader')).toBeTruthy();

    unmount();
  });

  it('happy: a name at the length bound saves', async () => {
    h.query.data = testSkills();
    h.query.isPending = false;
    h.mutations.createCustomSkill.mutateAsync.mockResolvedValue({ id: 'skill-2' });

    const { renderer, unmount } = await mountScreen();
    pressEmptyAction(renderer);
    changeText(renderer.root, 'Skill name', 'a'.repeat(SKILL_NAME_MAX_LENGTH));
    changeText(renderer.root, 'Skill content', 'Body');
    pressSheetDone(renderer.root);

    await waitFor(() => h.mutations.createCustomSkill.mutateAsync.mock.calls.length > 0);
    expect(h.mutations.createCustomSkill.mutateAsync.mock.calls[0]?.[0]).toMatchObject({
      name: 'a'.repeat(SKILL_NAME_MAX_LENGTH),
    });

    unmount();
  });

  it('refuses a create at the skill cap inside the sheet, without a request', async () => {
    h.query.data = testSkills(
      Array.from({ length: MAX_PROFILE_SKILLS }, (_, index) =>
        testSkill({ id: `skill-${index}`, name: `skill-${index}` })
      )
    );
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();
    const limitCopy = i18n.t('profiles.skillLimitReached', { max: MAX_PROFILE_SKILLS });

    // The list names the cap under the add control, before any authoring.
    expect(String(lineWith(renderer.root, limitCopy).props.className)).toContain('text-warn');

    pressAddButton(renderer.root);
    changeText(renderer.root, 'Skill name', 'one-more');
    changeText(renderer.root, 'Skill content', 'Body');
    pressSheetDone(renderer.root);

    expect(h.mutations.createCustomSkill.mutateAsync).not.toHaveBeenCalled();
    expect(findAll(renderer.root, 'Text').map(node => node.props.children)).toContain(
      i18n.t('profiles.skillLimitReached', { max: MAX_PROFILE_SKILLS })
    );
    expect(findOne(renderer.root, 'SheetHeader')).toBeTruthy();
    expect(findField(renderer.root, 'Skill name').props.disabled).toBe(false);

    unmount();
  });

  it('names the cap when the server refuses a create the list did not predict', async () => {
    h.query.data = testSkills([testSkill()]);
    h.query.isPending = false;
    h.mutations.createCustomSkill.mutateAsync.mockRejectedValue(
      Object.assign(new Error(`Profiles are limited to ${MAX_PROFILE_SKILLS} skills`), {
        data: { code: 'PRECONDITION_FAILED' },
      })
    );

    const { renderer, unmount } = await mountScreen();
    pressAddButton(renderer.root);
    changeText(renderer.root, 'Skill name', 'one-more');
    changeText(renderer.root, 'Skill content', 'Body');
    pressSheetDone(renderer.root);

    await waitFor(() => h.mutations.createCustomSkill.mutateAsync.mock.calls.length > 0);
    await waitFor(() =>
      findAll(renderer.root, 'Text').some(
        node =>
          node.props.children === i18n.t('profiles.skillLimitReached', { max: MAX_PROFILE_SKILLS })
      )
    );
    expect(findOne(renderer.root, 'SheetHeader')).toBeTruthy();

    unmount();
  });

  it('shows any other refused save as one line inside the open sheet', async () => {
    h.query.data = testSkills();
    h.query.isPending = false;
    h.mutations.createCustomSkill.mutateAsync.mockRejectedValue(new Error('Internal server error'));

    const { renderer, unmount } = await mountScreen();
    pressEmptyAction(renderer);
    changeText(renderer.root, 'Skill name', 'my-skill');
    changeText(renderer.root, 'Skill content', 'Body');
    pressSheetDone(renderer.root);

    await waitFor(() =>
      findAll(renderer.root, 'Text').some(
        node => node.props.children === i18n.t('profiles.skillSaveFailed')
      )
    );
    expect(
      String(lineWith(renderer.root, i18n.t('profiles.skillSaveFailed')).props.className)
    ).toContain('text-destructive');
    expect(findOne(renderer.root, 'SheetHeader')).toBeTruthy();

    unmount();
  });

  it('keeps the generic line for a refused update, which the cap cannot explain', async () => {
    h.query.data = testSkills([testSkill()]);
    h.query.isPending = false;
    h.mutations.updateSkill.mutateAsync.mockRejectedValue(
      Object.assign(
        new Error('Skills.sh references cannot be modified; delete and re-add the skill instead'),
        { data: { code: 'PRECONDITION_FAILED' } }
      )
    );

    const { renderer, unmount } = await mountScreen();
    pressPressable(renderer.root, 'Edit skill code-review');
    changeText(renderer.root, 'Skill content', '---\nname: code-review\n---\nNew body');
    pressSheetDone(renderer.root);

    await waitFor(() =>
      findAll(renderer.root, 'Text').some(
        node => node.props.children === i18n.t('profiles.skillSaveFailed')
      )
    );
    expect(findAll(renderer.root, 'Text').map(node => node.props.children)).not.toContain(
      i18n.t('profiles.skillLimitReached', { max: MAX_PROFILE_SKILLS })
    );

    unmount();
  });

  it('drops a refused-save message when the next form is opened', async () => {
    h.query.data = testSkills();
    h.query.isPending = false;
    h.mutations.createCustomSkill.mutateAsync.mockRejectedValueOnce(new Error('refused'));

    const { renderer, unmount } = await mountScreen();
    pressEmptyAction(renderer);
    changeText(renderer.root, 'Skill name', 'first-skill');
    changeText(renderer.root, 'Skill content', 'Body');
    pressSheetDone(renderer.root);
    await waitFor(() =>
      findAll(renderer.root, 'Text').some(
        node => node.props.children === i18n.t('profiles.skillSaveFailed')
      )
    );

    // The message describes the attempt that failed; a form opened afterwards
    // is a new attempt and must not open under the old refusal.
    pressSheetCancel(renderer.root);
    await act(async () => {
      confirmRequest(h.confirm as TestConfirmMock);
      await Promise.resolve();
    });
    pressEmptyAction(renderer);

    expect(findAll(renderer.root, 'Text').map(node => node.props.children)).not.toContain(
      i18n.t('profiles.skillSaveFailed')
    );
    unmount();
  });

  it('drops a save that settles after its sheet was replaced', async () => {
    h.query.data = testSkills();
    h.query.isPending = false;
    const pendingSave = Promise.withResolvers<unknown>();
    h.mutations.createCustomSkill.mutateAsync.mockImplementation(() => pendingSave.promise);

    const { renderer, unmount } = await mountScreen();
    pressEmptyAction(renderer);
    changeText(renderer.root, 'Skill name', 'slow-skill');
    changeText(renderer.root, 'Skill content', 'Body');
    pressSheetDone(renderer.root);
    expect(h.mutations.createCustomSkill.mutateAsync).toHaveBeenCalledTimes(1);

    pressSheetCancel(renderer.root);
    await act(async () => {
      confirmRequest(h.confirm as TestConfirmMock);
      await Promise.resolve();
    });
    pressEmptyAction(renderer);

    await act(async () => {
      pendingSave.reject(new Error('late failure'));
      await Promise.resolve();
    });

    expect(findAll(renderer.root, 'Text').map(node => node.props.children)).not.toContain(
      i18n.t('profiles.skillSaveFailed')
    );
    expect(findOne(renderer.root, 'SheetHeader')).toBeTruthy();

    unmount();
  });

  it('does not close the form opened after a save whose own form was replaced', async () => {
    h.query.data = testSkills();
    h.query.isPending = false;
    const pendingSave = Promise.withResolvers<{ id: string }>();
    h.mutations.createCustomSkill.mutateAsync.mockImplementation(() => pendingSave.promise);

    const { renderer, unmount } = await mountScreen();
    pressEmptyAction(renderer);
    changeText(renderer.root, 'Skill name', 'slow-skill');
    changeText(renderer.root, 'Skill content', 'Body');
    pressSheetDone(renderer.root);

    pressSheetCancel(renderer.root);
    await act(async () => {
      confirmRequest(h.confirm as TestConfirmMock);
      await Promise.resolve();
    });
    pressEmptyAction(renderer);

    await act(async () => {
      pendingSave.resolve({ id: 'skill-2' });
      await Promise.resolve();
    });

    expect(findOne(renderer.root, 'SheetHeader')).toBeTruthy();

    unmount();
  });

  it('names the delete action when a delete fails without a message', async () => {
    h.query.data = testSkills([testSkill()]);
    h.query.isPending = false;
    const error = new Error('placeholder');
    error.message = '';
    h.mutations.deleteSkill.mutateAsync.mockRejectedValue(error);

    const { renderer, unmount } = await mountScreen();
    pressPressable(renderer.root, 'Delete skill code-review');
    await act(async () => {
      confirmRequest(h.confirm as TestConfirmMock);
      await Promise.resolve();
    });

    await waitFor(() => h.error.mock.calls.length > 0);
    expect(h.error).toHaveBeenCalledWith(i18n.t('profiles.skillDeleteFailed'));

    unmount();
  });

  it('names the toggle action when enabling a skill fails without a message', async () => {
    h.query.data = testSkills([testSkill()]);
    h.query.isPending = false;
    const error = new Error('placeholder');
    error.message = '';
    h.mutations.setSkillEnabled.mutate.mockImplementation(
      (_variables: unknown, options?: { onError?: (failure: Error) => void }) => {
        options?.onError?.(error);
      }
    );

    const { renderer, unmount } = await mountScreen();
    const toggle = findOne(renderer.root, 'Switch');
    act(() => {
      (toggle.props as { onValueChange: (value: boolean) => void }).onValueChange(false);
    });

    expect(h.error).toHaveBeenCalledWith(i18n.t('profiles.skillToggleFailed'));

    unmount();
  });

  it('happy: confirming delete calls deleteSkill', async () => {
    h.query.data = testSkills([testSkill()]);
    h.query.isPending = false;
    h.mutations.deleteSkill.mutateAsync.mockResolvedValue({ success: true });

    const { renderer, unmount } = await mountScreen();
    pressPressable(renderer.root, 'Delete skill code-review');
    await act(async () => {
      confirmRequest(h.confirm as TestConfirmMock);
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
    h.query.data = testSkills([testSkill()]);
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
  it('reopens the add sheet with its typed fields after a remount', async () => {
    h.query.data = testSkills();
    h.query.isPending = false;

    const first = await mountScreen();
    pressEmptyAction(first.renderer);
    changeText(first.renderer.root, 'Skill name', 'portal-skill');
    changeText(first.renderer.root, 'Skill content', 'Use the portal carefully.');
    first.unmount();

    const second = await mountScreen();
    expect(findOne(second.renderer.root, 'SheetHeader')).toBeTruthy();
    expect(findField(second.renderer.root, 'Skill name').props.defaultValue).toBe('portal-skill');
    expect(findField(second.renderer.root, 'Skill content').props.defaultValue).toBe(
      'Use the portal carefully.'
    );
    second.unmount();
  });

  it('drops the row presses of the burst that saved the sheet', async () => {
    h.query.data = testSkills([testSkill()]);
    h.query.isPending = false;
    h.mutations.updateSkill.mutateAsync.mockResolvedValue({ success: true });

    const { renderer, unmount } = await mountScreen();
    pressPressable(renderer.root, 'Edit skill code-review');
    pressSheetDone(renderer.root);
    await waitFor(() => findAll(renderer.root, 'SheetHeader').length === 0);

    // The second tap of the double tap lands on the row the sheet covered.
    pressPressable(renderer.root, 'Delete skill code-review');
    pressPressable(renderer.root, 'Edit skill code-review');
    // The test renderer exposes host props untyped; the screen passes this handler.
    const toggleProps = findOne(renderer.root, 'Switch').props as ToggleProps;
    act(() => {
      toggleProps.onValueChange(false);
    });

    expect(h.confirm).not.toHaveBeenCalled();
    expect(findAll(renderer.root, 'SheetHeader')).toHaveLength(0);
    expect(h.mutations.setSkillEnabled.mutate).not.toHaveBeenCalled();

    unmount();
  });

  it('accepts the same row presses once the guard window has passed', async () => {
    h.query.data = testSkills([testSkill()]);
    h.query.isPending = false;
    h.mutations.updateSkill.mutateAsync.mockResolvedValue({ success: true });

    const { renderer, unmount } = await mountScreen();
    pressPressable(renderer.root, 'Edit skill code-review');
    pressSheetDone(renderer.root);
    await waitFor(() => findAll(renderer.root, 'SheetHeader').length === 0);

    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);
    try {
      pressPressable(renderer.root, 'Delete skill code-review');
    } finally {
      now.mockRestore();
    }

    expect(h.confirm).toHaveBeenCalledTimes(1);

    unmount();
  });
});
