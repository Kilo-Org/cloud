import { afterEach, describe, expect, it } from '@jest/globals';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRequire } from 'node:module';
import { EmailInputForm } from './EmailInputForm';

type LinkedomParseHtml = (html: string) => { window: typeof globalThis; document: Document };

function installDom(): { cleanup: () => void; container: HTMLElement } {
  const requireFromHere = createRequire(__filename);
  const { parseHTML } = requireFromHere('linkedom') as { parseHTML: LinkedomParseHtml };
  const { window, document } = parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>'
  );
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    Element: globalThis.Element,
    Node: globalThis.Node,
    Event: globalThis.Event,
    navigator: globalThis.navigator,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    navigator: window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.getElementById('root');
  if (!container) throw new Error('React root missing');
  return {
    container: container as unknown as HTMLElement,
    cleanup: () => Object.assign(globalThis, previous),
  };
}

describe('EmailInputForm validation visibility', () => {
  let root: Root | undefined;
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    cleanup?.();
    cleanup = undefined;
  });

  it('shows invalid-email feedback only after blur and clears it when valid', async () => {
    const dom = installDom();
    cleanup = dom.cleanup;
    let email = 'invalid';
    const render = () => {
      act(() => {
        root ??= createRoot(dom.container);
        root.render(
          createElement(EmailInputForm, {
            email,
            emailValidation: {
              isValid: email === 'valid@example.com',
              error: email === 'valid@example.com' ? null : 'Enter a valid email address.',
            },
            onSubmit: event => event.preventDefault(),
            onEmailChange: () => undefined,
          })
        );
      });
    };
    render();

    const input = dom.container.querySelector('input');
    if (!(input instanceof HTMLInputElement)) throw new Error('Email input missing');
    expect(dom.container.textContent).not.toContain('Enter a valid email address.');
    expect(input.getAttribute('aria-invalid')).toBe('false');

    await act(async () => {
      input.dispatchEvent(new Event('focusout', { bubbles: true }));
    });
    expect(dom.container.textContent).toContain('Enter a valid email address.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('sign-in-email-error');

    email = 'valid@example.com';
    render();
    expect(dom.container.textContent).not.toContain('Enter a valid email address.');
    expect(input.getAttribute('aria-invalid')).toBe('false');
    expect(input.hasAttribute('aria-describedby')).toBe(false);
  });
});
