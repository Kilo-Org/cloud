import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRequire } from 'node:module';
import type { PreparationStepSnapshot } from '@kilocode/cloud-agent-sdk';
import { PreparationDuration } from './PreparationDuration';

type LinkedomModule = {
  parseHTML: (html: string) => { window: Record<string, unknown>; document: Document };
};

describe('PreparationDuration', () => {
  let root: Root;
  let container: HTMLElement;
  let previous: Map<string, unknown>;
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  const step: PreparationStepSnapshot = {
    id: 'sandbox-1',
    key: 'sandbox_boot',
    kind: 'phase',
    label: 'Creating sandbox',
    status: 'running',
    startedAt: 1000,
    revision: 1,
  };

  beforeEach(() => {
    jest.useFakeTimers({ now: 13_000 });
    const requireFromNext = createRequire(require.resolve('next/package.json'));
    const { window, document } = (requireFromNext('linkedom') as LinkedomModule).parseHTML(
      '<!doctype html><html><body><div id="root"></div></body></html>'
    );
    const replacements = { React, window, document, IS_REACT_ACT_ENVIRONMENT: true };
    previous = new Map(Object.keys(replacements).map(key => [key, globals[key]]));
    Object.assign(globals, replacements);
    const element = document.getElementById('root');
    if (!element) throw new Error('Test root missing');
    container = element;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    previous.forEach((value, key) => {
      globals[key] = value;
    });
    jest.useRealTimers();
  });

  function render(snapshot = step) {
    act(() => root.render(createElement(PreparationDuration, { step: snapshot })));
  }

  it('shows elapsed time immediately and updates without incoming step events', () => {
    render();
    expect(container.textContent).toBe('12s');

    act(() => jest.advanceTimersByTime(1000));
    expect(container.textContent).toBe('13s');

    act(() => jest.advanceTimersByTime(60_000));
    expect(container.textContent).toBe('1m 13s');
  });

  it.each(['completed', 'failed'] as const)('freezes the duration when a step is %s', status => {
    render();
    render({ ...step, status, completedAt: 14_000 });
    expect(container.textContent).toBe('13s');
    expect(jest.getTimerCount()).toBe(0);

    act(() => jest.advanceTimersByTime(10_000));
    expect(container.textContent).toBe('13s');
  });

  it('uses the original start time when reopened', () => {
    render();
    act(() => root.render(null));
    expect(jest.getTimerCount()).toBe(0);
    act(() => jest.advanceTimersByTime(10_000));

    render();
    expect(container.textContent).toBe('22s');
  });

  it('cleans up the timer on unmount', () => {
    render();
    expect(jest.getTimerCount()).toBe(1);
    act(() => root.render(null));
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not start a timer for a finished step', () => {
    render({ ...step, status: 'completed', completedAt: 5000 });
    expect(container.textContent).toBe('4s');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not keep counting a terminal step without a completion timestamp', () => {
    render({ ...step, status: 'failed' });
    expect(container.textContent).toBe('');
    expect(jest.getTimerCount()).toBe(0);
  });
});
