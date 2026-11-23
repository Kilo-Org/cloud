/* eslint-disable max-lines -- the layout, script-fold, and notice suites share one mock harness; splitting them would duplicate the react-native and theme-color setup */
import { type ComponentProps, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { SUPPORTED_LANGUAGES } from '@/i18n/languages';
import { act, TestRenderer } from '@/test/renderer';
import { EmailOtpForm } from '../email-otp-form';

const i18nManager = vi.hoisted(() => ({ isRTL: false }));

vi.mock('react-native', () => ({
  I18nManager: i18nManager,
  TextInput: 'TextInput',
  View: 'View',
}));
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

/** The label text drawn inside the action button with this accessibility label. */
function actionLabel(root: TestRenderer.ReactTestInstance, accessibilityLabel: string) {
  return root
    .findByProps({ accessibilityLabel })
    .find(node => typeof node.type === 'string' && (node.type as string) === 'Text');
}

/** The notice lines in the measured block, in render order. */
function noticeTexts(root: TestRenderer.ReactTestInstance) {
  return root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Text' &&
      node.props.accessibilityLiveRegion === 'polite'
  );
}

/**
 * The catalog message with the address pulled flush against its neighbours:
 * the layout break that puts the address on its own line replaces the space
 * beside it, so the rendered text without breaks is the sentence without those
 * two spaces.
 */
function withoutAddressGaps(message: string, email: string): string {
  const [before = '', after = ''] = message.split(email);
  return `${before.trimEnd()}${email}${after.trimStart()}`;
}

afterEach(async () => {
  act(() => renderer?.unmount());
  renderer = undefined;
  i18nManager.isRTL = false;
  await i18n.changeLanguage('en');
});

describe('EmailOtpForm destination layout', () => {
  it.each(SUPPORTED_LANGUAGES)(
    'keeps the %s message intact and never strands its punctuation on its own line',
    async language => {
      await i18n.changeLanguage(language);
      expect(i18n.resolvedLanguage).toBe(language);
      const { mounted } = mount();
      const text = destination(mounted.root).props.children as string;
      const lines = text.split('\n');
      const message = i18n.t('login.enterCodeSentTo', { email: reportedEmail });

      // The break beside the address replaces the space it separates: aside from
      // those breaks and the spaces they replaced, the catalog message is intact.
      expect(text.replaceAll('\n', '')).toBe(withoutAddressGaps(message, reportedEmail));
      // No line starts or ends with the space a break replaced, so the wrapped
      // line never renders indented (Hindi reported `…\n पर भेजा गया…`).
      for (const line of lines) {
        expect(line).toBe(line.trim());
      }
      // The address begins a line, so a long address cannot break mid-word.
      expect(lines.some(line => line.startsWith(reportedEmail))).toBe(true);
      // Sentence text and its punctuation stay attached: no lone "." line.
      for (const line of lines.map(part => part.trim()).filter(Boolean)) {
        expect(line).not.toMatch(PUNCTUATION_ONLY);
      }
    }
  );

  it('shortens a long destination without changing code submission', () => {
    const email = `${'a'.repeat(3496)}@example.com`;
    const { mounted, props } = mount({ email });
    const displayedEmail = `${email.slice(0, 24)}…${email.slice(-23)}`;
    const text = destination(mounted.root, displayedEmail).props.children as string;
    expect(text.replaceAll('\n', '')).toBe(
      withoutAddressGaps(i18n.t('login.enterCodeSentTo', { email: displayedEmail }), displayedEmail)
    );
    expect(text).not.toContain(email);
    const node = destination(mounted.root, displayedEmail);
    expect(node.props.numberOfLines).toBeUndefined();
    expect(node.props.ellipsizeMode).toBeUndefined();
    expect(node.props.allowFontScaling).not.toBe(false);
    expect(node.props.adjustsFontSizeToFit).not.toBe(true);
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
  });

  it.each(['otp-send', 'otp-verify'] as const)(
    'keeps the destination unchanged through %s and recovery',
    busy => {
      const { mounted, props } = mount();
      const initialDescription = destination(mounted.root).props.children;

      act(() => {
        mounted.update(createElement(EmailOtpForm, { ...props, busy }));
      });

      expect(destination(mounted.root).props.children).toBe(initialDescription);
      for (const button of mounted.root.findAllByType('Button')) {
        expect(button.props.disabled).toBe(true);
      }

      const verify = mounted.root.findByProps({ accessibilityLabel: 'Verify code' });
      const resend = mounted.root.findByProps({ accessibilityLabel: 'Resend code' });
      // Button renders the spinner from its `loading` prop, not from a form
      // child, so the form never mounts an indicator of its own: the label's
      // reserved row is the same in both states and never shifts.
      expect(mounted.root.findAllByType('ActivityIndicator')).toHaveLength(0);
      if (busy === 'otp-verify') {
        // Verify owns the busy state.
        expect(verify.props.loading).toBe(true);
        expect(resend.props.loading).toBe(false);
      } else {
        // Resend owns its own busy state through Button's `loading`; Verify is
        // disabled but not busy, so it must keep the muted disabled fill, not
        // the brand-filled busy treatment.
        expect(verify.props.loading).not.toBe(true);
        expect(resend.props.loading).toBe(true);
      }

      act(() => {
        mounted.update(createElement(EmailOtpForm, props));
      });

      expect(destination(mounted.root).props.children).toBe(initialDescription);
      expect(mounted.root.findAllByType('ActivityIndicator')).toHaveLength(0);
      const idleResend = mounted.root.findByProps({ accessibilityLabel: 'Resend code' });
      expect(idleResend.props.disabled).toBe(false);
      act(() => {
        (idleResend.props.onPress as () => void)();
      });
      expect(props.onResend).toHaveBeenCalledOnce();
    }
  );
});

