import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    stepUp: { getStatus: { queryOptions: () => ({ queryKey: ['step-up-status'] }) } },
  }),
}));
const mockStatus = { enrolled: true };
const mockRefetchStatus = jest.fn(async () => ({}));
jest.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: { enrolled: mockStatus.enrolled, sessionBound: true, status: { status: 'required' } },
    isSuccess: true,
    isLoading: false,
    refetch: mockRefetchStatus,
  }),
}));
jest.mock('@simplewebauthn/browser', () => ({
  startAuthentication: jest.fn(),
  startRegistration: jest.fn(),
}));
jest.mock('./StepUpSignInAgainButton', () => ({
  StepUpSignInAgainButton: () => React.createElement('button', null, 'Sign out and sign in again'),
}));
jest.mock('@/components/ui/dialog', () => {
  const Context = React.createContext<{ open: boolean } | null>(null);
  function Dialog({ open, children }: any) {
    return React.createElement(Context.Provider, { value: { open } }, children);
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

import type { StepUpDialog as StepUpDialogComponent } from './StepUpDialog';

const simpleWebAuthn = jest.requireMock('@simplewebauthn/browser') as {
  startAuthentication: jest.Mock<(...args: unknown[]) => Promise<unknown>>;
  startRegistration: jest.Mock<(...args: unknown[]) => Promise<unknown>>;
};
const mockStartAuthentication = simpleWebAuthn.startAuthentication;
const mockStartRegistration = simpleWebAuthn.startRegistration;
const mockFetch = jest.fn<(...args: unknown[]) => Promise<unknown>>();

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
  for (const name of [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLInputElement',
    'Node',
    'Element',
    'Text',
    'Event',
  ]) {
    previous.set(name, globals[name]);
    globals[name] = name === 'window' ? window : name === 'document' ? document : window[name];
  }
  const container = (document as any).getElementById('root') as HTMLElement;
  return {
    container,
    cleanup: () => {
      for (const [name, value] of previous) globals[name] = value;
    },
  };
}

let StepUpDialog!: typeof StepUpDialogComponent;
let mounted: { container: HTMLElement; root: Root; cleanup: () => void } | undefined;
const onVerified = jest.fn();
const onCancel = jest.fn();

function mount() {
  const dom = installDom();
  let root!: Root;
  act(() => {
    root = createRoot(dom.container);
    root.render(
      createElement(StepUpDialog, {
        open: true,
        requirement: { code: 'MFA_REQUIRED' },
        onVerified,
        onCancel,
      })
    );
  });
  mounted = { ...dom, root };
}

function button(text: string): HTMLButtonElement | undefined {
  return Array.from(mounted!.container.querySelectorAll('button')).find(
    candidate => candidate.textContent?.trim() === text
  );
}

async function flush() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
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
  const input = mounted!.container.querySelector('input')!;
  act(() => {
    reactProps(input).onChange({ target: { value: code } });
  });
}

function submitCodeForm() {
  const form = mounted!.container.querySelector('form')!;
  act(() => {
    reactProps(form).onSubmit({ preventDefault: () => {} });
  });
}

function requestBody(call: number): unknown {
  const init = mockFetch.mock.calls[call]?.[1] as { body: string };
  return JSON.parse(init.body);
}

beforeAll(async () => {
  ({ StepUpDialog } = await import('./StepUpDialog'));
});

beforeEach(() => {
  jest.clearAllMocks();
  mockStatus.enrolled = true;
  mockFetch.mockReset();
  (globalThis as { fetch: unknown }).fetch = mockFetch;
});

afterEach(async () => {
  if (mounted) {
    await act(async () => {
      mounted!.root.unmount();
    });
    mounted.cleanup();
    mounted = undefined;
  }
});

describe('StepUpDialog', () => {
  it('focuses a role=alert message when the passkey sheet is cancelled', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ challengeId: 'c', options: {} }),
    });
    mockStartAuthentication.mockRejectedValue(
      Object.assign(new Error('dismissed'), { name: 'NotAllowedError' })
    );
    mount();
    const focusSpy = jest.spyOn(
      (mounted!.container.ownerDocument.defaultView as any).HTMLElement.prototype,
      'focus'
    );

    act(() => button('Verify with passkey')?.click());
    await flush();

    const alert = mounted!.container.querySelector('[role="alert"]') as HTMLElement | null;
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain('cancelled');
    expect(alert?.getAttribute('tabindex')).toBe('-1');
    expect(focusSpy).toHaveBeenCalled();
    expect(focusSpy.mock.instances).toContain(alert);
    expect(onVerified).not.toHaveBeenCalled();
  });

  it('offers sign-in again when in-dialog enrollment needs reauthentication', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'NOT_ENROLLED' }) })
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: 'REAUTH_REQUIRED' }),
      });
    mount();

    act(() => button('Verify with passkey')?.click());
    await flush();

    expect(requestBody(1)).toEqual({ action: 'send_code' });
    expect(button('Sign out and sign in again')).toBeDefined();
    expect(mounted!.container.textContent).toContain('Sign in again before adding a passkey');
    expect(onVerified).not.toHaveBeenCalled();
  });

  it('tells an off-network admin to connect to WARP', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'ADMIN_NETWORK_DENIED' }),
    });
    mount();

    act(() => button('Verify with passkey')?.click());
    await flush();

    const alert = mounted!.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Connect to Cloudflare WARP');
    expect(mockStartAuthentication).not.toHaveBeenCalled();
    expect(onVerified).not.toHaveBeenCalled();
  });

  it('adds a passkey with the emailed code, then verifies with it', async () => {
    mockStatus.enrolled = false;
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          emailCodeId: 'email-code-1',
          expiresInSeconds: 600,
          email: 'admin@example.com',
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ challengeId: 'r', options: {} }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ credentialId: 'credential' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ challengeId: 's', options: {} }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ verified: true }) });
    mockStartRegistration.mockResolvedValue({ id: 'new-credential' });
    mockStartAuthentication.mockResolvedValue({ id: 'assertion' });
    mount();

    act(() => button('Add a passkey')?.click());
    await flush();
    expect(mounted!.container.textContent).toContain('admin@example.com');
    expect(onVerified).not.toHaveBeenCalled();

    typeCode('123456');
    submitCodeForm();
    await flush();
    await flush();

    expect(requestBody(1)).toEqual({
      action: 'options',
      emailCode: { emailCodeId: 'email-code-1', code: '123456' },
    });
    expect(requestBody(2)).toMatchObject({
      action: 'verify',
      emailCode: { emailCodeId: 'email-code-1', code: '123456' },
    });
    expect(mockStartRegistration).toHaveBeenCalledTimes(1);
    expect(mockStartAuthentication).toHaveBeenCalledTimes(1);
    expect(onVerified).toHaveBeenCalledTimes(1);
  });

  it('stays busy while the status refreshes after the passkey is added', async () => {
    mockStatus.enrolled = false;
    const refreshed = Promise.withResolvers<object>();
    mockRefetchStatus.mockReturnValueOnce(refreshed.promise);
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          emailCodeId: 'email-code-1',
          expiresInSeconds: 600,
          email: 'admin@example.com',
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ challengeId: 'r', options: {} }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ credentialId: 'credential' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ challengeId: 's', options: {} }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ verified: true }) });
    mockStartRegistration.mockResolvedValue({ id: 'new-credential' });
    mockStartAuthentication.mockResolvedValue({ id: 'assertion' });
    mount();

    act(() => button('Add a passkey')?.click());
    await flush();
    typeCode('123456');
    submitCodeForm();
    await flush();

    expect(mockRefetchStatus).toHaveBeenCalledTimes(1);
    expect(button('Add a passkey')).toBeUndefined();
    expect(button('Waiting for your passkey...')?.disabled).toBe(true);
    act(() => button('Waiting for your passkey...')?.click());
    expect(mockFetch).toHaveBeenCalledTimes(3);

    await act(async () => {
      refreshed.resolve({});
    });
    await flush();

    expect(mockFetch).toHaveBeenCalledTimes(5);
    expect(onVerified).toHaveBeenCalledTimes(1);
  });

  it('verifies once and reports success', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ challengeId: 'c', options: {} }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ verified: true }) });
    mockStartAuthentication.mockResolvedValue({ id: 'assertion' });
    mount();

    act(() => button('Verify with passkey')?.click());
    await flush();

    expect(onVerified).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
