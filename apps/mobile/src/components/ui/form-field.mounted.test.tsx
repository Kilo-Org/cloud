import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FormField } from './form-field';
import { AccessibleStatus } from './accessible-status';
import { act, TestRenderer } from '@/test/renderer';
import { i18n } from '@/i18n';
import ar from '@/i18n/locales/ar.json';
import en from '@/i18n/locales/en.json';

const rtl = vi.hoisted(() => ({ isRTL: false }));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  View: 'View',
  TextInput: 'TextInput',
  I18nManager: {
    get isRTL() {
      return rtl.isRTL;
    },
  },
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#888888' }),
}));
vi.mock('@/lib/a11y/status-announcement', () => ({ useStatusAnnouncement: vi.fn() }));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

afterEach(() => {
  rtl.isRTL = false;
  act(() => {
    renderer?.unmount();
  });
});

/**
 * Flattens the field's nested style array the way React Native does, without
 * `StyleSheet` (the `react-native` mock above does not provide it).
 */
function flattenStyle(style: unknown): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const entry of Array.isArray(style) ? style : [style]) {
    if (Array.isArray(entry)) {
      Object.assign(merged, flattenStyle(entry));
    } else if (typeof entry === 'object' && entry !== null) {
      Object.assign(merged, entry);
    }
  }
  return merged;
}

describe('FormField reserved validation space', () => {
  it.each([
    ['English', en],
    ['Arabic', ar],
  ] as const)(
    'keeps the same full-width reservation across empty, error, and recovery in %s',
    (_language, catalog) => {
      const reserveErrorMessages = [
        catalog.login.pleaseEnterEmail,
        catalog.authErrors.invalidRequest,
        catalog.authErrors.invalidEmail,
      ];
      const props = { label: catalog.login.emailAddress, reserveErrorMessages };
      act(() => {
        renderer = TestRenderer.create(createElement(FormField, props));
      });
      if (!renderer) {
        throw new Error('renderer was not created');
      }
      const mounted = renderer;
      const reservation = () =>
        mounted.root.findByProps({ importantForAccessibility: 'no-hide-descendants' });
      const reserved = reservation();
      expect(reserved.props.className).toBe('flex-row opacity-0');
      expect(reserved.props.pointerEvents).toBe('none');
      expect(reserved.props.accessibilityElementsHidden).toBe(true);
      expect(reserved.children).toHaveLength(3);
      const placeholders = reserved.findAllByType('Text');
      expect(placeholders.map(node => node.props.children)).toEqual(reserveErrorMessages);
      expect(placeholders.map(node => node.props.className)).toEqual([
        'w-full shrink-0 text-sm',
        'w-full shrink-0 text-sm -ms-[100%]',
        'w-full shrink-0 text-sm -ms-[100%]',
      ]);
      expect(mounted.root.findByType(AccessibleStatus).props.message).toBeNull();

      for (const error of [...reserveErrorMessages, undefined]) {
        act(() => {
          mounted.update(createElement(FormField, { ...props, error }));
        });
        expect(reservation()).toBe(reserved);
        expect(reserved.findAllByType('Text').map(node => node.props.children)).toEqual(
          reserveErrorMessages
        );
        const status = mounted.root.findByType(AccessibleStatus);
        expect(status.props.message).toBe(error ?? null);
        expect(status.parent?.props.className).toBe('absolute inset-x-0 top-0');
        expect(status.parent?.parent).toBe(reserved.parent);
        const input = mounted.root.findByType('TextInput');
        if (error) {
          expect(input.props.accessibilityLabel).toContain(error);
          expect(input.props.className).toContain('border-destructive');
          expect(status.findByType('Text').props.accessibilityLiveRegion).toBe('polite');
        } else {
          expect(input.props.accessibilityLabel).toBe(props.label);
          expect(input.props.className).not.toContain('border-destructive');
        }
      }
    }
  );

  it('preserves the unreserved behavior for other fields', () => {
    act(() => {
      renderer = TestRenderer.create(
        createElement(FormField, {
          label: i18n.t('login.emailAddress'),
          error: i18n.t('login.pleaseEnterEmail'),
        })
      );
    });
    expect(
      renderer?.root.findAllByProps({ importantForAccessibility: 'no-hide-descendants' })
    ).toHaveLength(0);
    expect(renderer?.root.findByType(AccessibleStatus).props.message).toBe(
      i18n.t('login.pleaseEnterEmail')
    );
  });
});

