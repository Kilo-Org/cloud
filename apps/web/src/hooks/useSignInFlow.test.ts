/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires -- Jest mocks must be registered before loading the hook. */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SignInFlowProps, SignInFlowReturn } from './useSignInFlow';
import type { SignInHint } from './useSignInHint';

const mockSignIn = jest.fn<() => Promise<void>>();
const mockSaveHint = jest.fn<(hint: SignInHint) => void>();
const mockClearHint = jest.fn();
const mockSendMagicLink =
  jest.fn<(email: string, callbackUrl?: string) => Promise<{ success: true }>>();
let mockHint: SignInHint | null = null;

jest.mock('next-auth/react', () => ({ signIn: mockSignIn }));
jest.mock('@/hooks/useSignInHint', () => ({
  useSignInHint: () => ({
    hint: mockHint,
    isLoaded: true,
    saveHint: mockSaveHint,
    clearHint: mockClearHint,
  }),
}));
jest.mock('@/lib/auth/send-magic-link', () => ({ sendMagicLink: mockSendMagicLink }));

const { useSignInFlow } = require('./useSignInFlow') as {
  useSignInFlow: (props: SignInFlowProps) => SignInFlowReturn;
};

type LinkedomParseHtml = (html: string) => { window: typeof globalThis; document: Document };

