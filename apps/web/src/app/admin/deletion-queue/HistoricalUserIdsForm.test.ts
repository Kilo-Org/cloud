import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { QueryClient, QueryClientProvider, type UseMutationOptions } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { createRequire } from 'node:module';
import React, { act, createElement, type ComponentProps } from 'react';
import type { createRoot as createReactRoot, Root } from 'react-dom/client';
import type { RootRouter } from '@/routers/root-router';
import type { HistoricalUserIdsForm as HistoricalUserIdsFormComponent } from './HistoricalUserIdsForm';

type HistoricalResults =
  inferRouterOutputs<RootRouter>['admin']['userDeletionQueue']['previewHistoricalUsers'];
type HistoricalInput = { userIds: string[] };
type HistoricalMutationOptions = UseMutationOptions<HistoricalResults, Error, HistoricalInput>;

const mockPreview = jest.fn<(input: HistoricalInput) => Promise<HistoricalResults>>();
const mockSubmit = jest.fn<(input: HistoricalInput) => Promise<HistoricalResults>>();
const mockToast = { success: jest.fn(), error: jest.fn() };

const mockTrpc = {
  admin: {
    userDeletionQueue: {
      previewHistoricalUsers: {
        mutationOptions: (options?: HistoricalMutationOptions) => ({
          ...options,
          mutationFn: mockPreview,
        }),
      },
      submitHistoricalUsers: {
        mutationOptions: (options?: HistoricalMutationOptions) => ({
          ...options,
          mutationFn: mockSubmit,
        }),
      },
    },
  },
};

jest.mock('@/lib/trpc/utils', () => ({ useTRPC: () => mockTrpc }));

jest.mock('sonner', () => ({ toast: mockToast }));

jest.mock('next/link', () => ({
  __esModule: true,
  default: (props: ComponentProps<'a'>) => createElement('a', props),
}));

type LinkedomModule = {
  parseHTML: (
    html: string,
    globals: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'> & { location: URL }
  ) => { window: typeof globalThis; document: Document };
};

function installDom() {
  const requireFromHere = createRequire(__filename);
  const linkedom = requireFromHere('linkedom') as LinkedomModule;
  const { window, document } = linkedom.parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    { setTimeout, clearTimeout, location: new URL('http://localhost/') }
  );
  const container = document.getElementById('root');
  if (!container) throw new Error('React root missing');
  document.oninput = null;
  const globals = {
    React,
    window,
    document,
    HTMLElement: window.HTMLElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
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
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
  );
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  return {
    container,
    cleanup: () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

async function advanceTime(milliseconds: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(milliseconds);
  });
}

async function settle(action: () => void) {
  await act(async () => {
    action();
    await jest.advanceTimersByTimeAsync(0);
  });
}

