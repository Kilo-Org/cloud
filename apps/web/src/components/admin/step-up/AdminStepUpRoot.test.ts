jest.mock('next-auth/react', () => ({ useSession: () => mockSession }));
jest.mock('./StepUpProvider', () => {
  const ReactActual = jest.requireActual('react') as typeof React;
  return {
    StepUpProvider: ({ active, children }: { active: boolean; children: unknown }) =>
      ReactActual.createElement(
        'div',
        { 'data-active': String(active) },
        children as React.ReactNode
      ),
  };
});

import React, { act, useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AdminStepUpRoot as RootComponent } from './AdminStepUpRoot';

type LinkedomModule = {
  parseHTML: (html: string) => { window: Record<string, any>; document: Document };
};

let mockSession: { status: string; data: { isAdmin: boolean } | null } = {
  status: 'loading',
  data: null,
};
let AdminStepUpRoot!: typeof RootComponent;
let mounted: { container: HTMLElement; root: Root; cleanup: () => void } | undefined;
let childMounts = 0;

function installDom() {
  const requireFromHere = createRequire(__filename);
  const linkedom = requireFromHere('linkedom') as LinkedomModule;
  const { window, document } = linkedom.parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>'
  );
  const globals = globalThis as Record<string, unknown>;
  globals.window = window;
  globals.document = document;
  globals.navigator = window.navigator;
  globals.HTMLElement = window.HTMLElement;
  globals.Node = window.Node;
  globals.Element = window.Element;
  return { container: document.getElementById('root') as HTMLElement, cleanup: () => {} };
}

function StatefulChild() {
  const [value, setValue] = useState('');
  const mounts = useRef(0);
  useEffect(() => {
    mounts.current += 1;
    childMounts += 1;
  }, []);
  return React.createElement(
    'div',
    { 'data-mounts': mounts.current },
    React.createElement('button', { onClick: () => setValue('typed text') }, 'type'),
    React.createElement('span', { 'data-value': value }, value)
  );
}

function mount(enabled: boolean) {
  const dom = installDom();
  const root = createRoot(dom.container);
  act(() => {
    root.render(
      React.createElement(AdminStepUpRoot, {
        enabled,
        children: React.createElement(StatefulChild),
      })
    );
  });
  mounted = { ...dom, root };
}

async function rerender(enabled: boolean) {
  await act(async () => {
    mounted!.root.render(
      React.createElement(AdminStepUpRoot, {
        enabled,
        children: React.createElement(StatefulChild),
      })
    );
  });
}

beforeAll(async () => {
  ({ AdminStepUpRoot } = await import('./AdminStepUpRoot'));
});

beforeEach(() => {
  childMounts = 0;
  mockSession = { status: 'loading', data: null };
});

afterEach(async () => {
  if (mounted) {
    await act(async () => mounted!.root.unmount());
    mounted = undefined;
  }
});

describe('AdminStepUpRoot', () => {
  it('is inert for a non-admin', () => {
    mockSession = { status: 'authenticated', data: { isAdmin: false } };
    mount(true);
    expect(mounted!.container.querySelector('[data-active]')?.getAttribute('data-active')).toBe(
      'false'
    );
  });

  it('is inert when the switch is off', () => {
    mockSession = { status: 'authenticated', data: { isAdmin: true } };
    mount(false);
    expect(mounted!.container.querySelector('[data-active]')?.getAttribute('data-active')).toBe(
      'false'
    );
  });

  it('does not remount children when the session loads for an admin', async () => {
    mount(true);
    const button = mounted!.container.querySelector('button') as HTMLButtonElement;
    act(() => button.click());
    await act(async () => {});
    expect(mounted!.container.querySelector('[data-value]')?.textContent).toBe('typed text');

    mockSession = { status: 'authenticated', data: { isAdmin: true } };
    await rerender(true);

    const after = mounted!.container.querySelector('[data-mounts]') as HTMLElement;
    expect(childMounts).toBe(1);
    expect(after.getAttribute('data-mounts')).toBe('1');
    expect(mounted!.container.querySelector('[data-value]')?.textContent).toBe('typed text');
    expect(mounted!.container.querySelector('[data-active]')?.getAttribute('data-active')).toBe(
      'true'
    );
  });
});
