import { describe, expect, it, beforeEach, afterEach, beforeAll, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { type OlderMessagesError } from '@kilocode/cloud-agent-sdk';
import {
  canAutoloadOlderMessages,
  restoreScrollAfterPrepend,
  selectOlderMessagesHeaderState,
  shouldAnnounceOlderMessagesArrival,
  shouldTriggerOlderMessagesLoad,
  useOlderMessagesPagination,
} from './older-messages-scroll';

function error(kind: OlderMessagesError['kind']): OlderMessagesError {
  return { kind };
}

describe('shouldTriggerOlderMessagesLoad', () => {
  it('returns false when there are no older messages', () => {
    expect(
      shouldTriggerOlderMessagesLoad({
        hasOlderMessages: false,
        isLoadingOlderMessages: false,
        isInFlight: false,
        olderMessagesError: null,
      })
    ).toBe(false);
  });

  it('returns false when a page is already loading', () => {
    expect(
      shouldTriggerOlderMessagesLoad({
        hasOlderMessages: true,
        isLoadingOlderMessages: true,
        isInFlight: false,
        olderMessagesError: null,
      })
    ).toBe(false);
  });

  it('returns false while the local in-flight latch is still set', () => {
    expect(
      shouldTriggerOlderMessagesLoad({
        hasOlderMessages: true,
        isLoadingOlderMessages: false,
        isInFlight: true,
        olderMessagesError: null,
      })
    ).toBe(false);
  });

  it('returns false for a non-retryable invalid_data terminal failure', () => {
    expect(
      shouldTriggerOlderMessagesLoad({
        hasOlderMessages: true,
        isLoadingOlderMessages: false,
        isInFlight: false,
        olderMessagesError: error('invalid_data'),
      })
    ).toBe(false);
  });

  it('returns false for a non-retryable too_large terminal failure', () => {
    expect(
      shouldTriggerOlderMessagesLoad({
        hasOlderMessages: true,
        isLoadingOlderMessages: false,
        isInFlight: false,
        olderMessagesError: error('too_large'),
      })
    ).toBe(false);
  });

  it('returns true for a retryable failure so the gesture can re-trigger', () => {
    expect(
      shouldTriggerOlderMessagesLoad({
        hasOlderMessages: true,
        isLoadingOlderMessages: false,
        isInFlight: false,
        olderMessagesError: error('retryable'),
      })
    ).toBe(true);
  });

  it('returns true in the happy path with no error and a cursor', () => {
    expect(
      shouldTriggerOlderMessagesLoad({
        hasOlderMessages: true,
        isLoadingOlderMessages: false,
        isInFlight: false,
        olderMessagesError: null,
      })
    ).toBe(true);
  });

  it('gives the loading/in-flight guards priority over the retryable path', () => {
    expect(
      shouldTriggerOlderMessagesLoad({
        hasOlderMessages: true,
        isLoadingOlderMessages: true,
        isInFlight: true,
        olderMessagesError: error('retryable'),
      })
    ).toBe(false);
  });
});

describe('canAutoloadOlderMessages', () => {
  it('returns false when the scroller is hidden', () => {
    expect(canAutoloadOlderMessages({ hidden: true, clientHeight: 400 })).toBe(false);
  });

  it('returns false when the scroller has no height', () => {
    expect(canAutoloadOlderMessages({ hidden: false, clientHeight: 0 })).toBe(false);
  });

  it('returns true when the scroller is visible and has height', () => {
    expect(canAutoloadOlderMessages({ hidden: false, clientHeight: 400 })).toBe(true);
  });
});

describe('restoreScrollAfterPrepend', () => {
  it('adds the height delta to scrollTop', () => {
    const el = { scrollTop: 12, scrollHeight: 800 };
    restoreScrollAfterPrepend(el, 500);
    expect(el.scrollTop).toBe(312);
  });

  it('leaves scrollTop unchanged when height did not grow', () => {
    const el = { scrollTop: 40, scrollHeight: 400 };
    restoreScrollAfterPrepend(el, 400);
    expect(el.scrollTop).toBe(40);
  });
});

describe('selectOlderMessagesHeaderState', () => {
  it('hides the banner while loading with no omitted count', () => {
    expect(
      selectOlderMessagesHeaderState({
        isLoadingOlderMessages: true,
        olderMessagesError: null,
        olderMessagesOmittedItemCount: 0,
      })
    ).toEqual({ kind: 'hidden' });
  });

  it('keeps the omitted banner through a subsequent load', () => {
    expect(
      selectOlderMessagesHeaderState({
        isLoadingOlderMessages: true,
        olderMessagesError: null,
        olderMessagesOmittedItemCount: 5,
      })
    ).toEqual({ kind: 'omitted', count: 5 });
  });

  it('prefers a retryable error over loading', () => {
    expect(
      selectOlderMessagesHeaderState({
        isLoadingOlderMessages: true,
        olderMessagesError: error('retryable'),
        olderMessagesOmittedItemCount: 0,
      })
    ).toEqual({ kind: 'retryable' });
  });
});

describe('shouldAnnounceOlderMessagesArrival', () => {
  it('announces only when items prepend after the list has painted', () => {
    expect(
      shouldAnnounceOlderMessagesArrival({
        wasInitialized: true,
        previousCount: 10,
        nextCount: 20,
        previousNewestKey: 'msg_new',
        nextNewestKey: 'msg_new',
      })
    ).toBe(true);
  });

  it('skips the initial paint', () => {
    expect(
      shouldAnnounceOlderMessagesArrival({
        wasInitialized: false,
        previousCount: 0,
        nextCount: 10,
        previousNewestKey: null,
        nextNewestKey: 'msg_new',
      })
    ).toBe(false);
  });
});

type PaginationApi = ReturnType<typeof useOlderMessagesPagination>;

function installDom(): { container: HTMLElement; cleanup: () => void } {
  const requireFromHere = createRequire(__filename);
  const loadLinkedom = (): { parseHTML: (html: string) => { window: typeof globalThis } } => {
    try {
      return requireFromHere('linkedom') as {
        parseHTML: (html: string) => { window: typeof globalThis };
      };
    } catch {
      return requireFromHere(
        '../../../../../node_modules/.pnpm/linkedom@0.18.12/node_modules/linkedom'
      ) as { parseHTML: (html: string) => { window: typeof globalThis } };
    }
  };
  const { window } = loadLinkedom().parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>'
  );
  const document = window.document;
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Element: globalThis.Element,
    Node: globalThis.Node,
    getComputedStyle: globalThis.getComputedStyle,
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
    getComputedStyle: () => ({ animationName: 'none', display: 'block' }),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => undefined,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.getElementById('root');
  if (!container) throw new Error('older messages pagination test root missing');
  return { container, cleanup: () => Object.assign(globalThis, previous) };
}

