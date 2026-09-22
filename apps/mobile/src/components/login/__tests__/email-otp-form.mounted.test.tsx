import { type ComponentProps, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { SUPPORTED_LANGUAGES } from '@/i18n/languages';
import { act, TestRenderer } from '@/test/renderer';
import { EmailOtpForm } from '../email-otp-form';

vi.mock('react-native', () => ({ TextInput: 'TextInput', View: 'View' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666666' }),
}));

type Props = ComponentProps<typeof EmailOtpForm>;
const reportedEmail = 'e2e-firstrun-1789794214@example.com';
const PUNCTUATION_ONLY = /^[\p{P}\p{S}]+$/u;
let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function mount(overrides: Partial<Props> = {}) {
  const props: Props = {
    email: reportedEmail,
    busy: undefined,
    onVerify: vi.fn<Props['onVerify']>(),
    onResend: vi.fn<Props['onResend']>(),
    onBack: vi.fn<Props['onBack']>(),
    ...overrides,
  };
  act(() => {
    renderer = TestRenderer.create(createElement(EmailOtpForm, props));
  });
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return { mounted: renderer, props };
}

function destination(root: TestRenderer.ReactTestInstance, email = reportedEmail) {
  return root.find(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Text' &&
      typeof node.props.children === 'string' &&
      node.props.children.includes(email)
  );
}

function label(root: TestRenderer.ReactTestInstance, copy: string) {
  return root.find(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Text' &&
      node.props.children === copy
  );
}

afterEach(async () => {
  act(() => renderer?.unmount());
  renderer = undefined;
  await i18n.changeLanguage('en');
});

describe('EmailOtpForm destination layout', () => {
  it('starts the reported address on its own line instead of sharing the instruction', () => {
    const { mounted } = mount();
    const text = destination(mounted.root).props.children as string;

    expect(text.split('\n')).toEqual(['Enter the code sent to ', reportedEmail]);
  });

  it.each(SUPPORTED_LANGUAGES)(
    'keeps the %s message intact and never strands its punctuation on its own line',
    async language => {
      await i18n.changeLanguage(language);
      expect(i18n.resolvedLanguage).toBe(language);
      const { mounted } = mount();
      const text = destination(mounted.root).props.children as string;
      const lines = text.split('\n');

      // Removing the layout line breaks reproduces the catalog message exactly.
      expect(text.replaceAll('\n', '')).toBe(
        i18n.t('login.enterCodeSentTo', { email: reportedEmail })
      );
      // The address begins a line, so a long address cannot break mid-word.
      expect(lines.some(line => line.startsWith(reportedEmail))).toBe(true);
      // Sentence text and its punctuation stay attached: no lone "." line.
      for (const line of lines.map(part => part.trim()).filter(Boolean)) {
        expect(line).not.toMatch(PUNCTUATION_ONLY);
      }
    }
  );

  it.each(['a@example.com', `${'long-address-'.repeat(5)}@example.com`])(
    'preserves the complete address and native font scaling for %s',
    email => {
      const { mounted } = mount({ email });
      const node = destination(mounted.root, email);

      expect((node.props.children as string).split('\n')).toContain(email);
      expect(node.props.numberOfLines).toBeUndefined();
      expect(node.props.ellipsizeMode).toBeUndefined();
      expect(node.props.allowFontScaling).not.toBe(false);
      expect(node.props.adjustsFontSizeToFit).not.toBe(true);
    }
  );

  it.each(['otp-send', 'otp-verify'] as const)(
    'keeps the destination unchanged through %s and recovery',
    busy => {
      const { mounted, props } = mount();
      const initialDescription = destination(mounted.root).props.children;

      act(() => {
        mounted.update(createElement(EmailOtpForm, { ...props, busy }));
      });

      expect(destination(mounted.root).props.children).toBe(initialDescription);
      expect(mounted.root.findAllByType('ActivityIndicator')).toHaveLength(1);
      for (const button of mounted.root.findAllByType('Button')) {
        expect(button.props.disabled).toBe(true);
      }

      act(() => {
        mounted.update(createElement(EmailOtpForm, props));
      });

      expect(destination(mounted.root).props.children).toBe(initialDescription);
      expect(mounted.root.findAllByType('ActivityIndicator')).toHaveLength(0);
      const resend = mounted.root.findByProps({ accessibilityLabel: 'Resend code' });
      expect(resend.props.disabled).toBe(false);
      act(() => {
        (resend.props.onPress as () => void)();
      });
      expect(props.onResend).toHaveBeenCalledOnce();
    }
  );
});

describe('EmailOtpForm button labels', () => {
  // The reported capture: the Arabic secondary label ("إعادة إرسال الرمز")
  // wrapped onto two lines inside a full-width button, so the copy did not fit
  // its control. A single-line label is the same remedy the sign-in provider
  // buttons and the segmented control take.
  it.each(['en', 'ar'])('keeps the resend label on one line in %s', async language => {
    await i18n.changeLanguage(language);
    const { mounted } = mount();

    const resend = label(mounted.root, i18n.t('login.resendCode'));
    expect(resend.props.numberOfLines).toBe(1);
    expect(resend.props.adjustsFontSizeToFit).toBe(true);
    // The full label stays the control's accessible name.
    expect(
      mounted.root.findByProps({ accessibilityLabel: i18n.t('login.resendCode') })
    ).toBeTruthy();
  });

  it('keeps the verify label on one line', () => {
    const { mounted } = mount();
    expect(label(mounted.root, 'Verify code').props.numberOfLines).toBe(1);
  });
});

describe('EmailOtpForm controls', () => {
  it('keeps empty-code verification disabled and allows returning to the email field', () => {
    const { mounted, props } = mount();

    const verify = mounted.root.findByProps({ accessibilityLabel: 'Verify code' });
    expect(verify.props.disabled).toBe(true);
    act(() => {
      (verify.props.onPress as () => void)();
    });
    expect(props.onVerify).not.toHaveBeenCalled();
    const back = mounted.root.findByProps({ accessibilityLabel: 'Back' });
    expect(back.props.disabled).toBe(false);
    act(() => {
      (back.props.onPress as () => void)();
    });
    expect(props.onBack).toHaveBeenCalledOnce();
  });

  it('verifies a complete code without changing the destination', () => {
    const { mounted, props } = mount();
    const initialDescription = destination(mounted.root).props.children;
    const input = mounted.root.findByType('TextInput');
    act(() => {
      (input.props.onChangeText as (value: string) => void)('123456');
    });

    const verify = mounted.root.findByProps({ accessibilityLabel: 'Verify code' });
    expect(verify.props.disabled).toBe(false);
    act(() => {
      (verify.props.onPress as () => void)();
    });

    expect(props.onVerify).toHaveBeenCalledWith('123456');
    expect(destination(mounted.root).props.children).toBe(initialDescription);
  });
});
