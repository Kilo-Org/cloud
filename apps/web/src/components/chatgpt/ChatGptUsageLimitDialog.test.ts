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

import { createRequire } from 'node:module';
import { act, createElement, type ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
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

describe('Business usage-limit copying', () => {
  const adminRequest = `I've reached the limit for using my ChatGPT plan in Kilo. Could you increase our workspace's usage limits so I can continue?

Go to admin.openai.com → Workspace → Usage limits.
Thank you!`;
  let container: HTMLElement;
  let root: Root;
  let cleanup: () => void;
  const writeText = jest.fn<Promise<void>, [string]>();

  beforeEach(async () => {
    const requireFromNext = createRequire(createRequire(__filename).resolve('next/package.json'));
    const linkedom = requireFromNext('linkedom') as {
      parseHTML: (html: string) => { window: Record<string, unknown>; document: Document };
    };
    const { window, document } = linkedom.parseHTML(
      '<!doctype html><html><body><div id="root"></div></body></html>'
    );
    Object.defineProperty(document, 'oninput', { configurable: true, value: null });
    // Linkedom does not reflect textarea defaultValue into its text content.
    Object.defineProperty(
      Object.getPrototypeOf(document.createElement('textarea')),
      'defaultValue',
      {
        configurable: true,
        get(this: HTMLTextAreaElement) {
          return this.textContent ?? '';
        },
        set(this: HTMLTextAreaElement, value: string) {
          this.textContent = value;
        },
      }
    );
    const values = {
      window,
      document,
      HTMLElement: window.HTMLElement,
      Element: window.Element,
      Node: window.Node,
      Event: window.Event,
      navigator: { userAgent: 'linkedom', clipboard: { writeText } },
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = Object.keys(values).map(
      name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const
    );
    for (const [name, value] of Object.entries(values)) {
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    cleanup = () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    };
    const element = document.getElementById('root');
    if (!element) throw new Error('Dialog test root missing');
    container = element;
    writeText.mockReset().mockResolvedValue(undefined);
    // React must detect the installed DOM before it selects its input-event implementation.
    const { createRoot } = await import('react-dom/client');
    root = createRoot(container);
    act(() => {
      root.render(
        createElement(ChatGptUsageLimitContent, { code: CHATGPT_BUSINESS_USAGE_LIMIT_CODE })
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    cleanup();
  });

  async function copyRequest() {
    const button = container.querySelector('button');
    if (!button) throw new Error('Copy request action missing');
    expect(button.textContent).toBe('Copy request for admin');
    await act(async () => button.click());
  }

  it('copies the prescribed request and confirms success', async () => {
    expect(container.textContent).toContain("You've reached your workspace's limit");
    expect(container.textContent).toContain('ask your workspace admin for increased usage limits');

    await copyRequest();

    expect(writeText).toHaveBeenCalledWith(adminRequest);
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Request copied');
    expect(container.querySelector('textarea')).toBeNull();
  });

  it.each(['denied', 'unavailable'])(
    'offers a selectable request when clipboard access is %s and removes it after a successful retry',
    async failure => {
      if (failure === 'denied') writeText.mockRejectedValueOnce(new Error('Clipboard denied'));
      else Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });

      await copyRequest();

      expect(container.querySelector('[role="status"]')?.textContent).toContain('Could not copy');
      const fallback = container.querySelector('textarea');
      if (!fallback) throw new Error('Manual request field missing');
      expect(fallback.getAttribute('aria-label')).toBe('Request for workspace admin');
      expect(fallback.getAttributeNames().map(name => name.toLowerCase())).toContain('readonly');
      expect(fallback.value).toBe(adminRequest);
      const select = jest.fn();
      fallback.select = select;
      act(() => {
        fallback.dispatchEvent(new Event('focusin', { bubbles: true }));
      });
      expect(select).toHaveBeenCalledTimes(1);

      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
      });
      await copyRequest();

      expect(writeText).toHaveBeenLastCalledWith(adminRequest);
      expect(container.querySelector('[role="status"]')?.textContent).toContain('Request copied');
      expect(container.querySelector('textarea')).toBeNull();
    }
  );
});
