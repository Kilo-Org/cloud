import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { ProfilePickerSheet } from './repo-bindings-profile-sheet';
import { act } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';
import { type AgentProfileListItem } from '@/lib/hooks/agent-profile-types';

vi.mock('react-native', () => ({ View: 'View', ScrollView: 'ScrollView', Pressable: 'Pressable' }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('@/components/agents/session-page-sheet', () => ({ SessionPageSheet: 'SessionPageSheet' }));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/icons', () => ({ SlidersHorizontal: 'SlidersHorizontal' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

describe('binding profile picker', () => {
  it.each(['loading', 'error', 'empty', 'happy'] as const)(
    'renders the %s state and its available actions',
    async state => {
      const onRetry = vi.fn<() => void>();
      const onSelect = vi.fn<(id: string) => void>();
      const onClose = vi.fn<() => void>();
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
      };
      const { renderer, unmount } = await renderWithProviders(
        createElement(ProfilePickerSheet, {
          profiles: state === 'happy' ? [profile] : [],
          isLoading: state === 'loading',
          isError: state === 'error',
          isRefetching: false,
          selectedProfileId: '',
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
        expect(one('EmptyState').props.title).toBe('No profiles yet');
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
});
