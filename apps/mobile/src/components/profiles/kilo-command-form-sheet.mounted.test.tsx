import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { KiloCommandFormSheet } from '@/components/profiles/kilo-command-form-sheet';
import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

const h = vi.hoisted(() => ({
  onClose: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('react-native', () => ({
  View: 'View',
  ScrollView: 'ScrollView',
  Switch: 'Switch',
}));
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
      onCreate: () => undefined,
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
