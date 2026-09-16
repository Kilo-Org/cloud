// The client hooks are stubbed before the card is loaded: the view renders
// without them, and the container only runs in the browser.
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-auth/react', () => ({ signIn: jest.fn() }));

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from '@jest/globals';
import {
  OpenAiChatGptCardView,
  type OpenAiChatGptCardViewProps,
} from './OpenAiChatGptCard';
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
    label: 'status query failed',
    html: render({ status: undefined, hasLoadError: true }),
  },
];

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
  it('shows the stored message with one reconnect action', () => {
    const html = renderStatus({
      state: 'error',
      email: 'user@example.com',
      connectedAt: CONNECTED_AT,
      errorMessage: RECONNECT_MESSAGE,
    });

    expect(html).toContain(RECONNECT_MESSAGE);
    expect(html.match(/Reconnect with ChatGPT/g)).toHaveLength(1);
  });
});

describe('OpenAiChatGptCard returned authorization errors', () => {
  it('shows the declined copy with one try-again action for access_denied', () => {
    const html = render({ status: undefined, authErrorCode: 'access_denied' });

    expect(html).toContain('ChatGPT was not connected. Try again.');
    expect(html.match(/>Try again</g)).toHaveLength(1);
  });

  it('shows the generic copy with the same action for any other code', () => {
    const html = render({ status: undefined, authErrorCode: 'server_error' });

    expect(html.replace(/&#x27;/g, "'")).toContain(
      "We couldn't connect ChatGPT. Try again."
    );
    expect(html.match(/>Try again</g)).toHaveLength(1);
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

describe('OpenAiChatGptCard layout', () => {
  it('keeps the same card and body container classes in every state', () => {
    const cardClasses = new Set(STATES.map(state => cardClass(state.html)));
    const bodyClasses = new Set(STATES.map(state => bodyClass(state.html)));

    expect(STATES).toHaveLength(6);
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
