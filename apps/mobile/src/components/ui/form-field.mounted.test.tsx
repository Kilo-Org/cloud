/* eslint-disable max-lines -- the field's error, validation, alignment, gap and resting-preview suites share one react-native harness, so what is faked here reads as one answer. */
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FormField } from './form-field';
import { AccessibleStatus } from './accessible-status';
import { act, TestRenderer } from '@/test/renderer';
import { i18n } from '@/i18n';
import { lightColors } from '@/lib/hooks/theme-colors.generated';

const rtl = vi.hoisted(() => ({ isRTL: false }));
// Mutable so a suite can prove the placeholder follows the active palette. The
// inset is palette-independent; every suite resets the mock to the light tokens.
const appearance = vi.hoisted((): { colors: Record<string, string> } => ({ colors: {} }));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  View: 'View',
  TextInput: 'TextInput',
  Pressable: 'Pressable',
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

describe('FormField multiline accessible name', () => {
  const label = 'Environment (JSON)';
  const placeholder = '{\n  "API_KEY": "sk-..."\n}';

  function mountMultiline(props: { required?: boolean; error?: string } = {}) {
    act(() => {
      renderer = TestRenderer.create(
        createElement(FormField, { label, placeholder, multiline: true, ...props })
      );
    });
    if (!renderer) {
      throw new Error('renderer was not created');
    }
    return renderer.root.findByType('TextInput');
  }

  it('names the field by its label and keeps the example as the placeholder', () => {
    const input = mountMultiline();

    // A text area reads its example inside the box, not as part of its name:
    // the name must not change once the person types over the example.
    expect(input.props.accessibilityLabel).toBe(label);
    expect(input.props.placeholder).toBe(placeholder);
    expect(input.props.multiline).toBe(true);
  });

  it('appends the required and error state to the name, never the example', () => {
    const rawError = i18n.t('login.pleaseEnterEmail');
    const error = i18n.t('common.error', { error: rawError });
    const input = mountMultiline({ required: true, error: rawError });

    expect(input.props.accessibilityLabel).toBe(
      [label, i18n.t('common.required'), error].join(', ')
    );
    expect(input.props.accessibilityLabel).not.toContain('API_KEY');
    expect(input.props.placeholder).toBe(placeholder);
  });
});

describe('FormField label-to-input gap', () => {
  function mountField(gapClassName?: string) {
    act(() => {
      renderer = TestRenderer.create(
        createElement(FormField, {
          label: i18n.t('login.emailAddress'),
          ...(gapClassName === undefined ? {} : { gapClassName }),
        })
      );
    });
    if (!renderer) {
      throw new Error('renderer was not created');
    }
    // The block root carries `gap-1.5`; the wrapper carries the caller's gap
    // class and wraps the label row and the input. `findAllByType` is
    // self-inclusive and pre-order, so the root can also match the default
    // class — exclude it to hold the pair's own node.
    const root = renderer.root.findByType('View');
    const wrapper = root
      .findAllByType('View')
      .find(node => node !== root && String(node.props.className) === (gapClassName ?? 'gap-1.5'));
    if (wrapper === undefined) {
      throw new Error('the label-to-input wrapper was not rendered');
    }
    return { root, wrapper };
  }

  it('keeps the compact default on the label-to-input pair', () => {
    // An ordinary field's label row and input sit one small gap apart: the
    // wrapper's own default is the compact gap, distinct from the block
    // root's gap to the message slot below.
    const { root, wrapper } = mountField();
    expect(wrapper).not.toBe(root);
    expect(String(wrapper.props.className)).toContain('gap-1.5');
    expect(String(root.props.className)).toContain('gap-1.5');
  });

  it('puts the caller gap on the label-to-input pair only', () => {
    // A screen whose row controls hover over the label line passes
    // COMMAND_ROW_FIELD_GAP_CLASS so the controls' touch band ends above the
    // input's edge. The class lands on the wrapper around the label row and
    // the input; the block root keeps `gap-1.5`, so an error or reserved
    // message below the input keeps the ordinary spacing.
    const { root, wrapper } = mountField('gap-y-[16px]');
    expect(String(wrapper.props.className)).toBe('gap-y-[16px]');
    expect(String(root.props.className)).toBe('gap-1.5');
  });
});

