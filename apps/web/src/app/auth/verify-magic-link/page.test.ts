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

describe('VerifyMagicLinkPage', () => {
  test.each([
    ['fragment', '?callbackUrl=%2Fexample#token=example-token', '/example'],
    ['query', '?token=example-token', '/users/after-sign-in'],
    ['both locations', '?token=older-token&callbackUrl=%2Fexample#token=example-token', '/example'],
  ])(
    'clears a token from %s before a single exchange in StrictMode',
    (name, suffix, callbackUrl) => {
      const { window } = parseHTML('<html><body></body></html>');
      const location = new URL(`https://example.com/auth/verify-magic-link${suffix}`);
      const originalCallbackUrl = location.searchParams.get('callbackUrl');
      const historyState = { preserve: true };
      const replaceState = jest.fn<
        ReturnType<History['replaceState']>,
        Parameters<History['replaceState']>
      >((_state, _title, url) => {
        location.href = new URL(url ?? '', location).href;
      });
      const previousGlobals = {
        window: globalThis.window,
        document: globalThis.document,
        location: globalThis.location,
        history: globalThis.history,
        IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
          .IS_REACT_ACT_ENVIRONMENT,
      };
      Object.assign(globalThis, {
        window,
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

      try {
        act(() => root.render(createElement(StrictMode, null, createElement(VerifyMagicLinkPage))));
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
        act(() => root.unmount());
        Object.assign(globalThis, previousGlobals);
      }
    }
  );
});
