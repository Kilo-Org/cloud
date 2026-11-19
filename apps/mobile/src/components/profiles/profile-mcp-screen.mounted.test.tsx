/* eslint-disable max-lines -- one mounted case per MCP screen state: loading, error, empty, row toggle, edit, add, validation, failure fallbacks, and delete */
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
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
  pressRowContentPress,
  pressSheetCancel,
  pressSheetDone,
  rerenderScreen,
  testProfile,
  testServer,
} from '@/components/profiles/profile-mcp-screen.test-helpers';
import { act } from '@/test/renderer';
import { waitFor } from '@/test/render-with-providers';
import { resetFormDraftsForTests } from '@/lib/form-draft';
import { MAX_PROFILE_MCP_SERVERS } from '@/lib/agent-profile-forms';
import { isolateLtrBidiText } from '@/lib/bidi';

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
    createMcp: { mutateAsync: vi.fn(), isPending: false },
    updateMcp: { mutateAsync: vi.fn(), isPending: false },
    deleteMcp: { mutateAsync: vi.fn(), isPending: false },
    setMcpEnabled: { mutate: vi.fn(), isPending: false },
  },
}));

const permissionState = vi.hoisted(() => ({
  permission: 'allowed' as 'resolving' | 'allowed' | 'read-only',
}));

vi.mock('@/lib/hooks/use-can-manage-profiles', () => ({
  useOrganizationProfilePermission: () => permissionState.permission,
}));

vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfileMcpServers: () => h.query,
  useAgentProfileOverview: () => ({ data: { name: 'Team profile' } }),
  useAgentProfileSectionMutations: () => h.mutations,
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
  useThemeColors: () => ({ mutedForeground: '#000000', destructive: '#FF0000' }),
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
vi.mock('@/components/empty-state', () => ({
  StateAction: 'StateAction',
  // The screen hands its action to the manage slot, so the stub renders what it
  // is given: the read-only sentence replaces the button in the same subtree.
  EmptyState: (props: { title: string; description?: ReactNode; action?: ReactNode }) =>
    createElement('EmptyState', { title: props.title }, props.description, props.action),
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  Lock: 'Lock',
  Pencil: 'Pencil',
  Server: 'Server',
  Trash2: 'Trash2',
  Plus: 'Plus',
}));

/** The props a mocked Switch host element exposes, which the renderer keeps untyped. */
type ToggleProps = { onValueChange: (value: boolean) => void };

