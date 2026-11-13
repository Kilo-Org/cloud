import React, { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createRequire } from 'node:module';
import type { SessionPrIndicator as SessionPrIndicatorComponent } from './SessionPrIndicator';

Object.assign(globalThis, { React });

jest.mock('./PrHoverCardContent', () => ({
  PrHoverCardContent: () => createElement('p', null, 'Cached pull request details'),
}));

it('keeps real portaled overlay clicks out of the sidebar row navigation handler', async () => {
  const requireFromHere = createRequire(__filename);
  const {
    parseHTML,
    Event: DOMEvent,
    CustomEvent: DOMCustomEvent,
  } = requireFromHere(
    '../../../../../node_modules/.pnpm/linkedom@0.18.12/node_modules/linkedom'
  ) as {
    parseHTML: (html: string) => { window: typeof globalThis; document: Document };
    Event: typeof Event;
    CustomEvent: typeof CustomEvent;
  };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  const values = {
    window,
    document,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    CustomEvent: DOMCustomEvent,
    Event: DOMEvent,
    NodeFilter: { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
    getComputedStyle: () => ({
      animationName: 'none',
      animationDuration: '0s',
      display: 'block',
      visibility: 'visible',
      getPropertyValue: () => '',
    }),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.fromEntries(
    Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  );
  Object.assign(window, { getComputedStyle: values.getComputedStyle });
  Object.assign(globalThis, values);
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing portal test root');
  const root = createRoot(container);
  const onOpenOtherChat = jest.fn();
  try {
    const { SessionPrIndicator } = jest.requireActual<{
      SessionPrIndicator: typeof SessionPrIndicatorComponent;
    }>('./SessionPrIndicator');
    await act(async () =>
      root.render(
        createElement(
          'div',
          { onClick: onOpenOtherChat },
          createElement(SessionPrIndicator, {
            session: {
              sessionId: 'ses_other_chat',
              repository: 'example/repository',
              branch: 'feature',
              associatedPr: {
                url: 'https://github.com/example/repository/pull/123',
                number: 123,
                state: 'open',
                title: 'Example pull request',
                headSha: null,
                lastSyncedAt: '2026-11-12T12:00:00.000Z',
                reviewDecision: null,
                reviewDecisionPending: false,
                platform: 'github',
                observations: null,
              },
            },
          })
        )
      )
    );
    const trigger = container.querySelector('button');
    if (!trigger) throw new Error('Missing PR badge trigger');
    await act(async () => {
      trigger.dispatchEvent(new DOMEvent('click', { bubbles: true }));
    });
    const overlay = document.querySelector('div[data-state="open"].inset-0');
    if (!overlay) throw new Error('Missing actual portaled dialog overlay');
    expect(container.contains(overlay)).toBe(false);
    expect(onOpenOtherChat).not.toHaveBeenCalled();
    await act(async () => {
      overlay.dispatchEvent(new DOMEvent('click', { bubbles: true }));
    });
    expect(onOpenOtherChat).not.toHaveBeenCalled();
    const close = document.querySelector('button[aria-label="Close dialog"]');
    if (!close) throw new Error('Missing accessible dialog dismissal');
    await act(async () => {
      close.dispatchEvent(new DOMEvent('click', { bubbles: true }));
    });
    expect(onOpenOtherChat).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      root.unmount();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    });
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
