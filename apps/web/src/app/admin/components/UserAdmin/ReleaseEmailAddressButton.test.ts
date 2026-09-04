import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { QueryClient, QueryClientProvider, type UseMutationOptions } from '@tanstack/react-query';
import { createRequire } from 'node:module';
import React, { act, createElement, useContext, type ComponentProps, type ReactNode } from 'react';
import type { createRoot as createReactRoot, Root } from 'react-dom/client';
import type { ReleaseEmailAddressButton as ReleaseEmailAddressButtonComponent } from './ReleaseEmailAddressButton';

type ReleaseEmailInput = { userId: string; expectedEmail: string };
type ReleaseEmailMutationOptions = UseMutationOptions<void, Error, ReleaseEmailInput>;

const mockReleaseEmailAddress = jest.fn<(input: ReleaseEmailInput) => Promise<void>>();
const mockRefresh = jest.fn();
const mockToast = { success: jest.fn(), error: jest.fn() };

const mockTrpc = {
  admin: {
    users: {
      releaseEmailAddress: {
        mutationOptions: (options?: ReleaseEmailMutationOptions) => ({
          ...options,
          mutationFn: mockReleaseEmailAddress,
        }),
      },
    },
  },
};

const AlertDialogContext = React.createContext<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
} | null>(null);

function useAlertDialogContext() {
  const context = useContext(AlertDialogContext);
  if (!context) throw new Error('Alert dialog context missing');
  return context;
}

jest.mock('@/lib/trpc/utils', () => ({ useTRPC: () => mockTrpc }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh }) }));
jest.mock('sonner', () => ({ toast: mockToast }));
jest.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({
    children,
    open,
    onOpenChange,
  }: {
    children: ReactNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => createElement(AlertDialogContext.Provider, { value: { open, onOpenChange } }, children),
  AlertDialogTrigger: ({
    children,
  }: {
    children: React.ReactElement<ComponentProps<'button'>>;
  }) => {
    const { onOpenChange } = useAlertDialogContext();
    return React.cloneElement(children, { onClick: () => onOpenChange(true) });
  },
  AlertDialogContent: ({ children }: { children: ReactNode }) => {
    const { open, onOpenChange } = useAlertDialogContext();
    if (!open) return null;
    return createElement(
      'div',
      {
        role: 'alertdialog',
        tabIndex: -1,
        onKeyDown: event => event.key === 'Escape' && onOpenChange(false),
      },
      createElement('button', {
        'aria-label': 'Dismiss dialog overlay',
        onClick: () => onOpenChange(false),
      }),
      children
    );
  },
  AlertDialogHeader: ({ children }: { children: ReactNode }) =>
    createElement('div', null, children),
  AlertDialogFooter: ({ children }: { children: ReactNode }) =>
    createElement('div', null, children),
  AlertDialogTitle: ({ children }: { children: ReactNode }) => createElement('h2', null, children),
  AlertDialogDescription: ({ children }: { children: ReactNode }) =>
    createElement('p', null, children),
  AlertDialogCancel: ({ children, onClick, ...props }: ComponentProps<'button'>) => {
    const { onOpenChange } = useAlertDialogContext();
    return createElement(
      'button',
      {
        ...props,
        onClick: event => {
          onClick?.(event);
          onOpenChange(false);
        },
      },
      children
    );
  },
  AlertDialogAction: ({ children, ...props }: ComponentProps<'button'>) =>
    createElement('button', props, children),
}));

type LinkedomModule = {
  parseHTML: (
    html: string,
    globals: { location: URL }
  ) => { window: typeof globalThis; document: Document };
};