describe('ProfileMcpScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFormDraftsForTests();
    permissionState.permission = 'allowed';
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

  it('empty: shows the empty copy and the add CTA opens the sheet', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();

    expect(findOne(renderer.root, 'EmptyState').props.title).toBe('No MCP servers yet');
    pressEmptyAction(renderer);
    expect(findOne(renderer.root, 'SheetHeader')).toBeTruthy();

    unmount();
  });

  it('read-only: the empty state names who may act in place of the add control', async () => {
    permissionState.permission = 'read-only';
    h.query.data = testProfile();
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();

    expect(findOne(renderer.root, 'EmptyState').props.title).toBe('No MCP servers yet');
    expect(findAll(renderer.root, 'Text').map(node => node.props.children)).toContain(
      i18n.t('profiles.organizationRoleRequired')
    );
    expect(findAll(renderer.root, 'Button')).toHaveLength(0);

    unmount();
  });

  it('read-only: a loaded list keeps its rows, drops its controls and names who may act', async () => {
    permissionState.permission = 'read-only';
    h.query.data = testProfile([testServer()]);
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();

    expect(findOne(renderer.root, 'Switch').props.accessibilityLabel).toBe('docs');
    // The row content is the edit action, so without the manage role it renders
    // no labelled control at all.
    expect(
      findAll(renderer.root, 'Pressable')
        .map(node => node.props.accessibilityLabel)
        .filter((label): label is string => typeof label === 'string')
    ).toEqual([]);
    expect(findAll(renderer.root, 'Button')).toHaveLength(0);
    expect(findAll(renderer.root, 'Text').map(node => node.props.children)).toContain(
      i18n.t('profiles.organizationRoleRequired')
    );

    // With nothing to open the row renders static, so the count and the command
    // it paints stay text stops instead of being hidden for a press that does
    // not exist.
    const factLines = findAll(renderer.root, 'Text').filter(
      node => node.props.children === 1 || node.props.children === 'npx @example/mcp'
    );
    expect(factLines).toHaveLength(2);
    for (const line of factLines) {
      expect(line.props.accessible).toBeUndefined();
      expect(line.props.importantForAccessibility).toBeUndefined();
    }

    unmount();
  });

  it('resolving: the empty state renders neither the sentence nor an action', async () => {
    permissionState.permission = 'resolving';
    h.query.data = testProfile();
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();

    expect(findAll(renderer.root, 'Button')).toHaveLength(0);
    expect(findAll(renderer.root, 'Text').map(node => node.props.children)).not.toContain(
      i18n.t('profiles.organizationRoleRequired')
    );

    unmount();
  });

  it('happy: a row shows name, type and summary; the switch toggles the server', async () => {
    h.query.data = testProfile([
      testServer(),
      testServer({
        id: 'mcp-2',
        name: 'remote-docs',
        type: 'remote',
        config: { url: 'https://mcp.example.com/docs' },
      }),
    ]);
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();

    const texts = findAll(renderer.root, 'Text').map(node => node.props.children);
    expect(texts).toContain('docs');
    expect(texts).toContain('Local');
    expect(texts).toContain('npx @example/mcp');

    const toggle = findOne(renderer.root, 'Switch');
    expect(toggle.props.accessibilityLabel).toBe('docs');
    act(() => {
      (toggle.props as { onValueChange: (v: boolean) => void }).onValueChange(false);
    });
    expect(h.mutations.setMcpEnabled.mutate.mock.calls[0]?.[0]).toEqual({
      profileId: 'profile-1',
      mcpServerId: 'mcp-1',
      enabled: false,
    });

    unmount();
  });

  it('leaves the type out when every server has the same one', async () => {
    h.query.data = testProfile([testServer()]);
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();

    const texts = findAll(renderer.root, 'Text').map(node => node.props.children);
    expect(texts).toContain('docs');
    expect(texts).toContain('npx @example/mcp');
    expect(texts).not.toContain('Local');

    unmount();
  });

  it('happy: the edit control opens the sheet seeded with the server', async () => {
    h.query.data = testProfile([testServer()]);
    h.query.isPending = false;
    h.mutations.updateMcp.mutateAsync.mockResolvedValue({ success: true });

    const { renderer, unmount } = await mountScreen();
    pressRowContentPress(renderer.root, 'Edit MCP server docs');

    expect(findField(renderer.root, 'Server name').props.defaultValue).toBe('docs');
    expect(findField(renderer.root, 'Command line').props.defaultValue).toBe('npx @example/mcp');
    expect(findAll(renderer.root, 'SegmentedControl')).toHaveLength(0);

    pressSheetDone(renderer.root);
    await waitFor(() => h.mutations.updateMcp.mutateAsync.mock.calls.length > 0);
    expect(h.mutations.updateMcp.mutateAsync.mock.calls[0]?.[0]).toEqual({
      profileId: 'profile-1',
      mcpServerId: 'mcp-1',
      server: {
        type: 'local',
        name: 'docs',
        enabled: true,
        config: {
          command: ['npx', '@example/mcp'],
          environment: { API_KEY: '\u2022\u2022\u2022\u2022' },
        },
      },
    });

    unmount();
  });

  it('keeps remote type and masked headers unchanged when editing', async () => {
    const config = {
      url: 'https://example.com/mcp',
      headers: { Authorization: '\u2022\u2022\u2022\u2022' },
    };
    h.query.data = testProfile([testServer({ type: 'remote', config })]);
    h.query.isPending = false;
    h.mutations.updateMcp.mutateAsync.mockResolvedValue({ success: true });
    const { renderer, unmount } = await mountScreen();
    pressRowContentPress(renderer.root, 'Edit MCP server docs');
    expect(findAll(renderer.root, 'SegmentedControl')).toHaveLength(0);
    pressSheetDone(renderer.root);
    await waitFor(() => h.mutations.updateMcp.mutateAsync.mock.calls.length > 0);
    expect(h.mutations.updateMcp.mutateAsync.mock.calls[0]?.[0]).toMatchObject({
      server: { type: 'remote', config },
    });
    unmount();
  });

  it('happy: a valid add saves through createMcp and closes the sheet', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;
    h.mutations.createMcp.mutateAsync.mockResolvedValue({ id: 'mcp-2' });

    const { renderer, unmount } = await mountScreen();
    pressEmptyAction(renderer);
    changeText(renderer.root, 'Server name', 'new-server');
    changeText(renderer.root, 'Command line', 'npx some-mcp');
    pressSheetDone(renderer.root);

    await waitFor(() => h.mutations.createMcp.mutateAsync.mock.calls.length > 0);
    expect(h.mutations.createMcp.mutateAsync.mock.calls[0]?.[0]).toEqual({
      profileId: 'profile-1',
      server: {
        type: 'local',
        name: 'new-server',
        enabled: true,
        config: { command: ['npx', 'some-mcp'] },
      },
    });
    await waitFor(() => findAll(renderer.root, 'SheetHeader').length === 0);

    unmount();
  });

  it('non-retryable: an empty name is refused with an inline message and nothing persists', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();
    pressEmptyAction(renderer);
    pressSheetDone(renderer.root);

    expect(h.mutations.createMcp.mutateAsync).not.toHaveBeenCalled();
    expect(findField(renderer.root, 'Server name').props.error).toBe('Enter a server name');
    expect(findOne(renderer.root, 'SheetHeader')).toBeTruthy();

    unmount();
  });

  it('non-retryable: the name message names ASCII for a non-Latin name', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();
    pressEmptyAction(renderer);
    changeText(renderer.root, 'Server name', 'خادم الفريق');
    changeText(renderer.root, 'Command line', 'npx some-mcp');
    pressSheetDone(renderer.root);

    expect(h.mutations.createMcp.mutateAsync).not.toHaveBeenCalled();
    expect(findField(renderer.root, 'Server name').props.error).toBe(
      'Name can use only ASCII letters, numbers, underscores, and dashes, up to 100 characters'
    );

    unmount();
  });

  it('non-retryable: an invalid URL is refused for a remote server', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();
    pressEmptyAction(renderer);
    act(() => {
      const segmented = findOne(renderer.root, 'SegmentedControl');
      (segmented.props as { onChange: (v: string) => void }).onChange('remote');
    });
    changeText(renderer.root, 'Server name', 'new-server');
    changeText(renderer.root, 'URL', 'not a url');
    pressSheetDone(renderer.root);

    expect(h.mutations.createMcp.mutateAsync).not.toHaveBeenCalled();
    expect(findField(renderer.root, 'URL').props.error).toBe('Enter a valid URL');

    unmount();
  });

  it('retryable: a save failure shows its message inside the sheet and keeps the sheet open', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;
    h.mutations.createMcp.mutateAsync.mockRejectedValue(new Error('Internal server error'));

    const { renderer, unmount } = await mountScreen();
    pressEmptyAction(renderer);
    changeText(renderer.root, 'Server name', 'new-server');
    changeText(renderer.root, 'Command line', 'npx some-mcp');
    pressSheetDone(renderer.root);

    await waitFor(() =>
      findAll(renderer.root, 'Text').some(
        node => node.props.children === i18n.t('profiles.mcp.saveFailed')
      )
    );
    expect(findOne(renderer.root, 'SheetHeader')).toBeTruthy();

    unmount();
  });

  it('refuses a name a loaded server already uses, without calling the server', async () => {
    h.query.data = testProfile([testServer()]);
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();
    pressAddButton(renderer);
    changeText(renderer.root, 'Server name', 'docs');
    changeText(renderer.root, 'Command line', 'npx some-mcp');
    pressSheetDone(renderer.root);
    expect(findField(renderer.root, 'Server name').props.error).toBe(
      i18n.t('profiles.mcp.nameConflict')
    );
    expect(findOne(renderer.root, 'SheetHeader')).toBeTruthy();

    unmount();
  });

  it('lets an edit keep its own name and refuses one another server owns', async () => {
    h.query.data = testProfile([
      testServer(),
      testServer({ id: 'mcp-2', name: 'search', config: { command: ['npx', '@example/search'] } }),
    ]);
    h.query.isPending = false;
    h.mutations.updateMcp.mutateAsync.mockResolvedValue({ success: true });

    const { renderer, unmount } = await mountScreen();
    pressRowContentPress(renderer.root, 'Edit MCP server docs');
    expect(findField(renderer.root, 'Server name').props.error).toBeUndefined();

    changeText(renderer.root, 'Server name', 'search');
    pressSheetDone(renderer.root);

    expect(h.mutations.updateMcp.mutateAsync).not.toHaveBeenCalled();
    expect(findField(renderer.root, 'Server name').props.error).toBe(
      i18n.t('profiles.mcp.nameConflict')
    );

    unmount();
  });

  it("shows the server's name conflict on the name field, not only a toast", async () => {
    h.query.data = testProfile();
    h.query.isPending = false;
    h.mutations.createMcp.mutateAsync.mockRejectedValue(
      Object.assign(new Error('An MCP server with this name already exists in this profile'), {
        data: { code: 'CONFLICT' },
      })
    );

    const { renderer, unmount } = await mountScreen();
    pressEmptyAction(renderer);
    changeText(renderer.root, 'Server name', 'new-server');
    changeText(renderer.root, 'Command line', 'npx some-mcp');
    pressSheetDone(renderer.root);

    await waitFor(() =>
      findAll(renderer.root, 'FormField').some(
        node => node.props.label === 'Server name' && node.props.error !== undefined
      )
    );
    expect(findField(renderer.root, 'Server name').props.error).toBe(
      i18n.t('profiles.mcp.nameConflict')
    );
    expect(h.error).not.toHaveBeenCalled();

    unmount();
  });

  it('a11y: the switch is the row element named after the server, and the press names the count', async () => {
    h.query.data = testProfile([testServer()]);
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();

    // The visible name is painted only, so the switch beside it is the single
    // stop that speaks the server's name.
    expect(findOne(renderer.root, 'Switch').props.accessibilityLabel).toBe('docs');
    const nameLine = findAll(renderer.root, 'Text').find(
      node => node.props.children === 'docs' && node.props.variant === 'mono'
    );
    expect(nameLine?.props).toMatchObject({
      accessible: false,
      importantForAccessibility: 'no',
    });
    // The counted glyphs stay decorative; the content press carries their meaning.
    expect(findOne(renderer.root, 'Lock').parent?.props.accessibilityLabel).toBeUndefined();
    expect(
      findAll(renderer.root, 'Pressable').map(node => node.props.accessibilityLabel)
    ).toContain('Edit MCP server docs, 1 secret, npx @example/mcp');

    unmount();
  });

  it('a11y: the press names the count in the plural form', async () => {
    h.query.data = testProfile([
      testServer({
        type: 'remote',
        config: {
          url: 'https://example.com/mcp',
          headers: { API_KEY: '••••', TEAM: '••••', REGION: 'eu' },
        },
      }),
    ]);
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();

    const counts = findAll(renderer.root, 'Text').filter(node => node.props.children === 3);
    expect(counts).toHaveLength(1);
    expect(
      findAll(renderer.root, 'Pressable').map(node => node.props.accessibilityLabel)
    ).toContain('Edit MCP server docs, 3 secrets, https://example.com/mcp');
    expect(findOne(renderer.root, 'Switch').props.accessibilityLabel).toBe('docs');

    unmount();
  });

  it('happy: confirming delete calls deleteMcp', async () => {
    h.query.data = testProfile([testServer()]);
    h.query.isPending = false;
    h.mutations.deleteMcp.mutateAsync.mockResolvedValue({ success: true });

    const { renderer, unmount } = await mountScreen();
    pressPressable(renderer.root, 'Delete MCP server docs');
    await act(async () => {
      confirmRequest(h.confirm);
      await Promise.resolve();
    });

    await waitFor(() => h.mutations.deleteMcp.mutateAsync.mock.calls.length > 0);
    expect(h.mutations.deleteMcp.mutateAsync.mock.calls[0]?.[0]).toEqual({
      profileId: 'profile-1',
      mcpServerId: 'mcp-1',
    });

    unmount();
  });

  it('retryable: a delete with no usable message names the delete operation', async () => {
    h.query.data = testProfile([testServer()]);
    h.query.isPending = false;
    h.mutations.deleteMcp.mutateAsync.mockRejectedValue(new Error(' '));

    const { renderer, unmount } = await mountScreen();
    pressPressable(renderer.root, 'Delete MCP server docs');
    await act(async () => {
      confirmRequest(h.confirm);
      await Promise.resolve();
    });

    await waitFor(() => h.error.mock.calls.length > 0);
    expect(h.error).toHaveBeenCalledWith("Couldn't delete MCP server");

    unmount();
  });

  it('retryable: a refused toggle names the update, not a save', async () => {
    h.query.data = testProfile([testServer()]);
    h.query.isPending = false;
    h.mutations.setMcpEnabled.mutate.mockImplementation(
      (_input: unknown, options: { onError: (error: Error) => void }) => {
        options.onError(new Error(' '));
      }
    );

    const { renderer, unmount } = await mountScreen();
    // The test renderer exposes host props untyped; the screen passes this handler.
    const toggleProps = findOne(renderer.root, 'Switch').props as ToggleProps;
    act(() => {
      toggleProps.onValueChange(false);
    });

    expect(h.error).toHaveBeenCalledWith("Couldn't update MCP server");

    unmount();
  });

  it('keeps the rows while a refetch is in flight', async () => {
    h.query.data = testProfile([testServer()]);
    h.query.isPending = false;

    const { renderer, queryClient, unmount } = await mountScreen();

    h.query.isRefetching = true;
    await act(async () => {
      rerenderScreen(renderer, queryClient);
      await Promise.resolve();
    });
    expect(findOne(renderer.root, 'Switch').props.accessibilityLabel).toBe('docs');

    unmount();
  });
  it('reopens the add sheet with its typed fields after a remount', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;

    const first = await mountScreen();
    pressEmptyAction(first.renderer);
    changeText(first.renderer.root, 'Server name', 'portal-server');
    changeText(first.renderer.root, 'Command line', 'npx portal-mcp');
    first.unmount();

    const second = await mountScreen();
    expect(findOne(second.renderer.root, 'SheetHeader')).toBeTruthy();
    expect(findField(second.renderer.root, 'Server name').props.defaultValue).toBe('portal-server');
    expect(findField(second.renderer.root, 'Command line').props.defaultValue).toBe(
      'npx portal-mcp'
    );
    second.unmount();
  });

  it('starts a later add empty once the draft was saved', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;
    h.mutations.createMcp.mutateAsync.mockResolvedValue({ id: 'mcp-2' });

    const first = await mountScreen();
    pressEmptyAction(first.renderer);
    changeText(first.renderer.root, 'Server name', 'portal-server');
    changeText(first.renderer.root, 'Command line', 'npx portal-mcp');
    pressSheetDone(first.renderer.root);
    await waitFor(() => h.mutations.createMcp.mutateAsync.mock.calls.length > 0);
    first.unmount();

    const second = await mountScreen();
    expect(findAll(second.renderer.root, 'SheetHeader')).toHaveLength(0);
    pressEmptyAction(second.renderer);
    expect(findField(second.renderer.root, 'Server name').props.defaultValue).toBe('');
    second.unmount();
  });
  it('leaves the form opened after a failed save alone when that save settles', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;
    const pendingSave = Promise.withResolvers<unknown>();
    h.mutations.createMcp.mutateAsync.mockImplementation(() => pendingSave.promise);

    const { renderer, unmount } = await mountScreen();
    pressEmptyAction(renderer);
    changeText(renderer.root, 'Server name', 'first-server');
    changeText(renderer.root, 'Command line', 'npx first-mcp');
    pressSheetDone(renderer.root);
    expect(h.mutations.createMcp.mutateAsync).toHaveBeenCalledTimes(1);

    // The save is still in flight, so the guard closes without asking; the
    // refusal of the first save belongs to the first form and must not appear
    // under the second.
    pressSheetCancel(renderer.root);
    expect(h.confirm).not.toHaveBeenCalled();
    pressEmptyAction(renderer);

    await act(async () => {
      pendingSave.reject(new Error('late failure'));
      await Promise.resolve();
    });

    expect(findAll(renderer.root, 'Text').map(node => node.props.children)).not.toContain(
      i18n.t('profiles.mcp.saveFailed')
    );
    expect(findOne(renderer.root, 'SheetHeader')).toBeTruthy();
    unmount();
  });

  it('drops the row presses of the burst that saved the sheet', async () => {
    h.query.data = testProfile([testServer()]);
    h.query.isPending = false;
    h.mutations.updateMcp.mutateAsync.mockResolvedValue({ success: true });

    const { renderer, unmount } = await mountScreen();
    pressRowContentPress(renderer.root, 'Edit MCP server docs');
    pressSheetDone(renderer.root);
    await waitFor(() => findAll(renderer.root, 'SheetHeader').length === 0);

    pressPressable(renderer.root, 'Delete MCP server docs');
    pressRowContentPress(renderer.root, 'Edit MCP server docs');
    // The test renderer exposes host props untyped; the screen passes this handler.
    const toggleProps = findOne(renderer.root, 'Switch').props as ToggleProps;
    act(() => {
      toggleProps.onValueChange(false);
    });

    expect(h.confirm).not.toHaveBeenCalled();
    expect(findAll(renderer.root, 'SheetHeader')).toHaveLength(0);
    expect(h.mutations.setMcpEnabled.mutate).not.toHaveBeenCalled();
    unmount();
  });
});

