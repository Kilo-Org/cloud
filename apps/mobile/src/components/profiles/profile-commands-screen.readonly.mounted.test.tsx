import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import {
  findAll,
  findFields,
  mountScreen,
  testCommands,
  type TestCommands,
} from '@/components/profiles/profile-commands-screen.test-helpers';
import { resetFormDraftsForTests } from '@/lib/form-draft';

const h = vi.hoisted(() => ({
  error: vi.fn(),
  query: {
    data: undefined as TestCommands | undefined,
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

const permissionState = vi.hoisted(() => ({
  permission: 'read-only' as 'resolving' | 'allowed' | 'read-only',
}));

vi.mock('@/lib/hooks/use-can-manage-profiles', () => ({
  useOrganizationProfilePermission: () => permissionState.permission,
}));

vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfileCommands: () => h.query,
  useAgentProfileOverview: () => ({ data: { name: 'Team profile' } }),
  useAgentProfileMutations: () => h.mutations,
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: h.back }),
  usePreventRemove: () => undefined,
}));
vi.mock('sonner-native', () => ({ toast: { error: h.error } }));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
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
vi.mock('@/components/empty-state', async () => {
  // vi.mock factories are hoisted above the module's imports, so the React
  // helpers must be loaded inside the factory.
  const { createElement } = await import('react');
  return {
    // The real state renders its `action` below the title, so the manage slot's
    // sentence reaches the tree the way the screen hands it over.
    EmptyState: (props: { action?: unknown }) =>
      createElement('EmptyState', props, props.action as never),
  };
});
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/form-field', async () => {
  const { createElement, useRef } = await import('react');
  return {
    FormField: (props: {
      defaultValue?: string;
      labelAccessory?: unknown;
      onChangeText?: (value: string) => void;
    }) => {
      // Native uncontrolled text only accepts defaultValue when mounted.
      const nativeText = useRef(props.defaultValue);
      // The real field renders its label accessory beside the label, so the
      // caller's row controls are children of the mocked field too.
      return createElement(
        'FormField',
        {
          ...props,
          nativeText: nativeText.current,
          onChangeText: (value: string) => {
            nativeText.current = value;
            props.onChangeText?.(value);
          },
        },
        props.labelAccessory as never
      );
    },
  };
});
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/selectable-text', () => ({ SelectableText: 'SelectableText' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  ChevronDown: 'ChevronDown',
  ChevronUp: 'ChevronUp',
  Terminal: 'Terminal',
  Trash2: 'Trash2',
}));

/** The role sentence a member reads in the action's place. */
const ROLE_SENTENCE = 'Only organization owners and admins can change organization profiles.';

describe('ProfileCommandsScreen without the manage role', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFormDraftsForTests();
    permissionState.permission = 'read-only';
    Object.assign(h.query, {
      data: undefined,
      isError: false,
      isPending: true,
      isRefetching: false,
    });
  });

  it('shows each command in full to a member, with no editable field or row control', async () => {
    const commands = [
      'pnpm install --frozen-lockfile && pnpm build'.padEnd(420, 'z'),
      'b'.repeat(500),
    ];
    h.query.data = testCommands(commands);
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen('org-1');

    expect(findFields(renderer.root)).toHaveLength(0);
    expect(findAll(renderer.root, 'Pressable')).toHaveLength(0);
    expect(findAll(renderer.root, 'Button')).toHaveLength(0);
    const values = findAll(renderer.root, 'SelectableText');
    expect(values.map(value => value.props.children)).toEqual(commands);
    expect(values.map(value => value.props.accessibilityLabel)).toEqual(['Command 1', 'Command 2']);

    unmount();
  });

  it('names the required role in place of the add CTA when the list is empty', async () => {
    h.query.data = testCommands();
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen('org-1');

    expect(findAll(renderer.root, 'Button')).toHaveLength(0);
    expect(findAll(renderer.root, 'Text').map(node => node.props.children)).toContain(
      ROLE_SENTENCE
    );

    unmount();
  });

  it('names the required role in place of the add control a manager would get', async () => {
    h.query.data = testCommands(['pnpm install']);
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen('org-1');

    expect(findAll(renderer.root, 'Button')).toHaveLength(0);
    expect(findAll(renderer.root, 'Text').map(node => node.props.children)).toContain(
      ROLE_SENTENCE
    );

    unmount();
  });

  it('shows no length counter on a command a member cannot edit', async () => {
    h.query.data = testCommands(['a'.repeat(499)]);
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen('org-1');

    const texts = findAll(renderer.root, 'Text')
      .map(node => node.props.children)
      .filter((child): child is string => typeof child === 'string');
    expect(texts.filter(text => text.includes('character'))).toEqual([]);

    unmount();
  });
});
