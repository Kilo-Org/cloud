import { afterEach, describe, expect, it, vi } from 'vitest';

import { announcingToast } from '@/lib/a11y/announcing-toast';
import { type PendingLinkOffer } from '@/lib/auth/native-auth-contract';
import {
  announcePendingLinkResult,
  pendingLinkFailure,
  pendingLinkOptions,
  pendingLinkTokenBody,
  resolvePendingLinkView,
} from '@/lib/auth/pending-link';

vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const offer: PendingLinkOffer = {
  token: 'link-token',
  provider: 'github',
  email: 'person@example.com',
  methods: ['apple', 'google'],
  emailCode: false,
  expiresAt: 0,
};

const allDevice = { apple: true, google: true, passkey: true };
const noneDevice = { apple: false, google: false, passkey: false };

afterEach(() => {
  vi.clearAllMocks();
});

describe('pendingLinkTokenBody', () => {
  it('sends the token only while a pending link is being resolved', () => {
    expect(pendingLinkTokenBody(offer)).toEqual({ pendingLinkToken: 'link-token' });
    expect(pendingLinkTokenBody(null)).toEqual({});
  });
});

describe('pendingLinkOptions', () => {
  it('offers native Apple and Google where the device runs them', () => {
    expect(pendingLinkOptions(offer, allDevice)).toEqual({
      apple: true,
      google: true,
      passkey: false,
      emailCode: false,
      browser: false,
    });
  });

  it('sends methods the device cannot run natively to the browser', () => {
    expect(pendingLinkOptions(offer, noneDevice)).toEqual({
      apple: false,
      google: false,
      passkey: false,
      emailCode: false,
      browser: true,
    });
  });

  it('offers the browser for providers the app has no native sign-in for', () => {
    expect(pendingLinkOptions({ ...offer, methods: ['passkey', 'gitlab'] }, allDevice)).toEqual({
      apple: false,
      google: false,
      passkey: true,
      emailCode: false,
      browser: true,
    });
  });

  it('lets the email code stand in for an email method', () => {
    expect(
      pendingLinkOptions({ ...offer, methods: ['email'], emailCode: true }, noneDevice)
    ).toEqual({ apple: false, google: false, passkey: false, emailCode: true, browser: false });
    expect(pendingLinkOptions({ ...offer, methods: ['email'] }, noneDevice).browser).toBe(true);
  });
});

describe('resolvePendingLinkView', () => {
  const options = pendingLinkOptions(offer, allDevice);

  it('shows the options with no message on the happy path', () => {
    expect(resolvePendingLinkView({ offer, options, expired: false, failure: undefined })).toEqual({
      kind: 'options',
      error: undefined,
    });
  });

  it('keeps the options beside a retryable refusal', () => {
    const failure = pendingLinkFailure('Network error. Please try again.', undefined);
    expect(resolvePendingLinkView({ offer, options, expired: false, failure })).toEqual({
      kind: 'options',
      error: 'Network error. Please try again.',
    });
  });

  it.each(['BLOCKED', 'ADMISSION_REQUIRED'])(
    'replaces the options after a %s refusal no method can change',
    code => {
      const failure = pendingLinkFailure('refused', code);
      expect(failure.retryable).toBe(false);
      expect(resolvePendingLinkView({ offer, options, expired: false, failure })).toEqual({
        kind: 'unavailable',
        message: 'refused',
      });
    }
  );

  it('names the provider when the account has no method to offer', () => {
    const view = resolvePendingLinkView({
      offer: { ...offer, methods: [] },
      options: pendingLinkOptions({ ...offer, methods: [] }, allDevice),
      expired: false,
      failure: undefined,
    });
    expect(view).toEqual({
      kind: 'unavailable',
      message: "This account has no other sign-in method, so GitHub can't be added.",
    });
  });

  it('puts expiry ahead of every other state', () => {
    const failure = pendingLinkFailure('refused', 'BLOCKED');
    expect(resolvePendingLinkView({ offer, options, expired: true, failure })).toEqual({
      kind: 'expired',
      message: 'This request to add GitHub has expired.',
    });
  });
});

describe('announcePendingLinkResult', () => {
  it('confirms a linked provider by name', () => {
    announcePendingLinkResult({ status: 'linked', provider: 'openai' }, offer);
    expect(announcingToast.success).toHaveBeenCalledWith('ChatGPT was added to your account.');
  });

  it.each([
    ['EXPIRED', "GitHub wasn't added because the request expired."],
    ['WRONG_ACCOUNT', "GitHub wasn't added because you signed in to a different account."],
    [
      'ACCOUNT-ALREADY-LINKED',
      "GitHub wasn't added because it's already linked to another account.",
    ],
    [
      'PROVIDER-ALREADY-LINKED',
      "GitHub wasn't added because your account already has a different GitHub sign-in.",
    ],
    ['LINKING-FAILED', "GitHub couldn't be added to your account."],
  ] as const)('warns without blocking for %s', (reason, message) => {
    announcePendingLinkResult({ status: 'failed', reason }, offer);
    expect(announcingToast.warning).toHaveBeenCalledWith(message);
    expect(announcingToast.error).not.toHaveBeenCalled();
  });

  it('stays silent when the sign-in carried no link result', () => {
    announcePendingLinkResult(undefined, offer);
    expect(announcingToast.success).not.toHaveBeenCalled();
    expect(announcingToast.warning).not.toHaveBeenCalled();
  });
});
