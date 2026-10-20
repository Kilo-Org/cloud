import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { McpFormSheet } from '@/components/profiles/mcp-form-sheet';
import { i18n } from '@/i18n';
import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

const h = vi.hoisted(() => ({
  onClose: vi.fn(),
  onSave: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('react-native', () => ({ View: 'View', ScrollView: 'ScrollView', Switch: 'Switch' }));
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
  const onChangeText: unknown = field.props.onChangeText;
  if (typeof onChangeText !== 'function') {
    throw new TypeError(`${label} has no onChangeText`);
  }
  act(() => {
    onChangeText(value);
  });
}

function pressCancel(root: ReactTestInstance): void {
  const onCancel: unknown = findOne(root, 'SheetHeader').props.onCancel;
  if (typeof onCancel !== 'function') {
    throw new TypeError('the header has no onCancel');
  }
  act(() => {
    onCancel();
  });
}

// eslint-disable-next-line typescript-eslint/promise-function-async -- returning the harness promise unchanged
function mountSheet() {
  return renderWithProviders(
    createElement(McpFormSheet, {
      server: null,
      isSaving: false,
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

    const sheet = findOne(renderer.root, 'SessionPageSheet');
    const requestDismiss: unknown = sheet.props.onRequestDismiss;
    if (typeof requestDismiss !== 'function') {
      throw new TypeError('the sheet has no dismissal request');
    }
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
