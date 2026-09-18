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
  testProfile,
  testServer,
} from '@/components/profiles/profile-mcp-screen.test-helpers';
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
    createMcp: { mutateAsync: vi.fn(), isPending: false },
    updateMcp: { mutateAsync: vi.fn(), isPending: false },
    deleteMcp: { mutateAsync: vi.fn(), isPending: false },
    setMcpEnabled: { mutate: vi.fn(), isPending: false },
  },
}));

vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfile: () => h.query,
  useAgentProfileSectionMutations: () => h.mutations,
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
  useThemeColors: () => ({ mutedForeground: '#000000', destructive: '#FF0000' }),
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
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  Lock: 'Lock',
  Pencil: 'Pencil',
  Server: 'Server',
  Trash2: 'Trash2',
}));

describe('ProfileMcpScreen', () => {
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

  it('empty: shows the empty copy and the add CTA opens the sheet', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();

    expect(findOne(renderer.root, 'EmptyState').props.title).toBe('No MCP servers yet');
    pressEmptyAction(renderer);
    expect(findOne(renderer.root, 'SheetHeader')).toBeTruthy();

    unmount();
  });

  it('happy: a row shows name, type and summary; the switch toggles the server', async () => {
    h.query.data = testProfile([testServer()]);
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

  it('happy: the edit control opens the sheet seeded with the server', async () => {
    h.query.data = testProfile([testServer()]);
    h.query.isPending = false;
    h.mutations.updateMcp.mutateAsync.mockResolvedValue({ success: true });

    const { renderer, unmount } = await mountScreen();
    pressPressable(renderer.root, 'Edit MCP server');

    expect(findField(renderer.root, 'Server name').props.defaultValue).toBe('docs');
    expect(findField(renderer.root, 'Command line').props.defaultValue).toBe('npx @example/mcp');

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

  it('retryable: a failure with no message toasts the fallback and keeps the sheet', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;
    const error = new Error('placeholder');
    error.message = '';
    h.mutations.createMcp.mutateAsync.mockRejectedValue(error);

    const { renderer, unmount } = await mountScreen();
    pressEmptyAction(renderer);
    changeText(renderer.root, 'Server name', 'new-server');
    changeText(renderer.root, 'Command line', 'npx some-mcp');
    pressSheetDone(renderer.root);

    await waitFor(() => h.error.mock.calls.length > 0);
    expect(h.error).toHaveBeenCalledWith("Couldn't save MCP server");
    expect(findOne(renderer.root, 'SheetHeader')).toBeTruthy();

    unmount();
  });

  it('happy: confirming delete calls deleteMcp', async () => {
    h.query.data = testProfile([testServer()]);
    h.query.isPending = false;
    h.mutations.deleteMcp.mutateAsync.mockResolvedValue({ success: true });

    const { renderer, unmount } = await mountScreen();
    pressPressable(renderer.root, 'Delete');
    await act(async () => {
      confirmAlert(h.alert);
      await Promise.resolve();
    });

    await waitFor(() => h.mutations.deleteMcp.mutateAsync.mock.calls.length > 0);
    expect(h.mutations.deleteMcp.mutateAsync.mock.calls[0]?.[0]).toEqual({
      profileId: 'profile-1',
      mcpServerId: 'mcp-1',
    });

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
});
