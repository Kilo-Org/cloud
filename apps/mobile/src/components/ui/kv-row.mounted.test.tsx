import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { KvRow } from './kv-row';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/icons', () => ({}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#8A8680' }),
}));
vi.mock('@/lib/rtl-text', () => ({ LTR_TEXT_DIRECTION: { writingDirection: 'ltr' } }));
vi.mock('@/lib/utils', () => ({ cn: (...parts: unknown[]) => parts.filter(Boolean).join(' ') }));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderRow(props: {
  value: string;
  valueStatus?: { label: string; tone: 'good' | 'warn' | 'danger' | 'muted' };
}) {
  act(() => {
    const element = createElement(KvRow, {
      label: 'Organization plan',
      valueFace: 'text',
      ...props,
    });
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing KvRow renderer');
  }
  return renderer.root.findAllByType('Text');
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('KvRow value status', () => {
  it('keeps the value in the row ink and paints only the status in its own', () => {
    // The catalog value carries the separator (" · Lapsed"), so the row paints
    // the two parts and nothing else in the danger ink.
    const nodes = renderRow({
      value: 'Teams',
      valueStatus: { label: ' · Lapsed', tone: 'danger' },
    });

    // The label, the value paragraph, and the status inside that paragraph.
    const value = nodes.find(node => Array.isArray(node.props.children));
    expect(value?.props.className).toContain('text-foreground');

    const status = nodes.find(node => node.props.children === ' · Lapsed');
    expect(status?.props.className).toBe('text-[13px] text-destructive');
    // Both parts share the value's paragraph, so the status cannot wrap to a
    // line of its own on a narrow screen.
    expect(value?.findAllByType('Text')).toContain(status);
    // The value itself never wears the status ink.
    expect(value?.props.className).not.toContain('text-destructive');
  });

  it('paints the status in the tone it is given', () => {
    const nodes = renderRow({
      value: 'Teams',
      valueStatus: { label: ' · Lapsed', tone: 'warn' },
    });

    expect(nodes.find(node => node.props.children === ' · Lapsed')?.props.className).toBe(
      'text-[13px] text-warn'
    );
  });

  it('renders the value alone when it carries no status', () => {
    const nodes = renderRow({ value: 'Teams' });

    // The label and the value paragraph, with no status node inside it.
    expect(nodes).toHaveLength(2);
    expect(nodes[1]?.props.children).toContain('Teams');
  });
});
