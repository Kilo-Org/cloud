import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    stepUp: { getStatus: { queryOptions: () => ({ queryKey: ['step-up-status'] }) } },
  }),
}));
jest.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: { enrolled: true, sessionBound: true, status: { status: 'required' } },
    isSuccess: true,
    isLoading: false,
  }),
}));
jest.mock('@simplewebauthn/browser', () => ({
  startAuthentication: jest.fn(),
}));
jest.mock('@/components/profile/PasskeysCard', () => ({
  PasskeyRegistrationError: class PasskeyRegistrationError extends Error {
    failure: string;
    constructor(failure: string) {
      super(failure);
      this.failure = failure;
    }
  },
  registerNewPasskey: jest.fn(),
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

const mockStartAuthentication = (
  jest.requireMock('@simplewebauthn/browser') as {
    startAuthentication: jest.Mock<(...args: unknown[]) => Promise<unknown>>;
  }
).startAuthentication;
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
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Element']) {
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

beforeAll(async () => {
  ({ StepUpDialog } = await import('./StepUpDialog'));
});

beforeEach(() => {
  jest.clearAllMocks();
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
    mockFetch.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'NOT_ENROLLED' }),
    });
    const passkeysCard = jest.requireMock('@/components/profile/PasskeysCard') as {
      PasskeyRegistrationError: new (failure: string) => Error;
      registerNewPasskey: jest.Mock;
    };
    (
      passkeysCard.registerNewPasskey as jest.Mock<(...args: unknown[]) => Promise<never>>
    ).mockRejectedValueOnce(new passkeysCard.PasskeyRegistrationError('reauth_required'));
    mount();

    act(() => button('Verify with passkey')?.click());
    await flush();

    expect(button('Sign out and sign in again')).toBeDefined();
    expect(mounted!.container.textContent).toContain('Sign in again before adding a passkey');
    expect(onVerified).not.toHaveBeenCalled();
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
