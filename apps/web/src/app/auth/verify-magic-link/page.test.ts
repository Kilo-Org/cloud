import { parseHTML } from 'linkedom';
import { signIn } from 'next-auth/react';
import React, { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import VerifyMagicLinkPage from './page';

Object.assign(globalThis, { React });

jest.mock('next-auth/react', () => ({ signIn: jest.fn() }));
jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

function setupPage(suffix: string) {
  const { window } = parseHTML('<html><body></body></html>');
  const location = new URL(`https://example.com/auth/verify-magic-link${suffix}`);
  const historyState = { preserve: true };
  const replaceState = jest.fn<
    ReturnType<History['replaceState']>,
    Parameters<History['replaceState']>
  >((_state, _title, url) => {
    location.href = new URL(url ?? '', location).href;
  });
  const previousGlobals = {
    window: globalThis.window,
    self: globalThis.self,
    document: globalThis.document,
    location: globalThis.location,
    history: globalThis.history,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    self: window,
    document: window.document,
    location,
    history: { state: historyState, replaceState },
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  const root = createRoot(window.document.body);
  const urlsAtExchange: string[] = [];
  const mockSignIn = jest.mocked(signIn);
  mockSignIn.mockReset().mockImplementation(async () => {
    urlsAtExchange.push(location.href);
  });

  return {
    document: window.document,
    location,
    historyState,
    replaceState,
    urlsAtExchange,
    mockSignIn,
    render() {
      root.render(createElement(StrictMode, null, createElement(VerifyMagicLinkPage)));
    },
    restore() {
      act(() => root.unmount());
      Object.assign(globalThis, previousGlobals);
    },
  };
}

describe('VerifyMagicLinkPage', () => {
  test.each([
    ['fragment', '?callbackUrl=%2Fexample#token=example-token', '/example'],
    ['query', '?token=example-token', '/users/after-sign-in'],
    ['both locations', '?token=older-token&callbackUrl=%2Fexample#token=example-token', '/example'],
  ])(
    'clears a token from %s before a single exchange in StrictMode',
    (_name, suffix, callbackUrl) => {
      const page = setupPage(suffix);
      const { location, historyState, replaceState, urlsAtExchange, mockSignIn } = page;
      const originalCallbackUrl = location.searchParams.get('callbackUrl');

      try {
        act(page.render);
        expect(mockSignIn).toHaveBeenCalledTimes(1);
        expect(mockSignIn).toHaveBeenCalledWith('email', {
          token: 'example-token',
          callbackUrl,
          redirect: true,
        });
        expect(replaceState).toHaveBeenCalledTimes(1);
        expect(replaceState).toHaveBeenCalledWith(historyState, '', new URL(location.href));
        expect(urlsAtExchange).toEqual([location.href]);
        expect(location.hash).toBe('');
        expect(location.searchParams.has('token')).toBe(false);
        expect(location.searchParams.get('callbackUrl')).toBe(originalCallbackUrl);
      } finally {
        page.restore();
      }
    }
  );

  test('retries a failed exchange once with the token out of the URL', async () => {
    const page = setupPage('?token=older-token&callbackUrl=%2Fexample#token=example-token');
    const { document, location, replaceState, urlsAtExchange, mockSignIn } = page;
    const cleanUrl = 'https://example.com/auth/verify-magic-link?callbackUrl=%2Fexample';
    const signInOptions = { token: 'example-token', callbackUrl: '/example', redirect: true };
    mockSignIn.mockImplementationOnce(async () => {
      urlsAtExchange.push(location.href);
      throw new Error('Temporary network error');
    });

    try {
      await act(async () => page.render());
      expect(mockSignIn).toHaveBeenCalledTimes(1);
      expect(mockSignIn).toHaveBeenNthCalledWith(1, 'email', signInOptions);
      expect(location.href).toBe(cleanUrl);
      expect(document.querySelector('a[href="/users/sign_in"]')).not.toBeNull();

      const retryButton = document.querySelector('button');
      expect(retryButton?.textContent).toBe('Retry sign-in');
      if (!retryButton) throw new Error('Retry button is missing');
      await act(async () => {
        retryButton.click();
        retryButton.click();
      });

      expect(mockSignIn).toHaveBeenCalledTimes(2);
      expect(mockSignIn).toHaveBeenNthCalledWith(2, 'email', signInOptions);
      expect(replaceState).toHaveBeenCalledTimes(1);
      expect(urlsAtExchange).toEqual([cleanUrl, cleanUrl]);
      expect(location.href).toBe(cleanUrl);
      expect(document.querySelector('button')).toBeNull();
    } finally {
      page.restore();
    }
  });
});
