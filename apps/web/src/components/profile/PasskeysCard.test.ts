import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PasskeysCard as PasskeysCardComponent } from './PasskeysCard';

const mockDeletePasskey = jest.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
  success: true,
}));
const mockRenamePasskey = jest.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
  success: true,
}));
const mockRefetch = jest.fn<() => Promise<unknown>>(async () => ({}));
const mockBrowserSupportsWebAuthn = jest.fn<() => boolean>(() => true);
const mockStartRegistration = jest.fn<() => Promise<unknown>>(async () => ({}));
const mockFetch = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockQueryResult: {
  data: { passkeys: unknown[] } | undefined;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  refetch: () => Promise<unknown>;
} = {
  data: undefined,
  isLoading: false,
  isError: false,
  isFetching: false,
  refetch: mockRefetch,
};

const mockTrpc = {
  user: {
    getPasskeys: { queryOptions: () => ({ queryKey: ['passkeys'] }) },
    renamePasskey: {
      mutationOptions: (options: Record<string, unknown>) => ({
        ...options,
        mutationFn: mockRenamePasskey,
      }),
    },
    deletePasskey: {
      mutationOptions: (options: Record<string, unknown>) => ({
        ...options,
        mutationFn: mockDeletePasskey,
      }),
    },
  },
};

jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => mockTrpc,
}));

jest.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => mockBrowserSupportsWebAuthn(),
  startRegistration: () => mockStartRegistration(),
}));

jest.mock('next/navigation', () => ({
  usePathname: () => '/connected-accounts',
}));

jest.mock('@tanstack/react-query', () => {
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

  return { useMutation, useQuery: () => mockQueryResult };
});

// The real Radix dialog cannot run in the node test harness; this keeps the
// open/close contract the card relies on.
jest.mock('@/components/ui/dialog', () => {
  const Context = React.createContext<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
  } | null>(null);

  function Dialog({ open, onOpenChange, children }: any) {
    return React.createElement(Context.Provider, { value: { open, onOpenChange } }, children);
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
  };
});

let PasskeysCard!: typeof PasskeysCardComponent;

