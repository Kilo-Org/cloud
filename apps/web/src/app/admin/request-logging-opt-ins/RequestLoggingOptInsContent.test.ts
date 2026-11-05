import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import type { createRoot as createReactRoot, Root } from 'react-dom/client';
import type RequestLoggingOptInsContentComponent from './RequestLoggingOptInsContent';

const startTime = new Date('2026-11-02T12:00:00Z').getTime();
const mockOptIns = Array.from({ length: 10 }, (_, index) => ({
  id: `opt-in-${index}`,
  target_type: 'account',
  target_id: `account-${index}`,
  reason: 'Investigate request failures',
  errors_only: false,
  added_by_email: 'admin@example.com',
  added_at: new Date(startTime).toISOString(),
  expires_at: index === 0 ? new Date(startTime + 5_000).toISOString() : null,
}));

jest.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: mockOptIns, isLoading: false }),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
  useMutation: () => ({ isPending: false, mutate: jest.fn() }),
}));
jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    admin: {
      requestLoggingOptIns: {
        list: { queryOptions: () => ({ queryKey: ['opt-ins'] }) },
        create: { mutationOptions: jest.fn() },
        delete: { mutationOptions: jest.fn() },
      },
    },
  }),
}));
jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
jest.mock('@/components/ui/select', () => ({
  Select: () => null,
  SelectContent: () => null,
  SelectItem: () => null,
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

type LinkedomModule = {
  parseHTML: (html: string) => { window: typeof globalThis; document: Document };
};

describe('RequestLoggingOptInsContent expiry', () => {
  let root: Root;
  let container: HTMLElement;
  let cleanup: () => void;
  let Content: typeof RequestLoggingOptInsContentComponent;

  beforeEach(async () => {
    jest.useFakeTimers({ now: startTime });
    const requireFromNext = createRequire(require.resolve('next/package.json'));
    const { window, document } = (requireFromNext('linkedom') as LinkedomModule).parseHTML(
      '<!doctype html><html><body><div id="root"></div></body></html>'
    );
    document.oninput = null;
    const replacements = {
      React,
      window,
      document,
      HTMLElement: window.HTMLElement,
      HTMLInputElement: window.HTMLInputElement,
      HTMLTextAreaElement: window.HTMLTextAreaElement,
      Event: window.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = new Map(
      Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
    );
    Object.assign(globalThis, replacements);
    cleanup = () => {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    };
    const element = document.getElementById('root');
    if (!element) throw new Error('Test root missing');
    container = element;
    const { createRoot }: { createRoot: typeof createReactRoot } = await import('react-dom/client');
    const {
      default: RequestLoggingOptInsContent,
    }: {
      default: typeof RequestLoggingOptInsContentComponent;
    } = await import('./RequestLoggingOptInsContent');
    Content = RequestLoggingOptInsContent;
    root = createRoot(container);
    act(() => root.render(createElement(RequestLoggingOptInsContent)));
  });

  afterEach(() => {
    act(() => root?.unmount());
    cleanup?.();
    jest.useRealTimers();
  });

  it('releases capacity after expiration without user interaction or a query update', () => {
    const targetId = container.querySelector<HTMLInputElement>('#target-id');
    const reason = container.querySelector<HTMLTextAreaElement>('#reason');
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (!targetId || !reason || !submit) throw new Error('Opt-in form missing');
    targetId.type = 'text';

    act(() => {
      for (const [input, value] of [
        [targetId, 'new-account'],
        [reason, 'Investigate request failures'],
      ] as const) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
        if (!setter) throw new Error('Input value setter missing');
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });

    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      '10 of 10 active opt-ins.'
    );
    expect(submit.disabled).toBe(true);

    act(() => jest.advanceTimersByTime(10_000));

    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      '9 of 10 active opt-ins.'
    );
    expect(submit.disabled).toBe(false);
  });

  it('disables logging and warns while more than ten opt-ins are stored', () => {
    mockOptIns.push({
      ...mockOptIns[0],
      id: 'opt-in-extra',
      target_id: 'account-extra',
      expires_at: null,
    });
    try {
      act(() => root.render(createElement(Content)));

      expect(container.textContent).toContain(
        'Request logging is disabled while 11 opt-ins are stored.'
      );
    } finally {
      mockOptIns.pop();
    }
  });

  it('cleans up the refresh timer when unmounted', () => {
    expect(jest.getTimerCount()).toBe(1);
    act(() => root.render(null));
    expect(jest.getTimerCount()).toBe(0);
  });
});