/** The server name the fixture row holds; the dialog must isolate exactly this run. */
const SERVER_NAME = 'docs';

/** The confirm sheet's request, as the screen hands it to `useConfirmDialog`. */
type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
};

/** Read the request the screen raised, without answering it. */
function deleteRequest(): ConfirmRequest {
  const request = h.confirm.mock.calls[0]?.[0] as ConfirmRequest | undefined;
  if (!request) {
    throw new Error('the screen asked for no confirmation');
  }
  return request;
}

describe('ProfileMcpScreen delete confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFormDraftsForTests();
    permissionState.permission = 'allowed';
    h.query.data = testProfile([testServer({ name: SERVER_NAME })]);
    h.query.isError = false;
    h.query.isPending = false;
    h.query.isRefetching = false;
    for (const mutation of Object.values(h.mutations)) {
      Object.assign(mutation, { isPending: false });
    }
  });

  // The dialog used to read "Delete" as both its title and its confirm label,
  // with the bare name as the message, so the reader was never told what
  // removing the server would do.
  it('asks for consent with the server name in the title and states the consequence', async () => {
    const { renderer, unmount } = await mountScreen();

    pressPressable(renderer.root, `Delete MCP server ${SERVER_NAME}`);
    const request = deleteRequest();

    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(request).toMatchObject({
      title: i18n.t('profiles.mcp.deleteTitle', { name: isolateLtrBidiText(SERVER_NAME) }),
      message: i18n.t('profiles.mcp.deleteMessage'),
      confirmLabel: i18n.t('profiles.mcp.deleteConfirm'),
    });
    expect(request.confirmLabel).not.toBe(i18n.t('common.delete'));
    expect(request.title).not.toBe(request.message);
    expect(request.title).not.toBe(SERVER_NAME);
    expect(request.message).not.toBe(SERVER_NAME);

    unmount();
  });

  // A server name is compared character by character, so a right-to-left
  // sentence must not reorder it: one explicit left-to-right run, no more.
  it('keeps the server name in exactly one left-to-right isolate pair', async () => {
    const { renderer, unmount } = await mountScreen();

    pressPressable(renderer.root, `Delete MCP server ${SERVER_NAME}`);
    const { title } = deleteRequest();

    expect(title).toContain(`\u2066${SERVER_NAME}\u2069`);
    expect(title.split('\u2066')).toHaveLength(2);
    expect(title.split('\u2069')).toHaveLength(2);

    unmount();
  });

  it('deletes nothing until the reader confirms, then deletes that server', async () => {
    h.mutations.deleteMcp.mutateAsync.mockResolvedValue({ success: true });
    const { renderer, unmount } = await mountScreen();

    pressPressable(renderer.root, `Delete MCP server ${SERVER_NAME}`);
    const request = deleteRequest();

    expect(h.mutations.deleteMcp.mutateAsync).not.toHaveBeenCalled();

    await act(async () => {
      request.onConfirm();
      await Promise.resolve();
    });

    expect(h.mutations.deleteMcp.mutateAsync).toHaveBeenCalledTimes(1);
    expect(h.mutations.deleteMcp.mutateAsync.mock.calls[0]?.[0]).toEqual({
      profileId: 'profile-1',
      mcpServerId: 'mcp-1',
    });

    unmount();
  });
});

