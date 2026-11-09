/* eslint-disable typescript-eslint/no-deprecated -- the DOM-free `test-renderer` mounts React/RN trees under vitest (see src/test/renderer.ts) */
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BackendSettingsControl } from '@/components/chat/backend-settings-sheet';
import { act, TestRenderer } from '@/test/renderer';

/**
 * Opening the model catalog from the provider sheet.
 *
 * The sheet has to finish its native dismissal before the catalog is pushed:
 * a push while it is still sliding down presents the catalog under an empty,
 * closing card. The sheet keeps its content until that dismissal reports.
 */

const router = vi.hoisted(() => ({ push: vi.fn<(href: string) => void>() }));
vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Text: 'Text',
  View: 'View',
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({ foreground: '#000' }) }));
vi.mock('@/components/ui/icons', () => ({ Server: 'Server' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/chat/backend-target', () => ({ backendTargetId: () => 'target' }));
vi.mock('@/lib/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
}));
vi.mock('@/components/agents/session-page-sheet', () => ({
  SessionPageSheet: (props: { children: ReactNode }) =>
    createElement('SessionPageSheet', props, props.children),
}));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), dialog: null }),
}));
vi.mock('@/components/ui/use-sheet-dismiss-guard', () => ({
  useSheetDismissGuard: () => ({ requestClose: vi.fn(), requestDismiss: vi.fn(), dialog: null }),
}));
vi.mock('@/lib/chat/backend-store', () => ({
  addChatBackend: vi.fn(),
  BACKEND_INPUT_ERROR_KEYS: {},
  BackendInputError: class BackendInputError extends Error {},
  deleteChatBackend: vi.fn(),
  getChatBackendsHasLoaded: () => true,
  subscribeChatBackends: () => () => undefined,
  updateChatBackend: vi.fn(),
  useChatBackends: () => [],
}));
vi.mock('./backend-form', () => ({ BackendForm: 'BackendForm' }));
vi.mock('./backend-provider-choices', () => ({
  BackendProviderChoice: 'BackendProviderChoice',
  CloudProviderChoice: 'CloudProviderChoice',
}));
vi.mock('./local-model-section', () => ({ LocalModelSection: 'LocalModelSection' }));
vi.mock('./gguf-model-section', () => ({ GgufModelSection: 'GgufModelSection' }));

type SheetProps = { visible: boolean; onClose: () => void; onDismiss: () => void };

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function mount() {
  act(() => {
    renderer = TestRenderer.create(createElement(BackendSettingsControl));
  });
  if (!renderer) {
    throw new Error('Missing renderer');
  }
  return renderer;
}

function sheetProps(tree: TestRenderer.ReactTestRenderer): SheetProps[] {
  return tree.root
    .findAll(node => (node.type as string) === 'SessionPageSheet')
    .map(node => node.props as SheetProps);
}

function press(tree: TestRenderer.ReactTestRenderer, type: string, handler: string) {
  const node = tree.root.find(candidate => (candidate.type as string) === type);
  act(() => {
    (node.props[handler] as () => void)();
  });
}

function call(handler: (() => void) | undefined) {
  act(() => {
    handler?.();
  });
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

describe('BackendSettingsControl browse models', () => {
  it('keeps the closing sheet and its content mounted and pushes only after dismissal', () => {
    const tree = mount();
    press(tree, 'Pressable', 'onPress');
    press(tree, 'GgufModelSection', 'onBrowse');

    expect(sheetProps(tree).map(props => props.visible)).toEqual([false]);
    expect(tree.root.findAll(node => (node.type as string) === 'GgufModelSection')).toHaveLength(1);
    expect(router.push).not.toHaveBeenCalled();

    call(sheetProps(tree)[0]?.onDismiss);
    expect(router.push).toHaveBeenCalledExactlyOnceWith('/model-catalog');
    expect(sheetProps(tree)).toHaveLength(0);
  });

  it('does not push when the sheet is closed without browsing', () => {
    const tree = mount();
    press(tree, 'Pressable', 'onPress');
    call(sheetProps(tree)[0]?.onClose);
    call(sheetProps(tree)[0]?.onDismiss);
    expect(router.push).not.toHaveBeenCalled();
    expect(sheetProps(tree)).toHaveLength(0);
  });

  it('drops a pending browse when the sheet is reopened before it dismisses', () => {
    const tree = mount();
    press(tree, 'Pressable', 'onPress');
    press(tree, 'GgufModelSection', 'onBrowse');
    press(tree, 'Pressable', 'onPress');
    expect(sheetProps(tree).map(props => props.visible)).toEqual([true]);
    call(sheetProps(tree)[0]?.onClose);
    call(sheetProps(tree)[0]?.onDismiss);
    expect(router.push).not.toHaveBeenCalled();
  });
});