function installDom(): { cleanup: () => void; container: HTMLElement } {
  const requireFromHere = createRequire(__filename);
  const { parseHTML } = requireFromHere('linkedom') as { parseHTML: LinkedomParseHtml };
  const { window, document } = parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>'
  );
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    HTMLButtonElement: globalThis.HTMLButtonElement,
    Element: globalThis.Element,
    Node: globalThis.Node,
    Text: globalThis.Text,
    Comment: globalThis.Comment,
    DocumentFragment: globalThis.DocumentFragment,
    Document: globalThis.Document,
    SVGElement: globalThis.SVGElement,
    Event: globalThis.Event,
    CustomEvent: globalThis.CustomEvent,
    navigator: globalThis.navigator,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
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
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.getElementById('root');
  if (!container) throw new Error('React root missing');
  return {
    container: container as unknown as HTMLElement,
    cleanup: () => Object.assign(globalThis, previous),
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(promiseResolve => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function response(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function FlowProbe({ props = { searchParams: {} } }: { props?: SignInFlowProps }) {
  const flow = useSignInFlow(props);
  return createElement(
    'div',
    null,
    createElement('output', { id: 'state' }, flow.flowState),
    createElement('output', { id: 'tier' }, flow.tier),
    createElement('output', { id: 'email-input' }, String(flow.showEmailInput)),
    createElement('output', { id: 'email' }, flow.email),
    createElement('output', { id: 'turnstile' }, String(flow.showTurnstile)),
    createElement('output', { id: 'verifying' }, String(flow.isVerifying)),
    createElement('output', { id: 'delivering' }, String(flow.isDeliveringMagicLink)),
    createElement('output', { id: 'turnstile-error' }, String(flow.turnstileError)),
    createElement('output', { id: 'error' }, flow.error),
    createElement('output', { id: 'attempt' }, String(flow.turnstileAttemptId)),
    createElement('button', {
      id: 'first',
      onClick: () => flow.handleTurnstileSuccess('first-token', flow.turnstileAttemptId),
    }),
    createElement('button', {
      id: 'second',
      onClick: () => flow.handleTurnstileSuccess('second-token', flow.turnstileAttemptId),
    }),
    createElement('button', { id: 'back', onClick: flow.handleBack }),
    createElement('button', {
      id: 'old-email',
      onClick: () => flow.handleEmailChange('old@example.com'),
    }),
    createElement('button', {
      id: 'new-email',
      onClick: () => flow.handleEmailChange('new@example.com'),
    }),
    createElement('button', {
      id: 'sso',
      onClick: () => flow.handleSSOContinue('org-stale'),
    }),
    createElement('button', {
      id: 'stale-sso-callback',
      onClick: () => flow.handleTurnstileSuccess('stale-token', 1),
    }),
    createElement('button', {
      id: 'active-turnstile-error',
      onClick: () => flow.handleTurnstileError(flow.turnstileAttemptId),
    }),
    createElement('button', {
      id: 'stale-turnstile-error',
      onClick: () => flow.handleTurnstileError(1),
    }),
    createElement('button', {
      id: 'same-widget-delayed-error',
      onClick: () => flow.handleTurnstileError(1),
    }),
    createElement('button', { id: 'show-email', onClick: flow.handleShowEmailInput }),
    createElement('button', { id: 'select-email', onClick: () => flow.handleOAuthClick('email') }),
    createElement('button', {
      id: 'submit-email',
      onClick: () => flow.handleEmailSubmit({ preventDefault: () => undefined } as React.FormEvent),
    }),
    createElement('button', { id: 'clear-invite', onClick: flow.handleClearInvite }),
    createElement('button', { id: 'retry-turnstile', onClick: flow.handleRetryTurnstile })
  );
}

type MountedFlow = {
  container: HTMLElement;
  root: Root;
  render: (props: SignInFlowProps) => void;
  cleanup: () => void;
};

function mountFlow(props?: SignInFlowProps): MountedFlow {
  const dom = installDom();
  let root!: Root;
  act(() => {
    root = createRoot(dom.container);
    root.render(createElement(FlowProbe, { props }));
  });
  return {
    container: dom.container,
    root,
    render: nextProps => {
      act(() => root.render(createElement(FlowProbe, { props: nextProps })));
    },
    cleanup: () => {
      act(() => root.unmount());
      dom.cleanup();
    },
  };
}

function button(container: HTMLElement, id: string): HTMLButtonElement {
  const element = container.querySelector(`#${id}`);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Missing ${id} button`);
  return element;
}

describe('useSignInFlow discovery cancellation', () => {
  let mounted: MountedFlow | undefined;
  const fetchMock = jest.fn<typeof fetch>();

  beforeEach(() => {
    mockSignIn.mockReset();
    mockSignIn.mockResolvedValue(undefined);
    mockHint = null;
    mockSaveHint.mockReset();
    mockClearHint.mockReset();
    mockSendMagicLink.mockReset();
    mockSendMagicLink.mockResolvedValue({ success: true });
    fetchMock.mockReset();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    mounted?.cleanup();
    mounted = undefined;
  });

  it('ignores a late automatic OAuth discovery result after Back cancels the flow', async () => {
    const discovery = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(response({ success: true }))
      .mockReturnValueOnce(discovery.promise);
    mounted = mountFlow();

    act(() => button(mounted!.container, 'old-email').click());
    act(() => button(mounted!.container, 'submit-email').click());
    await act(async () => {
      button(mounted!.container, 'first').click();
      await flushAsyncWork();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    act(() => button(mounted!.container, 'back').click());
    await act(async () => {
      discovery.resolve(response({ kind: 'existing', providers: ['google'] }));
      await flushAsyncWork();
    });

    expect(mounted.container.querySelector('#state')?.textContent).toBe('landing');
    expect(mockSignIn).not.toHaveBeenCalled();
    expect(mockSaveHint).not.toHaveBeenCalled();
  });

  it('does not enter provider selection when Back cancels a late multi-provider discovery result', async () => {
    const discovery = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(response({ success: true }))
      .mockReturnValueOnce(discovery.promise);
    mounted = mountFlow();

    act(() => button(mounted!.container, 'old-email').click());
    await act(async () => {
      button(mounted!.container, 'first').click();
      await flushAsyncWork();
    });
    act(() => button(mounted!.container, 'back').click());
    await act(async () => {
      discovery.resolve(response({ kind: 'existing', providers: ['google', 'github'] }));
      await flushAsyncWork();
    });

    expect(mounted.container.querySelector('#state')?.textContent).toBe('landing');
    expect(mockSignIn).not.toHaveBeenCalled();
    expect(mockSaveHint).not.toHaveBeenCalled();
  });

  it('lets a newer discovery request supersede an older late result', async () => {
    const firstDiscovery = deferred<Response>();
    const secondDiscovery = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(response({ success: true }))
      .mockReturnValueOnce(firstDiscovery.promise)
      .mockResolvedValueOnce(response({ success: true }))
      .mockReturnValueOnce(secondDiscovery.promise);
    mounted = mountFlow();

    act(() => button(mounted!.container, 'old-email').click());
    await act(async () => {
      button(mounted!.container, 'first').click();
      await flushAsyncWork();
    });
    act(() => button(mounted!.container, 'new-email').click());
    await act(async () => {
      button(mounted!.container, 'second').click();
      await flushAsyncWork();
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await act(async () => {
      firstDiscovery.resolve(response({ kind: 'existing', providers: ['google'] }));
      await flushAsyncWork();
    });
    expect(mockSignIn).not.toHaveBeenCalled();

    await act(async () => {
      secondDiscovery.resolve(response({ kind: 'existing', providers: ['google', 'github'] }));
      await flushAsyncWork();
    });
    expect(mounted.container.querySelector('#state')?.textContent).toBe('provider-select');
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  it('does not redirect to an abandoned SSO organization after Back and fresh email discovery', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ success: true }))
      .mockResolvedValueOnce(response({ kind: 'new', providers: ['google', 'email'] }));
    mounted = mountFlow();

    act(() => button(mounted!.container, 'sso').click());
    act(() => button(mounted!.container, 'back').click());
    act(() => button(mounted!.container, 'new-email').click());
    await act(async () => {
      button(mounted!.container, 'first').click();
      await flushAsyncWork();
    });

    expect(mockSignIn).not.toHaveBeenCalled();
    expect(mounted.container.querySelector('#state')?.textContent).toBe('provider-select');
  });

  it('ignores a delayed Turnstile callback from an SSO attempt invalidated by Back', async () => {
    mounted = mountFlow();

    act(() => button(mounted!.container, 'sso').click());
    act(() => button(mounted!.container, 'back').click());
    await act(async () => {
      button(mounted!.container, 'stale-sso-callback').click();
      await Promise.resolve();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  it('ignores a stale Turnstile error while a newer verification discovery is pending', async () => {
    const firstDiscovery = deferred<Response>();
    const secondDiscovery = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(response({ success: true }))
      .mockReturnValueOnce(firstDiscovery.promise)
      .mockResolvedValueOnce(response({ success: true }))
      .mockReturnValueOnce(secondDiscovery.promise);
    mounted = mountFlow();

    act(() => button(mounted!.container, 'old-email').click());
    act(() => button(mounted!.container, 'submit-email').click());
    await act(async () => {
      button(mounted!.container, 'first').click();
      await flushAsyncWork();
    });
    act(() => button(mounted!.container, 'new-email').click());
    act(() => button(mounted!.container, 'submit-email').click());
    await act(async () => {
      button(mounted!.container, 'second').click();
      await flushAsyncWork();
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(mounted.container.querySelector('#verifying')?.textContent).toBe('true');

    act(() => button(mounted!.container, 'stale-turnstile-error').click());

    expect(mounted.container.querySelector('#verifying')?.textContent).toBe('true');
    expect(mounted.container.querySelector('#turnstile-error')?.textContent).toBe('false');

    await act(async () => {
      secondDiscovery.resolve(response({ kind: 'existing', providers: ['google', 'github'] }));
      await flushAsyncWork();
    });

    expect(mounted.container.querySelector('#state')?.textContent).toBe('provider-select');
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  it('recovers from an active replacement Turnstile widget error', async () => {
    mounted = mountFlow();

    act(() => button(mounted!.container, 'old-email').click());
    act(() => button(mounted!.container, 'submit-email').click());
    const originalAttempt = mounted.container.querySelector('#attempt')?.textContent;
    act(() => button(mounted!.container, 'back').click());
    act(() => button(mounted!.container, 'submit-email').click());

    expect(mounted.container.querySelector('#attempt')?.textContent).not.toBe(originalAttempt);
    act(() => button(mounted!.container, 'active-turnstile-error').click());

    expect(mounted.container.querySelector('#verifying')?.textContent).toBe('false');
    expect(mounted.container.querySelector('#turnstile-error')?.textContent).toBe('true');
  });

  it('keeps discovery active when its mounted Turnstile widget reports a delayed error', async () => {
    const discovery = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(response({ success: true }))
      .mockReturnValueOnce(discovery.promise);
    mounted = mountFlow();

    act(() => button(mounted!.container, 'old-email').click());
    act(() => button(mounted!.container, 'submit-email').click());
    const mountedAttempt = mounted.container.querySelector('#attempt')?.textContent;
    await act(async () => {
      button(mounted!.container, 'first').click();
      await flushAsyncWork();
    });

    // Discovery advances its cancellation generation, but it must not create a
    // replacement Turnstile widget. This error belongs to that still-mounted
    // widget and cannot abort the discovery it started.
    expect(mounted.container.querySelector('#attempt')?.textContent).toBe(mountedAttempt);
    act(() => button(mounted!.container, 'same-widget-delayed-error').click());

    expect(mounted.container.querySelector('#verifying')?.textContent).toBe('true');
    expect(mounted.container.querySelector('#turnstile-error')?.textContent).toBe('false');

    await act(async () => {
      discovery.resolve(response({ kind: 'existing', providers: ['google', 'github'] }));
      await flushAsyncWork();
    });

    expect(mounted.container.querySelector('#state')?.textContent).toBe('provider-select');
  });

  it('sends the selected sign-up Email magic link after Turnstile without discovery', async () => {
    fetchMock.mockResolvedValueOnce(response({ success: true }));
    mounted = mountFlow({ searchParams: {}, isSignUp: true });

    act(() => button(mounted!.container, 'show-email').click());
    act(() => button(mounted!.container, 'new-email').click());
    act(() => button(mounted!.container, 'submit-email').click());
    await act(async () => {
      button(mounted!.container, 'first').click();
      await flushAsyncWork();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockSendMagicLink).toHaveBeenCalledWith('new@example.com', '/users/after-sign-in');
    expect(mounted.container.querySelector('#state')?.textContent).toBe('magic-link-sent');
  });

  it('does not auto-verify a prefilled explicit sign-up email', async () => {
    mounted = mountFlow({ searchParams: { email: 'new@example.com' }, isSignUp: true });

    expect(mounted.container.querySelector('#tier')?.textContent).toBe('new');
    expect(mounted.container.querySelector('#turnstile')?.textContent).toBe('false');
    expect(mounted.container.querySelector('#email-input')?.textContent).toBe('false');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not treat an untrusted callback query error as an operational error', () => {
    mounted = mountFlow({ searchParams: {}, error: 'DISCOVERY_FAILED' });

    expect(mounted.container.querySelector('#error')?.textContent).toBe('UNKNOWN_CALLBACK_ERROR');
  });

  it('does not auto-verify an invite email before its SSO CTA is selected', async () => {
    mounted = mountFlow({
      searchParams: { email: 'invited@example.com', org: 'org-1' },
    });

    expect(mounted.container.querySelector('#tier')?.textContent).toBe('invite');
    expect(mounted.container.querySelector('#turnstile')?.textContent).toBe('false');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not reopen Turnstile after prefilled email discovery succeeds', async () => {
    mockSaveHint.mockImplementation(hint => {
      mockHint = hint;
    });
    fetchMock
      .mockResolvedValueOnce(response({ success: true }))
      .mockResolvedValueOnce(response({ kind: 'existing', providers: ['email'] }));
    mounted = mountFlow({ searchParams: { email: 'returning@example.com' } });

    expect(mounted.container.querySelector('#turnstile')?.textContent).toBe('true');
    await act(async () => {
      button(mounted!.container, 'first').click();
      await flushAsyncWork();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(mockSendMagicLink).toHaveBeenCalledTimes(1);
    expect(mounted.container.querySelector('#state')?.textContent).toBe('magic-link-sent');
    expect(mounted.container.querySelector('#turnstile')?.textContent).toBe('false');
  });

  it('auto-opens Turnstile once for a valid prefilled email', () => {
    mounted = mountFlow({ searchParams: { email: 'returning@example.com' } });
    const initialAttempt = mounted.container.querySelector('#attempt')?.textContent;

    expect(mounted.container.querySelector('#turnstile')?.textContent).toBe('true');
    expect(initialAttempt).toBe('1');

    mounted.render({ searchParams: { email: 'returning@example.com' } });

    expect(mounted.container.querySelector('#turnstile')?.textContent).toBe('true');
    expect(mounted.container.querySelector('#attempt')?.textContent).toBe(initialAttempt);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not reopen Turnstile or refetch after Back from prefilled multi-provider discovery', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ success: true }))
      .mockResolvedValueOnce(response({ kind: 'existing', providers: ['google', 'github'] }));
    mounted = mountFlow({ searchParams: { email: 'returning@example.com' } });

    await act(async () => {
      button(mounted!.container, 'first').click();
      await flushAsyncWork();
    });
    expect(mounted.container.querySelector('#state')?.textContent).toBe('provider-select');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    act(() => button(mounted!.container, 'back').click());

    expect(mounted.container.querySelector('#state')?.textContent).toBe('landing');
    expect(mounted.container.querySelector('#email-input')?.textContent).toBe('true');
    expect(mounted.container.querySelector('#turnstile')?.textContent).toBe('false');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns a remembered user from the email form to their sign-in option', () => {
    mockHint = {
      lastEmail: 'returning@example.com',
      lastAuthMethod: 'google',
      lastLogin: '2026-08-26T00:00:00.000Z',
    };
    mounted = mountFlow({ searchParams: {} });

    expect(mounted.container.querySelector('#tier')?.textContent).toBe('returning');
    expect(mounted.container.querySelector('#email-input')?.textContent).toBe('true');

    act(() => button(mounted!.container, 'back').click());

    expect(mounted.container.querySelector('#tier')?.textContent).toBe('returning');
    expect(mounted.container.querySelector('#email-input')?.textContent).toBe('false');
    expect(mockClearHint).not.toHaveBeenCalled();
  });

  it('auto-opens once for a genuinely changed prefilled query email', () => {
    mounted = mountFlow({ searchParams: { email: 'first@example.com' } });

    expect(mounted.container.querySelector('#email')?.textContent).toBe('first@example.com');
    expect(mounted.container.querySelector('#attempt')?.textContent).toBe('1');

    mounted.render({ searchParams: { email: 'second@example.com' } });

    expect(mounted.container.querySelector('#email')?.textContent).toBe('second@example.com');
    expect(mounted.container.querySelector('#turnstile')?.textContent).toBe('true');
    expect(mounted.container.querySelector('#attempt')?.textContent).toBe('2');

    mounted.render({ searchParams: { email: 'second@example.com' } });

    expect(mounted.container.querySelector('#attempt')?.textContent).toBe('2');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('holds the automatic email flow pending through delivery and recovers after failure', async () => {
    const delivery = deferred<{ success: true }>();
    fetchMock
      .mockResolvedValueOnce(response({ success: true }))
      .mockResolvedValueOnce(response({ kind: 'existing', providers: ['email'] }));
    mockSendMagicLink.mockReturnValueOnce(delivery.promise);
    mounted = mountFlow();

    act(() => button(mounted!.container, 'old-email').click());
    act(() => button(mounted!.container, 'submit-email').click());
    await act(async () => {
      button(mounted!.container, 'first').click();
      await flushAsyncWork();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockSendMagicLink).toHaveBeenCalledTimes(1);
    expect(mounted.container.querySelector('#turnstile')?.textContent).toBe('true');
    expect(mounted.container.querySelector('#verifying')?.textContent).toBe('true');
    expect(mounted.container.querySelector('#delivering')?.textContent).toBe('true');

    act(() => button(mounted!.container, 'second').click());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockSendMagicLink).toHaveBeenCalledTimes(1);

    await act(async () => {
      delivery.resolve({ success: false, error: 'Delivery failed' } as never);
      await flushAsyncWork();
    });

    expect(mounted.container.querySelector('#state')?.textContent).toBe('landing');
    expect(mounted.container.querySelector('#turnstile')?.textContent).toBe('false');
    expect(mounted.container.querySelector('#verifying')?.textContent).toBe('false');
    expect(mounted.container.querySelector('#delivering')?.textContent).toBe('false');
    expect(mounted.container.querySelector('#error')?.textContent).toBe(
      'MAGIC_LINK_DELIVERY_FAILED'
    );
  });

  it.each([
    [429, { ignored: true }, 'DISCOVERY_RATE_LIMITED'],
    [503, { ignored: true }, 'DISCOVERY_FAILED'],
    [200, { kind: 'existing', providers: [] }, 'NO_SUPPORTED_SIGN_IN_METHOD'],
  ])(
    'preserves the controlled discovery error for status %i',
    async (status, body, expectedError) => {
      fetchMock
        .mockResolvedValueOnce(response({ success: true }))
        .mockResolvedValueOnce({ ok: status === 200, status, json: async () => body } as Response);
      mounted = mountFlow();

      act(() => button(mounted!.container, 'old-email').click());
      act(() => button(mounted!.container, 'submit-email').click());
      await act(async () => {
        button(mounted!.container, 'first').click();
        await flushAsyncWork();
      });

      expect(mounted.container.querySelector('#state')?.textContent).toBe('landing');
      expect(mounted.container.querySelector('#error')?.textContent).toBe(expectedError);
    }
  );

  it('keeps explicit sign-up Email delivery pending and suppresses its completion after reset', async () => {
    const delivery = deferred<{ success: true }>();
    fetchMock.mockResolvedValueOnce(response({ success: true }));
    mockSendMagicLink.mockReturnValueOnce(delivery.promise);
    mounted = mountFlow({ searchParams: {}, isSignUp: true });

    act(() => button(mounted!.container, 'show-email').click());
    act(() => button(mounted!.container, 'new-email').click());
    act(() => button(mounted!.container, 'submit-email').click());
    await act(async () => {
      button(mounted!.container, 'first').click();
      await flushAsyncWork();
    });

    expect(mounted.container.querySelector('#turnstile')?.textContent).toBe('true');
    expect(mounted.container.querySelector('#verifying')?.textContent).toBe('true');
    expect(mounted.container.querySelector('#delivering')?.textContent).toBe('true');
    act(() => button(mounted!.container, 'second').click());
    expect(mockSendMagicLink).toHaveBeenCalledTimes(1);

    act(() => button(mounted!.container, 'back').click());
    await act(async () => {
      delivery.resolve({ success: true });
      await flushAsyncWork();
    });

    expect(mounted.container.querySelector('#state')?.textContent).toBe('landing');
    expect(mockSaveHint).not.toHaveBeenCalled();
  });

  it('keeps explicit existing-account Email delivery pending and completes it when active', async () => {
    const delivery = deferred<{ success: true }>();
    fetchMock.mockResolvedValueOnce(response({ success: true }));
    mockSendMagicLink.mockReturnValueOnce(delivery.promise);
    mounted = mountFlow({ searchParams: {} });

    act(() => button(mounted!.container, 'old-email').click());
    act(() => button(mounted!.container, 'select-email').click());
    await act(async () => {
      button(mounted!.container, 'first').click();
      await flushAsyncWork();
    });

    expect(mounted.container.querySelector('#delivering')?.textContent).toBe('true');
    act(() => button(mounted!.container, 'second').click());
    expect(mockSendMagicLink).toHaveBeenCalledTimes(1);

    await act(async () => {
      delivery.resolve({ success: true });
      await flushAsyncWork();
    });

    expect(mounted.container.querySelector('#state')?.textContent).toBe('magic-link-sent');
    expect(mockSaveHint).toHaveBeenCalledWith(
      expect.objectContaining({ lastEmail: 'old@example.com', lastAuthMethod: 'email' })
    );
  });

  it('suppresses stale invite parameters after choosing a different account', async () => {
    mounted = mountFlow({
      searchParams: { email: 'invited@example.com', org: 'org-1', callbackPath: '/claw/new' },
    });

    expect(mounted.container.querySelector('#tier')?.textContent).toBe('invite');
    await act(async () => {
      button(mounted!.container, 'clear-invite').click();
      await Promise.resolve();
    });

    expect(mounted.container.querySelector('#tier')?.textContent).toBe('new');
    expect(mounted.container.querySelector('#email-input')?.textContent).toBe('true');
    expect(mounted.container.querySelector('#email')?.textContent).toBe('');
    expect(mounted.container.querySelector('#turnstile')?.textContent).toBe('false');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not resurrect Turnstile when Back immediately follows retry', async () => {
    mounted = mountFlow();

    act(() => button(mounted!.container, 'old-email').click());
    act(() => button(mounted!.container, 'submit-email').click());
    act(() => button(mounted!.container, 'active-turnstile-error').click());
    act(() => button(mounted!.container, 'retry-turnstile').click());
    act(() => button(mounted!.container, 'back').click());
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 150));
    });

    expect(mounted.container.querySelector('#turnstile')?.textContent).toBe('false');
  });

  it('does not schedule a Turnstile state update when retry is followed by unmount', () => {
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    mounted = mountFlow();

    act(() => button(mounted!.container, 'old-email').click());
    act(() => button(mounted!.container, 'submit-email').click());
    act(() => button(mounted!.container, 'active-turnstile-error').click());
    act(() => button(mounted!.container, 'retry-turnstile').click());
    expect(mounted.container.querySelector('#turnstile')?.textContent).toBe('true');
    expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 100);

    mounted.cleanup();
    mounted = undefined;
    setTimeoutSpy.mockRestore();
  });

  it('immediately replaces the active Turnstile widget on retry', () => {
    mounted = mountFlow();

    act(() => button(mounted!.container, 'old-email').click());
    act(() => button(mounted!.container, 'submit-email').click());
    const originalAttempt = mounted.container.querySelector('#attempt')?.textContent;
    act(() => button(mounted!.container, 'active-turnstile-error').click());
    act(() => button(mounted!.container, 'retry-turnstile').click());

    expect(mounted.container.querySelector('#turnstile')?.textContent).toBe('true');
    expect(mounted.container.querySelector('#attempt')?.textContent).not.toBe(originalAttempt);
    expect(mounted.container.querySelector('#turnstile-error')?.textContent).toBe('false');
  });
});
