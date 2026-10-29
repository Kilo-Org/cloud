import { createElement, type ReactNode, type Ref } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { McpFormSheet } from '@/components/profiles/mcp-form-sheet';
import { i18n } from '@/i18n';
import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

const h = vi.hoisted(() => ({
  onClose: vi.fn(),
  onSave: vi.fn(),
  confirm: vi.fn(),
  scrollTo: vi.fn(),
}));

// A mock factory is hoisted above this file's imports, so React comes in through a
// dynamic import there (the pattern this suite's harness already relies on). The
// stub exposes `scrollTo`, which a refused Save drives, so tests can observe it.
vi.mock('react-native', async () => {
  const {
    createElement: createMockElement,
    forwardRef,
    useImperativeHandle,
  } = await import('react');
  return {
    Platform: { OS: 'ios' },
    View: 'View',
    Switch: 'Switch',
    ScrollView: forwardRef(function ScrollViewStub(
      props: { children?: ReactNode },
      ref: Ref<{ scrollTo: typeof h.scrollTo }>
    ) {
      useImperativeHandle(ref, () => ({ scrollTo: h.scrollTo }));
      return createMockElement('ScrollView', props, props.children);
    }),
  };
});
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/components/agents/session-page-sheet', () => ({ SessionPageSheet: 'SessionPageSheet' }));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({
    confirm: (request: unknown) => {
      h.confirm(request);
    },
    dialog: null,
  }),
}));

/** A host stub keeps the component's own props untyped; these suites call one handler each. */
function voidHandler(value: unknown): () => void {
  if (typeof value !== 'function') {
    throw new TypeError('expected a handler prop');
  }
  return value as () => void;
}

/** The sheet's dismissal request answers whether it may close. */
function booleanHandler(value: unknown): () => boolean {
  if (typeof value !== 'function') {
    throw new TypeError('expected a handler prop');
  }
  return value as () => boolean;
}

/** A field stub's onChangeText arrives untyped from the host element. */
function textHandler(value: unknown): (text: string) => void {
  if (typeof value !== 'function') {
    throw new TypeError('expected a text handler');
  }
  return value as (text: string) => void;
}

function findAll(root: ReactTestInstance, type: string): ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

function findOne(root: ReactTestInstance, type: string): ReactTestInstance {
  const node = findAll(root, type)[0];
  if (!node) {
    throw new Error(`${type} was not rendered`);
  }
  return node;
}

function changeText(root: ReactTestInstance, label: string, value: string): void {
  const field = findAll(root, 'FormField').find(node => node.props.label === label);
  if (!field) {
    throw new Error(`field ${label} was not rendered`);
  }
  const onChangeText = textHandler(field.props.onChangeText);
  act(() => {
    onChangeText(value);
  });
}

function pressCancel(root: ReactTestInstance): void {
  const onCancel = voidHandler(findOne(root, 'SheetHeader').props.onCancel);
  act(() => {
    onCancel();
  });
}

/** A host stub's layout prop, read from the renderer's untyped props. */
type ContainerLayout = (event: { nativeEvent: { layout: { y: number } } }) => void;

/** Register a field block's offset the way the scroll view reports it after layout. */
function layoutField(root: ReactTestInstance, label: string, y: number): void {
  const field = findAll(root, 'FormField').find(node => node.props.label === label);
  if (!field) {
    throw new Error(`field ${label} was not rendered`);
  }
  const handler: unknown = field.props.containerOnLayout ?? field.parent?.props.onLayout;
  if (typeof handler !== 'function') {
    throw new TypeError(`field ${label} has no layout handler`);
  }
  // Checked to be a function above; the stub props carry no call signature.
  const onLayout = handler as ContainerLayout;
  act(() => {
    onLayout({ nativeEvent: { layout: { y } } });
  });
}

function pressDone(root: ReactTestInstance): void {
  const onDone = voidHandler(findOne(root, 'SheetHeader').props.onDone);
  act(() => {
    onDone();
  });
}

/** A field stub's inline error, read from the renderer's untyped props. */
function fieldError(root: ReactTestInstance, label: string): unknown {
  return findAll(root, 'FormField').find(node => node.props.label === label)?.props.error;
}

