import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRequire } from 'node:module';
import { useSessionComposerFocus, type ComposerFocusRequest } from './useSessionComposerFocus';

type Props = {
  request?: ComposerFocusRequest | null;
  sessionId?: string;
  ready?: boolean;
  blocked?: boolean;
  disabled?: boolean;
  visible?: boolean;
};

function focusRequest(sessionId: string): ComposerFocusRequest {
  return { sessionId, onHandled: jest.fn() };
}

function Composer({
  request,
  sessionId = 'a',
  ready = true,
  blocked = false,
  disabled = false,
  visible = true,
}: Props) {
  const ref = useSessionComposerFocus(request, sessionId, ready, blocked, disabled);
  return visible ? createElement('textarea', { ref, disabled }) : null;
}

describe('session composer focus', () => {
  let root: Root;
  let container: HTMLElement;
  let restore: () => void;
  let focus: jest.SpyInstance;
  let desktop: boolean;

  beforeEach(() => {
    const requireFromHere = createRequire(__filename);
    let parseHTML: (html: string) => { window: Window & typeof globalThis };
    try {
      ({ parseHTML } = requireFromHere('linkedom'));
    } catch {
      ({ parseHTML } = requireFromHere(
        '../../../../../node_modules/.pnpm/linkedom@0.18.12/node_modules/linkedom'
      ));
    }
    const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
    const previous = {
      window: globalThis.window,
      document: globalThis.document,
      IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
        .IS_REACT_ACT_ENVIRONMENT,
    };
    Object.assign(globalThis, {
      window,
      document: window.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    restore = () => Object.assign(globalThis, previous);
    desktop = true;
    window.matchMedia = jest.fn(() => ({ matches: desktop }) as MediaQueryList);
    const element = window.document.getElementById('root');
    if (!element) throw new Error('Missing test root');
    container = element;
    root = createRoot(container);
    focus = jest.spyOn(window.HTMLElement.prototype, 'focus');
  });

  afterEach(() => {
    act(() => root.unmount());
    focus.mockRestore();
    restore();
  });

  function render(props: Props) {
    act(() => root.render(createElement(StrictMode, null, createElement(Composer, props))));
  }

  it('does not focus initial loads or background updates without a selection', () => {
    render({});
    render({ ready: false });
    render({});
    expect(focus).not.toHaveBeenCalled();
  });

  it('waits for the selected editable composer and focuses exactly once without scrolling', () => {
    const request = focusRequest('b');
    render({ request, ready: false });
    render({ request, sessionId: 'b', disabled: true });
    expect(focus).not.toHaveBeenCalled();
    render({ request, sessionId: 'b' });
    expect(focus).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(request.onHandled).toHaveBeenCalledTimes(1);
    render({ request, sessionId: 'b', ready: false });
    render({ request, sessionId: 'b' });
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it.each(['pointerdown', 'keydown', 'focusin'])('cancels on %s during loading', eventType => {
    const request = focusRequest('b');
    render({ request, sessionId: 'b', ready: false });
    act(() => {
      document.dispatchEvent(new window.Event(eventType));
    });
    render({ request, sessionId: 'b' });
    expect(focus).not.toHaveBeenCalled();
  });

  it('cancels when the window loses focus', () => {
    const request = focusRequest('b');
    render({ request, sessionId: 'b', ready: false });
    act(() => {
      window.dispatchEvent(new window.Event('blur'));
    });
    render({ request, sessionId: 'b' });
    expect(focus).not.toHaveBeenCalled();
  });

  it('does not open a mobile keyboard, even if capabilities later change', () => {
    desktop = false;
    const request = focusRequest('b');
    render({ request, sessionId: 'b', ready: false });
    desktop = true;
    render({ request, sessionId: 'b' });
    expect(focus).not.toHaveBeenCalled();
  });

  it('leaves questions, permissions, read-only sessions, and other panes in control', () => {
    const request = focusRequest('b');
    render({ request, sessionId: 'b', ready: false });
    render({ request, sessionId: 'b', blocked: true });
    render({ request, sessionId: 'b' });
    expect(focus).not.toHaveBeenCalled();
  });

  it('does not focus an old composer after a newer selection', () => {
    render({ request: focusRequest('b'), ready: false });
    const request = focusRequest('c');
    render({ request, sessionId: 'b' });
    expect(focus).not.toHaveBeenCalled();
    render({ request, sessionId: 'c' });
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('focuses an immediately ready selection only once under StrictMode', () => {
    render({ request: focusRequest('a') });
    expect(focus).toHaveBeenCalledTimes(1);
  });
});
