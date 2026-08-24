/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires -- Jest node-environment mocks must be registered before loading the component. */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AuthProviderId } from '@/lib/auth/provider-metadata';

jest.mock('@/components/auth/sign-in/AuthProviderButtons', () => ({
  AuthProviderButtons: ({
    providers,
    onProviderClick,
    disabled,
  }: {
    providers: string[];
    onProviderClick: (provider: AuthProviderId) => void;
    disabled: boolean;
  }) => {
    return React.createElement(
      React.Fragment,
      null,
      ...providers.map(provider =>
        React.createElement(
          'button',
          { key: provider, disabled, onClick: () => onProviderClick(provider as AuthProviderId) },
          `Continue with ${provider === 'google' ? 'Google' : provider}`
        )
      )
    );
  },
}));

const { ProviderSelectView } = require('./ProviderSelectView') as {
  ProviderSelectView: (props: {
    email: string;
    providers: AuthProviderId[];
    onProviderSelect: (provider: AuthProviderId) => Promise<boolean>;
    onBack: () => void;
  }) => React.ReactElement;
};

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
        '../../../../../node_modules/.pnpm/linkedom@0.18.12/node_modules/linkedom'
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
    cleanup: () => Object.assign(globalThis, previous),
  };
}

type MountedView = { container: HTMLElement; root: Root; cleanup: () => void };

function mountView(onProviderSelect: (provider: AuthProviderId) => Promise<boolean>): MountedView {
  const dom = installLinkedomDom();
  let root!: Root;
  act(() => {
    root = createRoot(dom.container);
    root.render(
      createElement(ProviderSelectView, {
        email: 'person@example.com',
        providers: ['google'],
        onProviderSelect,
        onBack: () => undefined,
      })
    );
  });
  return {
    container: dom.container,
    root,
    cleanup: () => {
      act(() => root.unmount());
      dom.cleanup();
    },
  };
}

function controls(container: HTMLElement): {
  provider: HTMLButtonElement;
  back: HTMLButtonElement;
} {
  const buttons = Array.from(container.querySelectorAll('button')) as HTMLButtonElement[];
  const provider = buttons.find(button => button.textContent?.includes('Continue with Google'));
  const back = buttons.find(button => button.textContent?.includes('Use a different email'));
  if (!provider || !back) throw new Error('Provider selection controls not found');
  return { provider, back };
}

function deferredOutcome(): {
  promise: Promise<boolean>;
  resolve: (outcome: boolean) => void;
  reject: (reason: Error) => void;
} {
  let resolve!: (outcome: boolean) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<boolean>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe('ProviderSelectView pending provider selection', () => {
  let mounted: MountedView | undefined;

  afterEach(() => {
    mounted?.cleanup();
    mounted = undefined;
  });

  it.each(['a handled non-redirect outcome', 'a rejected provider action'])(
    're-enables provider and Back controls after %s',
    async outcome => {
      const pending = deferredOutcome();
      mounted = mountView(async () => pending.promise);
      const { provider, back } = controls(mounted.container);

      act(() => {
        provider.click();
      });
      expect(provider.disabled).toBe(true);
      expect(back.disabled).toBe(true);

      await act(async () => {
        if (outcome === 'a handled non-redirect outcome') {
          pending.resolve(false);
        } else {
          pending.reject(new Error('provider failed'));
        }
      });

      expect(provider.disabled).toBe(false);
      expect(back.disabled).toBe(false);
    }
  );

  it('keeps provider and Back controls disabled after navigation begins', async () => {
    const pending = deferredOutcome();
    mounted = mountView(async () => pending.promise);
    const { provider, back } = controls(mounted.container);

    act(() => {
      provider.click();
    });
    expect(provider.disabled).toBe(true);
    expect(back.disabled).toBe(true);

    await act(async () => {
      pending.resolve(true);
    });

    expect(provider.disabled).toBe(true);
    expect(back.disabled).toBe(true);
  });
});
