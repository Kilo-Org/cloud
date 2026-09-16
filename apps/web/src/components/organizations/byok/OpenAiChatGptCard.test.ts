// The client hooks are stubbed before the card is loaded: the view renders
// without them, and the container only runs in the browser.
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-auth/react', () => ({ signIn: jest.fn() }));

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { OpenAiChatGptCardView, type OpenAiChatGptCardViewProps } from './OpenAiChatGptCard';
import { OPENAI_TOKEN_SHARING_SCOPE } from '@/lib/auth/openai/scopes';
import type { OpenAiChatGptStatus } from '@/lib/ai-gateway/openai-chatgpt/status';

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
  return html.match(/class="([^"]*min-h-\[5\.5rem\][^"]*)"/)?.[1];
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

  it('shows the declined copy as an alert above the stored reconnect state', () => {
    const html = render({
      status: STORED_RECONNECT_STATUS,
      authErrorCode: 'access_denied',
    });

    expect(html.replace(/&#x27;/g, "'")).toContain('ChatGPT was not connected. Try again.');
    expect(html).toContain('data-slot="alert"');
    // The stored connection keeps its badge, its message and one-click disconnect.
    expect(html).toContain('Needs reconnect');
    expect(html).toContain(RECONNECT_MESSAGE);
    expect(html.match(/Reconnect with ChatGPT/g)).toHaveLength(1);
    expect(html.match(/>Disconnect</g)).toHaveLength(1);
    // The alert is rendered above the stored status body.
    expect(html.indexOf('ChatGPT was not connected')).toBeLessThan(html.indexOf(RECONNECT_MESSAGE));
  });

  it('shows the generic copy above the stored status for any other code', () => {
    const html = render({ status: STORED_RECONNECT_STATUS, authErrorCode: 'server_error' });

    expect(html.replace(/&#x27;/g, "'")).toContain("We couldn't connect ChatGPT. Try again.");
    expect(html).toContain('Needs reconnect');
    expect(html.match(/Reconnect with ChatGPT/g)).toHaveLength(1);
    expect(html.match(/>Disconnect</g)).toHaveLength(1);
  });

  it('uses the stored body CTA as the retry when the linking session fails', () => {
    const html = render({ status: { state: 'disconnected' }, authErrorCode: 'connect_failed' });

    expect(html.replace(/&#x27;/g, "'")).toContain("We couldn't connect ChatGPT. Try again.");
    expect(html.match(/Sign in with ChatGPT/g)).toHaveLength(1);
    expect(html).not.toContain('>Try again<');
  });

  it('keeps the stored identity and disconnect action when a reconnect is declined', () => {
    const html = render({
      status: {
        state: 'connected',
        email: 'user@example.com',
        subject: 'subject-1',
        connectedAt: CONNECTED_AT,
      },
      authErrorCode: 'access_denied',
    });

    expect(html).toContain('data-slot="alert"');
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
    expect([...bodyClasses][0]).toContain('min-h-[5.5rem]');
  });

  it('keeps the same content padding in every state', () => {
    for (const state of STATES) {
      expect(state.html).toContain('class="p-6 pt-0"');
    }
  });
});

describe('startOpenAiChatGptConnect', () => {
  beforeEach(() => {
    // @swc/jest does not hoist `jest.mock` above the static imports, so the card
    // has to be loaded after the mock is registered: drop the module registry
    // and import both the card and the mocked `signIn` freshly per test.
    jest.resetModules();
    jest.clearAllMocks();
  });

  async function loadConnect() {
    const card = await import('./OpenAiChatGptCard');
    const nextAuth = await import('next-auth/react');
    return {
      startOpenAiChatGptConnect: card.startOpenAiChatGptConnect,
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
