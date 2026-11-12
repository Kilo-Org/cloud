/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native layout regression tests. */
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { KvRow } from './kv-row';

// The row pins left-to-right runs itself, so the interface direction is a stub
// the RTL cases flip.
const i18nManager = vi.hoisted(() => ({ isRTL: false }));

vi.mock('react-native', () => ({ I18nManager: i18nManager, Text: 'Text', View: 'View' }));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));
vi.mock('@/components/ui/icons', () => ({}));
// The row reads the face through the shared Text's variant, so the mock carries
// the same variant classes the primitive applies. The mock closes over the file's
// own `createElement` through the factory below, because the mock runs before the
// import binding it needs is alive.
const primitiveText = vi.hoisted(() => {
  type Factory = (type: string, props: Record<string, unknown>, ...children: unknown[]) => unknown;
  let factory: Factory = () => undefined;
  return {
    set(impl: unknown) {
      factory = impl as Factory;
    },
    make: (type: string, props: Record<string, unknown>, ...children: unknown[]) =>
      factory(type, props, ...children),
  };
});
vi.mock('@/components/ui/text', () => ({
  Text: ({
    variant,
    className,
    children,
    ...rest
  }: { variant?: string; className?: string; children?: unknown } & Record<string, unknown>) => {
    const variantClasses =
      variant === 'mono' ? 'font-mono-medium text-sm' : 'text-foreground text-base font-medium';
    return primitiveText.make(
      'Text',
      { ...rest, className: [variantClasses, className].filter(Boolean).join(' ') },
      children
    );
  },
}));
primitiveText.set(createElement);
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#8A8680' }),
}));
vi.mock('@/lib/rtl-text', () => ({
  LTR_TEXT_DIRECTION: { direction: 'ltr', writingDirection: 'ltr' },
}));

// The merged suite keeps the row's real class merge (`cn`) for the face and
// status cases, and the harness renderer resolves the value style itself.
vi.mock('@/lib/utils', async () => {
  const { twMerge } = (await vi.importActual('tailwind-merge')) as {
    twMerge: (...classes: string[]) => string;
  };
  return { cn: twMerge };
});

