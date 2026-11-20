import { type ComponentProps, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { act, TestRenderer } from '@/test/renderer';
import { EmailOtpForm } from '../email-otp-form';

const i18nManager = vi.hoisted(() => ({ isRTL: false }));
// The code step empties its uncontrolled code field through the ref (iOS text
// input rules: no controlled value), so the mock exposes the imperative
// `clear` a real TextInput has and hosts the props on a `TextInput` node.
const clearCode = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
  const {
    createElement: createMockElement,
    forwardRef,
    useImperativeHandle,
  } = await import('react');
  const MockTextInput = forwardRef<{ clear: () => void }, Record<string, unknown>>((props, ref) => {
    useImperativeHandle(ref, () => ({ clear: clearCode }));
    return createMockElement('TextInput', props);
  });
  MockTextInput.displayName = 'MockTextInput';
  return {
    I18nManager: i18nManager,
    TextInput: MockTextInput,
    View: 'View',
  };
});
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666666' }),
}));

type Props = ComponentProps<typeof EmailOtpForm>;
const reportedEmail = 'e2e-firstrun-1789794214@example.com';
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

function typeCode(root: TestRenderer.ReactTestInstance, value: string) {
  const input = root.findByType('TextInput');
  act(() => {
    (input.props.onChangeText as (value: string) => void)(value);
  });
}

function resendButton(root: TestRenderer.ReactTestInstance) {
  return root.findByProps({ accessibilityLabel: i18n.t('login.resendCode') });
}

function verifyButton(root: TestRenderer.ReactTestInstance) {
  return root.findByProps({ accessibilityLabel: i18n.t('login.verifyCode') });
}

async function pressResend(root: TestRenderer.ReactTestInstance) {
  await act(async () => {
    (resendButton(root).props.onPress as () => void)();
    await Promise.resolve();
  });
}

afterEach(async () => {
  act(() => renderer?.unmount());
  renderer = undefined;
  clearCode.mockClear();
  await i18n.changeLanguage('en');
});

describe('EmailOtpForm resend', () => {
  // The reported capture: the old code stayed in the field after Resend, so a
  // code that had just been replaced still read as the one to type.
  it('empties the code field a resend replaces', async () => {
    const onResend = vi.fn<Props['onResend']>(() => Promise.resolve(true));
    const { mounted, props } = mount({ onResend });
    typeCode(mounted.root, '123456');
    expect(verifyButton(mounted.root).props.disabled).toBe(false);

    await pressResend(mounted.root);

    expect(onResend).toHaveBeenCalledOnce();
    expect(clearCode).toHaveBeenCalledOnce();
    // The emptied field is incomplete again, so Verify cannot send the old code.
    const verify = verifyButton(mounted.root);
    expect(verify.props.disabled).toBe(true);
    act(() => {
      (verify.props.onPress as () => void)();
    });
    expect(props.onVerify).not.toHaveBeenCalled();
  });

  it('keeps the code when the resend is refused', async () => {
    const onResend = vi.fn<Props['onResend']>(() => Promise.resolve(false));
    const { mounted } = mount({ onResend });
    typeCode(mounted.root, '123456');

    await pressResend(mounted.root);

    // The refused request did not replace the code, which may still be the one
    // that works.
    expect(clearCode).not.toHaveBeenCalled();
    expect(verifyButton(mounted.root).props.disabled).toBe(false);
  });

  it('keeps a code typed while the resend was in flight', async () => {
    const onResend = vi.fn<Props['onResend']>(() => Promise.resolve(true));
    const { mounted } = mount({ onResend });
    typeCode(mounted.root, '111111');

    // The request is in flight: its reply settles after this keystroke.
    act(() => {
      (resendButton(mounted.root).props.onPress as () => void)();
    });
    // A keystroke after the request began owns the field now.
    typeCode(mounted.root, '222222');

    await act(async () => {
      await Promise.resolve();
    });

    expect(clearCode).not.toHaveBeenCalled();
    expect(verifyButton(mounted.root).props.disabled).toBe(false);
  });
});
