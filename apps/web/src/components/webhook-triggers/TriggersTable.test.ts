import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TriggersTable as TriggersTableComponent, TriggerItem } from './TriggersTable';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    createElement('a', { href }, children),
}));
jest.mock('lucide-react', () => new Proxy({}, { get: () => () => null }));
jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children }: { children: React.ReactNode }) => createElement('span', {}, children),
}));
jest.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    createElement('button', props, children),
}));
jest.mock('@/components/ui/table', () => ({
  Table: ({ children }: { children: React.ReactNode }) => createElement('table', {}, children),
  TableBody: ({ children }: { children: React.ReactNode }) => createElement('tbody', {}, children),
  TableCell: ({ children }: { children: React.ReactNode }) => createElement('td', {}, children),
  TableHead: ({ children }: { children: React.ReactNode }) => createElement('th', {}, children),
  TableHeader: ({ children }: { children: React.ReactNode }) =>
    createElement('thead', {}, children),
  TableRow: ({ children }: { children: React.ReactNode }) => createElement('tr', {}, children),
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

const scheduledTrigger: TriggerItem = {
  id: 'trigger-db-id',
  triggerId: 'saved-trigger-id',
  activationMode: 'scheduled',
  githubRepo: 'kilo/cloud',
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

let TriggersTable!: typeof TriggersTableComponent;

beforeAll(async () => {
  ({ TriggersTable } = await import('./TriggersTable'));
});

describe('TriggersTable invocation', () => {
  let root: Root | undefined;
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    cleanup?.();
    cleanup = undefined;
  });

  function render(props: Partial<React.ComponentProps<typeof TriggersTable>> = {}) {
    const dom = installDom();
    cleanup = dom.cleanup;
    root = createRoot(dom.container);
    act(() =>
      root?.render(
        createElement(TriggersTable, {
          triggers: [scheduledTrigger],
          onCopyUrl: jest.fn(),
          copiedTriggerId: null,
          getEditUrl: triggerId => `/webhooks/${triggerId}`,
          showCopy: false,
          showEdit: false,
          showDelete: false,
          ...props,
        })
      )
    );
    return dom.container;
  }

  it('shows an icon-only invoke action only for scheduled triggers and sends the saved trigger identity', () => {
    const onInvoke = jest.fn();
    const container = render({
      onInvoke,
      triggers: [
        { ...scheduledTrigger, id: 'webhook-db-id', activationMode: 'webhook' },
        scheduledTrigger,
      ],
    });
    const buttons = Array.from(container.querySelectorAll('button')).filter(item =>
      item.getAttribute('aria-label')?.startsWith('Invoke ')
    );

    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.getAttribute('aria-label')).toBe('Invoke saved-trigger-id now');
    expect(buttons[0]?.getAttribute('title')).toBe('Invoke saved-trigger-id now');
    expect(buttons[0]?.textContent).toBe('');
    act(() => buttons[0]?.click());
    expect(onInvoke).toHaveBeenCalledWith('saved-trigger-id');
  });

  it('disables paused and globally pending scheduled invocations', () => {
    const paused = render({
      onInvoke: jest.fn(),
      triggers: [{ ...scheduledTrigger, isActive: false }],
    });
    expect(paused.querySelector('button')?.disabled).toBe(true);

    act(() =>
      root?.render(
        createElement(TriggersTable, {
          triggers: [
            scheduledTrigger,
            { ...scheduledTrigger, id: 'other-db-id', triggerId: 'other' },
          ],
          onCopyUrl: jest.fn(),
          copiedTriggerId: null,
          getEditUrl: triggerId => `/webhooks/${triggerId}`,
          showCopy: false,
          showEdit: false,
          showDelete: false,
          onInvoke: jest.fn(),
          isInvoking: true,
          invokingTriggerId: 'saved-trigger-id',
        })
      )
    );
    expect(Array.from(paused.querySelectorAll('button')).every(button => button.disabled)).toBe(
      true
    );
    expect(
      Array.from(paused.querySelectorAll('button')).filter(button =>
        button.getAttribute('aria-label')?.startsWith('Invoke ')
      )
    ).toHaveLength(2);
  });

  it('does not add an action when no invoke callback is supplied', () => {
    const container = render();
    expect(container.querySelector('button')).toBeNull();
  });
});
