import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot, type Root } from 'react-dom/client';
import type { useInvokeWebhookTrigger as UseInvokeWebhookTrigger } from './useWebhookTriggers';

const mutationFn = jest.fn();
const mutationOptions = jest.fn((options: Record<string, unknown>) => ({ ...options, mutationFn }));
const queryKey = jest.fn((input: unknown) => ['webhookTriggers', 'listRequests', input]);

jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({ webhookTriggers: { invoke: { mutationOptions }, listRequests: { queryKey } } }),
}));
jest.mock('sonner', () => ({ toast: { error: jest.fn(), success: jest.fn() } }));

type LinkedomModule = {
  parseHTML: (html: string) => { window: Record<string, unknown>; document: Document };
};

function installDom() {
  const requireFromHere = createRequire(__filename);
  const requireFromNext = createRequire(requireFromHere.resolve('next/package.json'));
  const parsed = (requireFromNext('linkedom') as LinkedomModule).parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>'
  );
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  const previous = new Map<string, unknown>();
  for (const name of [
    'React',
    'window',
    'document',
    'HTMLElement',
    'Element',
    'Node',
    'IS_REACT_ACT_ENVIRONMENT',
  ]) {
    previous.set(name, globals[name]);
  }
  Object.assign(globals, {
    React,
    window: parsed.window,
    document: parsed.document,
    HTMLElement: (parsed.window as { HTMLElement: typeof HTMLElement }).HTMLElement,
    Element: (parsed.window as { Element: typeof Element }).Element,
    Node: (parsed.window as { Node: typeof Node }).Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = parsed.document.getElementById('root');
  if (!container) throw new Error('linkedom root missing');
  return {
    container: container as HTMLElement,
    cleanup: () => previous.forEach((value, name) => (globals[name] = value)),
  };
}

let useInvokeWebhookTrigger!: typeof UseInvokeWebhookTrigger;

beforeAll(async () => {
  ({ useInvokeWebhookTrigger } = await import('./useWebhookTriggers'));
});

describe('useInvokeWebhookTrigger', () => {
  let root: Root | undefined;
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    cleanup?.();
    cleanup = undefined;
    mutationFn.mockReset();
    mutationOptions.mockClear();
    queryKey.mockClear();
  });

  it('suppresses immediate repeats and resets after an error while invalidating every request-list limit', async () => {
    let rejectInvocation: (error: Error) => void = () => undefined;
    mutationFn.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectInvocation = reject;
        })
    );
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const invalidateQueries = jest.spyOn(queryClient, 'invalidateQueries');
    const dom = installDom();
    cleanup = dom.cleanup;
    root = createRoot(dom.container);

    function Harness() {
      const { invokeTrigger, isInvoking, invokingTriggerId } = useInvokeWebhookTrigger(
        '00000000-0000-4000-8000-000000000001'
      );
      return createElement(
        'button',
        { onClick: () => void invokeTrigger('saved-trigger-id').catch(() => undefined) },
        `${isInvoking}:${invokingTriggerId ?? ''}`
      );
    }

    act(() =>
      root?.render(
        createElement(QueryClientProvider, { client: queryClient }, createElement(Harness))
      )
    );
    const button = dom.container.querySelector('button');
    if (!button) throw new Error('invoke button missing');
    await act(async () => {
      button.click();
      button.click();
      await Promise.resolve();
    });
    expect(mutationFn).toHaveBeenCalledTimes(1);
    expect(mutationFn.mock.calls[0]?.[0]).toEqual({
      triggerId: 'saved-trigger-id',
      organizationId: '00000000-0000-4000-8000-000000000001',
    });
    expect(queryClient.getMutationCache().getAll()[0]?.options.retry).toBe(false);

    await act(async () => rejectInvocation(new Error('failed')));
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: [
        'webhookTriggers',
        'listRequests',
        { triggerId: 'saved-trigger-id', organizationId: '00000000-0000-4000-8000-000000000001' },
      ],
    });

    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(mutationFn).toHaveBeenCalledTimes(2);
  });
});
