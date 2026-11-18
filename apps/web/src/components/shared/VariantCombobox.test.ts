import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { VariantCombobox as VariantComboboxComponent } from './VariantCombobox';

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    createElement('button', props, children),
}));
jest.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => createElement('div', {}, children),
  PopoverContent: ({ children }: { children: React.ReactNode }) =>
    createElement('div', {}, children),
  PopoverTrigger: ({ children }: { children: React.ReactNode }) =>
    createElement('div', {}, children),
}));
jest.mock('@/components/ui/command', () => ({
  Command: ({ children }: { children: React.ReactNode }) => createElement('div', {}, children),
  CommandGroup: ({ children }: { children: React.ReactNode }) => createElement('div', {}, children),
  CommandItem: ({ children, onSelect }: { children: React.ReactNode; onSelect: () => void }) =>
    createElement('button', { type: 'button', role: 'option', onClick: onSelect }, children),
  CommandList: ({ children }: { children: React.ReactNode }) => createElement('div', {}, children),
}));
jest.mock('lucide-react', () => new Proxy({}, { get: () => () => null }));

type LinkedomModule = {
  parseHTML: (html: string) => { window: Record<string, unknown>; document: Document };
};

function installDom() {
  const requireFromHere = createRequire(__filename);
  const requireFromNext = createRequire(requireFromHere.resolve('next/package.json'));
  const { window, document } = (requireFromNext('linkedom') as LinkedomModule).parseHTML(
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
    window,
    document,
    HTMLElement: (window as { HTMLElement: typeof HTMLElement }).HTMLElement,
    Element: (window as { Element: typeof Element }).Element,
    Node: (window as { Node: typeof Node }).Node,
    Event: (window as { Event: typeof Event }).Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.getElementById('root');
  if (!container) throw new Error('linkedom root missing');
  return {
    container: container as HTMLElement,
    cleanup: () => previous.forEach((value, key) => (globals[key] = value)),
  };
}

let VariantCombobox!: typeof VariantComboboxComponent;

beforeAll(async () => {
  ({ VariantCombobox } = await import('./VariantCombobox'));
});

describe('VariantCombobox default option', () => {
  let root: Root | undefined;
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    cleanup?.();
    cleanup = undefined;
  });

  it('offers Default only when clearing is opted in and calls the clear callback', () => {
    const dom = installDom();
    cleanup = dom.cleanup;
    root = createRoot(dom.container);
    const onClear = jest.fn();
    const onValueChange = jest.fn();
    act(() =>
      root?.render(
        createElement(VariantCombobox, { variants: ['none', 'high'], onValueChange, onClear })
      )
    );

    expect(dom.container.textContent).toContain('Default');
    const defaultOption = Array.from(dom.container.querySelectorAll('button[role="option"]')).find(
      button => button.textContent === 'Default'
    );
    if (!defaultOption) throw new Error('default option not found');
    act(() => {
      defaultOption.dispatchEvent(new Event('click', { bubbles: true }));
    });
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('keeps legacy callers selectable without a Default option', () => {
    const dom = installDom();
    cleanup = dom.cleanup;
    root = createRoot(dom.container);
    const onValueChange = jest.fn();
    act(() =>
      root?.render(
        createElement(VariantCombobox, { variants: ['high'], value: 'high', onValueChange })
      )
    );
    expect(dom.container.textContent).toContain('High');
    expect(dom.container.textContent).not.toContain('Default');
    const option = dom.container.querySelector('button[role="option"]');
    if (!option) throw new Error('variant option not found');
    act(() => {
      option.dispatchEvent(new Event('click', { bubbles: true }));
    });
    expect(onValueChange).toHaveBeenCalledWith('high');
  });

  it('renders a stale effort with no variants so it can be cleared to Default', () => {
    const dom = installDom();
    cleanup = dom.cleanup;
    root = createRoot(dom.container);
    const onClear = jest.fn();
    act(() =>
      root?.render(
        createElement(VariantCombobox, {
          variants: [],
          value: 'high',
          onValueChange: jest.fn(),
          onClear,
        })
      )
    );
    expect(dom.container.textContent).toContain('High');
    const defaultOption = Array.from(dom.container.querySelectorAll('button[role="option"]')).find(
      button => button.textContent === 'Default'
    );
    if (!defaultOption) throw new Error('default option not found');
    act(() => {
      defaultOption.dispatchEvent(new Event('click', { bubbles: true }));
    });
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