const longRepository = 'iscekic/kilo-e2e-pr-review-sandbox-86773';

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderRow(
  props:
    | {
        value: string;
        selectable?: boolean;
        valueDirection?: 'ltr';
        valueFace?: 'mono' | 'text' | 'numeric';
        valueStatus?: { label: string; tone: 'good' | 'warn' | 'danger' | 'muted' };
      }
    | undefined
) {
  const row = props ?? { value: 'Teams' };
  act(() => {
    const element = createElement(KvRow, { label: 'Repository', ...row });
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing KvRow renderer');
  }
  return renderer.root;
}

/** The value Text, identified by its rendered string. */
function valueText(root: TestRenderer.ReactTestInstance, value: string) {
  return root.find(node => Object.is(node.type, 'Text') && node.children.includes(value));
}

/** The value's effective style: the shared RTL direction first, the row's own last. */
function valueStyle(node: TestRenderer.ReactTestInstance): Record<string, unknown> {
  const style: unknown = node.props.style;
  if (!Array.isArray(style)) {
    return typeof style === 'object' && style !== null ? { ...style } : {};
  }
  const flattened: Record<string, unknown> = {};
  for (const entry of style as unknown[]) {
    if (typeof entry === 'object' && entry !== null) {
      Object.assign(flattened, entry);
    }
  }
  return flattened;
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('KvRow mounted layout', () => {
  // Android's `selectable` routes the value through ReactTextView, which drops
  // the `maxLines` clamp on attach, so a clamped selectable value wrapped past
  // the one-line row height and painted a clipped second line (SPOT-DEFECT:
  // the finding-details Manifest row).
  it('leaves a selectable value unclamped so it wraps inside the row instead of clipping', () => {
    const text = valueText(renderRow({ value: longRepository, selectable: true }), longRepository);
    expect(text.props.selectable).toBe(true);
    expect(text.props.numberOfLines).toBeUndefined();
    expect(text.props.ellipsizeMode).toBeUndefined();
  });

  it('keeps the single-line middle ellipsis on a value that is not selectable', () => {
    const text = valueText(
      renderRow({ value: 'left-pad (npm)', selectable: false }),
      'left-pad (npm)'
    );
    expect(text.props.numberOfLines).toBe(1);
    expect(text.props.ellipsizeMode).toBe('middle');
  });

  // A version range is written left to right, so a right-to-left interface lets
  // the bidi algorithm paint `< 6.13.0` as `6.13.0 >` and invert its meaning.
  it('pins a value that names a version to a left-to-right run', () => {
    const text = valueText(renderRow({ value: '< 6.13.0', valueDirection: 'ltr' }), '< 6.13.0');
    expect(valueStyle(text)).toMatchObject({ direction: 'ltr', writingDirection: 'ltr' });
  });

  it('keeps that run left-to-right in a right-to-left interface', () => {
    i18nManager.isRTL = true;
    try {
      const text = valueText(renderRow({ value: '< 6.13.0', valueDirection: 'ltr' }), '< 6.13.0');

      expect(valueStyle(text)).toMatchObject({ direction: 'ltr', writingDirection: 'ltr' });
    } finally {
      i18nManager.isRTL = false;
    }
  });

  it('leaves a row without the direction in the interface direction', () => {
    i18nManager.isRTL = true;
    try {
      const text = valueText(renderRow({ value: 'لا يوجد تصحيح متاح' }), 'لا يوجد تصحيح متاح');

      expect(valueStyle(text).writingDirection).toBeUndefined();
    } finally {
      i18nManager.isRTL = false;
    }
  });
});

describe('KvRow value faces', () => {
  // An identifier belongs in the code face; a plain-language value or a
  // timestamp beside a sans label does not, because the code face reads as code.
  it('leaves an identifier in the mono face', () => {
    const text = valueText(
      renderRow({ value: 'left-pad (npm)', valueFace: 'mono' }),
      'left-pad (npm)'
    );
    expect(String(text.props.className)).toContain('font-mono-medium');
  });

  it('paints a plain-language value in the body face', () => {
    const text = valueText(
      renderRow({ value: 'No patch available', valueFace: 'text' }),
      'No patch available'
    );
    expect(String(text.props.className)).not.toContain('font-mono-medium');
    expect(String(text.props.className)).not.toContain('tabular-nums');
  });

  it('keeps tabular figures on a count in the body face', () => {
    const text = valueText(renderRow({ value: '12', valueFace: 'numeric' }), '12');
    expect(String(text.props.className)).not.toContain('font-mono-medium');
    expect(String(text.props.className)).toContain('tabular-nums');
  });
});

describe('KvRow value status', () => {
  it('keeps the value in the row ink and paints only the status in its own', () => {
    // The catalog value carries the separator (" · Lapsed"), so the row paints
    // the two parts and nothing else in the danger ink.
    const nodes = renderRow({
      value: 'Teams',
      valueFace: 'text',
      valueStatus: { label: ' · Lapsed', tone: 'danger' },
    }).findAllByType('Text');

    // The label, the value paragraph, and the status inside that paragraph.
    const value = nodes.find(node => Array.isArray(node.props.children));
    expect(value?.props.className).toContain('text-foreground');

    const status = nodes.find(node => node.props.children === ' · Lapsed');
    expect(String(status?.props.className)).toContain('text-[13px]');
    expect(String(status?.props.className)).toContain('text-destructive');
    // Both parts share the value's paragraph, so the status cannot wrap to a
    // line of its own on a narrow screen.
    expect(value?.findAllByType('Text')).toContain(status);
    // The value itself never wears the status ink.
    expect(value?.props.className).not.toContain('text-destructive');
  });

  it('paints the status in the tone it is given', () => {
    const nodes = renderRow({
      value: 'Teams',
      valueFace: 'text',
      valueStatus: { label: ' · Lapsed', tone: 'warn' },
    }).findAllByType('Text');

    expect(
      String(nodes.find(node => node.props.children === ' · Lapsed')?.props.className)
    ).toContain('text-warn');
  });

  it('renders the value alone when it carries no status', () => {
    const nodes = renderRow({ value: 'Teams', valueFace: 'text' }).findAllByType('Text');

    // The label and the value paragraph, with no status node inside it.
    expect(nodes).toHaveLength(2);
    expect(nodes[1]?.props.children).toContain('Teams');
  });
});
