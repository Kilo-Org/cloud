import { createElement, type ReactNode, type Ref } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { KiloCommandFormSheet } from '@/components/profiles/kilo-command-form-sheet';
import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

const h = vi.hoisted(() => ({
  onClose: vi.fn(),
  onCreate: vi.fn(),
  confirm: vi.fn(),
  scrollTo: vi.fn(),
}));

// A mock factory is hoisted above this file's imports, so React comes in through a
// dynamic import there (the pattern this suite's harness already relies on). The
// stub exposes `scrollTo`, which a refused Save drives, so tests can observe it.
// The shared switch takes its track and thumb from the app palette.
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    mutedForeground: '#6f6a61',
    primary: '#4f5a10',
    primaryForeground: '#ffffff',
  }),
}));
vi.mock('react-native', async () => {
  const {
    createElement: createMockElement,
    forwardRef,
    useImperativeHandle,
  } = await import('react');
  return {
    Platform: { OS: 'ios' },
    useColorScheme: () => 'light',
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
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({
    confirm: (request: unknown) => {
      h.confirm(request);
    },
    dialog: null,
  }),
}));

function findAll(root: ReactTestInstance, type: string): ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

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

function findOne(root: ReactTestInstance, type: string): ReactTestInstance {
  const node = findAll(root, type)[0];
  if (!node) {
    throw new Error(`${type} was not rendered`);
  }
  return node;
}

function findField(root: ReactTestInstance, label: string): ReactTestInstance {
  const field = findAll(root, 'FormField').find(node => node.props.label === label);
  if (!field) {
    throw new Error(`field ${label} was not rendered`);
  }
  return field;
}

function callHandler(node: ReactTestInstance, name: string): void {
  const handler = voidHandler(node.props[name]);
  act(() => {
    handler();
  });
}

/** A host stub's layout prop, read from the renderer's untyped props. */
type ContainerLayout = (event: { nativeEvent: { layout: { y: number } } }) => void;

/** Register a field block's offset the way the scroll view reports it after layout. */
function layoutField(root: ReactTestInstance, label: string, y: number): void {
  const handler: unknown = findField(root, label).props.containerOnLayout;
  if (typeof handler !== 'function') {
    throw new TypeError(`field ${label} has no layout handler`);
  }
  // Checked to be a function above; the stub props carry no call signature.
  const onLayout = handler as ContainerLayout;
  act(() => {
    onLayout({ nativeEvent: { layout: { y } } });
  });
}

type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
};

function confirmRequest(index: number): ConfirmRequest | undefined {
  return h.confirm.mock.calls[index]?.[0];
}

// eslint-disable-next-line typescript-eslint/promise-function-async -- returning the harness promise unchanged
function mountSheet() {
  return renderWithProviders(
    createElement(KiloCommandFormSheet, {
      command: null,
      isSaving: false,
      onClose: () => {
        h.onClose();
      },
      onCreate: (payload: unknown) => {
        h.onCreate(payload);
      },
      onUpdate: () => undefined,
    })
  );
}

describe('KiloCommandFormSheet server bounds', () => {
  it('caps the name, description, and template fields at the server limits', async () => {
    const { renderer, unmount } = await mountSheet();

    expect(findField(renderer.root, 'Command name').props.maxLength).toBe(50);
    expect(findField(renderer.root, 'Command description').props.maxLength).toBe(2000);
    expect(findField(renderer.root, 'Template').props.maxLength).toBe(100_000);

    unmount();
  });
});

describe('KiloCommandFormSheet agent identifier field', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('keeps the agent example an identifier in a non-Latin locale', async () => {
    await i18n.changeLanguage('km');
    // The picker's mode label is the localized action phrase in Khmer; the
    // field's hint must stay the identifier the value has to be.
    const modeLabel = i18n.t('agentChat.modeOptions.code');
    const { renderer, unmount } = await mountSheet();

    const field = findField(renderer.root, i18n.t('common.agent'));
    expect(field.props.placeholder).toBe('reviewer');
    expect(field.props.placeholder).not.toBe(modeLabel);

    unmount();
  });
});

