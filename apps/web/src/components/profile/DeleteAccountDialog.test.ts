import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DeleteAccountDialog as DeleteAccountDialogComponent } from './DeleteAccountDialog';

const mockChallengeMutationFn = jest.fn<() => Promise<{ challengeId: string; devCode?: string }>>();
const mockDeletionMutationFn = jest.fn<(input: unknown) => Promise<{ status: 'deleted' }>>();
const mockSignOut = jest.fn<(...args: unknown[]) => Promise<void>>();
const mockToastSuccess = jest.fn<(...args: unknown[]) => void>();
const mockToastError = jest.fn<(...args: unknown[]) => void>();

const mockTrpc = {
  user: {
    requestAccountDeletionChallenge: {
      mutationOptions: jest.fn((options: Record<string, unknown>) => ({
        ...options,
        mutationFn: mockChallengeMutationFn,
      })),
    },
    requestAccountDeletion: {
      mutationOptions: jest.fn((options: Record<string, unknown>) => ({
        ...options,
        mutationFn: mockDeletionMutationFn,
      })),
    },
  },
};

jest.mock('next-auth/react', () => ({
  signOut: (...args: unknown[]) => mockSignOut(...args),
}));

jest.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => mockTrpc,
}));

jest.mock('@tanstack/react-query', () => {
  function QueryClient(..._args: unknown[]) {}

  function QueryClientProvider({ children }: { children: unknown }) {
    return children;
  }

  function useMutation(options: any) {
    const [isPending, setIsPending] = React.useState(false);
    const mutate = (variables: unknown) => {
      setIsPending(true);
      Promise.resolve()
        .then(() => options.mutationFn(variables))
        .then(
          (data: unknown) => {
            setIsPending(false);
            options.onSuccess?.(data);
          },
          (error: unknown) => {
            setIsPending(false);
            options.onError?.(error);
          }
        );
    };
    return { isPending, mutate };
  }

  return { QueryClient, QueryClientProvider, useMutation };
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

jest.mock('@/components/ui/dialog', () => {
  const Context = React.createContext<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
  } | null>(null);

  function Dialog({ open, onOpenChange, children }: any) {
    return React.createElement(Context.Provider, { value: { open, onOpenChange } }, children);
  }

  function DialogTrigger({ children }: any) {
    const context = React.useContext(Context);
    const child = React.Children.only(children);
    return React.cloneElement(child, {
      onClick: (event: unknown) => {
        child.props.onClick?.(event);
        context?.onOpenChange(true);
      },
    });
  }

  function DialogContent({ children }: any) {
    const context = React.useContext(Context);
    if (!context?.open) return null;
    return React.createElement('div', { role: 'dialog' }, children);
  }

  const block = (tag: string) =>
    function Block({ children, ...props }: any) {
      return React.createElement(tag, props, children);
    };

  return {
    Dialog,
    DialogContent,
    DialogDescription: block('p'),
    DialogFooter: block('div'),
    DialogHeader: block('div'),
    DialogTitle: block('h2'),
    DialogTrigger,
  };
});

let DeleteAccountDialog!: typeof DeleteAccountDialogComponent;

type LinkedomModule = {
  parseHTML: (html: string) => { window: Record<string, any>; document: Document };
};

type MountedDialog = {
  container: HTMLElement;
  root: Root;
  cleanup: () => void;
};

function installDom(): { container: HTMLElement; cleanup: () => void } {
  const requireFromHere = createRequire(__filename);
  let linkedom: LinkedomModule;
  try {
    linkedom = requireFromHere('linkedom') as LinkedomModule;
  } catch {
    linkedom = requireFromHere(
      '../../../../node_modules/.pnpm/linkedom@0.18.12/node_modules/linkedom'
    ) as LinkedomModule;
  }

  const { window, document } = linkedom.parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>'
  );
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  const previous = new Map<string, unknown>();
  const names = [
    'window',
    'document',
    'HTMLElement',
    'Element',
    'Node',
    'Text',
    'Comment',
    'DocumentFragment',
    'Document',
    'SVGElement',
    'Event',
    'CustomEvent',
    'navigator',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ];
  for (const name of names) previous.set(name, globals[name]);
  Object.assign(globals, {
    window,
    document,
    HTMLElement: window.HTMLElement,
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
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  const container = document.getElementById('root');
  if (!container) throw new Error('linkedom root missing');
  return {
    container: container as HTMLElement,
    cleanup: () => {
      for (const [name, value] of previous) globals[name] = value;
    },
  };
}

function mountDialog(): MountedDialog {
  const dom = installDom();
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  let root!: Root;
  act(() => {
    root = createRoot(dom.container);
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(DeleteAccountDialog)
      )
    );
  });
  return {
    container: dom.container,
    root,
    cleanup: () => {
      act(() => root.unmount());
      dom.cleanup();
    },
  };
}

function button(container: ParentNode, text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find(
    candidate => candidate.textContent?.trim() === text
  );
  if (!found) throw new Error(`button not found: ${text}`);
  return found as HTMLButtonElement;
}

function clickElement(element: HTMLButtonElement): void {
  act(() => element.click());
}

function clickButton(container: ParentNode, text: string): void {
  clickElement(button(container, text));
}