describe('HistoricalUserIdsForm', () => {
  let dom: ReturnType<typeof installDom>;
  let root: Root;
  let queryClient: QueryClient;
  let createRoot: typeof createReactRoot;
  let HistoricalUserIdsForm: typeof HistoricalUserIdsFormComponent;
  const onSubmitted = jest.fn<() => void>();
  const onSubmittingChange = jest.fn<(submitting: boolean) => void>();

  function renderForm() {
    act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(HistoricalUserIdsForm, { onSubmitted, onSubmittingChange })
        )
      );
    });
  }

  function mountForm() {
    root = createRoot(dom.container);
    renderForm();
  }

  function textarea() {
    const input = dom.container.querySelector('textarea');
    if (!input) throw new Error('User IDs textarea missing');
    return input;
  }

  function editText(value: string) {
    const input = textarea();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setter) throw new Error('Textarea value setter missing');
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function findButton(text: string) {
    return Array.from(dom.container.querySelectorAll('button')).find(
      candidate => candidate.textContent?.trim() === text
    );
  }

  function button(text: string) {
    const found = findButton(text);
    if (!found) throw new Error(`Button missing: ${text}`);
    return found;
  }

  function resultText() {
    return dom.container.querySelector('ul')?.textContent ?? '';
  }

  function errorText() {
    return dom.container.querySelector('#historical-deletion-error')?.textContent ?? '';
  }

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockPreview.mockReset().mockResolvedValue([]);
    mockSubmit.mockReset().mockResolvedValue([]);
    dom = installDom();
    ({ createRoot } = await import('react-dom/client'));
    ({ HistoricalUserIdsForm } = await import('./HistoricalUserIdsForm'));
    queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false, gcTime: Infinity } },
    });
    mountForm();
  });

  afterEach(() => {
    try {
      act(() => root?.unmount());
      queryClient?.clear();
    } finally {
      try {
        dom?.cleanup();
      } finally {
        jest.clearAllTimers();
        jest.useRealTimers();
      }
    }
  });

  it('checks only the latest IDs after 400 ms of inactivity without submitting', async () => {
    const preview = Promise.withResolvers<HistoricalResults>();
    mockPreview.mockReturnValueOnce(preview.promise);
    expect(findButton('Preview user IDs')).toBeUndefined();
    expect(findButton('Retry check')).toBeUndefined();
    expect(button('Confirm ID-only cleanup').disabled).toBe(true);
    await advanceTime(1000);
    expect(mockPreview).not.toHaveBeenCalled();

    editText('obsolete-user');
    await advanceTime(399);
    editText(' oauth/Current \n\noauth/Current\noauth/current ');
    await advanceTime(399);
    expect(mockPreview).not.toHaveBeenCalled();
    expect(button('Confirm ID-only cleanup').disabled).toBe(true);
    await advanceTime(1);
    expect(mockPreview.mock.calls.map(([input]) => input)).toEqual([
      { userIds: ['oauth/Current', 'oauth/current'] },
    ]);
    await advanceTime(1);
    expect(textarea().disabled).toBe(false);
    expect(button('Confirm ID-only cleanup').disabled).toBe(true);
    expect(dom.container.querySelector('[aria-live="polite"]')?.textContent).toContain(
      'Checking user IDs'
    );

    await settle(() =>
      preview.resolve([
        { userId: 'oauth/Current', status: 'eligible' },
        { userId: 'oauth/current', status: 'refused', code: 'user_not_found' },
      ])
    );
    expect(button('Confirm ID-only cleanup').disabled).toBe(false);
    expect(resultText()).toContain('User ID not found.');
    expect(findButton('Retry check')).toBeUndefined();
    await advanceTime(1200);
    expect(mockPreview).toHaveBeenCalledTimes(1);
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(onSubmittingChange).not.toHaveBeenCalled();
  });

  it('cancels cleared input and removes eligibility for empty or invalid edits', async () => {
    editText('abandoned-user');
    await advanceTime(399);
    editText(' \n ');
    await advanceTime(1000);
    expect(mockPreview).not.toHaveBeenCalled();

    mockPreview.mockResolvedValueOnce([{ userId: 'eligible-user', status: 'eligible' }]);
    editText('eligible-user');
    await advanceTime(401);
    expect(button('Confirm ID-only cleanup').disabled).toBe(false);

    for (const [text, message] of [
      [
        Array.from({ length: 101 }, (_, index) => `user-${index}`).join('\n'),
        'Paste no more than 100 unique user IDs at a time.',
      ],
      ['x'.repeat(1025), 'Each user ID must be at most 1,024 characters.'],
      ['', ''],
    ]) {
      editText(text);
      expect(resultText()).toBe('');
      expect(button('Confirm ID-only cleanup').disabled).toBe(true);
      expect(errorText()).toBe(message);
      expect(textarea().getAttribute('aria-invalid')).toBe(String(Boolean(message)));
      expect(findButton('Retry check')).toBeUndefined();
      await advanceTime(1000);
    }
    expect(mockPreview).toHaveBeenCalledTimes(1);

    mockPreview.mockRejectedValueOnce(new Error('Previous check failed'));
    editText('failed-check');
    await advanceTime(401);
    expect(errorText()).toBe('Previous check failed');
    editText('');
    expect(errorText()).toBe('');
    expect(findButton('Retry check')).toBeUndefined();
    await advanceTime(1000);
    expect(mockPreview).toHaveBeenCalledTimes(2);
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it.each(['success', 'error'] as const)(
    'ignores stale preview %s during debounce and after newer results',
    async outcome => {
      const first = Promise.withResolvers<HistoricalResults>();
      const second = Promise.withResolvers<HistoricalResults>();
      const current = Promise.withResolvers<HistoricalResults>();
      mockPreview
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
        .mockReturnValueOnce(current.promise);
      editText('first-user');
      await advanceTime(401);
      expect(textarea().disabled).toBe(false);
      editText('second-user');
      await settle(() => {
        if (outcome === 'success') first.resolve([{ userId: 'first-user', status: 'eligible' }]);
        else first.reject(new Error('First preview failed'));
      });
      expect(resultText()).toBe('');
      expect(errorText()).toBe('');
      expect(button('Confirm ID-only cleanup').disabled).toBe(true);
      expect(findButton('Retry check')).toBeUndefined();
      expect(mockPreview).toHaveBeenCalledTimes(1);

      await advanceTime(401);
      editText('current-user');
      await advanceTime(401);
      await settle(() => current.resolve([{ userId: 'current-user', status: 'eligible' }]));
      await settle(() => {
        if (outcome === 'success') second.resolve([{ userId: 'second-user', status: 'eligible' }]);
        else second.reject(new Error('Second preview failed'));
      });
      expect(mockPreview.mock.calls.map(([input]) => input.userIds)).toEqual([
        ['first-user'],
        ['second-user'],
        ['current-user'],
      ]);
      expect(resultText()).toContain('current-user');
      expect(resultText()).not.toContain('first-user');
      expect(resultText()).not.toContain('second-user');
      expect(errorText()).toBe('');
      expect(findButton('Retry check')).toBeUndefined();
      expect(button('Confirm ID-only cleanup').disabled).toBe(false);
      expect(mockSubmit).not.toHaveBeenCalled();
      expect(mockToast.error).not.toHaveBeenCalled();
    }
  );

  it('cancels its debounce on unmount and ignores in-flight success and error', async () => {
    editText('never-checked');
    await advanceTime(399);
    act(() => root.unmount());
    await advanceTime(1000);
    expect(mockPreview).not.toHaveBeenCalled();

    mountForm();
    const first = Promise.withResolvers<HistoricalResults>();
    const second = Promise.withResolvers<HistoricalResults>();
    mockPreview.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    editText('first-user');
    await advanceTime(401);
    editText('second-user');
    await advanceTime(401);
    act(() => root.unmount());
    await settle(() => {
      first.resolve([{ userId: 'first-user', status: 'eligible' }]);
      second.reject(new Error('Unmounted preview failed'));
    });
    await advanceTime(1000);
    expect(dom.container.textContent).toBe('');
    expect(mockPreview).toHaveBeenCalledTimes(2);
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(onSubmittingChange).not.toHaveBeenCalled();
    expect(mockToast.error).not.toHaveBeenCalled();

    mountForm();
    expect(textarea().value).toBe('');
    expect(resultText()).toBe('');
    expect(errorText()).toBe('');
    expect(button('Confirm ID-only cleanup').disabled).toBe(true);
  });

  it('retries a preview error for unchanged IDs using the same debounce', async () => {
    const retry = Promise.withResolvers<HistoricalResults>();
    mockPreview
      .mockRejectedValueOnce(new Error('Preview temporarily unavailable'))
      .mockReturnValueOnce(retry.promise);
    editText('retry-user');
    await advanceTime(401);
    expect(errorText()).toBe('Preview temporarily unavailable');
    expect(textarea().getAttribute('aria-describedby')).toContain('historical-deletion-error');
    expect(
      textarea().parentElement?.contains(dom.container.querySelector('#historical-deletion-error'))
    ).toBe(true);
    expect(button('Confirm ID-only cleanup').disabled).toBe(true);
    expect(findButton('Preview user IDs')).toBeUndefined();

    act(() => button('Retry check').click());
    expect(errorText()).toBe('');
    expect(resultText()).toBe('');
    expect(textarea().value).toBe('retry-user');
    expect(findButton('Retry check')).toBeUndefined();
    await advanceTime(399);
    expect(mockPreview).toHaveBeenCalledTimes(1);
    await advanceTime(1);
    expect(mockPreview.mock.calls.map(([input]) => input)).toEqual([
      { userIds: ['retry-user'] },
      { userIds: ['retry-user'] },
    ]);
    expect(button('Confirm ID-only cleanup').disabled).toBe(true);
    await settle(() => retry.resolve([{ userId: 'retry-user', status: 'eligible' }]));
    expect(errorText()).toBe('');
    expect(button('Confirm ID-only cleanup').disabled).toBe(false);
    expect(findButton('Retry check')).toBeUndefined();
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('requires a debounced recheck and fresh confirmation after a submit error', async () => {
    mockPreview.mockResolvedValue([{ userId: 'retry-user', status: 'eligible' }]);
    mockSubmit.mockRejectedValueOnce(new Error('Queue temporarily unavailable'));
    editText('retry-user');
    await advanceTime(401);
    act(() => button('Confirm ID-only cleanup').click());
    await advanceTime(0);
    expect(errorText()).toBe('Queue temporarily unavailable');
    expect(resultText()).toBe('');
    expect(textarea().disabled).toBe(false);
    expect(button('Confirm ID-only cleanup').disabled).toBe(true);
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(onSubmittingChange.mock.calls).toEqual([[true], [false]]);

    act(() => button('Retry check').click());
    expect(errorText()).toBe('');
    expect(button('Confirm ID-only cleanup').disabled).toBe(true);
    await advanceTime(399);
    expect(mockPreview).toHaveBeenCalledTimes(1);
    await advanceTime(2);
    expect(mockPreview.mock.calls.map(([input]) => input.userIds)).toEqual([
      ['retry-user'],
      ['retry-user'],
    ]);
    expect(button('Confirm ID-only cleanup').disabled).toBe(false);
    expect(findButton('Retry check')).toBeUndefined();
    expect(mockSubmit).toHaveBeenCalledTimes(1);
  });

  it('offers rechecks for per-ID failures in both preview and queue outcomes', async () => {
    mockPreview
      .mockResolvedValueOnce([{ userId: 'failed-user', status: 'failed' }])
      .mockResolvedValueOnce([{ userId: 'failed-user', status: 'eligible' }])
      .mockResolvedValueOnce([{ userId: 'failed-user', status: 'eligible' }]);
    mockSubmit.mockResolvedValueOnce([{ userId: 'failed-user', status: 'failed' }]);
    editText('failed-user');
    await advanceTime(401);
    expect(resultText()).toContain('Could not confirm the result.');
    expect(button('Confirm ID-only cleanup').disabled).toBe(true);
    act(() => button('Retry check').click());
    expect(resultText()).toBe('');
    await advanceTime(399);
    expect(mockPreview).toHaveBeenCalledTimes(1);
    await advanceTime(2);
    expect(findButton('Retry check')).toBeUndefined();
    expect(button('Confirm ID-only cleanup').disabled).toBe(false);
    expect(mockSubmit).not.toHaveBeenCalled();

    act(() => button('Confirm ID-only cleanup').click());
    await advanceTime(0);
    expect(dom.container.textContent).toContain('Queue results');
    expect(resultText()).toContain('Could not confirm the result.');
    act(() => button('Retry check').click());
    expect(resultText()).toBe('');
    expect(dom.container.textContent).not.toContain('Queue results');
    expect(button('Confirm ID-only cleanup').disabled).toBe(true);
    await advanceTime(399);
    expect(mockPreview).toHaveBeenCalledTimes(2);
    await advanceTime(2);
    expect(mockPreview.mock.calls.map(([input]) => input.userIds)).toEqual([
      ['failed-user'],
      ['failed-user'],
      ['failed-user'],
    ]);
    expect(button('Confirm ID-only cleanup').disabled).toBe(false);
    expect(findButton('Retry check')).toBeUndefined();
    expect(mockSubmit).toHaveBeenCalledTimes(1);
  });

  it.each([
    { userId: 'changed-user', status: 'refused', code: 'live_subscription' },
    { userId: 'changed-user', status: 'failed' },
  ] satisfies HistoricalResults)(
    'reports $status submission outcomes as queue errors',
    async outcome => {
      mockPreview.mockResolvedValueOnce([
        { userId: 'eligible-user', status: 'eligible' },
        { userId: 'changed-user', status: 'eligible' },
      ]);
      mockSubmit.mockResolvedValueOnce([
        {
          userId: 'eligible-user',
          status: 'enqueued',
          requestId: '00000000-0000-4000-8000-000000000001',
        },
        outcome,
      ]);
      editText('eligible-user\nchanged-user');
      await advanceTime(401);
      act(() => button('Confirm ID-only cleanup').click());
      await advanceTime(0);
      expect(dom.container.textContent).toContain('Queue results');
      expect(resultText()).toContain('Queued');
      expect(mockToast.error).toHaveBeenCalledWith(
        'Some users could not be queued. Review the results.'
      );
      expect(mockToast.success).not.toHaveBeenCalled();
    }
  );

  it('submits only confirmed eligible IDs and preserves merged queue results across rerenders', async () => {
    const submission = Promise.withResolvers<HistoricalResults>();
    const requestId = '00000000-0000-4000-8000-000000000001';
    mockPreview.mockResolvedValueOnce([
      { userId: 'eligible-user', status: 'eligible' },
      { userId: 'refused-user', status: 'refused', code: 'not_canonical_soft_deleted_user' },
    ]);
    mockSubmit.mockReturnValueOnce(submission.promise);
    editText('eligible-user\nrefused-user');
    await advanceTime(401);
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(findButton('Retry check')).toBeUndefined();
    act(() => button('Confirm ID-only cleanup').click());
    await advanceTime(0);
    expect(mockSubmit.mock.calls.map(([input]) => input)).toEqual([{ userIds: ['eligible-user'] }]);
    expect(textarea().disabled).toBe(true);
    expect(button('Queueing…').disabled).toBe(true);
    expect(onSubmittingChange.mock.calls).toEqual([[true]]);
    expect(onSubmitted).not.toHaveBeenCalled();
    act(() => button('Queueing…').click());
    renderForm();
    await advanceTime(1200);
    expect(mockSubmit).toHaveBeenCalledTimes(1);
    expect(mockPreview).toHaveBeenCalledTimes(1);

    await settle(() =>
      submission.resolve([{ userId: 'eligible-user', status: 'enqueued', requestId }])
    );
    expect(dom.container.textContent).toContain('Queue results');
    expect(resultText()).toContain('eligible-user');
    expect(resultText()).toContain('Queued');
    expect(resultText()).toContain('refused-user');
    expect(resultText()).toContain('This is not a recognized soft-deleted account.');
    expect(dom.container.querySelector('a')?.getAttribute('href')).toBe(
      `/admin/deletion-queue/${requestId}`
    );
    expect(textarea().disabled).toBe(false);
    expect(button('Confirm ID-only cleanup').disabled).toBe(true);
    expect(findButton('Retry check')).toBeUndefined();
    expect(onSubmitted).toHaveBeenCalledTimes(1);
    expect(onSubmittingChange.mock.calls).toEqual([[true], [false]]);
    expect(mockToast.success).toHaveBeenCalledWith(
      '1 requests queued. No notifications will be sent.'
    );
    expect(mockToast.error).not.toHaveBeenCalled();

    const queuedResults = resultText();
    renderForm();
    await advanceTime(1200);
    expect(dom.container.textContent).toContain('Queue results');
    expect(resultText()).toBe(queuedResults);
    expect(button('Confirm ID-only cleanup').disabled).toBe(true);
    expect(mockPreview).toHaveBeenCalledTimes(1);
    expect(mockSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmitted).toHaveBeenCalledTimes(1);
  });
});
