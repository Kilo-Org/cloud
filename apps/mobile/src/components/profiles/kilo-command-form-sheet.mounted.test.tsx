import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { KiloCommandFormSheet } from '@/components/profiles/kilo-command-form-sheet';
import { type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

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

function findAll(root: ReactTestInstance, type: string): ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

function findField(root: ReactTestInstance, label: string): ReactTestInstance {
  const field = findAll(root, 'FormField').find(node => node.props.label === label);
  if (!field) {
    throw new Error(`field ${label} was not rendered`);
  }
  return field;
}

// eslint-disable-next-line typescript-eslint/promise-function-async -- returning the harness promise unchanged
function mountSheet() {
  return renderWithProviders(
    createElement(KiloCommandFormSheet, {
      command: null,
      isSaving: false,
      onClose: () => undefined,
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
    expect(field.props.placeholder).toBe('e.g. code, architect');
    expect(field.props.placeholder).not.toBe(modeLabel);

    unmount();
  });
});