describe('FormField shared single-line box', () => {
  it('renders the shared single-line box with centered vertical alignment', () => {
    act(() => {
      renderer = TestRenderer.create(
        createElement(FormField, { label: i18n.t('login.emailAddress') })
      );
    });
    if (!renderer) {
      throw new Error('renderer was not created');
    }
    const input = renderer.root.findByType('TextInput');
    expect(input.props.className).toContain('min-h-[44px]');
    expect(input.props.className).toContain('px-3');
    expect(input.props.className).toContain('leading-[normal]');
    expect(input.props.className).not.toContain('py-');
    expect(input.props.textAlignVertical).toBe('center');
  });

  it('keeps the box and the content style when an error appears under the field', () => {
    act(() => {
      renderer = TestRenderer.create(
        createElement(FormField, { label: i18n.t('login.emailAddress') })
      );
    });
    if (!renderer) {
      throw new Error('renderer was not created');
    }
    const mounted = renderer;
    const inputProps = () => mounted.root.findByType('TextInput').props;
    // The error swaps the border colour only; every other token is unchanged.
    const borderColourTokens = new Set(['border-input', 'border-destructive']);
    const stableTokens = (className: string) =>
      className.split(' ').filter(token => !borderColourTokens.has(token));

    const before = inputProps();
    expect(before.className).not.toContain('border-destructive');

    act(() => {
      mounted.update(
        createElement(FormField, {
          label: i18n.t('login.emailAddress'),
          error: i18n.t('login.pleaseEnterEmail'),
        })
      );
    });

    const after = inputProps();
    // The message only tints the border: the box's geometry, the vertical
    // alignment and the inline style are the ones rendered without it.
    expect(after.className).toContain('border-destructive');
    expect(stableTokens(String(after.className))).toEqual(stableTokens(String(before.className)));
    for (const token of ['min-h-[44px]', 'px-3', 'leading-[normal]']) {
      expect(after.className).toContain(token);
    }
    expect(after.className).not.toContain('py-');
    expect(after.textAlignVertical).toBe('center');
    expect(after.style).toBeUndefined();

    // The message is a sibling of the input, not part of its content, so the
    // text inside the box cannot move when it appears.
    const input = mounted.root.findByType('TextInput');
    const status = mounted.root.findByType(AccessibleStatus);
    expect(status.findByType('Text').props.children).toBe(i18n.t('login.pleaseEnterEmail'));
    expect(input.findAllByType(AccessibleStatus)).toHaveLength(0);
  });
});

describe('FormField direction-aware content alignment', () => {
  function mountInput(props: { style?: { textAlign: 'center' }; textAlign?: 'center' } = {}) {
    act(() => {
      renderer = TestRenderer.create(
        createElement(FormField, { label: i18n.t('login.emailAddress'), ...props })
      );
    });
    if (!renderer) {
      throw new Error('renderer was not created');
    }
    return renderer.root.findByType('TextInput');
  }

  it('right-aligns the field content in a right-to-left interface', () => {
    // The label mirrors to the right edge with the rest of the RTL layout, so
    // the value must sit on the same side even when it is Latin (an email
    // address, whose own strong direction would otherwise stay left).
    rtl.isRTL = true;

    expect(mountInput().props.style).toEqual([{ textAlign: 'right' }, undefined]);
  });

  it('leaves the field style to the caller in a left-to-right interface', () => {
    rtl.isRTL = false;

    expect(mountInput().props.style).toBeUndefined();
  });

  it('keeps an explicit caller alignment after the RTL default', () => {
    rtl.isRTL = true;
    const centered = { textAlign: 'center' } as const;

    expect(mountInput({ style: centered }).props.style).toEqual([{ textAlign: 'right' }, centered]);
  });

  it('keeps an explicit caller alignment passed as a prop after the RTL default', () => {
    // The shared field threads a `textAlign` prop straight to `Input`, so the
    // prop channel must survive the RTL default exactly like the style channel.
    rtl.isRTL = true;

    expect(flattenStyle(mountInput({ textAlign: 'center' }).props.style).textAlign).toBe('center');
  });
});