function PaginationHarness({
  ready,
  isLoadingOlderMessages,
  resetKey,
  onLoad,
  onApi,
  scrollElementRef,
  isProgrammaticScrollRef,
  lastScrollTopRef,
}: {
  ready: boolean;
  isLoadingOlderMessages: boolean;
  resetKey: string;
  onLoad: () => void;
  onApi: (api: PaginationApi) => void;
  scrollElementRef: RefObject<HTMLElement | null>;
  isProgrammaticScrollRef: RefObject<boolean>;
  lastScrollTopRef: RefObject<number>;
}) {
  const api = useOlderMessagesPagination({
    scrollElementRef,
    hasOlderMessages: true,
    isLoadingOlderMessages,
    olderMessagesError: null,
    onLoad,
    isProgrammaticScrollRef,
    lastScrollTopRef,
    resetKey,
    overflowCheckKey: resetKey,
    ready,
  });
  onApi(api);
  return null;
}

describe('useOlderMessagesPagination readiness', () => {
  let root: Root;
  let dom: ReturnType<typeof installDom>;

  beforeAll(() => {
    Object.assign(globalThis, { React });
  });

  beforeEach(() => {
    dom = installDom();
    root = createRoot(dom.container);
  });

  afterEach(() => {
    act(() => root.unmount());
    dom.cleanup();
  });

  function scrollingElement(height: () => number): {
    element: HTMLElement;
    heightReads: () => number;
  } {
    let reads = 0;
    const element = {
      hidden: false,
      clientHeight: 100,
      scrollTop: 0,
      get scrollHeight() {
        reads += 1;
        return height();
      },
    };
    return { element: element as unknown as HTMLElement, heightReads: () => reads };
  }

  function renderPagination(
    props: Omit<React.ComponentProps<typeof PaginationHarness>, 'onApi'> & {
      onApi: (api: PaginationApi) => void;
    }
  ): void {
    act(() => {
      root.render(createElement(PaginationHarness, props));
    });
  }

  it('does not read scroll height or autoload while not ready', () => {
    const { element, heightReads } = scrollingElement(() => 50);
    const onLoad = jest.fn();
    const scrollElementRef: RefObject<HTMLElement | null> = { current: element };
    const isProgrammaticScrollRef = { current: false };
    const lastScrollTopRef = { current: 0 };

    let api: PaginationApi | null = null;
    renderPagination({
      ready: false,
      isLoadingOlderMessages: false,
      resetKey: 'ses',
      onLoad,
      onApi: next => {
        api = next;
      },
      scrollElementRef,
      isProgrammaticScrollRef,
      lastScrollTopRef,
    });

    act(() => api?.tryLoadOlderFromScroll(0));
    act(() => api?.requestOlderMessages());
    expect(onLoad).not.toHaveBeenCalled();
    expect(heightReads()).toBe(0);

    renderPagination({
      ready: true,
      isLoadingOlderMessages: false,
      resetKey: 'ses',
      onLoad,
      onApi: () => undefined,
      scrollElementRef,
      isProgrammaticScrollRef,
      lastScrollTopRef,
    });

    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(heightReads()).toBeGreaterThan(0);
  });

  it('restores the prepend position when no reset intervenes', () => {
    let height = 200;
    const { element } = scrollingElement(() => height);
    const onLoad = jest.fn();
    const scrollElementRef: RefObject<HTMLElement | null> = { current: element };
    const isProgrammaticScrollRef = { current: false };
    const lastScrollTopRef = { current: 0 };
    let api: PaginationApi | null = null;

    const render = (loading: boolean): void =>
      renderPagination({
        ready: true,
        isLoadingOlderMessages: loading,
        resetKey: 'A',
        onLoad,
        onApi: next => {
          api = next;
        },
        scrollElementRef,
        isProgrammaticScrollRef,
        lastScrollTopRef,
      });

    render(false);
    act(() => api?.requestOlderMessages());
    render(true);
    height = 350;
    render(false);

    expect(lastScrollTopRef.current).toBe(150);
  });

  it('clears a pending prepend restore when the reset key changes', () => {
    let height = 200;
    const { element } = scrollingElement(() => height);
    const onLoad = jest.fn();
    const scrollElementRef: RefObject<HTMLElement | null> = { current: element };
    const isProgrammaticScrollRef = { current: false };
    const lastScrollTopRef = { current: 0 };
    let api: PaginationApi | null = null;

    const render = (ready: boolean, loading: boolean, resetKey: string): void =>
      renderPagination({
        ready,
        isLoadingOlderMessages: loading,
        resetKey,
        onLoad,
        onApi: next => {
          api = next;
        },
        scrollElementRef,
        isProgrammaticScrollRef,
        lastScrollTopRef,
      });

    render(true, false, 'A');
    act(() => api?.requestOlderMessages());
    render(false, false, 'B');
    render(true, false, 'B');
    render(true, true, 'B');
    height = 350;
    render(true, false, 'B');

    expect(lastScrollTopRef.current).toBe(0);
  });
});
