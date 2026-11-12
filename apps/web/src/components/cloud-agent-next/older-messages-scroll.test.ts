import { describe, expect, it, beforeEach, afterEach, beforeAll, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { type OlderMessagesError } from '@kilocode/cloud-agent-sdk';
import {
  canAutoloadOlderMessages,
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

function installDom() {
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
    ResizeObserver: globalThis.ResizeObserver,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  };
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const resizeCallbacks = new Set<() => void>();
  const observedElements = new Set<Element>();
  Object.assign(globalThis, {
    window,
    document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    getComputedStyle: () => ({ animationName: 'none', display: 'block' }),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    ResizeObserver: class {
      constructor(private callback: () => void) {}
      observe(element: Element) {
        resizeCallbacks.add(this.callback);
        observedElements.add(element);
      }
      disconnect() {
        resizeCallbacks.delete(this.callback);
      }
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.getElementById('root');
  if (!container) throw new Error('older messages pagination test root missing');
  return {
    container,
    frames,
    observedElements,
    resize: () => act(() => resizeCallbacks.forEach(callback => callback())),
    flushFrame: () => {
      const callbacks = [...frames.values()];
      frames.clear();
      act(() => callbacks.forEach(callback => callback(0)));
    },
    cleanup: () => Object.assign(globalThis, previous),
  };
}

function PaginationHarness({
  ready,
  isLoadingOlderMessages,
  resetKey,
  onLoad,
  onApi,
  scrollElementRef,
  scrollContentRef,
  isProgrammaticScrollRef,
  lastScrollTopRef,
  autoloadOnMount,
  initialPositionedRef,
  olderMessagesError = null,
  hasOlderMessages = true,
}: {
  ready: boolean;
  isLoadingOlderMessages: boolean;
  resetKey: string;
  onLoad: () => void;
  onApi: (api: PaginationApi) => void;
  scrollElementRef: RefObject<HTMLElement | null>;
  scrollContentRef?: RefObject<HTMLElement | null>;
  isProgrammaticScrollRef: RefObject<boolean>;
  lastScrollTopRef: RefObject<number>;
  autoloadOnMount?: boolean;
  initialPositionedRef?: RefObject<boolean>;
  olderMessagesError?: OlderMessagesError | null;
  hasOlderMessages?: boolean;
}) {
  const api = useOlderMessagesPagination({
    scrollElementRef,
    scrollContentRef,
    hasOlderMessages,
    isLoadingOlderMessages,
    olderMessagesError,
    onLoad,
    isProgrammaticScrollRef,
    lastScrollTopRef,
    resetKey,
    overflowCheckKey: resetKey,
    ready,
    autoloadOnMount,
    initialPositionedRef,
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
      getBoundingClientRect: () => ({ top: 0, bottom: 100 }),
      querySelectorAll: () => [],
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
    dom.flushFrame();
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

    dom.flushFrame();
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

  it.each([
    { name: 'a short first page', height: 50, top: 0, loads: 1 },
    { name: 'a visible header with overflow', height: 150, top: 50, loads: 1 },
    { name: 'an offscreen header', height: 1000, top: 900, loads: 0 },
    { name: 'a hidden chat', height: 50, top: 0, hidden: true, loads: 0 },
    { name: 'an unpositioned chat', height: 50, top: 0, positioned: false, loads: 0 },
    { name: 'a loading page', height: 50, top: 0, loading: true, loads: 0 },
    { name: 'exhausted history', height: 50, top: 0, hasOlder: false, loads: 0 },
    { name: 'a retryable error', height: 50, top: 0, error: error('retryable'), loads: 0 },
    { name: 'a terminal error', height: 50, top: 0, error: error('invalid_data'), loads: 0 },
  ])('autoloads only visible, positioned history: $name', scenario => {
    const { element } = scrollingElement(() => scenario.height);
    element.scrollTop = scenario.top;
    element.hidden = scenario.hidden ?? false;
    const onLoad = jest.fn();
    const positioned = { current: false };
    renderPagination({
      ready: true,
      isLoadingOlderMessages: scenario.loading ?? false,
      resetKey: 'visible-history',
      onLoad,
      onApi: () => undefined,
      scrollElementRef: { current: element },
      isProgrammaticScrollRef: { current: false },
      lastScrollTopRef: { current: scenario.top },
      initialPositionedRef: positioned,
      hasOlderMessages: scenario.hasOlder ?? true,
      olderMessagesError: scenario.error ?? null,
    });
    expect(onLoad).not.toHaveBeenCalled();
    positioned.current = scenario.positioned ?? true;
    dom.flushFrame();
    dom.resize();
    dom.flushFrame();
    expect(onLoad).toHaveBeenCalledTimes(scenario.loads);
  });

  it('loads consecutive pages until the earlier-history header leaves the viewport', async () => {
    let height = 50;
    const { element } = scrollingElement(() => height);
    const onLoad = jest.fn();
    const scrollElementRef = { current: element };
    const isProgrammaticScrollRef = { current: false };
    const lastScrollTopRef = { current: 0 };
    const render = (loading: boolean) =>
      renderPagination({
        ready: true,
        isLoadingOlderMessages: loading,
        resetKey: 'consecutive-pages',
        onLoad,
        onApi: () => undefined,
        scrollElementRef,
        isProgrammaticScrollRef,
        lastScrollTopRef,
      });

    render(false);
    dom.flushFrame();
    expect(onLoad).toHaveBeenCalledTimes(1);
    await act(async () => undefined);
    render(true);
    height = 70;
    render(false);
    dom.flushFrame();
    expect(onLoad).toHaveBeenCalledTimes(2);
    await act(async () => undefined);
    render(true);
    height = 270;
    render(false);
    dom.flushFrame();
    expect(element.scrollTop).toBe(220);
    expect(lastScrollTopRef.current).toBe(220);
    expect(onLoad).toHaveBeenCalledTimes(2);
  });

  it.each([50, 40])(
    'stops autoloading when a page does not grow the height (%s)',
    async nextHeight => {
      let height = 50;
      const { element } = scrollingElement(() => height);
      const onLoad = jest.fn();
      let api: PaginationApi | null = null;
      const scrollElementRef = { current: element };
      const isProgrammaticScrollRef = { current: false };
      const lastScrollTopRef = { current: 0 };
      const render = (loading: boolean, resetKey = 'no-progress') =>
        renderPagination({
          ready: true,
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

      render(false);
      dom.flushFrame();
      expect(onLoad).toHaveBeenCalledTimes(1);
      await act(async () => undefined);
      render(true);
      height = nextHeight;
      render(false);
      dom.flushFrame();
      dom.resize();
      dom.flushFrame();
      expect(onLoad).toHaveBeenCalledTimes(1);

      act(() => api?.requestOlderMessages());
      expect(onLoad).toHaveBeenCalledTimes(2);
      await act(async () => undefined);
      render(true);
      render(false);
      dom.flushFrame();
      expect(onLoad).toHaveBeenCalledTimes(2);

      height += 10;
      dom.resize();
      dom.flushFrame();
      expect(onLoad).toHaveBeenCalledTimes(3);
      await act(async () => undefined);
      render(false, 'another-session');
      dom.flushFrame();
      expect(onLoad).toHaveBeenCalledTimes(4);
    }
  );

  it('checks visibility again when the viewport grows without a scroll event', () => {
    const { element } = scrollingElement(() => 600);
    element.scrollTop = 500;
    const onLoad = jest.fn();
    renderPagination({
      ready: true,
      isLoadingOlderMessages: false,
      resetKey: 'resized-history',
      onLoad,
      onApi: () => undefined,
      scrollElementRef: { current: element },
      isProgrammaticScrollRef: { current: false },
      lastScrollTopRef: { current: 500 },
    });
    dom.flushFrame();
    expect(onLoad).not.toHaveBeenCalled();

    Object.defineProperty(element, 'clientHeight', { value: 580 });
    element.scrollTop = 20;
    dom.resize();
    dom.flushFrame();
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it('checks visibility when collapsed content exposes the earlier-history header', () => {
    let height = 600;
    const { element } = scrollingElement(() => height);
    const content = document.createElement('div');
    element.scrollTop = 500;
    const onLoad = jest.fn();
    renderPagination({
      ready: true,
      isLoadingOlderMessages: false,
      resetKey: 'collapsed-history',
      onLoad,
      onApi: () => undefined,
      scrollElementRef: { current: element },
      scrollContentRef: { current: content },
      isProgrammaticScrollRef: { current: false },
      lastScrollTopRef: { current: 500 },
    });
    dom.flushFrame();
    expect(onLoad).not.toHaveBeenCalled();
    expect(dom.observedElements).toEqual(new Set([element, content]));

    height = 60;
    element.scrollTop = 0;
    dom.resize();
    dom.flushFrame();
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'keeps the latest reading position during a load (capture frame runs before completion: %s)',
    captureBeforeCompletion => {
      let rowTop = 40;
      let height = 1000;
      const element = document.createElement('div');
      const row = document.createElement('div');
      row.dataset.messageId = 'msg_visible';
      element.append(row);
      element.scrollTop = 60;
      Object.defineProperties(element, {
        clientHeight: { value: 100 },
        scrollHeight: { get: () => height },
        getBoundingClientRect: { value: () => ({ top: 0, bottom: 100 }) },
      });
      row.getBoundingClientRect = () =>
        ({
          top: rowTop - element.scrollTop,
          bottom: rowTop - element.scrollTop + 200,
          height: 200,
        }) as DOMRect;
      const onLoad = jest.fn();
      const scrollElementRef = { current: element };
      const isProgrammaticScrollRef = { current: false };
      const lastScrollTopRef = { current: 0 };
      let api: PaginationApi | null = null;
      const render = (loading: boolean): void =>
        renderPagination({
          ready: true,
          isLoadingOlderMessages: loading,
          resetKey: 'reading',
          onLoad,
          onApi: next => {
            api = next;
          },
          scrollElementRef,
          isProgrammaticScrollRef,
          lastScrollTopRef,
          autoloadOnMount: false,
        });

      render(false);
      act(() => api?.requestOlderMessages());
      render(true);
      element.scrollTop = 160;
      act(() => api?.tryLoadOlderFromScroll(160));
      if (captureBeforeCompletion) dom.flushFrame();
      rowTop += 300;
      height += 480;
      render(false);
      dom.flushFrame();

      expect(element.scrollTop).toBe(460);
      expect(lastScrollTopRef.current).toBe(460);
      expect(row.getBoundingClientRect().top).toBe(-120);
      expect(onLoad).toHaveBeenCalledTimes(1);
    }
  );

  it('coalesces pending anchor scans into one per frame and skips unchanged scroll positions', () => {
    const { element } = scrollingElement(() => 1000);
    const scans = jest.spyOn(element, 'querySelectorAll');
    let api: PaginationApi | null = null;
    renderPagination({
      ready: true,
      isLoadingOlderMessages: false,
      resetKey: 'reading',
      onLoad: jest.fn(),
      onApi: next => {
        api = next;
      },
      scrollElementRef: { current: element },
      isProgrammaticScrollRef: { current: false },
      lastScrollTopRef: { current: 0 },
      autoloadOnMount: false,
    });
    act(() => api?.requestOlderMessages());
    scans.mockClear();

    for (const top of [100, 120, 160]) {
      element.scrollTop = top;
      act(() => api?.tryLoadOlderFromScroll(top));
    }
    expect(scans).not.toHaveBeenCalled();
    expect(dom.frames.size).toBe(1);
    dom.flushFrame();
    expect(scans).toHaveBeenCalledTimes(2);
    act(() => api?.tryLoadOlderFromScroll(160));
    expect(dom.frames.size).toBe(0);

    element.scrollTop = 180;
    act(() => api?.tryLoadOlderFromScroll(180));
    dom.flushFrame();
    expect(scans).toHaveBeenCalledTimes(4);
  });

  it('cancels a pending anchor scan when the session changes or unmounts', () => {
    const { element } = scrollingElement(() => 1000);
    let api: PaginationApi | null = null;
    const render = (resetKey: string): void =>
      renderPagination({
        ready: true,
        isLoadingOlderMessages: false,
        resetKey,
        onLoad: jest.fn(),
        onApi: next => {
          api = next;
        },
        scrollElementRef: { current: element },
        isProgrammaticScrollRef: { current: false },
        lastScrollTopRef: { current: 0 },
        autoloadOnMount: false,
      });
    render('A');
    act(() => api?.requestOlderMessages());
    element.scrollTop = 100;
    act(() => api?.tryLoadOlderFromScroll(100));
    expect(dom.frames.size).toBe(1);
    render('B');
    expect(dom.frames.size).toBe(0);

    act(() => api?.requestOlderMessages());
    element.scrollTop = 160;
    act(() => api?.tryLoadOlderFromScroll(160));
    expect(dom.frames.size).toBe(1);
    act(() => root.unmount());
    expect(dom.frames.size).toBe(0);
    root = createRoot(dom.container);
  });

  it('does not load before positioning or during a programmatic scroll', () => {
    const { element } = scrollingElement(() => 50);
    const onLoad = jest.fn();
    const positioned = { current: false };
    const programmatic = { current: false };
    let api: PaginationApi | null = null;
    renderPagination({
      ready: true,
      isLoadingOlderMessages: false,
      resetKey: 'root',
      onLoad,
      onApi: next => {
        api = next;
      },
      scrollElementRef: { current: element },
      isProgrammaticScrollRef: programmatic,
      lastScrollTopRef: { current: 0 },
      initialPositionedRef: positioned,
    });
    dom.flushFrame();
    expect(onLoad).not.toHaveBeenCalled();
    act(() => api?.tryLoadOlderFromScroll(0));
    expect(onLoad).not.toHaveBeenCalled();
    positioned.current = true;
    programmatic.current = true;
    act(() => api?.tryLoadOlderFromScroll(0));
    expect(onLoad).not.toHaveBeenCalled();
    programmatic.current = false;
    act(() => api?.tryLoadOlderFromScroll(0));
    expect(onLoad).toHaveBeenCalledTimes(1);
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
