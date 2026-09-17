/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires -- Jest mocks and the DOM shim must be installed before the hook is loaded. */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type LinkedomParseHtml = (html: string) => { window: typeof globalThis; document: Document };

type MockPosthog = {
  __loaded: boolean;
  flagValue: boolean;
  setPersonCalls: Array<Record<string, unknown>>;
  reloadCalls: number;
  resetCalls: number;
  onFeatureFlags: (callback: () => void) => () => void;
  getFeatureFlag: () => boolean;
  setPersonPropertiesForFlags: (properties: Record<string, unknown>, reload?: boolean) => void;
  resetPersonPropertiesForFlags: () => void;
  reloadFeatureFlags: () => void;
};

let mockPosthog: MockPosthog;
const flagCallbacks = new Set<() => void>();

jest.mock('posthog-js/react', () => ({
  usePostHog: () => mockPosthog,
}));

const { useChatGptSignInAccess } = require('./useChatGptSignInAccess') as {
  useChatGptSignInAccess: (email: string | null) => boolean;
};

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
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.getElementById('root');
  if (!container) throw new Error('React root missing');
  return {
    container: container as unknown as HTMLElement,
    cleanup: () => Object.assign(globalThis, previous),
  };
}

function makeMockPosthog(loaded: boolean): MockPosthog {
  const posthog: MockPosthog = {
    __loaded: loaded,
    flagValue: false,
    setPersonCalls: [],
    reloadCalls: 0,
    resetCalls: 0,
    onFeatureFlags: callback => {
      flagCallbacks.add(callback);
      return () => flagCallbacks.delete(callback);
    },
    getFeatureFlag: () => posthog.flagValue,
    setPersonPropertiesForFlags: properties => {
      posthog.setPersonCalls.push(properties);
    },
    resetPersonPropertiesForFlags: () => {
      posthog.resetCalls += 1;
    },
    reloadFeatureFlags: () => {
      posthog.reloadCalls += 1;
    },
  };
  return posthog;
}

function fireFlags(): void {
  for (const callback of [...flagCallbacks]) {
    callback();
  }
}

let allowed: boolean | undefined;

function AccessProbe({ email }: { email: string | null }) {
  allowed = useChatGptSignInAccess(email);
  return null;
}

describe('useChatGptSignInAccess', () => {
  let mounted: { container: HTMLElement; cleanup: () => void } | undefined;
  let root: Root | undefined;

  beforeEach(() => {
    flagCallbacks.clear();
    allowed = undefined;
    mounted = installDom();
    act(() => {
      root = createRoot(mounted!.container);
    });
  });

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = undefined;
    }
    mounted?.cleanup();
    mounted = undefined;
  });

  function render(email: string | null): void {
    act(() => root!.render(createElement(AccessProbe, { email })));
  }

  it('evaluates the flag when PostHog loads after the first effect, without a new submission', () => {
    mockPosthog = makeMockPosthog(false);
    render('person@kilo.ai');

    expect(mockPosthog.setPersonCalls).toHaveLength(0);

    act(() => {
      mockPosthog.__loaded = true;
      mockPosthog.flagValue = true;
      fireFlags();
    });

    expect(mockPosthog.setPersonCalls).toEqual([{ email: 'person@kilo.ai' }]);
    expect(mockPosthog.reloadCalls).toBe(1);
    expect(allowed).toBe(true);
  });

  it('does not evaluate anything before an address is submitted', () => {
    mockPosthog = makeMockPosthog(true);

    render(null);

    expect(mockPosthog.setPersonCalls).toHaveLength(0);
    expect(mockPosthog.reloadCalls).toBe(0);
    expect(allowed).toBe(false);
  });

  it('issues one reload per submitted address', () => {
    mockPosthog = makeMockPosthog(true);

    render('first@kilo.ai');
    expect(mockPosthog.reloadCalls).toBe(1);

    render('second@openai.com');
    expect(mockPosthog.reloadCalls).toBe(2);
    expect(mockPosthog.setPersonCalls).toEqual([
      { email: 'first@kilo.ai' },
      { email: 'second@openai.com' },
    ]);
  });
});