function installDom() {
  const requireFromHere = createRequire(__filename);
  const { window, document } = (requireFromHere('linkedom') as LinkedomModule).parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    { location: new URL('http://localhost/') }
  );
  const container = document.getElementById('root');
  if (!container) throw new Error('React root missing');
  const globals = {
    window,
    document,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    Text: window.Text,
    Comment: window.Comment,
    DocumentFragment: window.DocumentFragment,
    Document: window.Document,
    SVGElement: window.SVGElement,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    navigator: window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
  );
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  return {
    container,
    cleanup: () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

async function settle(action: () => void) {
  await act(async () => {
    action();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
}

describe('ReleaseEmailAddressButton', () => {
  let dom: ReturnType<typeof installDom>;
  let root: Root;
  let queryClient: QueryClient;
  let createRoot: typeof createReactRoot;
  let ReleaseEmailAddressButton: typeof ReleaseEmailAddressButtonComponent;

  function button(text: string) {
    const found = Array.from(dom.container.querySelectorAll('button')).find(
      candidate => candidate.textContent?.trim() === text
    );
    if (!found) throw new Error(`Button missing: ${text}`);
    return found;
  }

  function dialog() {
    return dom.container.querySelector('[role="alertdialog"]');
  }

  function dialogButton(text: string) {
    const found = Array.from(dialog()?.querySelectorAll('button') ?? []).find(
      candidate => candidate.textContent?.trim() === text
    );
    if (!found) throw new Error(`Dialog button missing: ${text}`);
    return found;
  }

  function openDialog() {
    act(() => button('Release email address').click());
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    mockReleaseEmailAddress.mockReset().mockResolvedValue(undefined);
    dom = installDom();
    ({ createRoot } = await import('react-dom/client'));
    ({ ReleaseEmailAddressButton } = await import('./ReleaseEmailAddressButton'));
    queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false, gcTime: Infinity } },
    });
    act(() => {
      root = createRoot(dom.container);
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(ReleaseEmailAddressButton, {
            userId: 'User/Original-Case',
            email: 'Original.Case+duplicate@example.com',
          })
        )
      );
    });
  });

  afterEach(() => {
    try {
      act(() => root?.unmount());
      queryClient?.clear();
    } finally {
      dom?.cleanup();
    }
  });

  it('opens for confirmation and cancel makes no request', () => {
    openDialog();
    expect(dialog()?.textContent).toContain('loses email sign-in and email delivery');
    expect(dialog()?.textContent).toContain('does not merge accounts');
    expect(dialog()?.textContent).toContain('or revoke access');

    act(() => button('Cancel').click());

    expect(mockReleaseEmailAddress).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it('submits the exact user ID and original-case email only after confirmation', async () => {
    openDialog();
    await settle(() => dialogButton('Release email address').click());

    expect(mockReleaseEmailAddress.mock.calls[0]?.[0]).toEqual({
      userId: 'User/Original-Case',
      expectedEmail: 'Original.Case+duplicate@example.com',
    });
  });

  it('disables confirmation and blocks overlay or Escape dismissal while pending', async () => {
    const release = Promise.withResolvers<void>();
    mockReleaseEmailAddress.mockReturnValueOnce(release.promise);
    openDialog();
    await settle(() => dialogButton('Release email address').click());

    expect(dialogButton('Releasing email address...').disabled).toBe(true);
    expect(dialogButton('Cancel').disabled).toBe(true);
    act(() => {
      const overlay = dialog()?.querySelector('[aria-label="Dismiss dialog overlay"]');
      if (!(overlay instanceof HTMLButtonElement)) throw new Error('Dismiss overlay missing');
      overlay.click();
    });
    act(() => {
      const escape = new Event('keydown', { bubbles: true });
      Object.defineProperty(escape, 'key', { value: 'Escape' });
      dialog()?.dispatchEvent(escape);
    });
    act(() => dialogButton('Releasing email address...').click());

    expect(dialog()).not.toBeNull();
    expect(mockReleaseEmailAddress).toHaveBeenCalledTimes(1);
  });

  it('toasts, refreshes, and closes on success but remains open on failure', async () => {
    const success = Promise.withResolvers<void>();
    mockReleaseEmailAddress.mockReturnValueOnce(success.promise);
    openDialog();
    await settle(() => dialogButton('Release email address').click());
    await settle(() => success.resolve());

    expect(mockToast.success).toHaveBeenCalledWith('Email address released');
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();

    mockReleaseEmailAddress.mockRejectedValueOnce(new Error('Address changed'));
    openDialog();
    await settle(() => dialogButton('Release email address').click());

    expect(mockToast.error).toHaveBeenCalledWith('Could not release email address', {
      description: 'Address changed',
    });
    expect(dialog()).not.toBeNull();
  });
});
