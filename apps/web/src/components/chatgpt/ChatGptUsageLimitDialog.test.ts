// The dialog primitives are stubbed so the content renders as plain markup:
// Radix portals its content, which no server renderer emits.
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
import { describe, expect, it } from '@jest/globals';
import { ChatGptUsageLimitContent, MANAGE_USAGE_LABEL } from './ChatGptUsageLimitDialog';
import {
  CHATGPT_BUSINESS_USAGE_LIMIT_CODE,
  CHATGPT_USAGE_SETTINGS_URL,
} from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/usage-limit';

function render(code: string | null = null): string {
  return renderToStaticMarkup(createElement(ChatGptUsageLimitContent, { code }));
}

describe('ChatGptUsageLimitContent', () => {
  it('opens the ChatGPT usage settings as the primary action', () => {
    const html = render();
    const manageUsage = html.slice(html.lastIndexOf('<a', html.indexOf(MANAGE_USAGE_LABEL)));

    expect(manageUsage).toContain(`href="${CHATGPT_USAGE_SETTINGS_URL}"`);
    expect(manageUsage).toContain('target="_blank"');
    expect(manageUsage).toContain('rel="noreferrer noopener"');
  });

  it('offers Kilo credits as the secondary action', () => {
    expect(render()).toContain('href="/credits"');
  });

  it('does not offer personal settings or credit purchases for a workspace limit', () => {
    const html = render(CHATGPT_BUSINESS_USAGE_LIMIT_CODE);
    expect(html).not.toContain(`href="${CHATGPT_USAGE_SETTINGS_URL}"`);
    expect(html).not.toContain('href="/credits"');
  });
});