// eslint-disable-next-line typescript-eslint/promise-function-async -- returning the harness promise unchanged
function mountSheet(
  options: {
    existingNames?: readonly string[];
    nameConflictFromServer?: boolean;
    saveFailure?: string | null;
  } = {}
) {
  return renderWithProviders(
    createElement(McpFormSheet, {
      server: null,
      existingNames: options.existingNames ?? [],
      isSaving: false,
      nameConflictFromServer: options.nameConflictFromServer ?? false,
      saveFailure: options.saveFailure ?? null,
      onClose: () => {
        h.onClose();
      },
      onSave: () => {
        h.onSave();
      },
    })
  );
}

describe('McpFormSheet dismissal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('closes an untouched sheet without asking', async () => {
    const { renderer, unmount } = await mountSheet();

    pressCancel(renderer.root);

    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(h.confirm).not.toHaveBeenCalled();

    unmount();
  });

  it('asks before Cancel drops a typed server, and refuses Android Back while dirty', async () => {
    const { renderer, unmount } = await mountSheet();

    changeText(renderer.root, 'Server name', 'notes');

    const requestDismiss = booleanHandler(
      findOne(renderer.root, 'SessionPageSheet').props.onRequestDismiss
    );
    expect(requestDismiss()).toBe(false);

    pressCancel(renderer.root);

    expect(h.confirm).toHaveBeenCalledTimes(2);
    expect(h.confirm.mock.calls[1]?.[0]).toMatchObject({
      title: i18n.t('common.discardChangesTitle'),
      message: i18n.t('common.discardChangesMessage'),
      confirmLabel: i18n.t('common.discard'),
      cancelLabel: i18n.t('common.keepEditing'),
    });
    expect(h.onClose).not.toHaveBeenCalled();

    unmount();
  });
});

describe('McpFormSheet refused save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scrolls to the name field when it is missing', async () => {
    const { renderer, unmount } = await mountSheet();
    layoutField(renderer.root, 'Server name', 420);

    pressDone(renderer.root);

    expect(h.scrollTo).toHaveBeenCalledWith({ y: 408, animated: true });
    expect(h.onSave).not.toHaveBeenCalled();

    unmount();
  });

  it('scrolls to a bad config to the config field', async () => {
    const { renderer, unmount } = await mountSheet();
    changeText(renderer.root, 'Server name', 'notes');
    changeText(renderer.root, 'Command line', 'node server.js');
    changeText(renderer.root, 'Environment (JSON)', '{"key":}');
    layoutField(renderer.root, 'Environment (JSON)', 780);

    pressDone(renderer.root);

    expect(h.scrollTo).toHaveBeenCalledWith({ y: 768, animated: true });
    expect(h.onSave).not.toHaveBeenCalled();

    unmount();
  });

  it('refuses a name another server already has, under the name field', async () => {
    const { renderer, unmount } = await mountSheet({ existingNames: ['docs'] });
    changeText(renderer.root, 'Server name', 'docs');
    changeText(renderer.root, 'Command line', 'node server.js');
    layoutField(renderer.root, 'Server name', 420);

    pressDone(renderer.root);

    expect(h.onSave).not.toHaveBeenCalled();
    expect(fieldError(renderer.root, 'Server name')).toBe(i18n.t('profiles.mcp.nameConflict'));
    expect(h.scrollTo).toHaveBeenCalledWith({ y: 408, animated: true });

    unmount();
  });

  it('shows a name conflict the server reported on the name field', async () => {
    const { renderer, unmount } = await mountSheet({ nameConflictFromServer: true });

    expect(fieldError(renderer.root, 'Server name')).toBe(i18n.t('profiles.mcp.nameConflict'));

    unmount();
  });

  it('clears a server-reported name conflict once the name changes', async () => {
    const { renderer, unmount } = await mountSheet({ nameConflictFromServer: true });

    changeText(renderer.root, 'Server name', 'another-name');

    expect(fieldError(renderer.root, 'Server name')).toBeUndefined();

    unmount();
  });

  it('renders a failed save inside the sheet', async () => {
    const { renderer, unmount } = await mountSheet({
      saveFailure: i18n.t('profiles.mcp.saveFailed'),
    });

    expect(findAll(renderer.root, 'Text').map(node => node.props.children)).toContain(
      i18n.t('profiles.mcp.saveFailed')
    );

    unmount();
  });
});
