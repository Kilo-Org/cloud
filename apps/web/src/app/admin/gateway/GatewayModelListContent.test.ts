import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import type { createRoot as createReactRoot, Root } from 'react-dom/client';
import type { GatewayModelListContent as GatewayModelListContentComponent } from './GatewayModelListContent';

const mockModelId = 'provider/missing-model';
const mockSavedConfig = { config: { models: [mockModelId] } };
const mockCatalog: { id: string; name: string }[] = [];

jest.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey: string[] }) =>
    options.queryKey[0] === 'catalog'
      ? { data: mockCatalog, isLoading: false, isSuccess: true }
      : { data: mockSavedConfig, isLoading: false },
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
  useMutation: () => ({ isPending: false, mutate: jest.fn() }),
}));
jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    admin: {
      gatewayModelLists: {
        get: {
          queryOptions: ({ list }: { list: string }) => ({ queryKey: ['gateway-list', list] }),
        },
        set: { mutationOptions: () => ({}) },
      },
    },
    models: { list: { queryOptions: () => ({ queryKey: ['catalog'] }) } },
  }),
}));
jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
jest.mock('@/components/shared/ModelCombobox', () => ({ ModelCombobox: () => null }));

type LinkedomModule = {
  parseHTML: (html: string) => { window: typeof globalThis; document: Document };
};

describe('GatewayModelListContent catalog badge', () => {
  let root: Root | undefined;
  let container: HTMLElement;
  let cleanup: (() => void) | undefined;
  let Content: typeof GatewayModelListContentComponent;

  beforeEach(async () => {
    const requireFromNext = createRequire(require.resolve('next/package.json'));
    const { window, document } = (requireFromNext('linkedom') as LinkedomModule).parseHTML(
      '<!doctype html><html><body><div id="root"></div></body></html>'
    );
    const replacements = {
      React,
      window,
      document,
      HTMLElement: window.HTMLElement,
      HTMLInputElement: window.HTMLInputElement,
      HTMLTextAreaElement: window.HTMLTextAreaElement,
      Event: window.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = new Map(
      Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
    );
    Object.assign(globalThis, replacements);
    cleanup = () => {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    };
    const element = document.getElementById('root');
    if (!element) throw new Error('Test root missing');
    container = element;
    const { createRoot }: { createRoot: typeof createReactRoot } = await import('react-dom/client');
    const { GatewayModelListContent } = await import('./GatewayModelListContent');
    Content = GatewayModelListContent;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    cleanup?.();
  });

  it('shows the saved ID without a catalog badge in unavailable models', () => {
    act(() =>
      root?.render(
        createElement(Content, {
          list: 'unavailable_models',
          title: 'Unavailable Models',
          description: 'Unavailable models',
          ordered: false,
        })
      )
    );

    expect(container.textContent).toContain(mockModelId);
    expect(container.textContent).not.toContain('Not in catalog');
  });

  it('marks a saved ID missing from the catalog in preferred models', () => {
    act(() =>
      root?.render(
        createElement(Content, {
          list: 'preferred_models',
          title: 'Preferred Models',
          description: 'Preferred models',
          ordered: true,
        })
      )
    );

    expect(container.textContent).toContain(mockModelId);
    expect(container.textContent).toContain('Not in catalog');
  });
});
