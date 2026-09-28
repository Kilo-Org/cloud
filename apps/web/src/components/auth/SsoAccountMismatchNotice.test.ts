/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires -- @swc/jest does not hoist `jest.mock` above imports, so the mocked module and the component that imports it are required after the mock registers. */
import * as React from 'react';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import type { signOut as SignOutFn } from 'next-auth/react';
import type { SsoAccountMismatchNotice as SsoAccountMismatchNoticeType } from './SsoAccountMismatchNotice';

jest.mock('next-auth/react', () => ({ signOut: jest.fn(async () => undefined) }));

// @swc/jest compiles JSX with the classic runtime, and the component imports no
// React default, so its `React.createElement` calls need React on the global.
Object.assign(globalThis, { React });

const { signOut } = require('next-auth/react') as { signOut: typeof SignOutFn };
const { SsoAccountMismatchNotice } = require('./SsoAccountMismatchNotice') as {
  SsoAccountMismatchNotice: typeof SsoAccountMismatchNoticeType;
};

const mockedSignOut = jest.mocked(signOut);

const mismatch = { expectedEmail: 'a@example.com', signedInEmail: 'b@example.com' };
const searchParams = {
  sso: 'true',
  email: 'a@example.com',
  callbackPath: '/device-auth?code=ABC&app=1',
};

const renderNotice = () =>
  renderToStaticMarkup(React.createElement(SsoAccountMismatchNotice, { mismatch, searchParams }));

describe('SsoAccountMismatchNotice', () => {
  test('names both addresses and offers the single switch action', () => {
    const html = renderNotice();

    expect(html).toContain('data-account-mismatch');
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).toContain('Wrong account signed in');
    expect(html).toContain('b@example.com');
    expect(html).toContain('a@example.com');
    expect(html).toContain('Sign out and continue as a@example.com');
  });

  test('offers no dismiss control and exactly one action', () => {
    const html = renderNotice();

    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toContain('Close');
    expect(html).not.toContain('Dismiss');
  });

  test('lets the action label wrap instead of spilling out of a fixed-height control', () => {
    const html = renderNotice();
    const button = html.match(/<button[^>]*>/)?.[0] ?? '';

    // A work address is long enough that the nowrap label would cross the
    // button and card borders at 375px, so the control must wrap and take its
    // height from its content rather than the shared fixed control height.
    expect(button).toContain('whitespace-normal');
    expect(button).toContain('wrap-anywhere');
    expect(button).not.toContain('whitespace-nowrap');
    expect(button).not.toContain('h-control-default');
  });

  test('never puts an address other than the expected one into a URL', () => {
    const html = renderNotice();

    // The only action is a button, so the notice renders no link or URL at all.
    expect(html).not.toContain('href=');
    // The signed-in address never appears in URL-encoded form either.
    expect(html).not.toContain(encodeURIComponent(mismatch.signedInEmail));
  });
});

// --- Transient failure of the single action ---
//
// The notice's one action signs out and continues. A network failure must not
// strand the visitor: the action comes back enabled and an inline error says
// what happened and what to try. A static render never runs the click handler,
// so these tests mount the client component into a minimal DOM (`linkedom`, a
// transitive monorepo dependency).

type LinkedomParseHtml = (html: string) => {
  window: typeof globalThis & {
    HTMLElement: typeof HTMLElement;
    Element: typeof Element;
    Node: typeof Node;
    Text: typeof Text;
    Comment: typeof Comment;
    DocumentFragment: typeof DocumentFragment;
    Document: typeof Document;
    SVGElement: typeof SVGElement;
    Event: typeof Event;
    CustomEvent: typeof CustomEvent;
    navigator: Navigator;
  };
  document: Document;
};

