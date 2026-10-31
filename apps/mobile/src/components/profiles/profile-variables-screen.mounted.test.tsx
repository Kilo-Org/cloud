/* eslint-disable max-lines -- one mounted harness pins the form, secret-masking, delete flows, and the inline refusals for the variables screen */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import {
  changeText,
  confirmRequest,
  findAll,
  findField,
  findOne,
  findPressable,
  mountScreen,
  pressButton,
  pressPressable,
  rerenderScreen,
  type TestConfirmMock,
  testVars,
  type TestVars,
} from '@/components/profiles/profile-variables-screen.test-helpers';
import { act } from '@/test/renderer';
import { waitFor } from '@/test/render-with-providers';

const h = vi.hoisted(() => ({
  confirm: vi.fn(),
  error: vi.fn(),
  canManage: true,
  query: {
    data: undefined as TestVars | undefined,
    isError: false,
    isPending: true,
    isRefetching: false,
    refetch: vi.fn(),
  },
  mutations: {
    setVar: { mutateAsync: vi.fn(), isPending: false },
    deleteVar: { mutateAsync: vi.fn(), isPending: false },
  },
}));

vi.mock('@/lib/hooks/use-can-manage-profiles', () => ({
  useCanManageOrganizationProfiles: () => h.canManage,
}));

vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfileVars: () => h.query,
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
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    mutedForeground: '#000000',
    secondaryForeground: '#000000',
    destructive: '#FF0000',
  }),
}));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: h.confirm, dialog: null }),
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  Eye: 'Eye',
  EyeOff: 'EyeOff',
  KeyRound: 'KeyRound',
  Lock: 'Lock',
  Trash2: 'Trash2',
}));

/** Press the add CTA the empty state renders through its `action` prop. */
function pressEmptyAction(renderer: Awaited<ReturnType<typeof mountScreen>>['renderer']): void {
  const action = findOne(renderer.root, 'EmptyState').props.action as {
    props: { onPress: () => void };
  };
  act(() => {
    action.props.onPress();
  });
}