describe('KiloCommandFormSheet command name', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps a typed name the server rejects and refuses the save under the field', async () => {
    const { renderer, unmount } = await mountSheet();
    act(() => {
      (findField(renderer.root, 'Command name').props.onChangeText as (v: string) => void)(
        'Revisão de Teste'
      );
      (findField(renderer.root, 'Template').props.onChangeText as (v: string) => void)('x');
    });

    callHandler(findOne(renderer.root, 'SheetHeader'), 'onDone');

    // The field holds what was typed, so Save refuses it instead of saving a
    // shortened name the reader never saw.
    expect(h.onCreate).not.toHaveBeenCalled();
    expect(findField(renderer.root, 'Command name').props.error).toBe(
      i18n.t('profiles.slashCommands.nameInvalid')
    );

    unmount();
  });

  it('creates a command under the name exactly as typed', async () => {
    const { renderer, unmount } = await mountSheet();
    act(() => {
      (findField(renderer.root, 'Command name').props.onChangeText as (v: string) => void)(
        'release-notes'
      );
      (findField(renderer.root, 'Template').props.onChangeText as (v: string) => void)('x');
    });

    callHandler(findOne(renderer.root, 'SheetHeader'), 'onDone');

    expect(h.onCreate).toHaveBeenCalledWith({
      name: 'release-notes',
      template: 'x',
      subtask: false,
    });
    expect(findField(renderer.root, 'Command name').props.error).toBeUndefined();

    unmount();
  });
});

describe('KiloCommandFormSheet dismissal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('closes without asking when nothing changed', async () => {
    const { renderer, unmount } = await mountSheet();

    callHandler(findOne(renderer.root, 'SheetHeader'), 'onCancel');

    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(h.confirm).not.toHaveBeenCalled();

    unmount();
  });

  it('asks before Cancel drops a typed template, and the sheet request follows the same gate', async () => {
    const { renderer, unmount } = await mountSheet();
    act(() => {
      (findField(renderer.root, 'Template').props.onChangeText as (v: string) => void)('Do it');
    });

    const requestDismiss = booleanHandler(
      findOne(renderer.root, 'SessionPageSheet').props.onRequestDismiss
    );
    expect(requestDismiss()).toBe(false);
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(confirmRequest(0)).toMatchObject({
      title: i18n.t('common.discardChangesTitle'),
      confirmLabel: i18n.t('common.discard'),
      cancelLabel: i18n.t('common.keepEditing'),
    });
    expect(h.onClose).not.toHaveBeenCalled();

    callHandler(findOne(renderer.root, 'SheetHeader'), 'onCancel');
    expect(h.confirm).toHaveBeenCalledTimes(2);
    expect(h.onClose).not.toHaveBeenCalled();

    act(() => {
      confirmRequest(1)?.onConfirm();
    });
    expect(h.onClose).toHaveBeenCalledTimes(1);

    unmount();
  });
});

describe('KiloCommandFormSheet refused save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scrolls to the name field when it is missing', async () => {
    const { renderer, unmount } = await mountSheet();
    layoutField(renderer.root, 'Command name', 200);

    callHandler(findOne(renderer.root, 'SheetHeader'), 'onDone');

    expect(h.scrollTo).toHaveBeenCalledWith({ y: 188, animated: true });

    unmount();
  });

  it('scrolls to a named command with no template to the template field', async () => {
    const { renderer, unmount } = await mountSheet();
    act(() => {
      (findField(renderer.root, 'Command name').props.onChangeText as (v: string) => void)(
        'release-notes'
      );
    });
    layoutField(renderer.root, 'Template', 640);

    callHandler(findOne(renderer.root, 'SheetHeader'), 'onDone');

    expect(h.scrollTo).toHaveBeenCalledWith({ y: 628, animated: true });

    unmount();
  });
});
