// The client hooks are stubbed before the card is loaded: the view renders
// without them, and the container only runs in the browser.
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-auth/react', () => ({ signIn: jest.fn() }));

// The dialog primitives are stubbed so the usage-limit content renders as
// plain markup: Radix portals its content, which no server renderer emits.
jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => children,
  DialogContent: ({ children }: { children: ReactNode }) => children,
  DialogHeader: ({ children }: { children: ReactNode }) => children,
  DialogTitle: ({ children }: { children: ReactNode }) => children,
  DialogDescription: ({ children }: { children: ReactNode }) => children,
  DialogFooter: ({ children }: { children: ReactNode }) => children,
}));

import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { OpenAiChatGptCardView, type OpenAiChatGptCardViewProps } from './OpenAiChatGptCard';
import { OPENAI_TOKEN_SHARING_SCOPE } from '@/lib/auth/openai/scopes';
import type { OpenAiChatGptStatus } from '@/lib/ai-gateway/openai-chatgpt/status';
import { CHATGPT_USAGE_SETTINGS_URL } from '@/lib/ai-gateway/openai-chatgpt/usage-limit';

const CONNECTED_AT = '2026-09-16T12:00:00.000Z';
const RECONNECT_MESSAGE = 'Your ChatGPT connection has expired. Reconnect to continue.';
const CONNECT_LABEL = 'Sign in with ChatGPT';

function render(props: OpenAiChatGptCardViewProps): string {
  return renderToStaticMarkup(createElement(OpenAiChatGptCardView, props));
}

function renderStatus(status: OpenAiChatGptStatus): string {
  return render({ status });
}

/** The class attribute of the reserved-height body wrapper. */
function bodyClass(html: string): string | undefined {
  return html.match(/class="([^"]*min-h-\[7rem\][^"]*)"/)?.[1];
}

/** The opening tag of the reserved-height body wrapper. */
const BODY_WRAPPER_OPEN = '<div class="flex min-h-[7rem] flex-col justify-center gap-3">';

/** True when `needle` renders inside the element opened by `openTag`. */
function containsElement(html: string, openTag: string, needle: string): boolean {
  const start = html.indexOf(openTag);
  const target = html.indexOf(needle);
  if (start < 0 || target < start) return false;

  const div = /<\/?div\b/g;
  div.lastIndex = start;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = div.exec(html))) {
    if (match[0] === '</div') {
      depth -= 1;
      if (depth === 0) return target < match.index;
    } else {
      depth += 1;
    }
  }
  return false;
}

/** The class attribute of the card container itself. */
function cardClass(html: string): string | undefined {
  return html.match(/^<div class="([^"]*)"/)?.[1];
}

/** The card header title text. `CardTitle` renders as `<div class="type-heading">`. */
function cardTitle(html: string): string | undefined {
  return html.match(/class="type-heading">([^<]*)</)?.[1];
}

const STATES: Array<{ label: string; html: string }> = [
  { label: 'loading', html: render({ status: undefined }) },
  { label: 'disconnected', html: renderStatus({ state: 'disconnected' }) },
  {
    label: 'connected',
    html: renderStatus({
      state: 'connected',
      email: 'user@example.com',
      subject: 'subject-1',
      connectedAt: CONNECTED_AT,
    }),
  },
  {
    label: 'expired',
    html: renderStatus({
      state: 'error',
      email: 'user@example.com',
      subject: 'subject-1',
      connectedAt: CONNECTED_AT,
      errorMessage: RECONNECT_MESSAGE,
    }),
  },
  {
    label: 'declined authorization',
    html: render({
      status: { state: 'disconnected' },
      authErrorCode: 'access_denied',
    }),
  },
  {
    label: 'connect failed',
    html: render({ status: { state: 'disconnected' }, authErrorCode: 'connect_failed' }),
  },
  {
    label: 'declined reconnect with a stored connection',
    html: render({
      status: {
        state: 'error',
        email: 'user@example.com',
        subject: 'subject-1',
        connectedAt: CONNECTED_AT,
        errorMessage: RECONNECT_MESSAGE,
      },
      authErrorCode: 'access_denied',
    }),
  },
  {
    label: 'disconnect failed',
    html: render({
      status: {
        state: 'connected',
        email: 'user@example.com',
        subject: 'subject-1',
        connectedAt: CONNECTED_AT,
      },
      hasDisconnectError: true,
    }),
  },
  {
    label: 'status query failed',
    html: render({ status: undefined, hasLoadError: true }),
  },
  {
    label: 'connecting',
    html: render({ status: { state: 'disconnected' }, isConnecting: true }),
  },
  {
    label: 'disconnecting',
    html: render({
      status: {
        state: 'connected',
        email: 'user@example.com',
        subject: 'subject-1',
        connectedAt: CONNECTED_AT,
      },
      isDisconnecting: true,
    }),
  },
];

