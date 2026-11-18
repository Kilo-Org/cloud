import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { ProfilePickerSheet } from './repo-bindings-profile-sheet';
import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';
import { type AgentProfileListItem } from '@/lib/hooks/agent-profile-types';

vi.mock('react-native', () => ({ View: 'View', ScrollView: 'ScrollView', Pressable: 'Pressable' }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('@/components/agents/session-page-sheet', () => ({ SessionPageSheet: 'SessionPageSheet' }));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icons', () => ({ SlidersHorizontal: 'SlidersHorizontal' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

/** The props `EmptyState` receives; it is a host node in this suite, so the action stays a prop. */
type EmptyStateNode = {
  props: {
    title?: string;
    description?: string;
    action?: { props: { onPress: () => void; children: { props: { children: string } } } };
  };
};

/** The first host node of a mocked component type (host node types are not in the intrinsic map). */
function nodeOfType(root: ReactTestInstance, type: string): ReactTestInstance | undefined {
  return root.findAll(node => node.type === type)[0];
}

function emptyStateOf(root: ReactTestInstance): EmptyStateNode {
  const node = nodeOfType(root, 'EmptyState');
  if (!node) {
    throw new Error('the empty state did not render');
  }
  // The mocked surface is a host node, so its props are untyped at the boundary.
  return { props: node.props as EmptyStateNode['props'] };
}

describe('binding profile picker', () => {
  it.each(['loading', 'error', 'empty', 'happy'] as const)(
    'renders the %s state and its available actions',
    async state => {
      const onRetry = vi.fn<() => void>();
      const onSelect = vi.fn<(id: string) => void>();
      const onClose = vi.fn<() => void>();
      const onCreateProfile = vi.fn<() => void>();
      const profile: AgentProfileListItem = {
        id: 'p1',
        name: 'Profile',
        isDefault: true,
        description: null,
        createdAt: '',
        updatedAt: '',
        varCount: 0,
        commandCount: 0,
        mcpServerCount: 0,
        skillCount: 0,
        agentCount: 0,
        kiloCommandCount: 0,
        instructionCount: 0,
      };
      const { renderer, unmount } = await renderWithProviders(
        createElement(ProfilePickerSheet, {
          profiles: state === 'happy' ? [profile] : [],
          isLoading: state === 'loading',
          isError: state === 'error',
          isRefetching: false,
          selectedProfileId: '',
          emptyDescription: 'Create a profile to reuse environment variables.',
          onCreateProfile,
          onRetry,
          onSelect,
          onClose,
        })
      );
      const nodes = (type: string) => renderer.root.findAll(node => node.type === type);
      const one = (type: string) => renderer.root.find(node => node.type === type);
      expect(nodes('Skeleton')).toHaveLength(state === 'loading' ? 1 : 0);
      expect(nodes('QueryError')).toHaveLength(state === 'error' ? 1 : 0);
      expect(nodes('EmptyState')).toHaveLength(state === 'empty' ? 1 : 0);
      expect(nodes('Pressable')).toHaveLength(state === 'happy' ? 1 : 0);
      if (state === 'empty') {
        const empty = emptyStateOf(renderer.root);
        expect(empty.props.title).toBe('No profiles yet');
        expect(empty.props.description).toBe('Create a profile to reuse environment variables.');
        // EmptyState renders its action as given; the mocked surface keeps it a prop.
        expect(empty.props.action?.props.children.props.children).toBe('Create profile');
        act(() => {
          empty.props.action?.props.onPress();
        });
        expect(onCreateProfile).toHaveBeenCalledOnce();
      }
      if (state === 'error') {
        act(() => {
          (one('QueryError').props.onRetry as () => void)();
        });
        expect(onRetry).toHaveBeenCalledOnce();
      }
      if (state === 'happy') {
        act(() => {
          (one('Pressable').props.onPress as () => void)();
        });
        expect(onSelect).toHaveBeenCalledWith('p1');
      }
      act(() => {
        (one('SheetHeader').props.onDone as () => void)();
      });
      expect(onClose).toHaveBeenCalledOnce();
      unmount();
    }
  );

  it('empty: a context that cannot create a profile gets no create action', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(ProfilePickerSheet, {
        profiles: [],
        isLoading: false,
        isError: false,
        isRefetching: false,
        selectedProfileId: '',
        emptyDescription: 'An organization owner or admin can create an organization profile.',
        onRetry: vi.fn<() => void>(),
        onSelect: vi.fn<(id: string) => void>(),
        onClose: vi.fn<() => void>(),
      })
    );

    const empty = emptyStateOf(renderer.root);
    expect(empty.props.description).toBe(
      'An organization owner or admin can create an organization profile.'
    );
    expect(empty.props.action).toBeUndefined();
    expect(nodeOfType(renderer.root, 'Button')).toBeUndefined();

    unmount();
  });
});
