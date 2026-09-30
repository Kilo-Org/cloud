import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BashToolCard as BashToolCardComponent } from './BashToolCard';
import type { ToolPart, ToolState } from './types';

jest.mock('react-markdown', () =>
  process.getBuiltinModule('module').createRequire(__filename)('react-markdown')
);
jest.mock('remark-gfm', () =>
  process.getBuiltinModule('module').createRequire(__filename)('remark-gfm')
);

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
    MouseEvent: window.MouseEvent,
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
  if (!container) throw new Error('BashToolCard test root missing');
  document.getSelection = () => null;
  return {
    container,
    cleanup: () => previous.forEach((value, name) => (globals[name] = value)),
  };
}

function bashPart(state: ToolState): ToolPart {
  return {
    id: 'part',
    sessionID: 'session',
    messageID: 'message',
    type: 'tool',
    callID: 'call',
    tool: 'bash',
    state,
  };
}

function runningPart(output: string): ToolPart {
  return bashPart({
    status: 'running',
    input: { command: 'seq 1 12' },
    metadata: { output },
    time: { start: 1 },
  });
}

describe('BashToolCard streaming output', () => {
  let BashToolCard: typeof BashToolCardComponent;
  let root: Root | undefined;
  let container: HTMLElement;
  let cleanup: () => void;

  beforeAll(async () => {
    const dom = installDom();
    container = dom.container;
    cleanup = dom.cleanup;
    ({ BashToolCard } = await import('./BashToolCard'));
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    container.replaceChildren();
  });

  afterAll(() => cleanup());

  function render(part: ToolPart) {
    root = createRoot(container);
    act(() => {
      root?.render(createElement(BashToolCard, { toolPart: part }));
    });
    const trigger = container.querySelector('button');
    if (!trigger) throw new Error('BashToolCard trigger missing');
    act(() => {
      const pointerDown = new Event('pointerdown', { bubbles: true, cancelable: true });
      Object.assign(pointerDown, { clientX: 10, clientY: 20 });
      trigger.dispatchEvent(pointerDown);
      const click = new Event('click', { bubbles: true, cancelable: true });
      Object.assign(click, { clientX: 10, clientY: 20, detail: 1 });
      trigger.dispatchEvent(click);
    });
    return container.querySelector<HTMLPreElement>('pre[aria-label="Output"]');
  }

  it('uses a short autoscrolling window while the command streams and keeps every line', () => {
    const lines = Array.from({ length: 12 }, (_, index) => `STREAM_B_${index + 1}`);
    const pre = render(runningPart(lines.join('\n')));

    expect(pre).not.toBeNull();
    expect(pre?.className).toContain('max-h-24');
    expect(pre?.className).not.toContain('max-h-80');
    expect(pre?.getAttribute('aria-busy')).toBe('true');
    expect(pre?.textContent).toBe(lines.join('\n'));
  });

  it('expands to the full output window once the command completes', () => {
    const pre = render(
      bashPart({
        status: 'completed',
        input: { command: 'seq 1 12' },
        output: 'STREAM_B_1\nSTREAM_B_12',
        title: 'shell',
        metadata: {},
        time: { start: 1, end: 2 },
      })
    );

    expect(pre?.className).toContain('max-h-80');
    expect(pre?.className).not.toContain('max-h-24');
    expect(pre?.getAttribute('aria-busy')).toBeNull();
    expect(pre?.textContent).toBe('STREAM_B_1\nSTREAM_B_12');
  });

  it('pins the streaming output to the bottom until the reader scrolls up', () => {
    root = createRoot(container);
    act(() => {
      root?.render(createElement(BashToolCard, { toolPart: runningPart('a\nb') }));
    });
    const trigger = container.querySelector('button');
    if (!trigger) throw new Error('BashToolCard trigger missing');
    act(() => {
      const click = new Event('click', { bubbles: true, cancelable: true });
      Object.assign(click, { detail: 1 });
      trigger.dispatchEvent(click);
    });
    const pre = container.querySelector<HTMLPreElement>('pre[aria-label="Output"]');
    if (!pre) throw new Error('streaming output window missing');

    let scrollHeight = 400;
    Object.defineProperty(pre, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    Object.defineProperty(pre, 'clientHeight', { configurable: true, get: () => 100 });

    act(() => {
      root?.render(createElement(BashToolCard, { toolPart: runningPart('a\nb\nc') }));
    });
    expect(pre.scrollTop).toBe(400);

    pre.scrollTop = 0;
    act(() => {
      pre.dispatchEvent(new Event('scroll'));
    });
    scrollHeight = 500;
    act(() => {
      root?.render(createElement(BashToolCard, { toolPart: runningPart('a\nb\nc\nd') }));
    });
    expect(pre.scrollTop).toBe(0);
  });

  it('shows the error output and exit state when the command fails', () => {
    render(
      bashPart({
        status: 'error',
        input: { command: 'exit 7' },
        error: 'EXPECTED_B_FAILURE',
        time: { start: 1, end: 2 },
      })
    );

    const error = container.querySelector('pre[aria-label="Error"]');
    expect(error?.textContent).toBe('EXPECTED_B_FAILURE');
    expect(container.textContent).toContain('Failed');
  });
});
