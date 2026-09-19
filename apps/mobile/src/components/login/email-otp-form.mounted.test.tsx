// eslint-disable-next-line import/no-nodejs-modules -- Use the compiler's compatible CommonJS export.
import { createRequire } from 'node:module';
import tailwindcss from '@tailwindcss/postcss';
import postcss from 'postcss';
import { type ComponentProps, createElement } from 'react';
import { I18nManager, Text as NativeText, Pressable, TextInput } from 'react-native';
import type * as NativeCSSCompiler from 'react-native-css/compiler';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { i18n } from '@/i18n';
import ar from '@/i18n/locales/ar.json';
import { act, TestRenderer } from '@/test/renderer';
import { EmailOtpForm } from './email-otp-form';

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#ECECEE', mutedForeground: '#8B8B94' }),
}));

const { compile } = createRequire(import.meta.url)(
  'react-native-css/compiler'
) as typeof NativeCSSCompiler;
type FormProps = ComponentProps<typeof EmailOtpForm>;
let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
const onResend = vi.fn<FormProps['onResend']>();
const onVerify = vi.fn<FormProps['onVerify']>();
const onBack = vi.fn<FormProps['onBack']>();

function renderForm(busy?: FormProps['busy']) {
  const element = createElement(EmailOtpForm, {
    email: 'user@example.com',
    busy,
    onResend,
    onVerify,
    onBack,
  });
  act(() => {
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing EmailOtpForm renderer');
  }
  return renderer.root;
}

function button(root: TestRenderer.ReactTestInstance, key: string) {
  return root.find(
    node => node.type === Pressable && node.props.accessibilityLabel === i18n.t(key)
  );
}

async function nativeLabelLayout(label: TestRenderer.ReactTestInstance) {
  const classes = (label.props.className as string)
    .split(' ')
    .filter(className => /^(?:flex-|text-center$)/.test(className))
    .join(' ');
  if (!classes) {
    return [];
  }
  const { css } = await postcss([tailwindcss()]).process(
    `@reference "../../global.css"; .target { @apply ${classes}; }`,
    { from: import.meta.filename }
  );
  return compile(css, { inlineVariables: false })
    .stylesheet()
    .s?.find(([name]) => name === 'target')?.[1]
    .flatMap(rule => rule.d ?? []);
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  i18n.addResourceBundle('ar', 'translation', ar);
});

afterEach(async () => {
  act(() => renderer?.unmount());
  renderer = undefined;
  I18nManager.isRTL = false;
  await i18n.changeLanguage('en');
  vi.unstubAllGlobals();
});

describe.each(['ar', 'en'])('EmailOtpForm resend layout in %s', language => {
  beforeEach(async () => {
    I18nManager.isRTL = language === 'ar';
    await i18n.changeLanguage(language);
  });

  it.each([undefined, 'otp-send', 'otp-verify'] as const)(
    'allocates the available row width to the complete label while busy=%s',
    async busy => {
      const root = renderForm(busy);
      const resend = button(root, 'login.resendCode');
      const label = resend.findByType(NativeText);
      expect(label.children).toEqual([i18n.t('login.resendCode')]);
      // Protect native sizing, not just utility names. Pixel wrapping is verified on device.
      expect(await nativeLabelLayout(label)).toEqual([
        { flexBasis: '0%', flexGrow: 1, flexShrink: 1, textAlign: 'center' },
      ]);
      // Larger accessibility text may still wrap naturally; never hide part of the copy.
      expect(label.props.numberOfLines).toBeUndefined();
      expect(label.props.adjustsFontSizeToFit).toBeUndefined();
      expect(label.props.allowFontScaling).not.toBe(false);
      expect(resend.props.disabled).toBe(busy !== undefined);
      expect(root.findAllByType(ActivityIndicator)).toHaveLength(busy ? 1 : 0);
    }
  );

  it('keeps resend and Back available with an empty code, and verifies a complete code', () => {
    const root = renderForm();
    expect(button(root, 'login.verifyCode').props.disabled).toBe(true);
    expect(button(root, 'login.resendCode').props.disabled).toBe(false);
    expect(button(root, 'common.back').props.disabled).toBe(false);
    act(() => {
      (button(root, 'common.back').props.onPress as () => void)();
      (root.findByType(TextInput).props.onChangeText as (value: string) => void)('123456');
    });
    expect(onBack).toHaveBeenCalledOnce();
    expect(button(root, 'login.verifyCode').props.disabled).toBe(false);
    act(() => {
      (button(root, 'login.verifyCode').props.onPress as () => void)();
    });
    expect(onVerify).toHaveBeenCalledWith('123456');
  });

  it('retains the resend control and label through a request and allows retry when it ends', () => {
    const root = renderForm();
    const resend = button(root, 'login.resendCode');
    const label = resend.findByType(NativeText);
    const labelClass = label.props.className;
    act(() => {
      (resend.props.onPress as () => void)();
    });
    expect(onResend).toHaveBeenCalledOnce();

    renderForm('otp-send');
    expect(root.findAllByType(Pressable).every(node => node.props.disabled)).toBe(true);
    expect(resend.findAllByType(ActivityIndicator)).toHaveLength(1);
    expect(resend.findByType(NativeText)).toBe(label);
    expect(label.props.className).toBe(labelClass);

    // The form receives the same idle state after success or a retryable failure.
    renderForm();
    expect(button(root, 'login.resendCode')).toBe(resend);
    expect(resend.findByType(NativeText)).toBe(label);
    expect(label.props.className).toBe(labelClass);
    expect(root.findAllByType(ActivityIndicator)).toHaveLength(0);
    expect(resend.props.disabled).toBe(false);
    act(() => {
      (resend.props.onPress as () => void)();
    });
    expect(onResend).toHaveBeenCalledTimes(2);
  });
});
