import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InvokeTriggerDialog as InvokeTriggerDialogComponent } from './InvokeTriggerDialog';

jest.mock('lucide-react', () => new Proxy({}, { get: () => () => null }));
jest.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    createElement('button', props, children),
}));
jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? createElement('div', {}, children) : null,
  DialogContent: ({ children }: { children: React.ReactNode }) =>
    createElement('div', {}, children),
  DialogDescription: ({ children }: { children: React.ReactNode }) =>
    createElement('p', {}, children),
  DialogFooter: ({ children }: { children: React.ReactNode }) => createElement('div', {}, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) => createElement('div', {}, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) => createElement('h2', {}, children),
}));

type LinkedomModule = {
  parseHTML: (html: string) => { window: Record<string, unknown>; document: Document };
};

function installDom() {
  const requireFromHere = createRequire(__filename);
  const requireFromNext = createRequire(requireFromHere.resolve('next/package.json'));
  const parsed = (requireFromNext('linkedom') as LinkedomModule).parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>'
  );
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  const previous = new Map<string, unknown>();
  for (const name of [
    'React',
    'window',
    'document',
    'HTMLElement',
    'Element',
    'Node',
    'Event',
    'IS_REACT_ACT_ENVIRONMENT',
  ]) {
    previous.set(name, globals[name]);
  }
  Object.assign(globals, {
    React,
    window: parsed.window,
    document: parsed.document,
    HTMLElement: (parsed.window as { HTMLElement: typeof HTMLElement }).HTMLElement,
    Element: (parsed.window as { Element: typeof Element }).Element,
    Node: (parsed.window as { Node: typeof Node }).Node,
    Event: (parsed.window as { Event: typeof Event }).Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = parsed.document.getElementById('root');
  if (!container) throw new Error('linkedom root missing');
  return {
    container: container as HTMLElement,
    cleanup: () => {
      for (const [name, value] of previous) globals[name] = value;
    },
  };
}

let InvokeTriggerDialog!: typeof InvokeTriggerDialogComponent;

beforeAll(async () => {
  ({ InvokeTriggerDialog } = await import('./InvokeTriggerDialog'));
});

describe('InvokeTriggerDialog', () => {
  let root: Root | undefined;
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    cleanup?.();
    cleanup = undefined;
  });

  function render(onConfirm = jest.fn<() => Promise<boolean>>().mockResolvedValue(true)) {
    const dom = installDom();
    cleanup = dom.cleanup;
    root = createRoot(dom.container);
    const onClose = jest.fn();
    act(() =>
      root?.render(
        createElement(InvokeTriggerDialog, {
          open: true,
          triggerId: 'saved-trigger-id',
          isInvokable: true,
          isInvoking: false,
          onClose,
          onConfirm,
        })
      )
    );
    return { container: dom.container, onClose, onConfirm };
  }

  it('does not invoke until the confirmation action is selected', () => {
    const { container, onConfirm } = render();

    expect(container.textContent).toContain('Invoke trigger now?');
    expect(container.textContent).toContain('saved-trigger-id');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('cancels without invoking', () => {
    const { container, onClose, onConfirm } = render();

    act(() => Array.from(container.querySelectorAll('button'))[0]?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('closes only after an accepted invocation', async () => {
    const { container, onClose, onConfirm } = render();

    await act(async () => Array.from(container.querySelectorAll('button'))[1]?.click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('guards against duplicate confirmation while an invocation is pending', async () => {
    let resolveInvocation: ((value: boolean) => void) | undefined;
    const onConfirm = jest.fn(
      () =>
        new Promise<boolean>(resolve => {
          resolveInvocation = resolve;
        })
    );
    const { container, onClose } = render(onConfirm);
    const invoke = () => Array.from(container.querySelectorAll('button'))[1]?.click();

    act(() => {
      invoke();
      invoke();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);

    await act(async () => resolveInvocation?.(true));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not invoke a trigger that is no longer scheduled and active', () => {
    const onConfirm = jest.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const { container } = render(onConfirm);

    act(() =>
      root?.render(
        createElement(InvokeTriggerDialog, {
          open: true,
          triggerId: 'saved-trigger-id',
          isInvokable: false,
          isInvoking: false,
          onClose: jest.fn(),
          onConfirm,
        })
      )
    );
    const invokeButton = Array.from(container.querySelectorAll('button'))[1];
    expect(invokeButton?.disabled).toBe(true);
    act(() => invokeButton?.click());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('keeps the dialog open after a rejected invocation and allows retrying', async () => {
    const onConfirm = jest
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('failed'))
      .mockResolvedValueOnce(true);
    const { container, onClose } = render(onConfirm);
    const invoke = () => Array.from(container.querySelectorAll('button'))[1]?.click();

    await act(async () => invoke());
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => invoke());
    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