describe('ProfileVariablesScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.canManage = true;
    Object.assign(h.query, {
      data: undefined,
      isError: false,
      isPending: true,
      isRefetching: false,
    });
    Object.assign(h.mutations.setVar, { isPending: false });
    Object.assign(h.mutations.deleteVar, { isPending: false });
  });

  it('loading: renders skeletons and no rows', async () => {
    const { renderer, unmount } = await mountScreen();

    expect(findAll(renderer.root, 'Skeleton').length).toBeGreaterThan(0);
    expect(findAll(renderer.root, 'FormField')).toHaveLength(0);

    unmount();
  });

  it('error: renders QueryError and Retry refetches', async () => {
    Object.assign(h.query, { isError: true, isPending: false });

    const { renderer, unmount } = await mountScreen();

    const queryError = findOne(renderer.root, 'QueryError');
    act(() => {
      (queryError.props as { onRetry: () => void }).onRetry();
    });
    expect(h.query.refetch).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('empty: shows variablesEmpty and the add CTA opens the form', async () => {
    h.query.data = testVars();
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();

    expect(findOne(renderer.root, 'EmptyState').props.title).toBe('No variables yet');
    pressEmptyAction(renderer);
    expect(findField(renderer.root, 'Key')).toBeTruthy();

    unmount();
  });

  it('happy: an added variable is saved with a cleaned key and shown', async () => {
    h.query.data = testVars();
    h.query.isPending = false;
    h.mutations.setVar.mutateAsync.mockResolvedValue({ success: true });

    const { renderer, unmount } = await mountScreen();
    pressEmptyAction(renderer);
    changeText(renderer.root, 'Key', 'api key');
    changeText(renderer.root, 'Value', 'shh');
    pressButton(renderer.root, 'Save');

    await waitFor(() => h.mutations.setVar.mutateAsync.mock.calls.length > 0);
    expect(h.mutations.setVar.mutateAsync.mock.calls[0]?.[0]).toEqual({
      profileId: 'profile-1',
      key: 'API_KEY',
      value: 'shh',
      isSecret: false,
    });
    await waitFor(() =>
      findAll(renderer.root, 'Pressable').some(node => node.props.accessibilityLabel === 'API_KEY')
    );

    unmount();
  });

  it('reaches a screen reader as the mark-secret switch alone, without a duplicate label stop', async () => {
    h.query.data = testVars();
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();
    pressEmptyAction(renderer);

    const label = i18n.t('profiles.secrets.markSecret');
    const labels = findAll(renderer.root, 'Text').filter(node => node.props.children === label);
    expect(labels).toHaveLength(1);
    expect(labels[0]?.props).toMatchObject({
      accessible: false,
      importantForAccessibility: 'no',
    });
    expect(findAll(renderer.root, 'Switch').map(node => node.props.accessibilityLabel)).toEqual([
      label,
    ]);

    unmount();
  });

  it('names the key it will store when a typed key would be normalized', async () => {
    h.query.data = testVars();
    h.query.isPending = false;
    h.mutations.setVar.mutateAsync.mockResolvedValue({ success: true });

    const { renderer, unmount } = await mountScreen();
    pressEmptyAction(renderer);
    changeText(renderer.root, 'Key', 'API_की');
    changeText(renderer.root, 'Value', 'https://api.example.com/v1');

    // The two Devanagari characters become underscores in the stored key, so the
    // form says so before the reader taps Save.
    expect(findAll(renderer.root, 'Text').map(node => node.props.children)).toContain(
      'Will be saved as API___'
    );

    pressButton(renderer.root, 'Save');

    await waitFor(() => h.mutations.setVar.mutateAsync.mock.calls.length > 0);
    // The hint and the payload cannot disagree: both come from the same helper.
    expect(h.mutations.setVar.mutateAsync.mock.calls[0]?.[0]).toEqual({
      profileId: 'profile-1',
      key: 'API___',
      value: 'https://api.example.com/v1',
      isSecret: false,
    });

    unmount();
  });

  it('stays quiet about a key that saves unchanged', async () => {
    h.query.data = testVars();
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();
    pressEmptyAction(renderer);
    changeText(renderer.root, 'Key', 'API_KEY');

    const texts = findAll(renderer.root, 'Text').map(node => node.props.children);
    expect(texts).not.toContain('Will be saved as API_KEY');

    unmount();
  });

  it('names the upper-cased key when only the letter case would change', async () => {
    h.query.data = testVars();
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();
    pressEmptyAction(renderer);
    changeText(renderer.root, 'Key', 'api_key');

    expect(findAll(renderer.root, 'Text').map(node => node.props.children)).toContain(
      'Will be saved as API_KEY'
    );

    unmount();
  });

  it('non-retryable: an empty key is refused, and an over-long key names the length', async () => {
    h.query.data = testVars();
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();
    pressEmptyAction(renderer);
    pressButton(renderer.root, 'Save');

    expect(h.mutations.setVar.mutateAsync).not.toHaveBeenCalled();
    expect(findField(renderer.root, 'Key').props.error).toBe('required');

    changeText(renderer.root, 'Key', 'a'.repeat(257));
    pressButton(renderer.root, 'Save');

    expect(h.mutations.setVar.mutateAsync).not.toHaveBeenCalled();
    expect(findField(renderer.root, 'Key').props.error).toBe('Key must be 256 characters or fewer');

    unmount();
  });

  it('non-retryable: a new key that cleans onto an existing one is refused', async () => {
    h.query.data = testVars([{ key: 'FOO_BAR', value: '1', isSecret: false }]);
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();
    pressButton(renderer.root, 'Add variable');
    changeText(renderer.root, 'Key', 'foo-bar');
    changeText(renderer.root, 'Value', '2');
    pressButton(renderer.root, 'Save');

    // The server upserts on (profile_id, key), so `foo-bar` would silently
    // replace `FOO_BAR`; the form refuses it instead of calling setVar.
    expect(h.mutations.setVar.mutateAsync).not.toHaveBeenCalled();
    expect(findField(renderer.root, 'Key').props.error).toBe(
      'This key already exists in the profile'
    );

    unmount();
  });

  it('non-retryable: clearing an existing value shows the required message instead of doing nothing', async () => {
    h.query.data = testVars([{ key: 'API_KEY', value: '1', isSecret: false }]);
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();
    pressPressable(renderer.root, 'API_KEY');
    changeText(renderer.root, 'Value', '');
    pressButton(renderer.root, 'Save');

    expect(h.mutations.setVar.mutateAsync).not.toHaveBeenCalled();
    expect(findField(renderer.root, 'Value').props.error).toBe('Enter a value');

    // Typing a value clears the message without another save attempt.
    changeText(renderer.root, 'Value', '2');
    expect(findField(renderer.root, 'Value').props.error).toBeUndefined();

    unmount();
  });

  it('non-retryable: a new variable needs a value', async () => {
    h.query.data = testVars();
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();
    pressEmptyAction(renderer);
    changeText(renderer.root, 'Key', 'API_KEY');
    pressButton(renderer.root, 'Save');

    expect(h.mutations.setVar.mutateAsync).not.toHaveBeenCalled();
    expect(findField(renderer.root, 'Value').props.error).toBe('Enter a value');
    expect(findField(renderer.root, 'Key').props.error).toBeUndefined();

    unmount();
  });

  it('retryable: a failure with no message toasts the fallback and keeps the form', async () => {
    h.query.data = testVars();
    h.query.isPending = false;
    const error = new Error('placeholder');
    error.message = '';
    h.mutations.setVar.mutateAsync.mockRejectedValue(error);

    const { renderer, unmount } = await mountScreen();
    pressEmptyAction(renderer);
    changeText(renderer.root, 'Key', 'API_KEY');
    changeText(renderer.root, 'Value', 'shh');
    pressButton(renderer.root, 'Save');

    await waitFor(() => h.error.mock.calls.length > 0);
    expect(h.error).toHaveBeenCalledWith("Couldn't save variable");
    expect(findField(renderer.root, 'Key')).toBeTruthy();

    unmount();
  });

  it('happy: tapping a row edits its value under the same key', async () => {
    h.query.data = testVars([{ key: 'API_KEY', value: '1', isSecret: false }]);
    h.query.isPending = false;
    h.mutations.setVar.mutateAsync.mockResolvedValue({ success: true });

    const { renderer, unmount } = await mountScreen();
    pressPressable(renderer.root, 'API_KEY');

    const keyField = findField(renderer.root, 'Key');
    expect(keyField.props.disabled).toBe(true);
    expect(keyField.props.defaultValue).toBe('API_KEY');
    // A non-secret edit keeps the plain Value placeholder.
    expect(findField(renderer.root, 'Value').props.placeholder).toBe('Value');

    changeText(renderer.root, 'Value', '2');
    pressButton(renderer.root, 'Save');

    await waitFor(() => h.mutations.setVar.mutateAsync.mock.calls.length > 0);
    expect(h.mutations.setVar.mutateAsync.mock.calls[0]?.[0]).toEqual({
      profileId: 'profile-1',
      key: 'API_KEY',
      value: '2',
      isSecret: false,
    });

    unmount();
  });

  it('happy: a secret row masks its value and never echoes the stored value', async () => {
    h.query.data = testVars([{ key: 'TOKEN', value: '***', isSecret: true }]);
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();

    expect(findAll(renderer.root, 'Text').some(node => node.props.children === '••••••••')).toBe(
      true
    );
    expect(findAll(renderer.root, 'Text').some(node => node.props.children === '***')).toBe(false);

    unmount();
  });

  it('happy: a secret value can be revealed only while editing', async () => {
    h.query.data = testVars([{ key: 'TOKEN', value: '***', isSecret: true }]);
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();

    // The row offers no reveal control.
    expect(
      findAll(renderer.root, 'Pressable').some(
        node => node.props.accessibilityLabel === 'Reveal value'
      )
    ).toBe(false);

    pressPressable(renderer.root, 'TOKEN');
    const valueField = findField(renderer.root, 'Value');
    expect(valueField.props.secureTextEntry).toBe(true);
    // A stored secret is never seeded into the edit field.
    expect(valueField.props.defaultValue).toBe('');
    // The empty field says what the user must do: type a new value to rotate.
    expect(valueField.props.placeholder).toBe('Enter new secret value');

    pressPressable(renderer.root, 'Reveal value');
    expect(findField(renderer.root, 'Value').props.secureTextEntry).toBe(false);

    unmount();
  });

  it('names each row delete control after the variable it removes', async () => {
    h.query.data = testVars([
      { key: 'API_KEY', value: '1', isSecret: false },
      { key: 'STRIPE_SECRET_KEY', value: '****', isSecret: true },
    ]);
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();

    const deleteLabels = findAll(renderer.root, 'Pressable')
      .map(node => node.props.accessibilityLabel as string)
      .filter(label => label.startsWith('Delete'));
    expect(deleteLabels).toEqual(['Delete variable API_KEY', 'Delete variable STRIPE_SECRET_KEY']);

    unmount();
  });

  it('read-only: rows render without edit or delete controls', async () => {
    h.canManage = false;
    h.query.data = testVars([{ key: 'API_KEY', value: '1', isSecret: false }]);
    h.query.isPending = false;
    const { renderer, unmount } = await mountScreen();
    const rowActions = findAll(renderer.root, 'Pressable').filter(node =>
      String(node.props.accessibilityLabel).startsWith('Delete variable')
    );
    expect(rowActions).toHaveLength(0);
    unmount();
  });

  it('happy: confirming delete calls deleteVar and drops the row', async () => {
    h.query.data = testVars([{ key: 'API_KEY', value: '1', isSecret: false }]);
    h.query.isPending = false;
    h.mutations.deleteVar.mutateAsync.mockResolvedValue({ success: true });
    const { renderer, unmount } = await mountScreen();
    pressPressable(renderer.root, 'Delete variable API_KEY');
    await act(async () => {
      confirmRequest(h.confirm as TestConfirmMock);
      await Promise.resolve();
    });

    await waitFor(() => h.mutations.deleteVar.mutateAsync.mock.calls.length > 0);
    expect(h.mutations.deleteVar.mutateAsync.mock.calls[0]?.[0]).toEqual({
      profileId: 'profile-1',
      key: 'API_KEY',
    });
    await waitFor(() => findAll(renderer.root, 'Pressable').length === 0);

    unmount();
  });

  it('keeps the row and shows a delete-specific fallback for an unreadable error', async () => {
    h.query.data = testVars([{ key: 'API_KEY', value: '1', isSecret: false }]);
    h.query.isPending = false;
    h.mutations.deleteVar.mutateAsync.mockRejectedValueOnce(undefined);

    const { renderer, unmount } = await mountScreen();
    pressPressable(renderer.root, 'Delete variable API_KEY');
    await act(async () => {
      confirmRequest(h.confirm as TestConfirmMock);
      await Promise.resolve();
    });

    expect(h.mutations.deleteVar.mutateAsync).toHaveBeenCalledWith({
      profileId: 'profile-1',
      key: 'API_KEY',
    });
    expect(findPressable(renderer.root, 'API_KEY')).toBeDefined();
    expect(h.error).toHaveBeenCalledExactlyOnceWith("Couldn't delete variable");
    unmount();
  });

  it('keeps the row without duplicating the mutation toast for a readable delete error', async () => {
    h.query.data = testVars([{ key: 'API_KEY', value: '1', isSecret: false }]);
    h.query.isPending = false;
    h.mutations.deleteVar.mutateAsync.mockRejectedValueOnce(new Error('Permission denied'));

    const { renderer, unmount } = await mountScreen();
    pressPressable(renderer.root, 'Delete variable API_KEY');
    await act(async () => {
      confirmRequest(h.confirm as TestConfirmMock);
      await Promise.resolve();
    });

    expect(h.mutations.deleteVar.mutateAsync).toHaveBeenCalledOnce();
    expect(findPressable(renderer.root, 'API_KEY')).toBeDefined();
    expect(h.error).not.toHaveBeenCalled();
    unmount();
  });

  it('disables delete and refuses another confirmation while deletion is pending', async () => {
    h.query.data = testVars([{ key: 'API_KEY', value: '1', isSecret: false }]);
    h.query.isPending = false;
    const { renderer, queryClient, unmount } = await mountScreen();
    h.mutations.deleteVar.isPending = true;
    act(() => {
      rerenderScreen(renderer, queryClient);
    });
    expect(findPressable(renderer.root, 'Delete variable API_KEY').props.disabled).toBe(true);
    pressPressable(renderer.root, 'Delete variable API_KEY');
    expect(h.confirm).not.toHaveBeenCalled();
    h.mutations.deleteVar.isPending = false;
    act(() => {
      rerenderScreen(renderer, queryClient);
    });
    expect(findPressable(renderer.root, 'Delete variable API_KEY').props.disabled).toBe(false);
    pressPressable(renderer.root, 'Delete variable API_KEY');
    expect(h.confirm).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('keeps the rows while a refetch is in flight', async () => {
    h.query.data = testVars([{ key: 'API_KEY', value: '1', isSecret: false }]);
    h.query.isPending = false;
    const { renderer, queryClient, unmount } = await mountScreen();

    h.query.isRefetching = true;
    await act(async () => {
      rerenderScreen(renderer, queryClient);
      await Promise.resolve();
    });

    expect(findPressable(renderer.root, 'API_KEY')).toBeTruthy();

    unmount();
  });
});