describe('FormField resting value preview', () => {
  const label = i18n.t('login.emailAddress');
  // A value longer than the box: the case Android draws from its tail with the
  // first glyph cut while the field rests.
  const longValue = 'person.with.a.long.address@example.com';

  function mountField(props: Partial<React.ComponentProps<typeof FormField>> = {}) {
    act(() => {
      renderer = TestRenderer.create(createElement(FormField, { label, ...props }));
    });
    if (!renderer) {
      throw new Error('renderer was not created');
    }
    return renderer;
  }

  function previewText(mounted: TestRenderer.ReactTestRenderer) {
    // The preview is the only text inside the pressable box; the field's own
    // label and message sit outside it.
    return mounted.root
      .findByType('Pressable')
      .findAllByType('Text')
      .map(node => node.props.children);
  }

  /** The preview box, typed so a test can read its press and its state. */
  function preview(mounted: TestRenderer.ReactTestRenderer) {
    return mounted.root.findByType('Pressable').props as {
      onPress: () => void;
      disabled?: boolean;
      accessibilityState: { disabled?: boolean };
    };
  }

  /** The real input's handlers, typed so a test can type and blur. */
  function inputHandlers(mounted: TestRenderer.ReactTestRenderer) {
    return mounted.root.findByType('TextInput').props as {
      onChangeText: (value: string) => void;
      onBlur: (event: unknown) => void;
    };
  }

  it('shows a resting single-line value from its start without the input', () => {
    const mounted = mountField({ defaultValue: longValue });

    // Android keeps a resting one-line EditText scrolled to its caret, so the
    // real input would paint this value's tail; the preview paints its start.
    expect(previewText(mounted)).toEqual([longValue]);
    expect(mounted.root.findAllByType('TextInput')).toHaveLength(0);
  });

  it('swaps the real input in when the preview is pressed', () => {
    const mounted = mountField({ defaultValue: longValue });

    act(() => {
      preview(mounted).onPress();
    });

    expect(mounted.root.findAllByType('Pressable')).toHaveLength(0);
    const input = mounted.root.findByType('TextInput');
    // The swap keeps the value and asks for focus, so the keyboard opens with it.
    expect(input.props.defaultValue).toBe(longValue);
    expect(input.props.autoFocus).toBe(true);
  });

  it('shows the typed value in the preview again after a blur', () => {
    const mounted = mountField({ defaultValue: longValue });
    const typed = 'person@example.com';

    act(() => {
      preview(mounted).onPress();
    });
    act(() => {
      inputHandlers(mounted).onChangeText(typed);
    });
    act(() => {
      inputHandlers(mounted).onBlur({});
    });

    expect(previewText(mounted)).toEqual([typed]);
    expect(mounted.root.findAllByType('TextInput')).toHaveLength(0);
  });

  it('keeps the real input for a multiline field', () => {
    const mounted = mountField({ defaultValue: longValue, multiline: true });

    expect(mounted.root.findAllByType('Pressable')).toHaveLength(0);
    expect(mounted.root.findByType('TextInput').props.multiline).toBe(true);
  });

  it('keeps the real input for a masked field', () => {
    const mounted = mountField({ defaultValue: longValue, secureTextEntry: true });

    // A masked value's dots are all the box can show; a preview would print the
    // plaintext it exists to hide.
    expect(mounted.root.findAllByType('Pressable')).toHaveLength(0);
    expect(mounted.root.findByType('TextInput').props.secureTextEntry).toBe(true);
  });

  it('keeps the real input for an empty field so its placeholder shows', () => {
    const mounted = mountField({ defaultValue: '', placeholder: i18n.t('login.emailAddress') });

    expect(mounted.root.findAllByType('Pressable')).toHaveLength(0);
    expect(mounted.root.findByType('TextInput').props.placeholder).toBe(
      i18n.t('login.emailAddress')
    );
  });

  it('marks a disabled field’s preview disabled and refuses the swap', () => {
    const mounted = mountField({ defaultValue: longValue, disabled: true });
    const box = preview(mounted);

    expect(box.accessibilityState.disabled).toBe(true);
    // The press is inert, so a disabled field cannot open an editor.
    expect(box.disabled).toBe(true);
  });

  it('carries no role of its own and lets the value be selected', () => {
    const mounted = mountField({ defaultValue: longValue });
    const box = mounted.root.findByType('Pressable');
    const text = box.findByType('Text');

    // The field is a text field, not a button, and the app localizes every
    // string it shows, so the resting box adds no role or hint of its own.
    expect(box.props.accessibilityRole).toBeUndefined();
    expect(box.props.accessibilityHint).toBeUndefined();
    // Android runs selection on a plain text node, so a resting value can be
    // selected and copied there, as it could inside the native input. iOS shows
    // an empty edit menu for that, so the preview does not rely on it: entering
    // the field with one press gives the real input, where the value is
    // selectable on both platforms.
    expect(text.props.selectable).toBe(true);
    // The line height lands on the painted line, not on the `View` around it.
    expect(box.props.className).not.toContain('leading-[normal]');
    expect(String(text.props.className)).toContain('leading-[normal]');
  });

  it('enters the field on an assistive activation, and not while disabled', () => {
    const enabled = mountField({ defaultValue: longValue });
    const enabledHandler = enabled.root.findByType('Pressable').props as {
      onAccessibilityAction: (event: { nativeEvent: { actionName: string } }) => void;
    };
    act(() => {
      enabledHandler.onAccessibilityAction({ nativeEvent: { actionName: 'activate' } });
    });
    expect(enabled.root.findAllByType('Pressable')).toHaveLength(0);
    expect(enabled.root.findByType('TextInput')).toBeDefined();

    // A disabled field has nothing to enter, so the same action changes nothing:
    // the resting box stays and no editor opens.
    const disabled = mountField({ defaultValue: longValue, disabled: true });
    const disabledHandler = disabled.root.findByType('Pressable').props as {
      onAccessibilityAction: (event: { nativeEvent: { actionName: string } }) => void;
    };
    act(() => {
      disabledHandler.onAccessibilityAction({ nativeEvent: { actionName: 'activate' } });
    });
    expect(disabled.root.findAllByType('Pressable')).toHaveLength(1);
    expect(disabled.root.findAllByType('TextInput')).toHaveLength(0);
  });
});
