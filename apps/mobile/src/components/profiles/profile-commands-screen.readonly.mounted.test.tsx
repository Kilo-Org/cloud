import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import {
  findAll,
  findFields,
  findOne,
  mountScreen,
  testProfile,
  type TestProfileDetail,
} from '@/components/profiles/profile-commands-screen.test-helpers';

const h = vi.hoisted(() => ({
  error: vi.fn(),
  query: {
    data: undefined as TestProfileDetail | undefined,
    isError: false,
    isPending: true,
    isRefetching: false,
    refetch: vi.fn(),
  },
  mutations: {
    setCommands: { mutateAsync: vi.fn() },
  },
  back: vi.fn(),
}));

const permissionState = vi.hoisted(() => ({ canManage: false }));

vi.mock('@/lib/hooks/use-can-manage-profiles', () => ({
  useCanManageOrganizationProfiles: () => permissionState.canManage,
}));

vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfile: () => h.query,
  useAgentProfileMutations: () => h.mutations,
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ back: h.back }) }));
vi.mock('sonner-native', () => ({ toast: { error: h.error } }));
vi.mock('react-native', () => ({
  View: 'View',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
}));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#000000', destructive: '#FF0000' }),
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/form-field', async () => {
  const { createElement, useRef } = await import('react');
  return {
    FormField: (props: { defaultValue?: string; onChangeText?: (value: string) => void }) => {
      // Native uncontrolled text only accepts defaultValue when mounted.
      const nativeText = useRef(props.defaultValue);
      return createElement('FormField', {
        ...props,
        nativeText: nativeText.current,
        onChangeText: (value: string) => {
          nativeText.current = value;
          props.onChangeText?.(value);
        },
      });
    },
  };
});
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  ChevronDown: 'ChevronDown',
  ChevronUp: 'ChevronUp',
  Terminal: 'Terminal',
  Trash2: 'Trash2',
}));

describe('ProfileCommandsScreen without the manage role', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissionState.canManage = false;
    Object.assign(h.query, {
      data: undefined,
      isError: false,
      isPending: true,
      isRefetching: false,
    });
  });

  it('shows no add, reorder, or delete control to a member', async () => {
    h.query.data = testProfile(['a', 'b']);
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen('org-1');

    expect(findFields(renderer.root).map(field => field.props.disabled)).toEqual([true, true]);
    expect(findAll(renderer.root, 'Pressable')).toHaveLength(0);
    expect(findAll(renderer.root, 'Button')).toHaveLength(0);

    unmount();
  });

  it('shows no add CTA to a member when the list is empty', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen('org-1');

    expect(findOne(renderer.root, 'EmptyState').props.action).toBeNull();

    unmount();
  });
});
