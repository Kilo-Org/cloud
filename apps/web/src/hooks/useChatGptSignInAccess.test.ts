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
  useChatGptSignInAccess: (email: string) => boolean;
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

function AccessProbe({ email }: { email: string }) {
  allowed = useChatGptSignInAccess(email);
  return null;
}

describe('useChatGptSignInAccess', () => {
  let mounted: { container: HTMLElement; cleanup: () => void } | undefined;
  let root: Root | undefined;

  beforeEach(() => {
    jest.useFakeTimers();
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
    jest.useRealTimers();
  });

  function render(email: string): void {
    act(() => root!.render(createElement(AccessProbe, { email })));
  }

  it('evaluates the flag when PostHog loads after the first effect, without an email change', () => {
    mockPosthog = makeMockPosthog(false);
    render('person@kilo.ai');

    expect(mockPosthog.setPersonCalls).toHaveLength(0);

    act(() => {
      mockPosthog.__loaded = true;
      mockPosthog.flagValue = true;
      fireFlags();
    });
    act(() => {
      jest.advanceTimersByTime(300);
    });

    expect(mockPosthog.setPersonCalls).toEqual([{ email: 'person@kilo.ai' }]);
    expect(mockPosthog.reloadCalls).toBe(1);
    expect(allowed).toBe(true);
  });

  it('reloads the flags once for a settled address instead of once per keystroke', () => {
    mockPosthog = makeMockPosthog(true);

    render('p');
    act(() => jest.advanceTimersByTime(50));
    render('pe');
    act(() => jest.advanceTimersByTime(50));
    render('per');
    act(() => jest.advanceTimersByTime(50));
    render('pers');

    expect(mockPosthog.reloadCalls).toBe(0);

    act(() => jest.advanceTimersByTime(300));

    expect(mockPosthog.setPersonCalls).toEqual([{ email: 'pers' }]);
    expect(mockPosthog.reloadCalls).toBe(1);
  });

  it('resets an empty email without issuing a second reload', () => {
    mockPosthog = makeMockPosthog(true);

    render('');
    act(() => jest.advanceTimersByTime(300));

    expect(mockPosthog.resetCalls).toBe(1);
    expect(mockPosthog.reloadCalls).toBe(0);
    expect(mockPosthog.setPersonCalls).toHaveLength(0);
  });
});
