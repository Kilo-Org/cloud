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
import {
  BUY_CREDITS_LABEL,
  ChatGptUsageLimitContent,
  MANAGE_USAGE_LABEL,
  USAGE_LIMIT_DESCRIPTION,
  USAGE_LIMIT_TITLE,
} from './ChatGptUsageLimitDialog';
import { CHATGPT_USAGE_SETTINGS_URL } from '@/lib/ai-gateway/openai-chatgpt/usage-limit';

function render(): string {
  return renderToStaticMarkup(createElement(ChatGptUsageLimitContent));
}

describe('ChatGptUsageLimitContent', () => {
  it('renders the guideline copy exactly', () => {
    const html = render();

    expect(html).toContain(USAGE_LIMIT_TITLE);
    expect(html).toContain(USAGE_LIMIT_DESCRIPTION);
    expect(html).toContain(MANAGE_USAGE_LABEL);
    expect(html).toContain(BUY_CREDITS_LABEL);
  });

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
});