function submitForm(container: ParentNode): void {
  const form = container.querySelector('form');
  if (!form) throw new Error('form not found');
  void act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('DeleteAccountDialog', () => {
  let mounted: MountedDialog | undefined;

  beforeAll(async () => {
    ({ DeleteAccountDialog } = await import('./DeleteAccountDialog'));
  });

  beforeEach(() => {
    mockChallengeMutationFn.mockResolvedValue({
      challengeId: '00000000-0000-4000-8000-000000000001',
      devCode: '123456',
    });
    mockDeletionMutationFn.mockResolvedValue({ status: 'deleted' });
    mockSignOut.mockResolvedValue(undefined);
    mounted = mountDialog();
  });

  afterEach(() => {
    mounted?.cleanup();
    jest.clearAllMocks();
  });

  it('opens and cancels without requesting a code', () => {
    if (!mounted) throw new Error('dialog was not mounted');
    clickButton(mounted.container, 'Delete account');
    const dialog = mounted.container.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('permanently deletes and anonymizes');

    clickButton(dialog ?? mounted.container, 'Cancel');
    expect(mounted.container.querySelector('[role="dialog"]')).toBeNull();
    expect(mockChallengeMutationFn).not.toHaveBeenCalled();
  });

  it('completes the development two-step flow and signs out after success', async () => {
    if (!mounted) throw new Error('dialog was not mounted');
    const restoreNodeEnv = jest.replaceProperty(process.env, 'NODE_ENV', 'development');
    try {
      clickButton(mounted.container, 'Delete account');
      const dialog = mounted.container.querySelector('[role="dialog"]');
      if (!dialog) throw new Error('dialog did not open');
      clickButton(dialog, 'Send confirmation code');
      await flush();

      const codeInput = dialog.querySelector('input') as HTMLInputElement;
      expect(codeInput.value).toBe('123456');
      submitForm(dialog);
      await flush();

      expect(mockDeletionMutationFn).toHaveBeenCalledWith({
        challengeId: '00000000-0000-4000-8000-000000000001',
        code: '123456',
      });
      expect(mockToastSuccess).toHaveBeenCalledWith(
        'Account deletion has started. Completion will be confirmed by email.'
      );
      expect(mockSignOut).toHaveBeenCalledWith({ callbackUrl: '/users/sign_in' });
    } finally {
      restoreNodeEnv.restore();
    }
  });

  it('resumes an issued challenge after closing and reopening the dialog', async () => {
    if (!mounted) throw new Error('dialog was not mounted');
    const restoreNodeEnv = jest.replaceProperty(process.env, 'NODE_ENV', 'development');
    try {
      clickButton(mounted.container, 'Delete account');
      let dialog = mounted.container.querySelector('[role="dialog"]');
      if (!dialog) throw new Error('dialog did not open');
      clickButton(dialog, 'Send confirmation code');
      await flush();

      clickButton(dialog, 'Cancel');
      expect(mounted.container.querySelector('[role="dialog"]')).toBeNull();

      clickButton(mounted.container, 'Delete account');
      dialog = mounted.container.querySelector('[role="dialog"]');
      if (!dialog) throw new Error('dialog did not reopen');
      expect((dialog.querySelector('input') as HTMLInputElement).value).toBe('123456');
      expect(mockChallengeMutationFn).toHaveBeenCalledTimes(1);
    } finally {
      restoreNodeEnv.restore();
    }
  });

  it('shows challenge and execution errors while keeping the dialog usable', async () => {
    if (!mounted) throw new Error('dialog was not mounted');
    const restoreNodeEnv = jest.replaceProperty(process.env, 'NODE_ENV', 'development');
    try {
      mockChallengeMutationFn.mockRejectedValueOnce(new Error('challenge failed'));
      clickButton(mounted.container, 'Delete account');
      let dialog = mounted.container.querySelector('[role="dialog"]');
      if (!dialog) throw new Error('dialog did not open');
      clickButton(dialog, 'Send confirmation code');
      await flush();
      expect(mockToastError).toHaveBeenCalledWith('challenge failed');
      expect(button(dialog, 'Send confirmation code')).toBeDefined();

      mockChallengeMutationFn.mockResolvedValueOnce({
        challengeId: '00000000-0000-4000-8000-000000000002',
        devCode: '654321',
      });
      mockDeletionMutationFn.mockRejectedValueOnce(new Error('deletion failed'));
      clickButton(dialog, 'Send confirmation code');
      await flush();
      dialog = mounted.container.querySelector('[role="dialog"]');
      if (!dialog) throw new Error('dialog closed unexpectedly');
      submitForm(dialog);
      await flush();
      expect(mockToastError).toHaveBeenLastCalledWith('deletion failed');
      expect(mounted.container.querySelector('[role="dialog"]')).not.toBeNull();
    } finally {
      restoreNodeEnv.restore();
    }
  });

  it('does not use devCode in production and prevents duplicate pending requests', async () => {
    if (!mounted) throw new Error('dialog was not mounted');
    const restoreNodeEnv = jest.replaceProperty(process.env, 'NODE_ENV', 'production');
    let resolveChallenge!: (value: { challengeId: string; devCode?: string }) => void;
    mockChallengeMutationFn.mockImplementationOnce(
      () =>
        new Promise<{ challengeId: string; devCode?: string }>(resolve => {
          resolveChallenge = resolve;
        })
    );
    try {
      clickButton(mounted.container, 'Delete account');
      const dialog = mounted.container.querySelector('[role="dialog"]');
      if (!dialog) throw new Error('dialog did not open');
      const send = button(dialog, 'Send confirmation code');
      clickElement(send);
      await flush();
      expect(send.disabled).toBe(true);
      clickElement(send);
      expect(mockChallengeMutationFn).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveChallenge({
          challengeId: '00000000-0000-4000-8000-000000000003',
          devCode: '999999',
        });
        await Promise.resolve();
      });
      expect((dialog.querySelector('input') as HTMLInputElement).value).toBe('');
    } finally {
      restoreNodeEnv.restore();
    }
  });
});
