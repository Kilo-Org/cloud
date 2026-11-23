/* eslint-disable max-lines -- the harness shares one mock block with the real hook under test */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, TestRenderer } from '@/test/renderer';

import { getAdmission } from '@/lib/auth/admission';
import type * as AdmissionTypes from '@/lib/auth/admission';
import { type PostAuthFailure } from '@/lib/auth/auth-fetch';
import type * as AuthFetchTypes from '@/lib/auth/auth-fetch';
import { type PendingLinkOffer } from '@/lib/auth/native-auth-contract';

import { i18n } from '@/i18n';

const authMock = vi.hoisted(() => ({ signIn: vi.fn() }));

// Mock @/lib/config to avoid pulling in react-native at module import time.
vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'http://localhost:3000',
  GOOGLE_IOS_CLIENT_ID: 'ios-client-id',
  GOOGLE_WEB_CLIENT_ID: 'web-client-id',
}));

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  useColorScheme: () => 'light',
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
}));

vi.mock('expo-application', () => ({
  nativeApplicationVersion: '1.0.4',
}));

vi.mock('@expo/app-integrity', () => ({
  isSupported: false,
  generateKeyAsync: vi.fn(),
  attestKeyAsync: vi.fn(),
  generateAssertionAsync: vi.fn(),
  prepareIntegrityTokenProviderAsync: vi.fn(),
  requestIntegrityCheckAsync: vi.fn(),
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

vi.mock('expo-apple-authentication', () => ({
  AppleAuthenticationButton: 'AppleAuthenticationButton',
  AppleAuthenticationButtonStyle: { WHITE: 0, BLACK: 1 },
  AppleAuthenticationButtonType: { SIGN_IN: 0 },
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
  formatFullName: vi.fn(),
  signInAsync: vi.fn(),
  isAvailableAsync: vi.fn().mockResolvedValue(false),
}));

vi.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: { configure: vi.fn(), hasPlayServices: vi.fn(), signIn: vi.fn() },
}));

vi.mock('sonner-native', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 1 },
  digestStringAsync: vi.fn(),
  getRandomBytesAsync: vi.fn(),
}));

vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({ signIn: authMock.signIn }),
}));

vi.mock('@sentry/react-native', () => ({ addBreadcrumb: vi.fn() }));

vi.mock('@/lib/auth/auth-fetch', async importOriginal => {
  const mod = await importOriginal<typeof AuthFetchTypes>();
  return { ...mod, postAuth: vi.fn() };
});

vi.mock('@/lib/auth/admission', async importOriginal => {
  const mod = await importOriginal<typeof AdmissionTypes>();
  return { ...mod, getAdmission: vi.fn() };
});

vi.mock('@/lib/login-draft', () => ({
  beginLoginEmail: vi.fn(),
  holdLoginEmail: vi.fn(),
  holdSsoRecovery: vi.fn(),
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

// UI primitives render as host strings so the test can drive their props.
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/login/email-otp-form', () => ({ EmailOtpForm: 'EmailOtpForm' }));
vi.mock('@/components/login/apple-logo', () => ({ AppleLogo: 'AppleLogo' }));
vi.mock('@/components/login/google-logo', () => ({ GoogleLogo: 'GoogleLogo' }));
vi.mock('@/components/ui/icons', () => ({ KeyRound: 'KeyRound', Mail: 'Mail' }));

// The idle screen reads the foreground ink for the Apple mark; the real hook
// pulls expo-router, which the mounted project cannot load.
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#14130f', mutedForeground: '#6f6a61' }),
}));

const { IdleAuth } = await import('@/components/login/idle-auth');
const { postAuth } = await import('@/lib/auth/auth-fetch');
const mockPostAuth = vi.mocked(postAuth);
const mockGetAdmission = vi.mocked(getAdmission);

type R = TestRenderer.ReactTestRenderer;
type I = TestRenderer.ReactTestInstance;
type StartFn = (mode: 'signin' | 'sso', ssoEmail?: string) => Promise<void>;

/** The code step's wrong-code copy, which names both ways out of the refusal. */
const INVALID_CODE_MESSAGE =
  "That code is incorrect or expired. Use 'Resend code' or 'More sign-in options'.";