/** The translated cap line, as the footer and the sheet render it. */
function capMessage(): string {
  return i18n.t('profiles.mcp.limitReached', { max: MAX_PROFILE_MCP_SERVERS });
}

/** `length` distinct servers, so the list holds exactly the count the server caps. */
function serversAt(length: number) {
  return Array.from({ length }, (_, index) =>
    testServer({ id: `mcp-${index}`, name: `server-${index}` })
  );
}

describe('ProfileMcpScreen server cap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFormDraftsForTests();
    permissionState.permission = 'allowed';
    Object.assign(h.query, { isError: false, isPending: false, isRefetching: false });
    for (const mutation of Object.values(h.mutations)) {
      Object.assign(mutation, { isPending: false });
    }
  });

  it('states the cap above the Add action and disables it at the cap', async () => {
    h.query.data = testProfile(serversAt(MAX_PROFILE_MCP_SERVERS));
    const { renderer, unmount } = await mountScreen();

    // One pre-order walk, so the indexes compare the footer's own order.
    const ordered = renderer.root.findAll(
      node => String(node.type) === 'Text' || String(node.type) === 'Button'
    );
    const noticeIndex = ordered.findIndex(node => node.props.children === capMessage());
    const addIndex = ordered.findIndex(node => String(node.type) === 'Button');

    expect(noticeIndex).toBeGreaterThan(-1);
    expect(addIndex).toBeGreaterThan(-1);
    expect(noticeIndex).toBeLessThan(addIndex);
    expect(ordered[noticeIndex]?.props.className).toContain('text-warn');
    expect(findOne(renderer.root, 'Button').props.disabled).toBe(true);

    unmount();
  });

  it('offers the Add action without a notice one server below the cap', async () => {
    h.query.data = testProfile(serversAt(MAX_PROFILE_MCP_SERVERS - 1));
    const { renderer, unmount } = await mountScreen();

    expect(findAll(renderer.root, 'Text').some(node => node.props.children === capMessage())).toBe(
      false
    );
    expect(findOne(renderer.root, 'Button').props.disabled).toBe(false);

    unmount();
  });

  it('reports a create the cap refuses as the cap line, not a generic failure', async () => {
    h.query.data = testProfile([testServer()]);
    h.mutations.createMcp.mutateAsync.mockRejectedValue(
      Object.assign(new Error('Profiles are limited to 20 MCP servers'), {
        data: { code: 'PRECONDITION_FAILED' },
      })
    );

    const { renderer, unmount } = await mountScreen();
    pressAddButton(renderer);
    changeText(renderer.root, 'Server name', 'new-server');
    changeText(renderer.root, 'Command line', 'npx some-mcp');
    pressSheetDone(renderer.root);

    await waitFor(() =>
      findAll(renderer.root, 'Text').some(node => node.props.children === capMessage())
    );
    const status = findAll(renderer.root, 'Text').find(
      node => node.props.children === capMessage()
    );
    expect(status?.props.className).toContain('text-warn');
    expect(
      findAll(renderer.root, 'Text').some(
        node => node.props.children === i18n.t('profiles.mcp.saveFailed')
      )
    ).toBe(false);

    unmount();
  });

  it('reports any other refused create as a generic failure', async () => {
    h.query.data = testProfile([testServer()]);
    h.mutations.createMcp.mutateAsync.mockRejectedValue(
      Object.assign(new Error('Internal server error'), { data: { code: 'INTERNAL_SERVER_ERROR' } })
    );

    const { renderer, unmount } = await mountScreen();
    pressAddButton(renderer);
    changeText(renderer.root, 'Server name', 'new-server');
    changeText(renderer.root, 'Command line', 'npx some-mcp');
    pressSheetDone(renderer.root);

    await waitFor(() =>
      findAll(renderer.root, 'Text').some(
        node => node.props.children === i18n.t('profiles.mcp.saveFailed')
      )
    );
    const status = findAll(renderer.root, 'Text').find(
      node => node.props.children === i18n.t('profiles.mcp.saveFailed')
    );
    expect(status?.props.className).toContain('text-destructive');

    unmount();
  });
});
