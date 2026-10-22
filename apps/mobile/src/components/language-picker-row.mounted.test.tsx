import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { LanguagePickerRow } from '@/components/language-picker-row';
import { type LanguagePickerItem } from '@/i18n/language-rows';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Text: 'Text',
  View: 'View',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));
vi.mock('@/components/ui/choice-row', () => ({ ChoiceRow: 'ChoiceRow' }));

// ── Helpers ────────────────────────────────────────────────────────────────

function mountRow(item: LanguagePickerItem): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(LanguagePickerRow, {
        item,
        first: item.kind === 'section',
        showDivider: false,
        selected: 'device',
        disabled: false,
        deviceEndonym: 'English',
        isRtl: false,
        onSelect: vi.fn<(preference: string) => void>(),
      })
    );
  });
  if (!ref.current) {
    throw new Error('renderer was not created');
  }
  return ref.current;
}

/** Every mounted `Text`, as the accessibility tree sees it. */
function mountedTexts(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === 'Text'
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('LanguagePickerRow section titles', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it.each([
    { section: 'current', label: 'Current' },
    { section: 'all', label: 'All languages' },
  ] as const)('exposes the $section group title as a heading', ({ section, label }) => {
    const renderer = mountRow({ kind: 'section', key: `section:${section}`, section });

    // A screen reader reaches a picker group only when the title is a heading:
    // the rows below are independent radio choices with no grouping container.
    expect(mountedTexts(renderer)).toEqual([
      expect.objectContaining({ props: expect.objectContaining({ accessibilityRole: 'header' }) }),
    ]);
    expect(mountedTexts(renderer)[0]?.props.children).toBe(label);

    renderer.unmount();
  });

  it('keeps a language row out of heading navigation', () => {
    const renderer = mountRow({
      kind: 'language',
      key: 'es',
      row: { tag: 'es', endonym: 'Español', englishName: 'Spanish' },
    });

    const texts = mountedTexts(renderer);
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) {
      expect(text.props.accessibilityRole).toBeUndefined();
    }

    renderer.unmount();
  });
});