type LinkedomModule = {
  parseHTML: (html: string) => { window: Record<string, any>; document: Document };
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
    'HTMLInputElement',
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
    HTMLInputElement: window.HTMLInputElement,
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

function mountCard(props: { showAdminStepUpNote?: boolean } = {}): {
  container: HTMLElement;
  root: Root;
  cleanup: () => void;
} {
  const dom = installDom();
  let root!: Root;
  act(() => {
    root = createRoot(dom.container);
    root.render(createElement(PasskeysCard, props));
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

function hasButton(container: ParentNode, text: string): boolean {
  return Array.from(container.querySelectorAll('button')).some(
    candidate => candidate.textContent?.trim() === text
  );
}

/** The inline failure notices currently rendered, by their text. */
function alerts(container: ParentNode): string[] {
  return Array.from(container.querySelectorAll('[role="alert"]')).map(
    node => node.textContent?.trim() ?? ''
  );
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Lets every pending fetch and state update of the add flow settle. */
async function settle() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

function dialog(): HTMLElement | null {
  return mounted!.container.querySelector('[role="dialog"]');
}

/**
 * The React props of a rendered element. React's change and submit events do
 * not fire through linkedom, so the tests call the handlers React attached.
 */
function reactProps(element: Element): Record<string, any> {
  const key = Object.keys(element).find(name => name.startsWith('__reactProps$'));
  if (!key) throw new Error('not a React element');
  return (element as any)[key];
}

function typeCode(code: string) {
  const input = dialog()!.querySelector('input')!;
  act(() => {
    reactProps(input).onChange({ target: { value: code } });
  });
}

function submitCode() {
  const form = dialog()!.querySelector('form')!;
  act(() => {
    reactProps(form).onSubmit({ preventDefault: () => {} });
  });
}

function requestBody(call: number): unknown {
  const init = mockFetch.mock.calls[call]?.[1] as { body: string };
  return JSON.parse(init.body);
}

const SENT = {
  ok: true,
  json: async () => ({
    emailCodeId: 'email-code-1',
    expiresInSeconds: 600,
    email: 'person@example.com',
  }),
};
const OPTIONS = { ok: true, json: async () => ({ challengeId: 'c', options: {} }) };

function refused(status: number, body: Record<string, unknown>) {
  return { ok: false, status, json: async () => body };
}

const ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Work laptop',
  created_at: '2026-04-29T01:16:12.945Z',
  last_used_at: null,
  device_type: 'singleDevice',
  backed_up: false,
};

let mounted: { container: HTMLElement; root: Root; cleanup: () => void } | undefined;

beforeAll(async () => {
  ({ PasskeysCard } = await import('./PasskeysCard'));
});

beforeEach(() => {
  mockQueryResult.data = undefined;
  mockQueryResult.isLoading = false;
  mockQueryResult.isError = false;
  mockQueryResult.isFetching = false;
  mockBrowserSupportsWebAuthn.mockReturnValue(true);
  mockStartRegistration.mockResolvedValue({ id: 'new-credential' });
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({ challengeId: 'c', options: {} }) });
  (globalThis as { fetch: unknown }).fetch = mockFetch;
  mockDeletePasskey.mockResolvedValue({ success: true });
  mockRenamePasskey.mockResolvedValue({ success: true });
});

afterEach(() => {
  mounted?.cleanup();
  mounted = undefined;
  jest.clearAllMocks();
});

describe('PasskeysCard', () => {
  it('reserves the list height with a skeleton while loading', () => {
    mockQueryResult.isLoading = true;
    mounted = mountCard();

    expect(mounted.container.querySelector('[role="status"]')).not.toBeNull();
    expect(mounted.container.querySelectorAll('[role="listitem"]')).toHaveLength(0);
    expect(hasButton(mounted.container, 'Add a passkey')).toBe(false);
  });

  it('offers the add control when there are no passkeys yet', () => {
    mockQueryResult.data = { passkeys: [] };
    mounted = mountCard();

    expect(mounted.container.textContent).toContain('No passkeys yet');
    expect(hasButton(mounted.container, 'Add a passkey')).toBe(true);
  });

  it('lists a passkey with its name and the date it was added', () => {
    mockQueryResult.data = { passkeys: [ROW] };
    mounted = mountCard();

    expect(mounted.container.querySelectorAll('[role="listitem"]')).toHaveLength(1);
    expect(mounted.container.textContent).toContain('Work laptop');
    expect(mounted.container.textContent).toContain('Added Apr 29, 2026');
    expect(hasButton(mounted.container, 'Rename')).toBe(true);
    expect(hasButton(mounted.container, 'Remove')).toBe(true);
  });

  it('falls back to a neutral name when the passkey was never renamed', () => {
    mockQueryResult.data = { passkeys: [{ ...ROW, name: null }] };
    mounted = mountCard();

    expect(mounted.container.textContent).toContain('Passkey');
  });

  it('does not report a capable browser as unsupported before the client reads the credential API', () => {
    // The first render (here: a static render, where effects never run) has a
    // cached list already, so the old `false` default flashed the unsupported
    // notice for a browser that does support WebAuthn.
    mockQueryResult.data = { passkeys: [ROW] };

    const markup = renderToStaticMarkup(createElement(PasskeysCard));

    expect(markup).not.toContain('This browser cannot create passkeys.');
    expect(markup).toContain('Work laptop');
  });

  it('keeps the list and withholds the add control when the browser cannot create passkeys', () => {
    mockBrowserSupportsWebAuthn.mockReturnValue(false);
    mockQueryResult.data = { passkeys: [ROW] };
    mounted = mountCard();

    expect(hasButton(mounted.container, 'Add a passkey')).toBe(false);
    expect(mounted.container.textContent).toContain('This browser cannot create passkeys.');
    expect(mounted.container.querySelectorAll('[role="listitem"]')).toHaveLength(1);
    expect(hasButton(mounted.container, 'Remove')).toBe(true);
  });

  it('keeps the row in place and offers the retry when removal fails', async () => {
    mockQueryResult.data = { passkeys: [ROW] };
    mockDeletePasskey.mockRejectedValue(new Error('boom'));
    mounted = mountCard();

    act(() => button(mounted!.container, 'Remove').click());
    const dialog = mounted.container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    act(() => button(dialog ?? mounted!.container, 'Yes, remove passkey').click());
    await flush();

    expect(mockDeletePasskey).toHaveBeenCalledWith({ id: ROW.id });
    expect(mounted.container.textContent).toContain('Could not remove that passkey. Try again.');
    expect(mounted.container.querySelectorAll('[role="listitem"]')).toHaveLength(1);
    expect(hasButton(mounted.container, 'Remove')).toBe(true);
  });

  it('removes the passkey once the server accepts it', async () => {
    mockQueryResult.data = { passkeys: [ROW] };
    mounted = mountCard();

    act(() => button(mounted!.container, 'Remove').click());
    const dialog = mounted.container.querySelector('[role="dialog"]');
    act(() => button(dialog ?? mounted!.container, 'Yes, remove passkey').click());
    await flush();

    expect(mockDeletePasskey).toHaveBeenCalledWith({ id: ROW.id });
    expect(mockRefetch).toHaveBeenCalled();
  });

  it('renames the passkey through the dialog', async () => {
    mockQueryResult.data = { passkeys: [ROW] };
    mounted = mountCard();

    act(() => button(mounted!.container, 'Rename').click());
    const dialog = mounted.container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const input = dialog?.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('Work laptop');
    act(() => button(dialog ?? mounted!.container, 'Save').click());
    await flush();

    expect(mockRenamePasskey).toHaveBeenCalledWith({ id: ROW.id, name: 'Work laptop' });
    expect(mockRefetch).toHaveBeenCalled();
  });

  it('adds a passkey with the code emailed to the account', async () => {
    mockQueryResult.data = { passkeys: [ROW] };
    mockFetch
      .mockResolvedValueOnce(SENT)
      .mockResolvedValueOnce(OPTIONS)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ credentialId: 'credential' }) });
    mounted = mountCard();

    act(() => button(mounted!.container, 'Add a passkey').click());
    await settle();

    expect(requestBody(0)).toEqual({ action: 'send_code' });
    expect(dialog()?.textContent).toContain(
      'We sent a 6-digit code to person@example.com. It expires in 10 minutes.'
    );
    const input = dialog()!.querySelector('input')!;
    expect(reactProps(input)).toMatchObject({
      inputMode: 'numeric',
      autoComplete: 'one-time-code',
    });

    typeCode('123456');
    submitCode();
    await settle();

    expect(requestBody(1)).toEqual({
      action: 'options',
      emailCode: { emailCodeId: 'email-code-1', code: '123456' },
    });
    expect(requestBody(2)).toMatchObject({
      action: 'verify',
      challengeId: 'c',
      emailCode: { emailCodeId: 'email-code-1', code: '123456' },
    });
    expect(mockRefetch).toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it('keeps the dialog and the typed code after a wrong code', async () => {
    mockQueryResult.data = { passkeys: [ROW] };
    mockFetch
      .mockResolvedValueOnce(SENT)
      .mockResolvedValueOnce(refused(401, { error: 'EMAIL_CODE_INVALID', attemptsLeft: 3 }));
    mounted = mountCard();

    act(() => button(mounted!.container, 'Add a passkey').click());
    await settle();
    typeCode('123456');
    submitCode();
    await settle();

    expect(alerts(mounted.container)).toContain('That code is not correct. 3 tries left.');
    expect((dialog()!.querySelector('input') as HTMLInputElement).value).toBe('123456');
    expect(mockStartRegistration).not.toHaveBeenCalled();
    expect(mockRefetch).not.toHaveBeenCalled();
  });

  it('sends a new code after the code expired', async () => {
    mockQueryResult.data = { passkeys: [ROW] };
    mockFetch
      .mockResolvedValueOnce(SENT)
      .mockResolvedValueOnce(refused(401, { error: 'EMAIL_CODE_EXPIRED' }))
      .mockResolvedValueOnce(SENT);
    mounted = mountCard();

    act(() => button(mounted!.container, 'Add a passkey').click());
    await settle();
    typeCode('123456');
    submitCode();
    await settle();

    expect(alerts(mounted.container)).toContain(
      'That code expired or was already used. Send a new code.'
    );

    act(() => button(dialog()!, 'Send a new code').click());
    await settle();

    expect(requestBody(2)).toEqual({ action: 'send_code' });
    expect(alerts(mounted.container)).toEqual([]);
    expect((dialog()!.querySelector('input') as HTMLInputElement).value).toBe('');
  });

  it('shows the wait and holds the code step while the account is locked', async () => {
    mockQueryResult.data = { passkeys: [ROW] };
    mockFetch
      .mockResolvedValueOnce(SENT)
      .mockResolvedValueOnce(refused(429, { error: 'EMAIL_CODE_LOCKED', retryAfterSeconds: 900 }));
    mounted = mountCard();

    act(() => button(mounted!.container, 'Add a passkey').click());
    await settle();
    typeCode('123456');
    submitCode();
    await settle();

    expect(alerts(mounted.container)).toContain(
      'Too many incorrect codes. You can send a new code in 15 minutes.'
    );
    expect(button(dialog()!, 'Send a new code').disabled).toBe(true);
    expect(button(dialog()!, 'Add passkey').disabled).toBe(true);
  });

  it('offers a retry when the code email could not be sent', async () => {
    mockQueryResult.data = { passkeys: [ROW] };
    mockFetch
      .mockResolvedValueOnce(refused(502, { error: 'EMAIL_DELIVERY_FAILED' }))
      .mockResolvedValueOnce(SENT);
    mounted = mountCard();

    act(() => button(mounted!.container, 'Add a passkey').click());
    await settle();

    expect(alerts(mounted.container)).toContain('We could not send the code email. Try again.');

    act(() => button(dialog()!, 'Try again').click());
    await settle();

    expect(dialog()?.textContent).toContain('person@example.com');
  });

  it('explains an account address that cannot receive email, without a retry', async () => {
    mockQueryResult.data = { passkeys: [ROW] };
    mockFetch.mockResolvedValueOnce(refused(422, { error: 'EMAIL_UNDELIVERABLE' }));
    mounted = mountCard();

    act(() => button(mounted!.container, 'Add a passkey').click());
    await settle();

    expect(alerts(mounted.container)).toContain(
      'We cannot deliver email to your account address, so we cannot send a code.'
    );
    expect(hasButton(dialog()!, 'Try again')).toBe(false);
    expect(hasButton(dialog()!, 'Send a new code')).toBe(false);
  });

  it('reports a retryable failure when the add request fails', async () => {
    mockQueryResult.data = { passkeys: [ROW] };
    mockFetch.mockResolvedValue(refused(503, { error: 'RATE_LIMIT_UNAVAILABLE' }));
    mounted = mountCard();

    act(() => button(mounted!.container, 'Add a passkey').click());
    await settle();

    expect(alerts(mounted.container)).toContain('Could not add a passkey. Try again.');
    expect(hasButton(dialog()!, 'Try again')).toBe(true);
    expect(mounted.container.querySelectorAll('[role="listitem"]')).toHaveLength(1);
  });

  it('closes without an error and adds no row when the creation sheet is cancelled', async () => {
    mockQueryResult.data = { passkeys: [ROW] };
    mockFetch.mockResolvedValueOnce(SENT).mockResolvedValueOnce(OPTIONS);
    mockStartRegistration.mockRejectedValue(
      Object.assign(new Error('cancelled'), { name: 'NotAllowedError' })
    );
    mounted = mountCard();

    act(() => button(mounted!.container, 'Add a passkey').click());
    await settle();
    typeCode('123456');
    submitCode();
    await settle();

    expect(dialog()).toBeNull();
    expect(alerts(mounted.container)).toEqual([]);
    expect(mounted.container.querySelectorAll('[role="listitem"]')).toHaveLength(1);
    expect(mockRefetch).not.toHaveBeenCalled();
  });

  it('asks to sign in again when enrollment needs reauthentication', async () => {
    mockQueryResult.data = { passkeys: [ROW] };
    mockFetch.mockResolvedValue(refused(401, { error: 'REAUTH_REQUIRED' }));
    mounted = mountCard();

    act(() => button(mounted!.container, 'Add a passkey').click());
    await settle();

    expect(mounted.container.textContent).toContain('Sign in again before adding a passkey');
    expect(hasButton(mounted.container, 'Sign out and sign in again')).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockRefetch).not.toHaveBeenCalled();
  });

  it('keeps the rendered list, its controls and the add control when a background refresh fails', () => {
    mockQueryResult.data = { passkeys: [ROW] };
    mockQueryResult.isError = true;
    mounted = mountCard();

    expect(mounted.container.querySelectorAll('[role="listitem"]')).toHaveLength(1);
    expect(mounted.container.textContent).toContain('Work laptop');
    expect(hasButton(mounted.container, 'Rename')).toBe(true);
    expect(hasButton(mounted.container, 'Remove')).toBe(true);
    expect(hasButton(mounted.container, 'Add a passkey')).toBe(true);
    expect(alerts(mounted.container)).toContain('Could not load your passkeys. Try again.');
    expect(hasButton(mounted.container, 'Try again')).toBe(true);
  });

  it('keeps the empty state and the add control when a background refresh fails', () => {
    mockQueryResult.data = { passkeys: [] };
    mockQueryResult.isError = true;
    mounted = mountCard();

    expect(mounted.container.textContent).toContain('No passkeys yet');
    expect(hasButton(mounted.container, 'Add a passkey')).toBe(true);
    expect(alerts(mounted.container)).toContain('Could not load your passkeys. Try again.');
    expect(hasButton(mounted.container, 'Try again')).toBe(true);
    expect(mounted.container.querySelectorAll('[role="listitem"]')).toHaveLength(0);
  });

  it('retries the list request once without unmounting the rendered rows', async () => {
    mockQueryResult.data = { passkeys: [ROW] };
    mockQueryResult.isError = true;
    mounted = mountCard();

    act(() => button(mounted!.container, 'Try again').click());
    await flush();

    expect(mockRefetch).toHaveBeenCalledTimes(1);
    expect(mounted.container.querySelectorAll('[role="listitem"]')).toHaveLength(1);
    expect(mounted.container.querySelector('[role="status"]')).toBeNull();
  });

  it('locks the retry control and shows one inline spinner while the retry runs', () => {
    mockQueryResult.data = { passkeys: [ROW] };
    mockQueryResult.isError = true;
    mockQueryResult.isFetching = true;
    mounted = mountCard();

    expect(button(mounted.container, 'Try again').disabled).toBe(true);
    expect(mounted.container.querySelectorAll('.animate-spin')).toHaveLength(1);
    expect(mounted.container.querySelector('[role="status"]')).toBeNull();
    expect(mounted.container.querySelectorAll('[role="listitem"]')).toHaveLength(1);
  });

  it('keeps the rows, the add control and the notice when the retry fails again', async () => {
    mockQueryResult.data = { passkeys: [ROW] };
    mockQueryResult.isError = true;
    mounted = mountCard();

    act(() => button(mounted!.container, 'Try again').click());
    await flush();

    // The retry finished and failed again: the query is still in error and the
    // list it already had is still on screen.
    mockQueryResult.isFetching = false;
    act(() => mounted!.root.render(createElement(PasskeysCard)));
    await flush();

    expect(mounted.container.querySelectorAll('[role="listitem"]')).toHaveLength(1);
    expect(hasButton(mounted.container, 'Add a passkey')).toBe(true);
    expect(alerts(mounted.container)).toContain('Could not load your passkeys. Try again.');
  });

  it('shows only the error and its retry when the first load fails with no data', () => {
    mockQueryResult.isError = true;
    mounted = mountCard();

    expect(mounted.container.querySelectorAll('[role="listitem"]')).toHaveLength(0);
    expect(hasButton(mounted.container, 'Add a passkey')).toBe(false);
    expect(alerts(mounted.container)).toContain('Could not load your passkeys. Try again.');
    expect(hasButton(mounted.container, 'Try again')).toBe(true);
  });
});
