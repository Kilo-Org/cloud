import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { InstructionViewSheet } from '@/components/profiles/instruction-view-sheet';
import { i18n } from '@/i18n';
import { isolateLtrBidiText } from '@/lib/bidi';
import { type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: 'View',
  ScrollView: 'ScrollView',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/components/agents/session-page-sheet', () => ({ SessionPageSheet: 'SessionPageSheet' }));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/ui/form-field-label', () => ({ FormFieldLabel: 'FormFieldLabel' }));
vi.mock('@/components/ui/selectable-text', () => ({ SelectableText: 'SelectableText' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/layout', () => ({ SCREEN_BODY_CLASS: 'screen-body' }));

/** The longest file name the server stores, i.e. `INSTRUCTION_NAME_MAX_LENGTH`. */
const LONG_NAME =
  'release-checklist-for-the-hindi-and-urdu-partner-team-handoff-before-every-quarter-close-safety-revi';

const CONTENT = '# Rules\n\nClose the quarter before the handoff.\n';

function findAll(root: ReactTestInstance, type: string): ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

/** The read-only value a label names, as the sheet hands it to `SelectableText`. */
function valueFor(root: ReactTestInstance, label: string): ReactTestInstance | undefined {
  return findAll(root, 'SelectableText').find(node => node.props.accessibilityLabel === label);
}

function mountSheet(instruction: { name: string; content: string } | null) {
  return renderWithProviders(
    createElement(InstructionViewSheet, { instruction, onClose: () => undefined })
  );
}

describe('InstructionViewSheet', () => {
  // The row clamps the name to one line, so this sheet is where the whole file
  // name is readable: the value keeps every character and takes no line cap.
  it('paints the whole file name without a line clamp', async () => {
    const { renderer, unmount } = await mountSheet({ name: LONG_NAME, content: CONTENT });

    expect(LONG_NAME).toHaveLength(100);
    const nameValue = valueFor(renderer.root, i18n.t('profiles.instructionNameLabel'));
    expect(nameValue?.props.children).toBe(LONG_NAME);
    expect(nameValue?.props.numberOfLines).toBeUndefined();

    unmount();
  });

  it('names the path the file is stored at and paints the content', async () => {
    const { renderer, unmount } = await mountSheet({ name: LONG_NAME, content: CONTENT });

    const path = findAll(renderer.root, 'Text').find(
      node => node.props.children === isolateLtrBidiText(`.kilocode/rules/${LONG_NAME}.md`)
    );
    expect(path).toBeDefined();

    const contentValue = valueFor(renderer.root, i18n.t('profiles.instructionContentLabel'));
    expect(contentValue?.props.children).toBe(CONTENT);

    unmount();
  });

  it('renders no header title while it is closed', async () => {
    const { renderer, unmount } = await mountSheet(null);

    expect(findAll(renderer.root, 'SheetHeader')).toHaveLength(0);
    expect(findAll(renderer.root, 'SelectableText')).toHaveLength(0);

    unmount();
  });
});
