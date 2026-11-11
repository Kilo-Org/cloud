import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import type {
  SupportAccessRequestDialog as DialogComponentType,
  SupportGrantReceipt,
} from './SupportAccessRequestDialog';

type MutationOptions = {
  onSuccess?: (grant: SupportGrantReceipt) => void;
};

let mockMutationOptions: MutationOptions | undefined;

jest.mock('@tanstack/react-query', () => ({
  useMutation: (options: MutationOptions) => {
    mockMutationOptions = options;
    return { isPending: false, mutate: jest.fn() };
  },
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));
jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    admin: {
      supportAccess: {
        request: { mutationOptions: (options: MutationOptions) => options },
        viewAccess: { queryOptions: () => ({ queryKey: ['support-view'] }) },
      },
    },
  }),
}));
jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
jest.mock('@/components/ui/dialog', () => {
  const ReactActual = jest.requireActual('react') as typeof React;
  const passthrough =
    (tag: string) =>
    ({ children }: { children?: React.ReactNode }) =>
      ReactActual.createElement(tag, null, children);
  return {
    Dialog: ({ children }: { children?: React.ReactNode }) =>
      children ? ReactActual.createElement(ReactActual.Fragment, null, children) : null,
    DialogContent: passthrough('div'),
    DialogDescription: passthrough('p'),
    DialogFooter: passthrough('div'),
    DialogHeader: passthrough('div'),
    DialogTitle: passthrough('h2'),
  };
});

describe('SupportAccessRequestDialog', () => {
  let container: HTMLElement;
  let root: Root;
  let cleanup: () => void;
  let DialogComponent: typeof DialogComponentType;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockMutationOptions = undefined;
    const { parseHTML } = createRequire(__filename)('linkedom') as {
      parseHTML: (html: string) => { window: typeof globalThis; document: Document };
    };
    const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
    document.oninput = null;
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
    ({ SupportAccessRequestDialog: DialogComponent } =
      await import('./SupportAccessRequestDialog'));
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    cleanup?.();
  });

  it('passes the granted grant to the caller and closes', () => {
    const onGranted = jest.fn();
    const onOpenChange = jest.fn();
    act(() =>
      root.render(
        createElement(DialogComponent, {
          open: true,
          onOpenChange,
          organizationId: 'org-1',
          organizationName: 'Customer Org',
          onGranted,
        })
      )
    );

    expect(mockMutationOptions?.onSuccess).toBeDefined();
    const grant: SupportGrantReceipt = {
      id: 'grant-1',
      organizationId: 'org-1',
      actionClass: 'support_read',
      status: 'active',
    };
    act(() => mockMutationOptions?.onSuccess?.(grant));

    expect(onGranted).toHaveBeenCalledWith(grant);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