describe('OpenAiChatGptCard title', () => {
  it('names the ChatGPT connection so it never reads as the pasted OpenAI API key entry below it', () => {
    for (const state of STATES) {
      expect(cardTitle(state.html)).toBe('OpenAI (ChatGPT subscription)');
    }
  });
});

describe('OpenAiChatGptCard disconnected state', () => {
  it('explains the subscription connection and offers one connect action', () => {
    const html = renderStatus({ state: 'disconnected' });

    expect(html).toContain('OpenAI');
    expect(html).toContain('ChatGPT subscription');
    expect(html).toContain('No API key needed.');
    expect(html.match(/Sign in with ChatGPT/g)).toHaveLength(1);
    expect(html).not.toContain('Disconnect');
  });
});

describe('OpenAiChatGptCard connected state', () => {
  it('shows the connected indicator, the email, the date and one disconnect action', () => {
    const html = renderStatus({
      state: 'connected',
      email: 'user@example.com',
      subject: 'subject-1',
      connectedAt: CONNECTED_AT,
    });

    expect(html).toContain('Connected');
    expect(html).toContain('Connected as user@example.com');
    expect(html).toContain(new Date(CONNECTED_AT).toLocaleDateString());
    expect(html.match(/Disconnect/g)).toHaveLength(1);
    expect(html).not.toContain(CONNECT_LABEL);
  });

  it('falls back to the account subject when the token has no email claim', () => {
    const html = renderStatus({
      state: 'connected',
      subject: 'subject-1',
      connectedAt: CONNECTED_AT,
    });

    expect(html).toContain('Connected as subject-1');
  });
});

describe('OpenAiChatGptCard expired state', () => {
  it('shows the stored message with a reconnect and a disconnect action', () => {
    const html = renderStatus({
      state: 'error',
      email: 'user@example.com',
      connectedAt: CONNECTED_AT,
      errorMessage: RECONNECT_MESSAGE,
    });

    expect(html).toContain(RECONNECT_MESSAGE);
    expect(html.match(/Reconnect with ChatGPT/g)).toHaveLength(1);
    expect(html.match(/>Disconnect</g)).toHaveLength(1);
  });
});

