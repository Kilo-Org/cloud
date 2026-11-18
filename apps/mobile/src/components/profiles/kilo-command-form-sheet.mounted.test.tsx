/* eslint-disable max-lines -- one mounted case per slash-command sheet state: bounds, name, duplicate, dismissal, refused save, and the subtask row */
import { createElement, type ReactNode, type Ref } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import {
  KiloCommandFormSheet,
  type KiloCommandSaveFailure,
} from '@/components/profiles/kilo-command-form-sheet';
import { type KiloCommandSource } from '@/components/profiles/profile-kilo-commands-model';
import { MAX_PROFILE_KILO_COMMANDS } from '@/lib/agent-profile-forms';
import { resetFormDraftsForTests } from '@/lib/form-draft';
import { act, type ReactTestInstance, TestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

const h = vi.hoisted(() => ({
  onClose: vi.fn(),
  onCreate: vi.fn(),
  onUpdate: vi.fn(),
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
    useColorScheme: () => 'light',
    Pressable: 'Pressable',
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
// The subtask row is the shared `PreferenceRow`: its spinner reaches the icon
// barrel (whose lucide modules this project cannot parse in the mounted
// environment) and its flip calls the haptics wrapper, which reaches `expo`.
vi.mock('@/components/ui/icons', () => ({ Loader2: 'Loader2' }));
vi.mock('@/lib/haptics', () => ({
  selectionHaptic: vi.fn(),
  impactHaptic: vi.fn(),
  notificationHaptic: vi.fn(),
}));
vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return { Text: 'Text', TextClassContext: React.createContext<string | undefined>(undefined) };
});
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
function mountSheet(
  options: {
    existingNames?: readonly string[];
    saveFailure?: KiloCommandSaveFailure | null;
    onFieldEdited?: () => void;
  } = {}
) {
  return renderWithProviders(
    createElement(KiloCommandFormSheet, {
      command: null,
      existingNames: options.existingNames ?? [],
      isSaving: false,
      onClose: () => {
        h.onClose();
      },
      onCreate: (payload: unknown) => {
        h.onCreate(payload);
      },
      onUpdate: () => undefined,
      saveFailure: options.saveFailure ?? null,
      onFieldEdited: options.onFieldEdited ?? (() => undefined),
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

describe('KiloCommandFormSheet duplicate name', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses a loaded profile name under the field without calling the caller', async () => {
    const { renderer, unmount } = await mountSheet({ existingNames: ['release-notes', 'deploy'] });
    act(() => {
      (findField(renderer.root, 'Command name').props.onChangeText as (v: string) => void)(
        'release-notes'
      );
      (findField(renderer.root, 'Template').props.onChangeText as (v: string) => void)('x');
    });
    layoutField(renderer.root, 'Command name', 200);

    callHandler(findOne(renderer.root, 'SheetHeader'), 'onDone');

    expect(h.onCreate).not.toHaveBeenCalled();
    expect(findField(renderer.root, 'Command name').props.error).toBe(
      i18n.t('profiles.slashCommands.duplicateName')
    );
    expect(h.scrollTo).toHaveBeenCalledWith({ y: 188, animated: true });

    unmount();
  });

  it('shows a conflict the server reported and asks the caller to drop it on edit', async () => {
    const onFieldEdited = vi.fn<() => void>();
    const { renderer, unmount } = await mountSheet({
      saveFailure: { kind: 'name-conflict' },
      onFieldEdited,
    });

    expect(findField(renderer.root, 'Command name').props.error).toBe(
      i18n.t('profiles.slashCommands.duplicateName')
    );

    act(() => {
      (findField(renderer.root, 'Command name').props.onChangeText as (v: string) => void)(
        'another-name'
      );
    });
    // The refusal is retired by the caller's store, not mirrored here.
    expect(onFieldEdited).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('keeps a template refusal ahead of a server name conflict', async () => {
    const { renderer, unmount } = await mountSheet({ saveFailure: { kind: 'name-conflict' } });

    act(() => {
      (findField(renderer.root, 'Command name').props.onChangeText as (v: string) => void)(
        'ok-name'
      );
    });
    callHandler(findOne(renderer.root, 'SheetHeader'), 'onDone');

    // The field's own refusal wins: the name conflict has nothing to say about
    // an empty template.
    expect(findField(renderer.root, 'Template').props.error).toBe(
      i18n.t('profiles.slashCommands.templateRequired')
    );
    expect(findField(renderer.root, 'Command name').props.error).toBeUndefined();

    unmount();
  });

  it('shows a save failure the caller cannot name inside the sheet', async () => {
    const { renderer, unmount } = await mountSheet({ saveFailure: { kind: 'refused' } });

    expect(
      findAll(renderer.root, 'Text').some(
        node => node.props.children === i18n.t('profiles.slashCommands.saveFailed')
      )
    ).toBe(true);
    expect(findOne(renderer.root, 'SheetHeader')).toBeTruthy();

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

describe('KiloCommandFormSheet subtask row', () => {
  it('reaches a screen reader as the switch alone, without a duplicate label stop', async () => {
    const { renderer, unmount } = await mountSheet();

    const label = i18n.t('profiles.slashCommands.subtask');
    const labels = findAll(renderer.root, 'Text').filter(node => node.props.children === label);
    expect(labels).toHaveLength(1);
    // The row's text column is the switch's label, not a second stop: the
    // control that wraps it hides its descendants from the reader.
    let labelColumnHidden = false;
    for (let node = labels[0]?.parent; node; node = node.parent) {
      if (node.props.importantForAccessibility === 'no-hide-descendants') {
        labelColumnHidden = true;
        break;
      }
    }
    expect(labelColumnHidden).toBe(true);

    const toggles = findAll(renderer.root, 'Switch');
    expect(toggles.map(node => node.props.accessibilityLabel)).toEqual([label]);

    unmount();
  });
});

describe('KiloCommandFormSheet refetched command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFormDraftsForTests();
  });

  afterEach(() => {
    // The draft is module-level: a later case must not reopen on it.
    resetFormDraftsForTests();
  });

  it('submits the text the field shows when the profile refetches while the sheet is open', () => {
    const command: KiloCommandSource = {
      id: 'cmd-1',
      name: 'release-notes',
      description: 'Draft the release notes',
      template: 'Summarize $ARGUMENTS',
      agent: 'reviewer',
      model: null,
      subtask: false,
      enabled: true,
      sortOrder: 0,
    };
    /* One host whose `command` prop the case replaces, so the sheet stays
       mounted the way a refetch leaves it. */
    function SheetHost({ refetched }: Readonly<{ refetched: KiloCommandSource }>) {
      return createElement(KiloCommandFormSheet, {
        draftScope: 'profiles:slash-commands:profile-1',
        command: refetched,
        existingNames: [],
        isSaving: false,
        onClose: () => {
          h.onClose();
        },
        onCreate: (payload: unknown) => {
          h.onCreate(payload);
        },
        onUpdate: (payload: unknown) => {
          h.onUpdate(payload);
        },
        onFieldEdited: () => undefined,
      });
    }
    const mounted: { renderer?: TestRenderer.ReactTestRenderer } = {};
    act(() => {
      mounted.renderer = TestRenderer.create(createElement(SheetHost, { refetched: command }));
    });
    const renderer = mounted.renderer;
    if (!renderer) {
      throw new Error('the sheet did not mount');
    }

    // A refetch under the open sheet reports the command with no template. The
    // field keeps the text it mounted with, so Save must send that text instead
    // of refusing a visibly non-empty field.
    act(() => {
      renderer.update(createElement(SheetHost, { refetched: { ...command, template: '' } }));
    });
    callHandler(findOne(renderer.root, 'SheetHeader'), 'onDone');

    expect(findField(renderer.root, 'Template').props.error).toBeUndefined();
    expect(h.onUpdate).toHaveBeenCalledWith({
      name: 'release-notes',
      description: 'Draft the release notes',
      template: 'Summarize $ARGUMENTS',
      agent: 'reviewer',
      model: null,
      subtask: false,
    });

    act(() => {
      renderer.unmount();
    });
  });
});

describe('KiloCommandFormSheet cap refusal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('states the command cap as a warning when a create is refused at the limit', async () => {
    const { renderer, unmount } = await mountSheet({ saveFailure: { kind: 'limit' } });

    const message = i18n.t('profiles.slashCommands.limitReached', {
      max: MAX_PROFILE_KILO_COMMANDS,
    });
    const status = findAll(renderer.root, 'Text').find(node => node.props.children === message);

    expect(status).toBeTruthy();
    expect(status?.props.className).toContain('text-warn');
    expect(
      findAll(renderer.root, 'Text').some(
        node => node.props.children === i18n.t('profiles.slashCommands.saveFailed')
      )
    ).toBe(false);

    unmount();
  });

  it('keeps the generic copy for a refusal that is not the cap', async () => {
    const { renderer, unmount } = await mountSheet({ saveFailure: { kind: 'refused' } });

    const status = findAll(renderer.root, 'Text').find(
      node => node.props.children === i18n.t('profiles.slashCommands.saveFailed')
    );

    expect(status).toBeTruthy();
    expect(status?.props.className).toContain('text-destructive');
    expect(findAll(renderer.root, 'Text').map(node => node.props.children)).not.toContain(
      i18n.t('profiles.slashCommands.limitReached', { max: MAX_PROFILE_KILO_COMMANDS })
    );

    unmount();
  });
});
