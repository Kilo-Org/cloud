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

/** Focuses the field's input, the state that opens the reserved slot. */
function focusInput(mounted: TestRenderer.ReactTestRenderer): void {
  const inputProps = mounted.root.findByType('TextInput').props as {
    onFocus: (event: unknown) => void;
  };
  act(() => {
    inputProps.onFocus({});
  });
}

/** The reserved-slot nodes, present only while the field is edited or in error. */
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

      // The slot exists only while the field is edited or in error, so the
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

  it('reserves the slot only while the field is edited or in error', () => {
    const ownError = i18n.t('login.pleaseEnterEmail');
    const mounted = mountField({
      label: i18n.t('login.emailAddress'),
      reserveErrorMessages: [ownError],
      validate: (value: string) => (value === '' ? ownError : null),
    });
    const input = mounted.root.findByType('TextInput').props as {
      onBlur: (event: unknown) => void;
    };

    // An idle form keeps the section rhythm of the screen it sits on.
    expect(slot(mounted)).toHaveLength(0);
    // The slot opens on focus and stays while the field is edited.
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
  });
});

describe('FormField errors known from elsewhere', () => {
  const label = i18n.t('login.emailAddress');
  const ownError = i18n.t('login.pleaseEnterEmail');
  const submittedError = i18n.t('authErrors.invalidEmail');

  function mount(props: { error?: string }) {
    act(() => {
      renderer = TestRenderer.create(
        createElement(FormField, {
          label,
          validate: (value: string) => (value === '' ? ownError : null),
          ...props,
        })
      );
    });
    if (!renderer) {
      throw new Error('renderer was not created');
    }
    return renderer;
  }

  function shownError(mounted: TestRenderer.ReactTestRenderer) {
    const texts = mounted.root.findByType(AccessibleStatus).findAllByType('Text');
    return texts.map(node => node.props.children);
  }

  function inputHandlers(mounted: TestRenderer.ReactTestRenderer) {
    return mounted.root.findByType('TextInput').props as {
      onBlur: (event: unknown) => void;
      onChangeText: (value: string) => void;
    };
  }

  it('shows a rejected submit before the field has been blurred', () => {
    const mounted = mount({ error: submittedError });
    expect(shownError(mounted)).toEqual([submittedError]);
    expect(mounted.root.findByType('TextInput').props.className).toContain('border-destructive');
  });

  it("lets the field's own rule speak first once it has something to say", () => {
    const mounted = mount({ error: submittedError });
    act(() => {
      inputHandlers(mounted).onBlur({});
    });
    expect(shownError(mounted)).toEqual([ownError]);
  });

  it('returns to the externally known error once the value satisfies the rule', () => {
    const mounted = mount({ error: submittedError });
    act(() => {
      inputHandlers(mounted).onBlur({});
    });
    act(() => {
      inputHandlers(mounted).onChangeText('dev@example.com');
    });
    expect(shownError(mounted)).toEqual([submittedError]);
  });
});

describe('FormField validation while typing', () => {
  const label = i18n.t('login.emailAddress');
  const ownError = i18n.t('authErrors.invalidEmail');
  const validEmail = 'dev@example.com';

  function mount(props: { validateWhileTyping?: boolean } = {}) {
    act(() => {
      renderer = TestRenderer.create(
        createElement(FormField, {
          label,
          validate: (value: string) => (value === validEmail ? null : ownError),
          ...props,
        })
      );
    });
    if (!renderer) {
      throw new Error('renderer was not created');
    }
    return renderer;
  }

  function shownError(mounted: TestRenderer.ReactTestRenderer) {
    return mounted.root
      .findByType(AccessibleStatus)
      .findAllByType('Text')
      .map(node => node.props.children);
  }

  function inputHandlers(mounted: TestRenderer.ReactTestRenderer) {
    return mounted.root.findByType('TextInput').props as {
      onBlur: (event: unknown) => void;
      onChangeText: (value: string) => void;
    };
  }

  it('shows the rule on a non-empty invalid value without a blur', () => {
    const mounted = mount({ validateWhileTyping: true });
    act(() => {
      inputHandlers(mounted).onChangeText('dev@example');
    });
    expect(shownError(mounted)).toEqual([ownError]);
  });

  it('waits for the first blur while the value is empty', () => {
    const mounted = mount({ validateWhileTyping: true });
    act(() => {
      inputHandlers(mounted).onChangeText('');
    });
    expect(shownError(mounted)).toEqual([]);
    act(() => {
      inputHandlers(mounted).onBlur({});
    });
    expect(shownError(mounted)).toEqual([ownError]);
  });

  it('clears the message once the typed value becomes valid', () => {
    const mounted = mount({ validateWhileTyping: true });
    act(() => {
      inputHandlers(mounted).onChangeText('dev@example');
    });
    act(() => {
      inputHandlers(mounted).onChangeText(validEmail);
    });
    expect(shownError(mounted)).toEqual([]);
  });

  it('keeps blur-only validation for a field that does not opt in', () => {
    const mounted = mount();
    act(() => {
      inputHandlers(mounted).onChangeText('dev@example');
    });
    expect(shownError(mounted)).toEqual([]);
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

  function textAlign(input: TestRenderer.ReactTestInstance): unknown {
    return flattenStyle(input.props.style).textAlign;
  }

  it('right-aligns the field content in a right-to-left interface', () => {
    // The label mirrors to the right edge with the rest of the RTL layout, so
    // the value must sit on the same side even when it is Latin (an email
    // address, whose own strong direction would otherwise stay left).
    rtl.isRTL = true;
    expect(textAlign(mountInput())).toBe('right');
  });

  it('leaves the field alignment to the caller in a left-to-right interface', () => {
    rtl.isRTL = false;
    expect(textAlign(mountInput())).toBeUndefined();
  });

  it('keeps an explicit caller alignment after the RTL default', () => {
    rtl.isRTL = true;
    expect(textAlign(mountInput({ style: { textAlign: 'center' } }))).toBe('center');
  });

  it('keeps an explicit caller alignment passed as a prop after the RTL default', () => {
    // The shared field threads a `textAlign` prop straight to `Input`, so the
    // prop channel must survive the RTL default exactly like the style channel.
    rtl.isRTL = true;
    expect(textAlign(mountInput({ textAlign: 'center' }))).toBe('center');
  });
});
