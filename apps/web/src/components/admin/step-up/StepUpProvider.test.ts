jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    stepUp: { getStatus: { queryOptions: () => ({ queryKey: ['step-up-status'] }) } },
  }),
}));
jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));
jest.mock('@/lib/trpc/step-up-link', () => ({ registerStepUpHandler: jest.fn() }));
jest.mock('./StepUpDialog', () => {
  const ReactActual = jest.requireActual('react') as typeof React;
  return { StepUpDialog: () => ReactActual.createElement('div', null, 'dialog') };
});

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { StepUpProvider as ProviderComponent } from './StepUpProvider';

const mockRegister = (
  jest.requireMock('@/lib/trpc/step-up-link') as { registerStepUpHandler: jest.Mock }
).registerStepUpHandler;
let StepUpProvider!: typeof ProviderComponent;
let mounted: { root: Root; container: HTMLElement } | undefined;

function installDom() {
  const requireFromHere = createRequire(__filename);
  const { parseHTML } = requireFromHere('linkedom') as {
    parseHTML: (html: string) => { window: Record<string, any>; document: Document };
  };
  const { window, document } = parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>'
  );
  const globals = globalThis as Record<string, unknown>;
  globals.window = window;
  globals.document = document;
  globals.navigator = window.navigator;
  globals.HTMLElement = window.HTMLElement;
  globals.Node = window.Node;
  globals.Element = window.Element;
  return document.getElementById('root') as HTMLElement;
}

function render(active: boolean) {
  const container = mounted?.container ?? installDom();
  const root = mounted?.root ?? createRoot(container);
  act(() => {
    root.render(
      React.createElement(StepUpProvider, {
        active,
        children: React.createElement('span', null, 'child'),
      })
    );
  });
  mounted = { root, container };
}

beforeAll(async () => {
  ({ StepUpProvider } = await import('./StepUpProvider'));
});

afterEach(async () => {
  if (mounted) await act(async () => mounted!.root.unmount());
  mounted = undefined;
  mockRegister.mockClear();
});

describe('StepUpProvider', () => {
  it('registers no handler and renders no dialog when inactive', () => {
    render(false);
    expect(mockRegister).not.toHaveBeenCalled();
    expect(mounted!.container.textContent).not.toContain('dialog');
  });

  it('settles pending work when active turns false', async () => {
    render(true);
    const handler = mockRegister.mock.calls.at(-1)?.[0] as
      | ((requirement: { code: 'MFA_REQUIRED' }) => Promise<boolean>)
      | undefined;
    const pending = handler?.({ code: 'MFA_REQUIRED' });
    expect(pending).toBeDefined();

    render(false);

    await expect(pending).resolves.toBe(false);
  });

  it('registers a handler only when active and unregisters on teardown', async () => {
    render(true);
    expect(mockRegister).toHaveBeenCalledWith(expect.any(Function));
    expect(mounted!.container.textContent).toContain('dialog');

    await act(async () => mounted!.root.unmount());
    expect(mockRegister).toHaveBeenLastCalledWith(null);
    mounted = undefined;
  });
});
