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

/** Focuses the field's input, the state that opens the reserved slot. */
function focusInput(mounted: TestRenderer.ReactTestRenderer): void {
  const inputProps = mounted.root.findByType('TextInput').props as {
    onFocus: (event: unknown) => void;
  };
  act(() => {
    inputProps.onFocus({});
  });
}

/** The reserved-slot nodes, present only once the field is focused or in error. */
function slot(mounted: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance[] {
  return mounted.root.findAllByProps({ importantForAccessibility: 'no-hide-descendants' });
}

/** Renders `FormField` with these props and asserts the mount took. */
function mountField(props: React.ComponentProps<typeof FormField>): TestRenderer.ReactTestRenderer {
  act(() => {
    renderer = TestRenderer.create(createElement(FormField, props));
  });
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
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
      const mounted = mountField(props);

      // The slot exists only once the field is focused or in error, so the
      // announce-through-recovery walk below runs with the field focused.
      focusInput(mounted);
      const reserved = slot(mounted);
      expect(reserved).toHaveLength(1);
      const reservedNode = reserved[0];
      if (!reservedNode) {
        throw new Error('the focused field reserved no slot');
      }
      expect(reservedNode.props.pointerEvents).toBe('none');
      expect(reservedNode.props.accessibilityElementsHidden).toBe(true);
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
    const mounted = mountField({
      label: i18n.t('login.emailAddress'),
      error: i18n.t('login.pleaseEnterEmail'),
    });
    expect(slot(mounted)).toHaveLength(0);
    expect(mounted.root.findByType(AccessibleStatus).findByType('Text').props.children).toBe(
      i18n.t('login.pleaseEnterEmail')
    );
  });

  it('reserves the slot from the first render when the caller opts out', () => {
    const mounted = mountField({
      label: i18n.t('login.emailAddress'),
      reserveErrorMessages: [i18n.t('login.pleaseEnterEmail')],
      alwaysReserve: true,
    });
    // The async-error and autoFocus flows shift layout when the slot mounts
    // late, so those callers reserve permanently and pay the idle line.
    expect(slot(mounted)).toHaveLength(1);
  });

  it('opens the slot at the first focus and keeps it after blurs', () => {
    const ownError = i18n.t('login.pleaseEnterEmail');
    const mounted = mountField({
      label: i18n.t('login.emailAddress'),
      reserveErrorMessages: [ownError],
      validate: (value: string) => (value === '' ? ownError : null),
    });
    const input = mounted.root.findByType('TextInput').props as {
      onBlur: (event: unknown) => void;
      onChangeText: (value: string) => void;
    };

    // An untouched form keeps the section rhythm of the screen it sits on.
    expect(slot(mounted)).toHaveLength(0);
    // The slot opens on focus and stays: a focus/blur cycle grows the form
    // once instead of moving the content below the field on every blur.
    focusInput(mounted);
    expect(slot(mounted)).toHaveLength(1);
    // After a blur that leaves an error showing, the slot stays with it.
    act(() => {
      input.onBlur({});
    });
    expect(slot(mounted)).toHaveLength(1);
    expect(mounted.root.findByType(AccessibleStatus).findByType('Text').props.children).toBe(
      ownError
    );
    // A later blur of a valid field keeps the line; the form never shrinks back.
    act(() => {
      const typing = mounted.root.findByType('TextInput').props as {
        onChangeText: (value: string) => void;
      };
      typing.onChangeText('dev@example.com');
    });
    expect(mounted.root.findByType(AccessibleStatus).findAllByType('Text')).toHaveLength(0);
    act(() => {
      input.onBlur({});
    });
    expect(slot(mounted)).toHaveLength(1);
    expect(mounted.root.findByType(AccessibleStatus).findAllByType('Text')).toHaveLength(0);
  });
});
