/* eslint-disable typescript-eslint/no-deprecated -- the DOM-free `test-renderer` mounts React/RN trees under vitest (see src/test/renderer.ts) */
import { createElement, type ReactNode } from 'react';
import { type Href } from 'expo-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { connectedServicesHref } from '@/lib/profile-navigation';
import { act, TestRenderer } from '@/test/renderer';

import { RepoPickerSheet } from './repo-picker-sheet';

/**
 * The repo picker's empty state.
 *
 * A person with no repository to pick used to hit a dead end: the list said
 * "No repositories available" and nothing opened the screen where a repository
 * service is connected. The state now carries one action, and that action must
 * not push the Connected services route while the native sheet is still
 * presented — a push under a presented sheet reads as a dead tap — so the push
 * waits for the sheet's finished-dismissal report.
 */

const router = vi.hoisted(() => ({ push: vi.fn<(href: Href) => void>() }));

vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('react-native', () => ({
  Keyboard: { dismiss: vi.fn() },
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#888', foreground: '#000' }),
}));
// The sheet stays mounted through the native dismiss animation, so the stub
// renders `children` whatever `visible` says and exposes `onDismiss` for the
// suite to report the finished dismissal.
vi.mock('@/components/agents/session-page-sheet', () => ({
  SessionPageSheet: (props: { children?: ReactNode }) =>
    createElement('SessionPageSheet', props, props.children),
}));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/empty-state', () => ({
  EmptyState: (props: { action?: ReactNode }) => createElement('EmptyState', props, props.action),
  StateAction: 'StateAction',
}));
vi.mock('@/components/ui/choice-row', () => ({ ChoiceRow: 'ChoiceRow' }));
vi.mock('@/components/ui/eyebrow', () => ({ Eyebrow: 'Eyebrow' }));
vi.mock('@/components/ui/icons', () => ({
  GitBranch: 'GitBranch',
  Lock: 'Lock',
  Plug: 'Plug',
  SearchX: 'SearchX',
  Unlock: 'Unlock',
}));
vi.mock('@/components/ui/row-skeleton', () => ({ RowSkeleton: 'RowSkeleton' }));
vi.mock('@/components/ui/search-field', () => ({ SearchField: 'SearchField' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

/** The props the empty state, its action, the search field and the sheet receive as host nodes. */
type EmptyStateProps = { title?: string; description?: string; action?: ReactNode };
type StateActionProps = { label?: string; onPress?: () => void };
type SearchFieldProps = { onChangeText?: (text: string) => void };
type SheetProps = { visible?: boolean; onClose?: () => void; onDismiss?: () => void };

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function nodesOfType(type: string): TestRenderer.ReactTestInstance[] {
  if (!renderer) {
    throw new Error('Missing renderer');
  }
  return renderer.root.findAll(node => (node.type as string) === type);
}

function emptyStateProps(): EmptyStateProps {
  const [state] = nodesOfType('EmptyState');
  if (!state) {
    throw new Error('the empty state did not render');
  }
  return state.props as EmptyStateProps;
}

function actionProps(): StateActionProps | undefined {
  const [action] = nodesOfType('StateAction');
  return action?.props as StateActionProps | undefined;
}

function sheetProps(): SheetProps[] {
  return nodesOfType('SessionPageSheet').map(node => node.props as SheetProps);
}

function mountSheet(href: Href, options: { isLoading?: boolean; isError?: boolean } = {}) {
  const onClose = vi.fn<() => void>();
  act(() => {
    renderer = TestRenderer.create(
      createElement(RepoPickerSheet, {
        repositories: [],
        isLoading: options.isLoading ?? false,
        isError: options.isError ?? false,
        onRetry: vi.fn<() => void>(),
        selectedKey: null,
        onSelect: vi.fn<() => void>(),
        onClose,
        connectedServicesHref: href,
      })
    );
  });
  return onClose;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  router.push.mockReset();
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe('RepoPickerSheet empty state', () => {
  it('offers the Connected services action beside the sentence that names it', () => {
    mountSheet(connectedServicesHref());

    const state = emptyStateProps();
    expect(state.description).toBe(i18n.t('agentChat.repoPicker.noRepositoriesDescription'));
    // The description quotes the action's own label, so the pair reads as one
    // instruction: connect a service on the screen this action opens.
    expect(actionProps()?.label).toBe(i18n.t('integrations.sectionTitle'));
  });

  it('pushes Connected services only after the native dismissal reports', () => {
    const onClose = mountSheet(connectedServicesHref());

    act(() => {
      actionProps()?.onPress?.();
    });

    // The sheet is still presented: a push now would land under it, and the
    // tap would look dead.
    expect(onClose).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(sheetProps().map(props => props.visible)).toEqual([false]);

    // `Sheet` forwards its own close edge for the close this asks for, ahead of
    // the finished-dismissal report. That edge must not become the caller's
    // close or drop the queued route: the sheet is still sliding down.
    act(() => {
      sheetProps()[0]?.onClose?.();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();

    act(() => {
      sheetProps()[0]?.onDismiss?.();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledExactlyOnceWith('/(app)/(tabs)/(3_profile)/integrations');
  });

  it('carries the scope into the route it opens', () => {
    const onClose = mountSheet(connectedServicesHref('org-1'));

    act(() => {
      actionProps()?.onPress?.();
    });
    act(() => {
      sheetProps()[0]?.onDismiss?.();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledExactlyOnceWith(
      '/(app)/(tabs)/(3_profile)/integrations?org=org-1'
    );
  });

  it('keeps the search-empty state actionless', async () => {
    mountSheet(connectedServicesHref());

    const [field] = nodesOfType('SearchField');
    if (!field) {
      throw new Error('the search field did not render');
    }
    const { onChangeText } = field.props as SearchFieldProps;
    await act(() => {
      onChangeText?.('nothing-matches');
    });

    const state = emptyStateProps();
    expect(state.title).toBe(i18n.t('common.noRepositoriesFound'));
    expect(actionProps()).toBeUndefined();
  });

  it('keeps the loading and error states actionless', () => {
    mountSheet(connectedServicesHref(), { isLoading: true });

    expect(nodesOfType('RowSkeleton').length).toBeGreaterThan(0);
    expect(nodesOfType('EmptyState')).toHaveLength(0);
    expect(actionProps()).toBeUndefined();

    act(() => renderer?.unmount());
    mountSheet(connectedServicesHref(), { isError: true });

    expect(nodesOfType('QueryError')).toHaveLength(1);
    expect(nodesOfType('EmptyState')).toHaveLength(0);
    expect(actionProps()).toBeUndefined();
  });
});
