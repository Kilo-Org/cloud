import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { ProfileKiloCommandsScreen } from '@/components/profiles/profile-kilo-commands-screen';
import { type KiloCommandSource } from '@/components/profiles/profile-kilo-commands-model';
import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

const h = vi.hoisted(() => ({
  confirm: vi.fn(),
  error: vi.fn(),
  query: {
    data: undefined as readonly KiloCommandSource[] | undefined,
    isError: false,
    isPending: false,
    isRefetching: false,
    refetch: vi.fn(),
  },
  mutations: {
    createKiloCommand: { mutateAsync: vi.fn(), isPending: false },
    updateKiloCommand: { mutateAsync: vi.fn(), isPending: false },
    deleteKiloCommand: { mutateAsync: vi.fn(), isPending: false },
    setKiloCommandEnabled: { mutate: vi.fn(), isPending: false },
    reorderKiloCommands: { mutate: vi.fn(), isPending: false },
  },
}));

vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfileKiloCommands: () => h.query,
  useAgentProfileSectionMutations: () => h.mutations,
}));
vi.mock('@/lib/hooks/use-can-manage-profiles', () => ({
  useCanManageOrganizationProfiles: () => true,
}));
vi.mock('sonner-native', () => ({ toast: { error: h.error } }));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
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
vi.mock('@/components/profiles/kilo-command-form-sheet', () => ({
  KiloCommandFormSheet: 'KiloCommandFormSheet',
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  ChevronDown: 'ChevronDown',
  ChevronUp: 'ChevronUp',
  Pencil: 'Pencil',
  Terminal: 'Terminal',
  Trash2: 'Trash2',
}));

const COMMAND: KiloCommandSource = {
  id: 'command-1',
  name: 'review',
  description: null,
  template: 'Review the diff',
  agent: null,
  model: null,
  subtask: false,
  enabled: true,
  sortOrder: 0,
};

const mountScreen = () =>
  renderWithProviders(createElement(ProfileKiloCommandsScreen, { profileId: 'profile-1' }));

/** The row control whose accessibility label starts with `prefix`. */
function rowControl(root: ReactTestInstance, prefix: string): ReactTestInstance | undefined {
  return root.findAll(
    node =>
      String(node.type) === 'Pressable' &&
      typeof node.props.onPress === 'function' &&
      String(node.props.accessibilityLabel).startsWith(prefix)
  )[0];
}

/** Press that control. The test renderer exposes its handler untyped; the screen passes it. */
function pressRow(root: ReactTestInstance, prefix: string): void {
  const onPress = rowControl(root, prefix)?.props.onPress as (() => void) | undefined;
  act(() => {
    onPress?.();
  });
}

/** The row's enabled switch, whose handler the screen passes untyped through the host. */
function toggleRow(root: ReactTestInstance, value: boolean): void {
  const onValueChange = root.find(node => String(node.type) === 'Switch').props.onValueChange as (
    next: boolean
  ) => void;
  act(() => {
    onValueChange(value);
  });
}

/** The form sheet's close handler, untyped on the mocked host element. */
function closeSheet(root: ReactTestInstance): void {
  const sheet = root.find(node => String(node.type) === 'KiloCommandFormSheet');
  const onClose = sheet.props.onClose as () => void;
  act(() => {
    onClose();
  });
}

describe('ProfileKiloCommandsScreen after a sheet closes', () => {
  it('drops the row presses of the burst that closed the sheet', async () => {
    h.query.data = [COMMAND];
    const { renderer, unmount } = await mountScreen();

    pressRow(renderer.root, 'Edit');
    closeSheet(renderer.root);

    pressRow(renderer.root, 'Delete');
    pressRow(renderer.root, 'Move');
    toggleRow(renderer.root, false);

    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.mutations.setKiloCommandEnabled.mutate).not.toHaveBeenCalled();
    expect(h.mutations.reorderKiloCommands.mutate).not.toHaveBeenCalled();

    unmount();
  });

  it('accepts the same row press once the guard window has passed', async () => {
    h.query.data = [COMMAND];
    const { renderer, unmount } = await mountScreen();

    pressRow(renderer.root, 'Edit');
    closeSheet(renderer.root);

    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);
    try {
      pressRow(renderer.root, 'Delete');
    } finally {
      now.mockRestore();
    }

    expect(h.confirm).toHaveBeenCalledTimes(1);

    unmount();
  });
});
