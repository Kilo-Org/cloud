import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import type { AdminViewOrganizationButton as ButtonComponentType } from './AdminViewOrganizationButton';

const mockFetchQuery =
  jest.fn<(options: unknown) => Promise<{ grantRequired: boolean; expiresAt: string | null }>>();

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ fetchQuery: mockFetchQuery }),
}));
jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    admin: {
      supportAccess: {
        viewAccess: { queryOptions: () => ({ queryKey: ['support-view'] }) },
      },
    },
  }),
}));
jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
jest.mock('@/components/organizations/SupportAccessRequestDialog', () => ({
  SupportAccessRequestDialog: () => null,
}));

describe('AdminViewOrganizationButton', () => {
  let container: HTMLElement;
  let root: Root;
  let cleanup: () => void;
  let ButtonComponent: typeof ButtonComponentType;
  let mockWindowOpen: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();
    const { parseHTML } = createRequire(__filename)('linkedom') as {
      parseHTML: (html: string) => { window: typeof globalThis; document: Document };
    };
    const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
    document.oninput = null;
    mockWindowOpen = jest.fn(() => ({ opener: null }));
    Reflect.set(window, 'open', mockWindowOpen);
    const globals = {
      React,
      window,
      document,
      HTMLElement: window.HTMLElement,
      HTMLTextAreaElement: window.HTMLTextAreaElement,
      Event: window.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = new Map(
      Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
    );
    Object.assign(globalThis, globals);
    cleanup = () => {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    };
    const element = document.getElementById('root');
    if (!element) throw new Error('Test root missing');
    container = element;
    const { createRoot } = await import('react-dom/client');
    ({ AdminViewOrganizationButton: ButtonComponent } =
      await import('./AdminViewOrganizationButton'));
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    cleanup?.();
  });

  it('opens the organization when no grant is required', async () => {
    mockFetchQuery.mockResolvedValue({ grantRequired: false, expiresAt: null });
    act(() =>
      root.render(
        createElement(ButtonComponent, {
          organizationId: 'org-1',
          organizationName: 'Customer Org',
          children: 'View organization',
        })
      )
    );

    const link = container.querySelector('a');
    if (!link) throw new Error('View link missing');
    await act(async () => {
      link.click();
      await Promise.resolve();
    });

    expect(mockWindowOpen).toHaveBeenCalledWith('/organizations/org-1', '_blank');
  });
});
