// The client hooks and the dialog primitives are stubbed before the component
// module is loaded: @swc/jest emits the static imports first, so every render
// goes through the fresh-module helper below.
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => children,
  DialogContent: ({ children }: { children: ReactNode }) => children,
  DialogHeader: ({ children }: { children: ReactNode }) => children,
  DialogTitle: ({ children }: { children: ReactNode }) => children,
  DialogDescription: ({ children }: { children: ReactNode }) => children,
  DialogFooter: ({ children }: { children: ReactNode }) => children,
}));

import { describe, expect, it, jest } from '@jest/globals';
import type { ReactNode } from 'react';
import type { OpenAiChatGptStatus } from '@/lib/ai-gateway/openai-chatgpt/status';
import { CHATGPT_USAGE_SETTINGS_URL } from '@/lib/ai-gateway/openai-chatgpt/usage-limit';
import {
  canManageSharedServices,
  type ChatGptSharedServicesCardViewProps,
} from './ChatGptSharedServicesCard';

const CARD_TITLE = 'OpenAI (ChatGPT) for shared services';
const CONNECT_LABEL = 'Connect an OpenAI account';
const USAGE_LINK_SUMMARY = 'View and manage your ChatGPT usage';
const CONNECTED_AT = '2026-09-16T00:00:00.000Z';

async function render(props: ChatGptSharedServicesCardViewProps): Promise<string> {
  jest.resetModules();
  const [card, react, server] = await Promise.all([
    import('./ChatGptSharedServicesCard'),
    import('react'),
    import('react-dom/server'),
  ]);
  return server.renderToStaticMarkup(react.createElement(card.ChatGptSharedServicesCardView, props));
}

function connectedStatus(overrides: Partial<OpenAiChatGptStatus> = {}): OpenAiChatGptStatus {
  return {
    state: 'connected',
    email: 'shared@example.com',
    subject: 'subject-1',
    connectedAt: CONNECTED_AT,
    ...overrides,
  } as OpenAiChatGptStatus;
}

describe('ChatGptSharedServicesCardView', () => {
  it('offers the connect action while no account is connected', async () => {
    const html = await render({ status: { state: 'disconnected' } });

    expect(html).toContain(CARD_TITLE);
    expect(html).toContain(CONNECT_LABEL);
    expect(html).toContain('Kilo shared services use it');
    expect(html).not.toContain(USAGE_LINK_SUMMARY);
  });

  it('names the connected account, its scope, the usage link and a disconnect action', async () => {
    const html = await render({ status: connectedStatus() });

    expect(html).toContain('Connected as shared@example.com');
    expect(html).toContain('It is not your own connection.');
    expect(html).toContain(USAGE_LINK_SUMMARY);
    expect(html).toContain(CHATGPT_USAGE_SETTINGS_URL);
    expect(html).toContain('Disconnect');
    expect(html).not.toContain(CONNECT_LABEL);
  });

  it('offers reconnect and disconnect for a failed connection', async () => {
    const html = await render({
      status: {
        state: 'error',
        errorMessage: 'Your ChatGPT connection has expired. Reconnect to continue.',
      },
    });

    expect(html).toContain('Your ChatGPT connection has expired. Reconnect to continue.');
    expect(html).toContain('Reconnect');
    expect(html).toContain('Disconnect');
  });

  it('shows the usage-limit message for a current plan limit', async () => {
    const html = await render({
      status: connectedStatus({
        usageLimit: { reachedAt: '2026-09-16T13:00:00.000Z', resetsAt: null },
      }),
    });

    expect(html).toContain('ChatGPT usage limit reached');
    expect(html).toContain('Review your usage settings in ChatGPT.');
    expect(html).toContain('Buy Kilo credits instead');
  });

  it('hides the usage-limit message once it is dismissed', async () => {
    const html = await render({
      status: connectedStatus({
        usageLimit: { reachedAt: '2026-09-16T13:00:00.000Z', resetsAt: null },
      }),
      isUsageLimitDismissed: true,
    });

    expect(html).not.toContain('ChatGPT usage limit reached');
  });

  it('reports a load failure with a retry', async () => {
    const html = await render({ status: undefined, hasLoadError: true });

    // The apostrophe is HTML-escaped in the markup, so the stable part is asserted.
    expect(html).toContain('load the shared services connection. Try again.');
    expect(html).toContain('Try again');
  });
});

describe('canManageSharedServices', () => {
  it('is true only for an owner or an admin', () => {
    expect(canManageSharedServices('owner')).toBe(true);
    expect(canManageSharedServices('admin')).toBe(true);
    expect(canManageSharedServices('member')).toBe(false);
    expect(canManageSharedServices('billing_manager')).toBe(false);
    expect(canManageSharedServices(undefined)).toBe(false);
  });
});
