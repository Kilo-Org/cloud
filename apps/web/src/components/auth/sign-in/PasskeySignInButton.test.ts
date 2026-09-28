/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires -- Jest node-environment mocks must be registered before loading the component. */
import { jest } from '@jest/globals';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const mockHookResult: {
  isSupported: boolean | null;
  isPending: boolean;
  failure: 'cancelled' | 'expired' | 'no_passkey' | 'failed' | null;
  signInWithPasskey: () => Promise<void>;
} = {
  isSupported: true,
  isPending: false,
  failure: null,
  signInWithPasskey: jest.fn(async () => {}),
};

jest.mock('@/hooks/usePasskeySignIn', () => ({
  usePasskeySignIn: () => mockHookResult,
}));

const { PasskeySignInButton } = require('./PasskeySignInButton') as {
  PasskeySignInButton: (props: { callbackUrl?: string }) => React.ReactElement | null;
};

function render() {
  return renderToStaticMarkup(createElement(PasskeySignInButton, { callbackUrl: '/welcome' }));
}

beforeEach(() => {
  mockHookResult.isSupported = true;
  mockHookResult.isPending = false;
  mockHookResult.failure = null;
});

describe('PasskeySignInButton', () => {
  it('renders nothing when the browser has no credential API', () => {
    mockHookResult.isSupported = false;

    expect(render()).toBe('');
  });

  // The server render and the first client render both run before the
  // credential-API global can be read. The control's slot is reserved on both,
  // so resolving support later cannot push the providers below it down.
  it('reserves the control height until the browser support check resolves', () => {
    mockHookResult.isSupported = null;
    const html = render();

    expect(html).toContain('h-10 w-full');
    expect(html).not.toContain('Sign in with a passkey');
  });

  it('reserves the same height as the button that replaces it', () => {
    mockHookResult.isSupported = null;
    const reserved = render();
    mockHookResult.isSupported = true;
    const offered = render();

    expect(reserved).toContain('h-10 w-full');
    expect(offered).toContain('h-10 w-full');
    // The slot and the button both grow to the 44px touch target on a coarse
    // pointer, so swapping one for the other cannot move the providers below.
    expect(reserved).toContain('pointer-coarse:min-h-11');
    expect(offered).toContain('pointer-coarse:min-h-11');
  });

  it('offers the button when a passkey can be used', () => {
    const html = render();

    expect(html).toContain('Sign in with a passkey');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('disabled');
  });

  it('keeps the button busy while the ceremony runs', () => {
    mockHookResult.isPending = true;
    const html = render();

    expect(html).toContain('Waiting for your passkey');
    expect(html).toContain('disabled');
  });

  it('keeps the button available after a cancelled ceremony', () => {
    mockHookResult.failure = 'cancelled';
    const html = render();

    expect(html).toContain('Sign in with a passkey');
    expect(html).toContain('Sign-in was cancelled or could not start. Try again.');
    expect(html).toContain('role="alert"');
  });

  it('keeps the button available after an expired or replayed challenge', () => {
    mockHookResult.failure = 'expired';
    const html = render();

    expect(html).toContain('Sign in with a passkey');
    expect(html).toContain('That sign-in attempt expired. Try again.');
    expect(html).toContain('role="alert"');
  });

  it('shows the way out instead of the button when no passkey exists on the device', () => {
    mockHookResult.failure = 'no_passkey';
    const html = render();

    expect(html).not.toContain('Sign in with a passkey');
    expect(html).toContain(
      'No passkey was found on this device. Sign in another way, then add one from Connected Accounts.'
    );
  });

  it('shows the way out instead of the button when the passkey is refused', () => {
    mockHookResult.failure = 'failed';
    const html = render();

    expect(html).not.toContain('Sign in with a passkey');
    expect(html).toContain('Use another sign-in method.');
  });
});
