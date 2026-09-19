import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import {
  changeText,
  confirmAlert,
  findAll,
  findField,
  findOne,
  findPressable,
  mountScreen,
  pressButton,
  pressPressable,
  rerenderScreen,
  type TestAlertMock,
  testProfile,
  type TestProfileDetail,
} from '@/components/profiles/profile-variables-screen.test-helpers';
import { act } from '@/test/renderer';
import { waitFor } from '@/test/render-with-providers';

const h = vi.hoisted(() => ({
  alert: vi.fn(),
  error: vi.fn(),
  query: {
    data: undefined as TestProfileDetail | undefined,
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
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    mutedForeground: '#000000',
    secondaryForeground: '#000000',
    destructive: '#FF0000',
  }),
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
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
    h.query.data = testProfile();
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();

    expect(findOne(renderer.root, 'EmptyState').props.title).toBe('No variables yet');
    pressEmptyAction(renderer);
    expect(findField(renderer.root, 'Key')).toBeTruthy();

    unmount();
  });

  it('happy: an added variable is saved with a cleaned key and shown', async () => {
    h.query.data = testProfile();
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

  it('non-retryable: an empty key is refused before the call', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();
    pressEmptyAction(renderer);
    pressButton(renderer.root, 'Save');

    expect(h.mutations.setVar.mutateAsync).not.toHaveBeenCalled();
    expect(findField(renderer.root, 'Key').props.error).toBe('required');

    unmount();
  });

  it('non-retryable: an over-long key names the key length before the call', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();
    pressEmptyAction(renderer);
    changeText(renderer.root, 'Key', 'a'.repeat(257));
    pressButton(renderer.root, 'Save');

    expect(h.mutations.setVar.mutateAsync).not.toHaveBeenCalled();
    expect(findField(renderer.root, 'Key').props.error).toBe('Key must be 256 characters or fewer');

    unmount();
  });

  it('retryable: a failure with no message toasts the fallback and keeps the form', async () => {
    h.query.data = testProfile();
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
    h.query.data = testProfile([{ key: 'API_KEY', value: '1', isSecret: false }]);
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
    h.query.data = testProfile([{ key: 'TOKEN', value: '***', isSecret: true }]);
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();

    expect(findAll(renderer.root, 'Text').some(node => node.props.children === '••••••••')).toBe(
      true
    );
    expect(findAll(renderer.root, 'Text').some(node => node.props.children === '***')).toBe(false);

    unmount();
  });

  it('happy: a secret value can be revealed only while editing', async () => {
    h.query.data = testProfile([{ key: 'TOKEN', value: '***', isSecret: true }]);
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

  it('happy: a new variable marked secret says its value is encrypted', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();
    pressEmptyAction(renderer);
    // Until it is marked secret, the value field keeps the plain placeholder.
    expect(findField(renderer.root, 'Value').props.placeholder).toBe('Value');

    act(() => {
      (
        findOne(renderer.root, 'Switch').props as { onValueChange: (value: boolean) => void }
      ).onValueChange(true);
    });
    expect(findField(renderer.root, 'Value').props.placeholder).toBe('Secret value (encrypted)');

    unmount();
  });

  it('happy: confirming delete calls deleteVar and drops the row', async () => {
    h.query.data = testProfile([{ key: 'API_KEY', value: '1', isSecret: false }]);
    h.query.isPending = false;
    h.mutations.deleteVar.mutateAsync.mockResolvedValue({ success: true });

    const { renderer, unmount } = await mountScreen();
    pressPressable(renderer.root, 'Delete');
    await act(async () => {
      confirmAlert(h.alert as TestAlertMock);
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

  it('keeps the rows while a refetch is in flight', async () => {
    h.query.data = testProfile([{ key: 'API_KEY', value: '1', isSecret: false }]);
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
