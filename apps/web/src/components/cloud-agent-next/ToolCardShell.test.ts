import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FileText } from 'lucide-react';
import type { ToolCardShell as ToolCardShellComponent } from './ToolCardShell';

function installDom() {
  const requireFromHere = createRequire(__filename);
  const requireFromNext = createRequire(requireFromHere.resolve('next/package.json'));
  const { window, document } = (
    requireFromNext('linkedom') as {
      parseHTML: (html: string) => { window: Record<string, unknown>; document: Document };
    }
  ).parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  const values = {
    React,
    window,
    document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    getComputedStyle: () => ({ animationName: 'none', display: 'block' }),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => undefined,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(values).map(name => [name, globals[name]]));
  Object.assign(globals, values);
  const container = document.getElementById('root');
  if (!container) throw new Error('ToolCardShell test root missing');
  return {
    container,
    cleanup: () => previous.forEach((value, name) => (globals[name] = value)),
  };
}

function selectionIn(trigger: HTMLElement, isCollapsed = false): Selection {
  const text = trigger.querySelector('code')?.firstChild;
  if (!text) throw new Error('ToolCardShell subtitle text missing');
  const selection: Pick<Selection, 'isCollapsed' | 'rangeCount' | 'getRangeAt'> = {
    isCollapsed,
    rangeCount: 1,
    getRangeAt: () => ({ intersectsNode: (node: Node) => node.contains(text) }) as Range,
  };
  return selection as Selection;
}

function dispatch(
  target: HTMLElement,
  type: 'pointerdown' | 'pointercancel' | 'click',
  properties: Partial<Pick<MouseEvent, 'clientX' | 'clientY' | 'detail' | 'shiftKey'>> = {}
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { clientX: 10, clientY: 20, detail: 1, shiftKey: false, ...properties });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe('ToolCardShell selection click guard', () => {
  let ToolCardShell: typeof ToolCardShellComponent;
  let root: Root | undefined;
  let container: HTMLElement;
  let cleanup: () => void;
  let selection: Selection | null;
  let trigger: HTMLButtonElement;
  let otherTrigger: HTMLButtonElement;

  beforeAll(async () => {
    const dom = installDom();
    container = dom.container;
    cleanup = dom.cleanup;
    ({ ToolCardShell } = await import('./ToolCardShell'));
  });

  beforeEach(() => {
    selection = null;
    document.getSelection = () => selection;
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(
          React.Fragment,
          null,
          createElement(
            ToolCardShell,
            { icon: FileText, title: 'Write', subtitle: 'PLAN.md', status: 'completed' },
            'Plan details'
          ),
          createElement(
            ToolCardShell,
            { icon: FileText, title: 'Read', subtitle: 'README.md', status: 'completed' },
            'Read details'
          )
        )
      );
    });
    const buttons = container.querySelectorAll('button');
    if (buttons.length !== 2) throw new Error('ToolCardShell triggers missing');
    [trigger, otherTrigger] = Array.from(buttons);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
  });

  afterAll(() => cleanup());

  it('toggles open and closed on ordinary pointer clicks', () => {
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    for (const expanded of [true, false]) {
      dispatch(trigger, 'pointerdown');
      const click = dispatch(trigger, 'click');
      expect(click.defaultPrevented).toBe(false);
      expect(trigger.getAttribute('aria-expanded')).toBe(String(expanded));
    }
  });

  it('preserves both closed and open state after a selected drag', () => {
    dispatch(trigger, 'pointerdown');
    selection = selectionIn(trigger);
    const closedClick = dispatch(trigger, 'click', { clientX: 13 });
    expect(closedClick.defaultPrevented).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    selection = null;
    dispatch(trigger, 'pointerdown');
    dispatch(trigger, 'click');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    dispatch(trigger, 'pointerdown');
    selection = selectionIn(trigger);
    const openClick = dispatch(trigger, 'click', { clientY: 17 });
    expect(openClick.defaultPrevented).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('allows detail-zero activation clicks despite selection and a pending pointer gesture', () => {
    dispatch(trigger, 'pointerdown');
    selection = selectionIn(trigger);
    for (const expanded of [true, false]) {
      const click = dispatch(trigger, 'click', { detail: 0, clientX: 50 });
      expect(click.defaultPrevented).toBe(false);
      expect(trigger.getAttribute('aria-expanded')).toBe(String(expanded));
    }
  });

  it('ignores stale same-row selection for stationary and small-jitter ordinary clicks', () => {
    selection = selectionIn(trigger);
    dispatch(trigger, 'pointerdown');
    const stationaryClick = dispatch(trigger, 'click');
    expect(stationaryClick.defaultPrevented).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    dispatch(trigger, 'pointerdown');
    const jitterClick = dispatch(trigger, 'click', { clientX: 12, clientY: 18 });
    expect(jitterClick.defaultPrevented).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('does not toggle when a stationary Shift-click selects header text', () => {
    dispatch(trigger, 'pointerdown', { shiftKey: true });
    selection = selectionIn(trigger);
    const click = dispatch(trigger, 'click', { shiftKey: true });
    expect(click.defaultPrevented).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('does not block another row when the selection is elsewhere', () => {
    selection = selectionIn(trigger);
    dispatch(otherTrigger, 'pointerdown');
    const dragClick = dispatch(otherTrigger, 'click', { clientX: 50 });
    expect(dragClick.defaultPrevented).toBe(false);
    expect(otherTrigger.getAttribute('aria-expanded')).toBe('true');

    dispatch(otherTrigger, 'pointerdown');
    const multiClick = dispatch(otherTrigger, 'click', { detail: 2 });
    expect(multiClick.defaultPrevented).toBe(false);
    expect(otherTrigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('allows movement when selection is absent, collapsed, or empty', () => {
    const selections = [
      null,
      selectionIn(trigger, true),
      { isCollapsed: true, rangeCount: 0 } as Selection,
    ];
    let expanded = false;
    for (const currentSelection of selections) {
      dispatch(trigger, 'pointerdown');
      selection = currentSelection;
      const click = dispatch(trigger, 'click', { clientX: 50 });
      expanded = !expanded;
      expect(click.defaultPrevented).toBe(false);
      expect(trigger.getAttribute('aria-expanded')).toBe(String(expanded));
    }
  });

  it('clears a cancelled gesture before a click without a fresh pointerdown', () => {
    dispatch(trigger, 'pointerdown');
    selection = selectionIn(trigger);
    dispatch(trigger, 'pointercancel');
    const click = dispatch(trigger, 'click', { clientY: 60 });
    expect(click.defaultPrevented).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('allows the first click but vetoes selection-producing multi-clicks', () => {
    dispatch(trigger, 'pointerdown');
    const firstClick = dispatch(trigger, 'click');
    expect(firstClick.defaultPrevented).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    for (const detail of [2, 3]) {
      dispatch(trigger, 'pointerdown');
      selection = selectionIn(trigger);
      const click = dispatch(trigger, 'click', { detail });
      expect(click.defaultPrevented).toBe(true);
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
    }
  });
});