describe('OpenAiChatGptCard disconnect failure', () => {
  it('keeps one disconnect action so the click can be retried', () => {
    const html = render({
      status: {
        state: 'connected',
        email: 'user@example.com',
        subject: 'subject-1',
        connectedAt: CONNECTED_AT,
      },
      hasDisconnectError: true,
    });

    expect(html.replace(/&#x27;/g, "'")).toContain("We couldn't disconnect ChatGPT. Try again.");
    expect(html.match(/Disconnect/g)).toHaveLength(1);
  });
});

describe('OpenAiChatGptCard returned authorization errors', () => {
  const STORED_RECONNECT_STATUS: OpenAiChatGptStatus = {
    state: 'error',
    email: 'user@example.com',
    subject: 'subject-1',
    connectedAt: CONNECTED_AT,
    errorMessage: RECONNECT_MESSAGE,
  };

  it('shows the declined copy in the stored reconnect body, keeping its reconnect and disconnect actions', () => {
    const html = render({
      status: STORED_RECONNECT_STATUS,
      authErrorCode: 'access_denied',
    });

    expect(html.replace(/&#x27;/g, "'")).toContain('ChatGPT was not connected. Try again.');
    expect(html).toContain('data-slot="alert"');
    // The stored connection keeps its badge and its one-click actions.
    expect(html).toContain('Needs reconnect');
    expect(html.match(/Reconnect with ChatGPT/g)).toHaveLength(1);
    expect(html.match(/>Disconnect</g)).toHaveLength(1);
    // The returned failure is the body's single message: it replaces the
    // stored failure text instead of stacking a second row that would grow the
    // card and move the key list below it.
    expect(html).not.toContain(RECONNECT_MESSAGE);
  });

  it('shows the generic copy with the stored status for any other code', () => {
    const html = render({ status: STORED_RECONNECT_STATUS, authErrorCode: 'server_error' });

    expect(html.replace(/&#x27;/g, "'")).toContain("We couldn't connect ChatGPT. Try again.");
    expect(html).toContain('Needs reconnect');
    expect(html.match(/Reconnect with ChatGPT/g)).toHaveLength(1);
    expect(html.match(/>Disconnect</g)).toHaveLength(1);
  });

  it('names the expired linking session instead of the generic connect failure', () => {
    const html = render({ status: { state: 'disconnected' }, authErrorCode: 'TURNSTILE_REQUIRED' });

    expect(html).toContain('ChatGPT was not connected in time. Try again.');
    expect(html.match(/>Try again</g)).toHaveLength(1);
  });

  it('offers the promised Try again retry when the linking session fails', () => {
    const html = render({ status: { state: 'disconnected' }, authErrorCode: 'connect_failed' });

    expect(html.replace(/&#x27;/g, "'")).toContain("We couldn't connect ChatGPT. Try again.");
    // One retry control only, labelled with the action the message promises.
    expect(html.match(/>Try again</g)).toHaveLength(1);
    expect(html).not.toContain('>Sign in with ChatGPT<');
  });

  it('offers Try again for a declined authorization with no stored connection', () => {
    const html = render({ status: { state: 'disconnected' }, authErrorCode: 'access_denied' });

    expect(html.replace(/&#x27;/g, "'")).toContain('ChatGPT was not connected. Try again.');
    // The failure copy is the body's message, so the connect pitch is not
    // stacked under it.
    expect(html).not.toContain('No API key needed.');
    expect(html.match(/>Try again</g)).toHaveLength(1);
    expect(html).not.toContain('>Sign in with ChatGPT<');
  });

  it('keeps the plain connect label when the disconnected card has no error', () => {
    const html = renderStatus({ state: 'disconnected' });

    expect(html.match(/Sign in with ChatGPT/g)).toHaveLength(1);
    expect(html).not.toContain('>Try again<');
  });

  it('reports the stored live connection when a declined attempt is reported late', () => {
    const html = render({
      status: {
        state: 'connected',
        email: 'user@example.com',
        subject: 'subject-1',
        connectedAt: CONNECTED_AT,
      },
      authErrorCode: 'access_denied',
    });

    // A live connection has nothing to recover, and a failure alert beside
    // 'Connected as ...' would contradict it: the card reports the connection.
    expect(html).not.toContain('data-slot="alert"');
    expect(html).toContain('Connected as user@example.com');
    expect(html.match(/>Disconnect</g)).toHaveLength(1);
  });
});

describe('OpenAiChatGptCard loading state', () => {
  it('renders the reserved-height skeleton instead of any action', () => {
    const html = render({ status: undefined });

    expect(html).toContain('data-slot="skeleton"');
    expect(html).not.toContain(CONNECT_LABEL);
    expect(html).not.toContain('Disconnect');
    expect(html).not.toContain('Reconnect');
  });

  it('offers a retry instead of a stuck skeleton when the status query failed', () => {
    const html = render({ status: undefined, hasLoadError: true });

    expect(html.replace(/&#x27;/g, "'")).toContain(
      "We couldn't load your ChatGPT connection. Try again."
    );
    expect(html.match(/>Try again</g)).toHaveLength(1);
    expect(html).not.toContain('data-slot="skeleton"');
  });
});

describe('OpenAiChatGptCard in-progress states', () => {
  it('shows the redirecting label and blocks a second connect click while connecting', () => {
    const html = render({ status: { state: 'disconnected' }, isConnecting: true });

    expect(html).toContain('Redirecting to ChatGPT...');
    expect(html).not.toContain('>Sign in with ChatGPT<');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Redirecting to ChatGPT\.\.\.<\/button>/);
  });

  it('shows the redirecting label for the reconnect action', () => {
    const html = render({
      status: {
        state: 'error',
        email: 'user@example.com',
        connectedAt: CONNECTED_AT,
        errorMessage: RECONNECT_MESSAGE,
      },
      isConnecting: true,
    });

    expect(html).toContain('Redirecting to ChatGPT...');
    expect(html).not.toContain('>Reconnect with ChatGPT<');
  });

  it('shows the redirecting label on the stored connect action after a failed authorization', () => {
    const html = render({
      status: { state: 'disconnected' },
      authErrorCode: 'connect_failed',
      isConnecting: true,
    });

    expect(html).toContain('Redirecting to ChatGPT...');
    expect(html).not.toContain('>Try again<');
  });

  it('shows the disconnecting label and blocks a second disconnect click while disconnecting', () => {
    const html = render({
      status: {
        state: 'connected',
        email: 'user@example.com',
        subject: 'subject-1',
        connectedAt: CONNECTED_AT,
      },
      isDisconnecting: true,
    });

    expect(html).toContain('Disconnecting...');
    expect(html).not.toContain('>Disconnect<');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Disconnecting\.\.\.<\/button>/);
  });

  it('shows the disconnecting label on the failed-disconnect retry action', () => {
    const html = render({
      status: {
        state: 'connected',
        email: 'user@example.com',
        subject: 'subject-1',
        connectedAt: CONNECTED_AT,
      },
      hasDisconnectError: true,
      isDisconnecting: true,
    });

    expect(html).toContain('Disconnecting...');
    expect(html).not.toContain('>Disconnect<');
  });
});

describe('OpenAiChatGptCard layout', () => {
  it('keeps the same card and body container classes in every state', () => {
    const cardClasses = new Set(STATES.map(state => cardClass(state.html)));
    const bodyClasses = new Set(STATES.map(state => bodyClass(state.html)));

    expect(STATES).toHaveLength(11);
    expect(cardClasses.size).toBe(1);
    expect(bodyClasses.size).toBe(1);
    expect([...cardClasses][0]).toBeDefined();
    expect([...bodyClasses][0]).toContain('min-h-[7rem]');
  });

  it('keeps the same content padding in every state', () => {
    for (const state of STATES) {
      expect(state.html).toContain('class="p-6 pt-0"');
    }
  });

  it('reserves the status column in every state so the title wraps the same with and without a badge', () => {
    for (const state of STATES) {
      expect(state.html).toContain('min-w-[7.625rem]');
    }
  });

  it('renders the returned-error alert inside the reserved body height', () => {
    const html = render({
      status: { state: 'disconnected' },
      authErrorCode: 'access_denied',
    });
    const wrapperOpen = html.indexOf(BODY_WRAPPER_OPEN);
    const alert = html.indexOf('data-slot="alert"');

    // Inside the wrapper the alert is covered by the reservation in every
    // state; as a sibling above it the alert would add a row and push the key
    // list below the card down when it mounts.
    expect(alert).toBeGreaterThan(wrapperOpen);
    expect(containsElement(html, BODY_WRAPPER_OPEN, 'data-slot="alert"')).toBe(true);
  });
});

describe('startOpenAiChatGptConnect', () => {
  beforeEach(() => {
    // @swc/jest does not hoist `jest.mock` above the static imports, so the
    // connect module has to be loaded after the mock is registered: drop the
    // module registry and import both it and the mocked `signIn` per test.
    jest.resetModules();
    jest.clearAllMocks();
  });

  async function loadConnect() {
    const connect = await import('@/lib/auth/openai/connect');
    const nextAuth = await import('next-auth/react');
    return {
      startOpenAiChatGptConnect: connect.startOpenAiChatGptConnect,
      signIn: jest.mocked(nextAuth.signIn),
    };
  }

  it('creates the account-linking session before starting the OpenAI authorization', async () => {
    const { startOpenAiChatGptConnect, signIn } = await loadConnect();
    const createLinkingSession = jest.fn(async () => ({}));

    await startOpenAiChatGptConnect(createLinkingSession);

    expect(createLinkingSession).toHaveBeenCalledTimes(1);
    expect(signIn).toHaveBeenCalledWith(
      'openai',
      { callbackUrl: '/byok' },
      { scope: OPENAI_TOKEN_SHARING_SCOPE }
    );
    expect(createLinkingSession.mock.invocationCallOrder[0]).toBeLessThan(
      signIn.mock.invocationCallOrder[0]
    );
  });

  it('returns to the organization BYOK page when an organization is given', async () => {
    const { startOpenAiChatGptConnect, signIn } = await loadConnect();
    const createLinkingSession = jest.fn(async () => ({}));

    await startOpenAiChatGptConnect(createLinkingSession, '00000000-0000-4000-8000-000000000001');

    expect(signIn).toHaveBeenCalledWith(
      'openai',
      { callbackUrl: '/organizations/00000000-0000-4000-8000-000000000001/byok' },
      { scope: OPENAI_TOKEN_SHARING_SCOPE }
    );
  });

  it('does not start the OpenAI authorization when the linking session fails', async () => {
    const { startOpenAiChatGptConnect, signIn } = await loadConnect();
    const createLinkingSession = jest.fn(async () => {
      throw new Error('linking session failed');
    });

    await expect(startOpenAiChatGptConnect(createLinkingSession)).rejects.toThrow(
      'linking session failed'
    );
    expect(signIn).not.toHaveBeenCalled();
  });
});

describe('OpenAiChatGptCard usage limit', () => {
  const USAGE_LIMIT = { reachedAt: '2026-09-16T13:00:00.000Z', resetsAt: null };
  const USAGE_LIMIT_TITLE = 'ChatGPT usage limit reached';
  const USAGE_LINK_SUMMARY = 'View and manage your ChatGPT usage';

  /**
   * Renders through a fresh module registry, because @swc/jest emits the static
   * imports before the `jest.mock` calls: the stubbed dialog only applies to a
   * module that is required after the stub is registered.
   */
  async function renderWithStubbedDialog(props: OpenAiChatGptCardViewProps): Promise<string> {
    jest.resetModules();
    const [card, react, server] = await Promise.all([
      import('./OpenAiChatGptCard'),
      import('react'),
      import('react-dom/server'),
    ]);
    return server.renderToStaticMarkup(react.createElement(card.OpenAiChatGptCardView, props));
  }

  it('shows the usage-limit message for a connection whose recorded limit is current', async () => {
    const html = await renderWithStubbedDialog({
      status: {
        state: 'connected',
        email: 'user@example.com',
        connectedAt: CONNECTED_AT,
        usageLimit: USAGE_LIMIT,
      },
    });

    expect(html).toContain(USAGE_LIMIT_TITLE);
    expect(html).toContain('Review your usage settings in ChatGPT.');
    expect(html).toContain('Buy Kilo credits instead');
    expect(html).toContain(CHATGPT_USAGE_SETTINGS_URL);
  });

  it('hides the usage-limit message once it is dismissed', async () => {
    const html = await renderWithStubbedDialog({
      status: {
        state: 'connected',
        email: 'user@example.com',
        connectedAt: CONNECTED_AT,
        usageLimit: USAGE_LIMIT,
      },
      isUsageLimitDismissed: true,
    });

    expect(html).not.toContain(USAGE_LIMIT_TITLE);
  });

  it('shows no usage-limit message without a recorded limit', () => {
    const html = renderStatus({
      state: 'connected',
      email: 'user@example.com',
      connectedAt: CONNECTED_AT,
    });

    expect(html).not.toContain(USAGE_LIMIT_TITLE);
  });

  it('offers the usage link while the connection is live and not otherwise', () => {
    const connected = renderStatus({
      state: 'connected',
      email: 'user@example.com',
      connectedAt: CONNECTED_AT,
    });
    expect(connected).toContain(USAGE_LINK_SUMMARY);
    expect(connected).toContain(CHATGPT_USAGE_SETTINGS_URL);

    expect(renderStatus({ state: 'disconnected' })).not.toContain(USAGE_LINK_SUMMARY);
  });
});
