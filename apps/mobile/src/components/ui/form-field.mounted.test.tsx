import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FormField } from './form-field';
import { AccessibleStatus } from './accessible-status';
import { act, TestRenderer } from '@/test/renderer';
import { i18n } from '@/i18n';
import { lightColors } from '@/lib/hooks/theme-colors.generated';
import ar from '@/i18n/locales/ar.json';
import en from '@/i18n/locales/en.json';

const rtl = vi.hoisted(() => ({ isRTL: false }));
// Mutable so a suite can prove the placeholder follows the active palette. The
// inset is palette-independent; every suite resets the mock to the light tokens.
const appearance = vi.hoisted((): { colors: Record<string, string> } => ({ colors: {} }));
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
  useThemeColors: () => appearance.colors,
}));
vi.mock('@/lib/a11y/status-announcement', () => ({ useStatusAnnouncement: vi.fn() }));

appearance.colors = lightColors;

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

afterEach(() => {
  rtl.isRTL = false;
  appearance.colors = lightColors;
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
    'hides reserved messages and announces errors through recovery in %s',
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
      expect(reserved.props.pointerEvents).toBe('none');
      expect(reserved.props.accessibilityElementsHidden).toBe(true);
      expect(mounted.root.findByType(AccessibleStatus).findAllByType('Text')).toHaveLength(0);

      for (const error of [...reserveErrorMessages, undefined]) {
        act(() => {
          mounted.update(createElement(FormField, { ...props, error }));
        });
        const status = mounted.root.findByType(AccessibleStatus);
        expect(status.findAllByType('Text').map(node => node.props.children)).toEqual(
          error ? [error] : []
        );
        const input = mounted.root.findByType('TextInput');
        if (error) {
          expect(input.props.accessibilityLabel).toContain(error);
          expect(status.findByType('Text').props.accessibilityLiveRegion).toBe('polite');
        } else {
          expect(input.props.accessibilityLabel).toBe(props.label);
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
    expect(renderer?.root.findByType(AccessibleStatus).findByType('Text').props.children).toBe(
      i18n.t('login.pleaseEnterEmail')
    );
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

    expect(flattenStyle(mountInput().props.style).textAlign).toBe('right');
  });

  it('leaves the field alignment to the caller in a left-to-right interface', () => {
    rtl.isRTL = false;

    expect(flattenStyle(mountInput().props.style).textAlign).toBeUndefined();
  });

  it('keeps an explicit caller alignment after the RTL default', () => {
    rtl.isRTL = true;
    const centered = { textAlign: 'center' } as const;

    expect(flattenStyle(mountInput({ style: centered }).props.style).textAlign).toBe('center');
  });

  it('keeps an explicit caller alignment passed as a prop after the RTL default', () => {
    // The shared field threads a `textAlign` prop straight to `Input`, so the
    // prop channel must survive the RTL default exactly like the style channel.
    rtl.isRTL = true;

    expect(flattenStyle(mountInput({ textAlign: 'center' }).props.style).textAlign).toBe('center');
  });
});
