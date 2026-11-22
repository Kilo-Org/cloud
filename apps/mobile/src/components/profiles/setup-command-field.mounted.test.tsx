// Setup command field: the value is code, so the field keeps the mono family
// whenever it holds a command. Only an empty field whose localized placeholder
// is written in a script the mono family cannot draw — a right-to-left block or
// a joined script — keeps the interface font, because a fallback drew that
// placeholder glyph by glyph. The value is also pinned left to right with the
// family's ligatures off, so a flag like `--frozen-lockfile` renders as two
// hyphens.
import { act, type ElementType, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { TestRenderer } from '@/test/renderer';

import { SetupCommandField } from './setup-command-field';

const copy = vi.hoisted(() => ({ placeholder: 'e.g. pnpm install' }));

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/lib/utils', () => ({
  cn: (...parts: unknown[]) => parts.filter(Boolean).join(' '),
}));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/form-field-label', () => ({ FormFieldLabel: 'FormFieldLabel' }));
vi.mock('@/components/ui/input', () => ({ INPUT_BOX_SHAPE_CLASS: 'rounded-md' }));
vi.mock('@/components/ui/selectable-text', () => ({ SelectableText: 'SelectableText' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
// The catalog copy is checked by tools/i18n; this stub only has to hand the
// field the placeholder the real catalog would.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (key === 'profiles.commandPlaceholder' ? copy.placeholder : key),
  }),
}));

/** The Arabic catalog's placeholder for this field: a right-to-left script the
 * mono family cannot draw. */
const ARABIC_PLACEHOLDER = 'مثال: pnpm install';

const FIELD = 'FormField' as ElementType;

const noop = (): void => undefined;

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderField(element: ReactElement) {
  act(() => {
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing SetupCommandField renderer');
  }
  return renderer.root.findByType(FIELD);
}

function fieldFor(command: string) {
  return renderField(<SetupCommandField command={command} label="Command" onChangeText={noop} />);
}

describe('<SetupCommandField>', () => {
  it('keeps mono on the field that holds a command', () => {
    // The placeholder's script decides nothing while a value is on screen: the
    // command is code, so it stays in the family the row is laid out in.
    copy.placeholder = ARABIC_PLACEHOLDER;
    const field = fieldFor('pnpm install --frozen-lockfile');

    expect(String(field.props.className)).toContain('font-mono');
  });

  it('keeps mono for an empty field whose placeholder is Latin copy', () => {
    copy.placeholder = 'e.g. pnpm install';
    const field = fieldFor('');

    expect(String(field.props.className)).toContain('font-mono');
  });

  it('uses the interface font for an empty field whose placeholder needs its glyphs', () => {
    copy.placeholder = ARABIC_PLACEHOLDER;
    const field = fieldFor('');

    expect(String(field.props.className)).not.toContain('font-mono');
  });

  it('uses the interface font for an empty field whose joined-script placeholder needs its glyphs', () => {
    // A joined script that is not right to left reaches the same rule: the mono
    // family draws none of its clusters, so the empty field keeps the
    // interface font.
    copy.placeholder = 'उदा. pnpm install';
    const field = fieldFor('');

    expect(String(field.props.className)).not.toContain('font-mono');
  });

  it('keeps mono on a field holding a command beside a joined-script placeholder', () => {
    copy.placeholder = 'उदा. pnpm install';
    const field = fieldFor('pnpm install --frozen-lockfile');

    expect(String(field.props.className)).toContain('font-mono');
  });

  it('pins the value left to right with the ligatures off', () => {
    const field = fieldFor('pnpm install --frozen-lockfile');

    expect(field.props.style).toMatchObject({
      direction: 'ltr',
      writingDirection: 'ltr',
      textAlign: 'left',
      fontVariant: ['no-common-ligatures', 'no-discretionary-ligatures', 'no-contextual'],
    });
  });
});