function findAll(root: I, type: string): I[] {
  return root.findAll(n => typeof n.type === 'string' && (n.type as string) === type);
}

function continueButton(root: I): I {
  const button = findAll(root, 'Button').find(
    b => (b.props.accessibilityLabel as string) === 'Continue with email'
  );
  if (!button) {
    throw new Error('Continue with email button not found');
  }
  return button;
}

async function mountIdleAuth(
  props: Partial<React.ComponentProps<typeof IdleAuth>> = {}
): Promise<R> {
  const ref: { current: R | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(
      React.createElement(IdleAuth, { start: vi.fn<StartFn>(), ...props })
    );
    await Promise.resolve();
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

/** The code step's form, re-read after every update: its props carry the refusal. */
function codeStep(root: I): I {
  const form = findAll(root, 'EmailOtpForm')[0];
  if (!form) {
    throw new Error('EmailOtpForm not found');
  }
  return form;
}

/** Mounts the idle screen and lands on the code step, with the OTP route accepting the request. */
async function mountCodeStep(
  email: string,
  props: Partial<React.ComponentProps<typeof IdleAuth>> = {}
): Promise<R> {
  mockPostAuth.mockResolvedValue({
    ok: true,
    data: { success: true, challengeId: 'c0000000-0000-4000-8000-000000000001' },
  });
  const renderer = await mountIdleAuth(props);
  const field = findAll(renderer.root, 'FormField')[0];
  if (!field) {
    throw new Error('FormField not found');
  }
  act(() => {
    (field.props.onChangeText as (value: string) => void)(email);
  });
  await act(async () => {
    (continueButton(renderer.root).props.onPress as () => void)();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

/** Answers the next verify with `failure`, then settles the step's update. */
async function refuseVerify(renderer: R, failure: PostAuthFailure): Promise<void> {
  mockPostAuth.mockResolvedValue(failure);
  await act(async () => {
    (codeStep(renderer.root).props.onVerify as (code: string) => void)('000000');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('IdleAuth email sign-in flow (real useNativeAuth)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAdmission.mockResolvedValue({
      platform: 'ios',
      kind: 'attestation',
      challenge: 'server-challenge',
      payload: 'device-proof',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('types an email, taps Continue, posts the code request, and shows the code screen', async () => {
    mockPostAuth.mockResolvedValue({
      ok: true,
      data: { success: true, challengeId: 'c0000000-0000-4000-8000-000000000001' },
    });

    const renderer = await mountIdleAuth();

    const field = findAll(renderer.root, 'FormField')[0];
    if (!field) {
      throw new Error('FormField not found');
    }
    act(() => {
      (field.props.onChangeText as (value: string) => void)('User@Example.com ');
    });

    await act(async () => {
      (continueButton(renderer.root).props.onPress as () => void)();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockPostAuth).toHaveBeenCalledWith('/api/auth/native/otp', {
      email: 'user@example.com',
    });
    expect(findAll(renderer.root, 'EmailOtpForm')).toHaveLength(1);

    act(() => {
      renderer.unmount();
    });
  });

  it('presses the keyboard Go key and shows the code screen', async () => {
    mockPostAuth.mockResolvedValue({ ok: true, data: { success: true } });

    const renderer = await mountIdleAuth();

    const field = findAll(renderer.root, 'FormField')[0];
    if (!field) {
      throw new Error('FormField not found');
    }
    act(() => {
      (field.props.onChangeText as (value: string) => void)('go@example.com');
    });

    await act(async () => {
      (field.props.onSubmitEditing as () => void)();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(findAll(renderer.root, 'EmailOtpForm')).toHaveLength(1);

    act(() => {
      renderer.unmount();
    });
  });

  it('shows the empty-email error under the field and never posts', async () => {
    const renderer = await mountIdleAuth();

    // The field starts empty: tapping Continue is the scenario under test.
    await act(async () => {
      (continueButton(renderer.root).props.onPress as () => void)();
      await Promise.resolve();
    });

    const field = findAll(renderer.root, 'FormField')[0];
    if (!field) {
      throw new Error('FormField not found');
    }
    // The message is rendered through FormField's error slot (a visible,
    // announced status), never as a toast that leaves the landing silent.
    expect(field.props.error).toBe('Please enter your email address.');
    expect(mockPostAuth).not.toHaveBeenCalled();
    expect(findAll(renderer.root, 'EmailOtpForm')).toHaveLength(0);
    const { toast } = await import('sonner-native');
    expect(toast.error).not.toHaveBeenCalled();

    // Typing clears the message so the control is not left in an error state.
    act(() => {
      (field.props.onChangeText as (value: string) => void)('user@example.com');
    });
    expect(findAll(renderer.root, 'FormField')[0]?.props.error).toBeUndefined();

    act(() => {
      renderer.unmount();
    });
  });

  it('shows an error and stays on the landing when the request fails', async () => {
    mockPostAuth.mockResolvedValue({
      ok: false,
      errorCode: undefined,
      ssoOrganizationId: undefined,
    });

    const renderer = await mountIdleAuth();

    const field = findAll(renderer.root, 'FormField')[0];
    if (!field) {
      throw new Error('FormField not found');
    }
    act(() => {
      (field.props.onChangeText as (value: string) => void)('fail@example.com');
    });

    await act(async () => {
      (continueButton(renderer.root).props.onPress as () => void)();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const { toast } = await import('sonner-native');
    expect(toast.error).toHaveBeenCalled();
    expect(findAll(renderer.root, 'EmailOtpForm')).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });

  it('shows the timeout toast, keeps the landing, then advances on retry', async () => {
    mockPostAuth.mockResolvedValue({
      ok: false,
      errorCode: 'TIMEOUT',
      ssoOrganizationId: undefined,
    });

    const renderer = await mountIdleAuth();

    const field = findAll(renderer.root, 'FormField')[0];
    if (!field) {
      throw new Error('FormField not found');
    }
    act(() => {
      (field.props.onChangeText as (value: string) => void)('timeout@example.com');
    });

    await act(async () => {
      (continueButton(renderer.root).props.onPress as () => void)();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const { toast } = await import('sonner-native');
    expect(toast.error).toHaveBeenCalledWith('Sign-in timed out. Please try again.');
    expect(findAll(renderer.root, 'EmailOtpForm')).toHaveLength(0);
    // The landing is intact with the Continue control back in its slot.
    expect(findAll(renderer.root, 'FormField')).toHaveLength(1);
    expect(continueButton(renderer.root)).toBeTruthy();

    // Recovery: the next submit is accepted and reaches the code screen.
    mockPostAuth.mockResolvedValue({ ok: true, data: { success: true } });
    await act(async () => {
      (continueButton(renderer.root).props.onPress as () => void)();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(findAll(renderer.root, 'EmailOtpForm')).toHaveLength(1);

    act(() => {
      renderer.unmount();
    });
  });

  it('drops a refusal that settles after the user edited the code', async () => {
    mockPostAuth.mockResolvedValue({
      ok: true,
      data: { success: true, challengeId: 'c0000000-0000-4000-8000-000000000001' },
    });

    const renderer = await mountIdleAuth();

    const field = findAll(renderer.root, 'FormField')[0];
    if (!field) {
      throw new Error('FormField not found');
    }
    act(() => {
      (field.props.onChangeText as (value: string) => void)('late@example.com');
    });

    await act(async () => {
      (continueButton(renderer.root).props.onPress as () => void)();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const otpForm = findAll(renderer.root, 'EmailOtpForm')[0];
    if (!otpForm) {
      throw new Error('EmailOtpForm not found');
    }

    // The refusal resolves only after the user has edited the code.
    const verifyGate = Promise.withResolvers<unknown>();
    mockPostAuth.mockReturnValue(verifyGate.promise as never);

    await act(async () => {
      (otpForm.props.onVerify as (code: string) => void)('000000');
      await Promise.resolve();
      await Promise.resolve();
    });

    // The user edits the code while the attempt is in flight.
    act(() => {
      (otpForm.props.onCodeChange as () => void)();
    });

    await act(async () => {
      verifyGate.resolve({
        ok: false,
        errorCode: 'INVALID_CODE',
        ssoOrganizationId: undefined,
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(findAll(renderer.root, 'EmailOtpForm')[0]?.props.error).toBeUndefined();

    act(() => {
      renderer.unmount();
    });
  });

  it('keeps a wrong-code refusal and its options control while the person edits the code', async () => {
    const renderer = await mountCodeStep('wrong@example.com');
    expect(codeStep(renderer.root).props.error).toBeUndefined();

    await refuseVerify(renderer, {
      ok: false,
      errorCode: 'INVALID_CODE',
      ssoOrganizationId: undefined,
    });

    expect(codeStep(renderer.root).props.error).toBe(INVALID_CODE_MESSAGE);
    // The server answers INVALID_CODE for an address it silently refused, so a
    // resent code never arrives either: the step offers the other methods.
    expect(codeStep(renderer.root).props.recovery).toBe('options');

    // Typing is not a way out of that dead end, so the message and the control
    // that names the real exit stay exactly where they are.
    act(() => {
      (codeStep(renderer.root).props.onCodeChange as () => void)();
    });
    expect(codeStep(renderer.root).props.error).toBe(INVALID_CODE_MESSAGE);
    expect(codeStep(renderer.root).props.recovery).toBe('options');

    act(() => {
      renderer.unmount();
    });
  });

  it('keeps a wrong-code refusal and its options control when the resend is rate limited', async () => {
    const renderer = await mountCodeStep('wrong-resend-rate-limited@example.com');
    await refuseVerify(renderer, {
      ok: false,
      errorCode: 'INVALID_CODE',
      ssoOrganizationId: undefined,
    });
    expect(codeStep(renderer.root).props.recovery).toBe('options');

    // A refused resend delivers no code either, so clearing the refusal on the
    // tap would drop the only control that can finish a sign-in for this address.
    mockPostAuth.mockResolvedValue({
      ok: false,
      errorCode: 'RATE_LIMITED',
      ssoOrganizationId: undefined,
    });
    await act(async () => {
      await (codeStep(renderer.root).props.onResend as () => Promise<boolean>)();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(codeStep(renderer.root).props.error).toBe(INVALID_CODE_MESSAGE);
    expect(codeStep(renderer.root).props.recovery).toBe('options');
    expect(codeStep(renderer.root).props.busy).toBeUndefined();

    act(() => {
      renderer.unmount();
    });
  });

  it('keeps a wrong-code refusal and its options control when the resend succeeds', async () => {
    const renderer = await mountCodeStep('wrong-resend-sent@example.com');
    await refuseVerify(renderer, {
      ok: false,
      errorCode: 'INVALID_CODE',
      ssoOrganizationId: undefined,
    });
    expect(codeStep(renderer.root).props.recovery).toBe('options');

    // The resend the person tapped did deliver a challenge, but the field clears
    // its code and the address stays one the code route cannot take: the refusal
    // and its exit outlive the resend rather than vanishing with the field.
    mockPostAuth.mockResolvedValue({
      ok: true,
      data: { success: true, challengeId: 'c0000000-0000-4000-8000-000000000002' },
    });
    await act(async () => {
      await (codeStep(renderer.root).props.onResend as () => Promise<boolean>)();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(codeStep(renderer.root).props.error).toBe(INVALID_CODE_MESSAGE);
    expect(codeStep(renderer.root).props.recovery).toBe('options');

    act(() => {
      renderer.unmount();
    });
  });

  it('clears a retryable verify refusal on edit and never offers the options control', async () => {
    const renderer = await mountCodeStep('retryable@example.com');
    await refuseVerify(renderer, {
      ok: false,
      errorCode: 'RATE_LIMITED',
      ssoOrganizationId: undefined,
    });

    expect(codeStep(renderer.root).props.error).toBe(
      'Too many sign-in attempts. Please wait and try again.'
    );
    // A code can still clear this one, so the browser action stays off.
    expect(codeStep(renderer.root).props.recovery).toBeUndefined();

    act(() => {
      (codeStep(renderer.root).props.onCodeChange as () => void)();
    });
    expect(codeStep(renderer.root).props.error).toBeUndefined();
    expect(codeStep(renderer.root).props.recovery).toBeUndefined();

    act(() => {
      renderer.unmount();
    });
  });

  it('retires a terminal refusal on Back, so the step the person returns to is fresh', async () => {
    const renderer = await mountCodeStep('back-out@example.com');
    await refuseVerify(renderer, {
      ok: false,
      errorCode: 'INVALID_CODE',
      ssoOrganizationId: undefined,
    });
    expect(codeStep(renderer.root).props.error).toBe(INVALID_CODE_MESSAGE);

    act(() => {
      (codeStep(renderer.root).props.onBack as () => void)();
    });
    expect(findAll(renderer.root, 'EmailOtpForm')).toHaveLength(0);

    // Back is the person leaving the step, so the step they open next starts clean.
    mockPostAuth.mockResolvedValue({
      ok: true,
      data: { success: true, challengeId: 'c0000000-0000-4000-8000-000000000003' },
    });
    await act(async () => {
      (continueButton(renderer.root).props.onPress as () => void)();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(codeStep(renderer.root).props.error).toBeUndefined();
    expect(codeStep(renderer.root).props.recovery).toBeUndefined();

    act(() => {
      renderer.unmount();
    });
  });

  // The reported dead end: the signup rules or the domain blacklist silently
  // refuse an address, so the OTP route answers 200 with a challenge but issues
  // no code, and the token route answers INVALID_CODE. Resending never delivers,
  // so the step must offer the other sign-in methods its copy names — and that
  // control must start the browser flow.
  it('offers the other sign-in methods when the server silently refused the address', async () => {
    mockPostAuth.mockResolvedValue({
      ok: true,
      data: { success: true, challengeId: 'c0000000-0000-4000-8000-000000000001' },
    });
    const start = vi.fn<StartFn>().mockResolvedValue(undefined);

    const renderer = await mountIdleAuth({ start });

    const field = findAll(renderer.root, 'FormField')[0];
    if (!field) {
      throw new Error('FormField not found');
    }
    act(() => {
      (field.props.onChangeText as (value: string) => void)('refused-domain@example.com');
    });

    await act(async () => {
      (continueButton(renderer.root).props.onPress as () => void)();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const otpForm = findAll(renderer.root, 'EmailOtpForm')[0];
    if (!otpForm) {
      throw new Error('EmailOtpForm not found');
    }

    mockPostAuth.mockResolvedValue({
      ok: false,
      errorCode: 'INVALID_CODE',
      ssoOrganizationId: undefined,
      httpStatus: 401,
    });
    await act(async () => {
      (otpForm.props.onVerify as (code: string) => void)('123456');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const refused = findAll(renderer.root, 'EmailOtpForm')[0];
    if (!refused) {
      throw new Error('EmailOtpForm not found');
    }
    expect(refused.props.error).toBe(
      "That code is incorrect or expired. Use 'Resend code' or 'More sign-in options'."
    );
    expect(refused.props.recovery).toBe('options');
    expect(authMock.signIn).not.toHaveBeenCalled();

    const onAlternativeSignIn = refused.props.onAlternativeSignIn as (() => void) | undefined;
    if (!onAlternativeSignIn) {
      throw new Error('alternative sign-in action not rendered');
    }
    await act(async () => {
      onAlternativeSignIn();
      await Promise.resolve();
    });
    expect(start).toHaveBeenCalledWith('signin', undefined, undefined);

    act(() => {
      renderer.unmount();
    });
  });

  it('signs in when the correct code verifies and stays silent on success', async () => {
    mockPostAuth.mockResolvedValue({
      ok: true,
      data: { success: true, challengeId: 'c0000000-0000-4000-8000-000000000001' },
    });

    const renderer = await mountIdleAuth();

    const field = findAll(renderer.root, 'FormField')[0];
    if (!field) {
      throw new Error('FormField not found');
    }
    act(() => {
      (field.props.onChangeText as (value: string) => void)('correct@example.com');
    });

    await act(async () => {
      (continueButton(renderer.root).props.onPress as () => void)();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const otpForm = findAll(renderer.root, 'EmailOtpForm')[0];
    if (!otpForm) {
      throw new Error('EmailOtpForm not found');
    }

    mockPostAuth.mockResolvedValue({
      ok: true,
      data: { token: 'at', refreshToken: 'rt', expiresIn: 3600 },
    });
    await act(async () => {
      (otpForm.props.onVerify as (code: string) => void)('123456');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(findAll(renderer.root, 'EmailOtpForm')[0]?.props.error).toBeUndefined();
    expect(authMock.signIn).toHaveBeenCalledExactlyOnceWith('at', 'rt', 3600);

    act(() => {
      renderer.unmount();
    });
  });

  it('keeps admission failures inline on the code step and allows verification to retry', async () => {
    mockPostAuth.mockResolvedValue({
      ok: true,
      data: { success: true, challengeId: 'c0000000-0000-4000-8000-000000000001' },
    });
    const renderer = await mountIdleAuth();
    const field = findAll(renderer.root, 'FormField')[0];
    if (!field) {
      throw new Error('FormField not found');
    }
    act(() => {
      (field.props.onChangeText as (value: string) => void)('admission@example.com');
    });
    await act(() => {
      (continueButton(renderer.root).props.onPress as () => void)();
    });
    const otpForm = findAll(renderer.root, 'EmailOtpForm')[0];
    if (!otpForm) {
      throw new Error('EmailOtpForm not found');
    }

    mockGetAdmission.mockRejectedValueOnce(new Error('Device proof unavailable'));
    mockPostAuth.mockClear();
    await act(() => {
      (otpForm.props.onVerify as (code: string) => void)('123456');
    });

    expect(findAll(renderer.root, 'EmailOtpForm')[0]?.props.error).toBe(
      i18n.t('authErrors.retryableAdmission')
    );
    expect(mockPostAuth).not.toHaveBeenCalled();
    expect(authMock.signIn).not.toHaveBeenCalled();

    mockPostAuth.mockResolvedValue({
      ok: true,
      data: { token: 'at', refreshToken: 'rt', expiresIn: 3600 },
    });
    await act(() => {
      (otpForm.props.onVerify as (code: string) => void)('123456');
    });
    expect(authMock.signIn).toHaveBeenCalledExactlyOnceWith('at', 'rt', 3600);
    act(() => {
      renderer.unmount();
    });
  });

  it('offers the browser sign-in the admission refusal names and starts that flow', async () => {
    mockPostAuth.mockResolvedValue({
      ok: true,
      data: { success: true, challengeId: 'c0000000-0000-4000-8000-000000000001' },
    });
    const start = vi.fn<StartFn>().mockResolvedValue(undefined);
    const renderer = await mountIdleAuth({ start });
    const field = findAll(renderer.root, 'FormField')[0];
    if (!field) {
      throw new Error('FormField not found');
    }
    act(() => {
      (field.props.onChangeText as (value: string) => void)('blocked@example.com');
    });
    await act(async () => {
      (continueButton(renderer.root).props.onPress as () => void)();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const otpForm = findAll(renderer.root, 'EmailOtpForm')[0];
    if (!otpForm) {
      throw new Error('EmailOtpForm not found');
    }

    mockPostAuth.mockResolvedValue({
      ok: false,
      errorCode: 'ADMISSION_REQUIRED',
      ssoOrganizationId: undefined,
      httpStatus: 403,
    });
    await act(async () => {
      (otpForm.props.onVerify as (code: string) => void)('123456');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const refused = findAll(renderer.root, 'EmailOtpForm')[0];
    if (!refused) {
      throw new Error('EmailOtpForm not found');
    }
    expect(refused.props.error).toBe(
      "Your device can't be verified. Use 'More sign-in options' to sign in on another device or through the web."
    );
    expect(refused.props.recovery).toBe('options');
    const onAlternativeSignIn = refused.props.onAlternativeSignIn as (() => void) | undefined;
    if (!onAlternativeSignIn) {
      throw new Error('alternative sign-in action not rendered');
    }

    await act(async () => {
      onAlternativeSignIn();
      await Promise.resolve();
    });
    expect(start).toHaveBeenCalledWith('signin', undefined, undefined);
    expect(authMock.signIn).not.toHaveBeenCalled();

    act(() => {
      renderer.unmount();
    });
  });
});

describe('IdleAuth pending-link code step (real useNativeAuth)', () => {
  // The code goes to the account that owns the link, and the options screen is
  // off screen once the code step opens, so a refused resend has to say so here.
  const offer: PendingLinkOffer = {
    token: 'link-token',
    provider: 'github',
    email: 'person@example.com',
    methods: ['email'],
    emailCode: true,
    expiresAt: Date.now() + 15 * 60 * 1000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAdmission.mockResolvedValue({
      platform: 'ios',
      kind: 'attestation',
      challenge: 'server-challenge',
      payload: 'device-proof',
    });
  });

  it('shows the refusal on the code step and leaves the resend control usable', async () => {
    mockPostAuth.mockResolvedValue({ ok: true, data: { success: true } });

    const renderer = await mountIdleAuth({
      pendingLink: offer,
      onPendingLink: vi.fn<(link: PendingLinkOffer) => void>(),
    });

    const send = findAll(renderer.root, 'Button').find(
      b => b.props.accessibilityLabel === 'Email me a sign-in code'
    );
    if (!send) {
      throw new Error('Email me a sign-in code button not found');
    }
    await act(async () => {
      (send.props.onPress as () => void)();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(findAll(renderer.root, 'EmailOtpForm')).toHaveLength(1);

    mockPostAuth.mockResolvedValue({
      ok: false,
      errorCode: 'RATE_LIMITED',
      ssoOrganizationId: undefined,
    });
    const otpForm = findAll(renderer.root, 'EmailOtpForm')[0];
    if (!otpForm) {
      throw new Error('EmailOtpForm not found');
    }
    await act(async () => {
      (otpForm.props.onResend as () => void)();
      await Promise.resolve();
      await Promise.resolve();
    });

    const refused = findAll(renderer.root, 'EmailOtpForm')[0];
    expect(refused?.props.error).toBe('Too many sign-in attempts. Please wait and try again.');
    expect(refused?.props.busy).toBeUndefined();
    // A retryable resend refusal never offers the terminal browser action.
    expect(refused?.props.recovery).toBeUndefined();

    act(() => {
      renderer.unmount();
    });
  });

  it('signs in through the browser with the pending link token after an admission refusal', async () => {
    mockPostAuth.mockResolvedValue({ ok: true, data: { success: true } });
    const start = vi.fn<StartFn>().mockResolvedValue(undefined);
    const renderer = await mountIdleAuth({
      start,
      pendingLink: offer,
      onPendingLink: vi.fn<(link: PendingLinkOffer) => void>(),
    });

    const send = findAll(renderer.root, 'Button').find(
      b => b.props.accessibilityLabel === 'Email me a sign-in code'
    );
    if (!send) {
      throw new Error('Email me a sign-in code button not found');
    }
    await act(async () => {
      (send.props.onPress as () => void)();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    mockPostAuth.mockResolvedValue({
      ok: false,
      errorCode: 'ADMISSION_REQUIRED',
      ssoOrganizationId: undefined,
      httpStatus: 403,
    });
    const otpForm = findAll(renderer.root, 'EmailOtpForm')[0];
    if (!otpForm) {
      throw new Error('EmailOtpForm not found');
    }
    await act(async () => {
      (otpForm.props.onVerify as (code: string) => void)('123456');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const refused = findAll(renderer.root, 'EmailOtpForm')[0];
    if (!refused) {
      throw new Error('EmailOtpForm not found');
    }
    expect(refused.props.error).toBe(
      "Your device can't be verified. Use 'More sign-in options' to sign in on another device or through the web."
    );
    expect(refused.props.recovery).toBe('options');
    const onAlternativeSignIn = refused.props.onAlternativeSignIn as (() => void) | undefined;
    if (!onAlternativeSignIn) {
      throw new Error('alternative sign-in action not rendered');
    }
    await act(async () => {
      onAlternativeSignIn();
      await Promise.resolve();
    });
    expect(start).toHaveBeenCalledWith('signin', undefined, 'link-token');

    act(() => {
      renderer.unmount();
    });
  });
});