function installLinkedomDom(): { cleanup: () => void; container: HTMLElement } {
  const requireFromHere = createRequire(__filename);
  const loadLinkedom = (): { parseHTML: LinkedomParseHtml } => {
    try {
      return requireFromHere('linkedom') as { parseHTML: LinkedomParseHtml };
    } catch {
      return requireFromHere(
        '../../../../node_modules/.pnpm/linkedom@0.18.12/node_modules/linkedom'
      ) as { parseHTML: LinkedomParseHtml };
    }
  };
  const { parseHTML } = loadLinkedom();

  const { window, document } = parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>'
  );

  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Element: globalThis.Element,
    Node: globalThis.Node,
    Text: globalThis.Text,
    Comment: globalThis.Comment,
    DocumentFragment: globalThis.DocumentFragment,
    Document: globalThis.Document,
    SVGElement: globalThis.SVGElement,
    Event: globalThis.Event,
    CustomEvent: globalThis.CustomEvent,
    navigator: globalThis.navigator,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  };

  Object.assign(globalThis, {
    window,
    document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Text: window.Text,
    Comment: window.Comment,
    DocumentFragment: window.DocumentFragment,
    Document: window.Document,
    SVGElement: window.SVGElement,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    navigator: window.navigator,
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  const container = document.getElementById('root');
  if (!container) throw new Error('linkedom root missing');

  return {
    container: container as unknown as HTMLElement,
    cleanup: () => {
      Object.assign(globalThis, previous);
    },
  };
}

function mountNotice(): { container: HTMLElement; root: Root; cleanup: () => void } {
  const dom = installLinkedomDom();
  let root!: Root;
  act(() => {
    root = createRoot(dom.container);
    root.render(React.createElement(SsoAccountMismatchNotice, { mismatch, searchParams }));
  });

  return {
    container: dom.container,
    root,
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      dom.cleanup();
    },
  };
}

function actionButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector('button');
  if (!button) throw new Error('sign-out action not found');
  return button as HTMLButtonElement;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('SsoAccountMismatchNotice sign-out failure', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockedSignOut.mockReset();
    mockedSignOut.mockResolvedValue(undefined);
    global.fetch = jest.fn(async () => new Response(null, { status: 200 })) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('re-enables the action and explains the failure when sign-out rejects', async () => {
    mockedSignOut.mockRejectedValueOnce(new Error('network down'));

    const mounted = mountNotice();
    try {
      await act(async () => {
        actionButton(mounted.container).click();
      });
      await flush();

      // The single action must not stay disabled at "Signing out…".
      const button = actionButton(mounted.container);
      expect(button.disabled).toBe(false);
      expect(button.getAttribute('aria-busy')).toBeNull();

      const error = mounted.container.querySelector('[data-sign-out-error]');
      expect(error).not.toBeNull();
      expect(error?.textContent).toContain('try again');

      // Retrying runs the action again.
      await act(async () => {
        button.click();
      });
      await flush();
      expect(mockedSignOut).toHaveBeenCalledTimes(2);
    } finally {
      mounted.cleanup();
    }
  });

  test('clears the failure and retries when the action is pressed again', async () => {
    mockedSignOut.mockRejectedValueOnce(new Error('network down'));

    const mounted = mountNotice();
    try {
      await act(async () => {
        actionButton(mounted.container).click();
      });
      await flush();
      expect(mounted.container.querySelector('[data-sign-out-error]')).not.toBeNull();

      await act(async () => {
        actionButton(mounted.container).click();
      });
      await flush();

      expect(mockedSignOut).toHaveBeenCalledTimes(2);
      expect(mounted.container.querySelector('[data-sign-out-error]')).toBeNull();
    } finally {
      mounted.cleanup();
    }
  });

  test('still attempts the sign-out when the session revoke call fails', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('revoke unreachable');
    }) as unknown as typeof fetch;

    const mounted = mountNotice();
    try {
      await act(async () => {
        actionButton(mounted.container).click();
      });
      await flush();

      // Revoking the web session is best effort; the switch action still runs.
      expect(mockedSignOut).toHaveBeenCalledTimes(1);
      // Its failure is reported as a retryable error, not swallowed.
      expect(mounted.container.querySelector('[data-sign-out-error]')).not.toBeNull();
      expect(actionButton(mounted.container).disabled).toBe(false);
    } finally {
      mounted.cleanup();
    }
  });
});