describe('EmailOtpForm button labels', () => {
  // The reported capture: the Arabic secondary label ("إعادة إرسال الرمز")
  // wrapped onto two lines inside a full-width button, so the copy did not fit
  // its control. Pin the label to one line and keep the full text as the
  // control's accessible name.
  it.each(['en', 'ar'])('keeps the resend label on one line in %s', async language => {
    await i18n.changeLanguage(language);
    const { mounted } = mount();

    const resend = label(mounted.root, i18n.t('login.resendCode'));
    expect(resend.props.numberOfLines).toBe(1);
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
    // Disabled but not busy: no loading flag, so Button keeps the muted
    // disabled fill instead of the brand-filled busy treatment.
    expect(verify.props.loading).not.toBe(true);
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

  it.each([
    ['Arabic-Indic', '٢٤٦٨١٠'],
    ['Extended Arabic-Indic', '۲۴۶۸۱۰'],
    ['Thai', '๒๔๖๘๑๐'],
    ['full-width', '２４６８１０'],
    ['mixed Latin and Urdu', '۲468١0'],
  ])('verifies a code typed in %s digits', (_script, typed) => {
    const { mounted, props } = mount();
    const input = mounted.root.findByType('TextInput');
    act(() => {
      (input.props.onChangeText as (value: string) => void)(typed);
    });

    const verify = mounted.root.findByProps({ accessibilityLabel: 'Verify code' });
    expect(verify.props.disabled).toBe(false);
    act(() => {
      (verify.props.onPress as () => void)();
    });

    expect(props.onVerify).toHaveBeenCalledWith('246810');
  });
});

describe('EmailOtpForm action labels', () => {
  it.each([
    { language: 'en', isRTL: false },
    { language: 'ar', isRTL: true },
  ])('keeps both stacked action labels on one line in $language', async ({ language, isRTL }) => {
    i18nManager.isRTL = isRTL;
    await i18n.changeLanguage(language);
    const { mounted } = mount();

    const verify = actionLabel(mounted.root, i18n.t('login.verifyCode'));
    const resend = actionLabel(mounted.root, i18n.t('login.resendCode'));

    // The row and its content width belong to the shared Button; each label
    // stays on one line, so neither stacked action can outgrow the other
    // (the Arabic resend copy once wrapped and orphaned "الرمز" on a second
    // line).
    expect(verify.props.children).toBe(i18n.t('login.verifyCode'));
    expect(resend.props.children).toBe(i18n.t('login.resendCode'));
    expect(verify.props.numberOfLines).toBe(1);
    expect(resend.props.numberOfLines).toBe(1);
  });

  it('keeps both labels on one line while a send or verify is in flight', () => {
    const { mounted, props } = mount();

    act(() => {
      mounted.update(createElement(EmailOtpForm, { ...props, busy: 'otp-send' }));
    });

    // Button owns the busy spinner (from `loading`), so the form adds no child
    // indicator and the labels keep their single-line box, so the row height
    // stays the same between idle and busy.
    const resend = mounted.root.findByProps({ accessibilityLabel: i18n.t('login.resendCode') });
    expect(resend.props.loading).toBe(true);
    expect(mounted.root.findAllByType('ActivityIndicator')).toHaveLength(0);
    expect(actionLabel(mounted.root, i18n.t('login.verifyCode')).props.numberOfLines).toBe(1);
    expect(actionLabel(mounted.root, i18n.t('login.resendCode')).props.numberOfLines).toBe(1);
  });
});

describe('EmailOtpForm code-step notices', () => {
  const TERMINAL_COPY =
    "That code is incorrect or expired. Use 'Resend code' or 'More sign-in options'.";
  const RATE_LIMITED_COPY = 'Too many sign-in attempts. Please wait and try again.';

  it('renders every notice on its own line in list order', () => {
    const { mounted } = mount({
      notices: [
        { kind: 'terminal', message: TERMINAL_COPY },
        { kind: 'refusal', message: RATE_LIMITED_COPY },
      ],
    });

    const rendered = noticeTexts(mounted.root);
    expect(rendered.map(node => node.props.children)).toEqual([TERMINAL_COPY, RATE_LIMITED_COPY]);
    for (const node of rendered) {
      expect(node.props.accessibilityLiveRegion).toBe('polite');
    }
    // The sentence that names the control is not replaced by the newest
    // failure, so the step never shows a failure beside a control it does not
    // explain.
    expect(
      mounted.root.findByProps({ accessibilityLabel: i18n.t('login.moreSignInOptions') })
    ).toBeTruthy();
  });

  it('paints the confirmation as the neutral line and a refusal destructive', () => {
    const { mounted } = mount({
      notices: [
        { kind: 'refusal', message: RATE_LIMITED_COPY },
        { kind: 'confirmation', message: 'Code sent' },
      ],
    });

    const [refusal, confirmation] = noticeTexts(mounted.root);
    expect(refusal?.props.className).toBe('text-center text-destructive');
    expect(confirmation?.props.className).toBe('text-center');
    expect(confirmation?.props.className).not.toContain('text-destructive');
  });
});

describe('EmailOtpForm alternative sign-in', () => {
  // The control renders from the notice kinds, not from a handler: a notice a
  // code cannot clear offers it, and a retryable refusal alone does not.
  it('offers no other sign-in method without a notice', () => {
    const { mounted } = mount();
    expect(
      mounted.root.findAllByProps({ accessibilityLabel: i18n.t('login.moreSignInOptions') })
    ).toHaveLength(0);
  });

  it('offers no other sign-in method for a retryable refusal alone', () => {
    const { mounted } = mount({
      notices: [
        { kind: 'refusal', message: 'Too many sign-in attempts. Please wait and try again.' },
      ],
    });
    expect(
      mounted.root.findAllByProps({ accessibilityLabel: i18n.t('login.moreSignInOptions') })
    ).toHaveLength(0);
  });

  it('offers the other sign-in methods a notice a code cannot clear names', () => {
    const onAlternativeSignIn = vi.fn<() => void>();
    const { mounted } = mount({
      notices: [
        {
          kind: 'terminal',
          message:
            "That code is incorrect or expired. Use 'Resend code' or 'More sign-in options'.",
        },
      ],
      onAlternativeSignIn,
    });

    const alternatives = mounted.root.findByProps({
      accessibilityLabel: i18n.t('login.moreSignInOptions'),
    });
    expect(alternatives.props.disabled).toBe(false);
    expect(alternatives.props.loading).not.toBe(true);
    act(() => {
      (alternatives.props.onPress as () => void)();
    });
    expect(onAlternativeSignIn).toHaveBeenCalledOnce();
  });

  // A confirmation replaces the terminal sentence in the same slot, and the
  // ways out exist exactly because the address stays one the code route cannot
  // take: the control survives the swapping copy.
  it('keeps the other sign-in methods for a confirmation', () => {
    const { mounted } = mount({
      notices: [{ kind: 'confirmation', message: 'Code sent' }],
    });
    expect(
      mounted.root.findByProps({ accessibilityLabel: i18n.t('login.moreSignInOptions') })
    ).toBeTruthy();
  });

  // The mounted flow proves the control's presence and wiring; this pins the
  // busy edge it cannot see: the whole step locks while the browser opens.
  it('disables the step and spins the action while the alternative sign-in starts', () => {
    const { mounted } = mount({
      notices: [{ kind: 'terminal', message: 'Use more sign-in options.' }],
      onAlternativeSignIn: vi.fn<() => void>(),
      alternativeSignInStarting: true,
    });
    for (const button of mounted.root.findAllByType('Button')) {
      expect(button.props.disabled).toBe(true);
    }
    expect(
      mounted.root.findByProps({ accessibilityLabel: i18n.t('login.moreSignInOptions') }).props
        .loading
    ).toBe(true);
  });
});
