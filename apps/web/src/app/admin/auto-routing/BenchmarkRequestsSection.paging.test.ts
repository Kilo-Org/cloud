/**
 * Interactive paging tests. The section's controls are stateful (TanStack infinite queries
 * driven by real clicks), so static markup cannot exercise them.
 *
 * Install the test DOM before loading the renderer. Import the component through Jest's
 * module registry so it uses the mocked transport.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import type { BenchmarkRun, PaidBenchmarkAdminRequest } from '@kilocode/auto-routing-contracts';

type LinkedomModule = {
  parseHTML: (html: string) => { window: typeof globalThis; document: Document };
};

const requireFromHere = createRequire(__filename);
const requireFromNext = createRequire(requireFromHere.resolve('next/package.json'));

/** Installed once for the whole file, at module scope, before any renderer import. */
function installDom() {
  const { window, document } = (requireFromNext('linkedom') as LinkedomModule).parseHTML(
    '<html><body><div id="root"></div></body></html>'
  );
  const globals = globalThis as unknown as Record<string, unknown>;
  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.assign(globals, {
    window,
    document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    DocumentFragment: (window as unknown as { DocumentFragment: unknown }).DocumentFragment,
    Event: window.Event,
    ResizeObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing test root');
  return { container: container as HTMLElement, window };
}

const dom = installDom();

jest.mock('sonner', () => ({ toast: { success: () => {}, info: () => {}, error: () => {} } }));

// The component's only network boundary. Mocking it here keeps the tests about paging
// behaviour instead of global fetch plumbing, and the mock answers in a microtask.
const mockAdminFetch = jest.fn<(url: string, init?: RequestInit) => Promise<Response>>();
jest.mock('@/lib/admin/admin-fetch', () => ({
  adminFetch: (url: string, init?: RequestInit) => mockAdminFetch(url, init),
}));

// Radix select mounts a portal linkedom cannot host; the filter is not under test.
jest.mock('@/components/ui/select', () => {
  const container = ({ children }: { children?: React.ReactNode }) =>
    createElement('div', null, children);
  return {
    Select: container,
    SelectTrigger: container,
    SelectContent: container,
    SelectItem: container,
    SelectValue: () => null,
  };
});

type RenderRoot = {
  render: (node: React.ReactNode) => void;
  unmount: () => void;
};

/**
 * Loaded inside each test, through jest's registry so the mocks above apply, and after the
 * module-scope DOM exists because react-dom/client reads `window` at load.
 */
async function loadModules() {
  const [reactDom, reactQuery, confirm, section] = await Promise.all([
    import('react-dom/client'),
    import('@tanstack/react-query'),
    import('@/components/ui/confirm'),
    import('./BenchmarkRequestsSection'),
  ]);
  return {
    createRoot: reactDom.createRoot,
    QueryClient: reactQuery.QueryClient,
    QueryClientProvider: reactQuery.QueryClientProvider,
    ConfirmProvider: confirm.ConfirmProvider,
    BenchmarkRequestsSection: section.BenchmarkRequestsSection,
    RequestDetail: section.RequestDetail,
  };
}

const now = '2026-11-20T13:00:00.000Z';

/** One request in the shape the list renders; only the id matters to the paging tests. */
function request(overrides: Partial<PaidBenchmarkAdminRequest> = {}): PaidBenchmarkAdminRequest {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    router: 'efficient',
    routerId: '22222222-2222-4222-8222-222222222222',
    organizationId: null,
    requester: {
      kind: 'user',
      ownerId: 'user-1',
      actorUserId: 'user-1',
      ownerLabel: 'a@example.com',
    },
    status: 'active',
    createdAt: now,
    activatedAt: now,
    pausedAt: null,
    completedAt: null,
    estimateMicrodollars: 1_100_000,
    maximumMicrodollars: 1_300_000,
    chargedMicrodollars: 420_000,
    billedModelRequests: 9,
    kiloCoveredModelRequests: 0,
    kiloCoveredMicrodollars: 0,
    pauseReason: null,
    counts: { queued: 0, running: 1, reused: 0, done: 2, failed: 0, paused: 0 },
    payers: [
      {
        kind: 'user',
        ownerId: 'user-1',
        billedModelRequests: 9,
        chargedMicrodollars: 420_000,
        detachReason: null,
        ownerLabel: 'a@example.com',
      },
    ],
    poolName: 'Pool',
    failureReason: null,
    failureRetryable: false,
    ...overrides,
  };
}

/** A real uuid per synthetic row: the component parses responses with the shared schema. */
function uuidFor(label: string): string {
  const hex = label.charCodeAt(0).toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

function requestPage(labels: readonly string[], nextCursor: string | null) {
  return { requests: labels.map(label => request({ id: uuidFor(label) })), nextCursor };
}

/** Render one element under a real query client and return the root plus a click helper. */
async function renderInteractive(
  element: React.ReactElement,
  modules: Awaited<ReturnType<typeof loadModules>>,
  seed?: { pages: unknown[]; pageParams: unknown[] }
) {
  const { createRoot, QueryClient, QueryClientProvider, ConfirmProvider } = modules;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  if (seed) {
    // Pre-seed the infinite query so the first paint already shows real rows: paging is what
    // these tests exercise, not the mount-time fetch.
    client.setQueryData(
      ['auto-routing', 'benchmark-requests', 'efficient', 'all'],
      { pages: seed.pages, pageParams: seed.pageParams },
      { updatedAt: Date.now() }
    );
  }
  const root = createRoot(dom.container);
  await act(async () => {
    root.render(
      createElement(QueryClientProvider, { client }, createElement(ConfirmProvider, null, element))
    );
    await Promise.resolve();
  });
  const click = async (label: string, count = 1) => {
    const button = [...dom.container.querySelectorAll('button')].find(
      candidate => candidate.getAttribute('aria-label') === label
    );
    if (!button) throw new Error(`no button labelled ${label}`);
    await act(async () => {
      for (let i = 0; i < count; i += 1) {
        button.dispatchEvent(new (dom.window.Event as typeof Event)('click', { bubbles: true }));
      }
      await Promise.resolve();
      await Promise.resolve();
    });
    return button;
  };
  return { client, root, click };
}

/**
 * The request ids currently rendered, in order. Each row's Pause control names its request,
 * so this reads the visible order without depending on copy.
 */
function renderedRowIds(): string[] {
  // Desktop table only: the narrow layout renders the same requests again as cards, so an
  // unscoped query would count each row twice.
  return [...dom.container.querySelectorAll('tbody button')]
    .map(button => button.getAttribute('aria-label') ?? '')
    .map(label => /^Pause request (.+)$/.exec(label)?.[1])
    .filter((id): id is string => id !== undefined);
}

/**
 * Waits for any rendered condition. React Query settles its mutations off the act queue, so
 * every assertion about post-click state must poll rather than read the first snapshot.
 */
async function waitFor(
  predicate: () => boolean,
  describeCondition: string,
  timeoutMs = 3_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) {
      throw new Error(
        `${describeCondition} not met; rendered: ${(dom.container.textContent ?? '').slice(0, 300)}`
      );
    }
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
    });
  }
}

function renderedAlertText(): string {
  return [...dom.container.querySelectorAll('[role="alert"]')]
    .map(node => node.textContent ?? '')
    .join(' ');
}

function renderedButtonLabels(): string[] {
  return [...dom.container.querySelectorAll('button')]
    .map(button => button.getAttribute('aria-label') ?? '')
    .filter(label => label.length > 0);
}

async function waitForRows(
  predicate: (rows: string[]) => boolean,
  timeoutMs = 3_000
): Promise<string[]> {
  await waitFor(() => predicate(renderedRowIds()), 'rows condition', timeoutMs);
  return renderedRowIds();
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('request list paging through the real control', () => {
  const SECTION_PROPS = {
    router: 'efficient' as const,
    runs: [] as BenchmarkRun[],
    runningRunIds: [] as string[],
  };

  it('admits one page fetch on a double click and appends its unique rows in order', async () => {
    let root: RenderRoot | undefined;
    mockAdminFetch.mockImplementation(async url => {
      if (url.includes('cursor=cursor-2')) {
        // The server repeats 'b' on the second page; a correct reader keeps one copy.
        return jsonResponse(requestPage(['a', 'b'], null));
      }
      return jsonResponse(requestPage(['c', 'b'], 'cursor-2'));
    });
    try {
      const modules = await loadModules();
      const rendered = await renderInteractive(
        createElement(modules.BenchmarkRequestsSection, SECTION_PROPS),
        modules,
        { pages: [requestPage(['c', 'b'], 'cursor-2')], pageParams: [null] }
      );
      root = rendered.root;
      const rowIdsNow = () => renderedRowIds();
      expect(rowIdsNow()).toEqual([uuidFor('c'), uuidFor('b')]);

      await rendered.click('Load more benchmark requests', 2);

      // Each row's own control names its request id, so this reads the rendered order and
      // proves 'b' (present on both pages) appears exactly once.
      await waitForRows(rows => rows.length === 3);
      expect(rowIdsNow()).toEqual([uuidFor('c'), uuidFor('b'), uuidFor('a')]);
      expect(rendered.client.getQueryCache().getAll()).toHaveLength(1);
      expect(
        mockAdminFetch.mock.calls.filter(([url]) => url.includes('cursor=cursor-2'))
      ).toHaveLength(1);
      // The cursor is exhausted, so the control is gone.
      expect(dom.container.textContent ?? '').not.toContain('Load older requests');
    } finally {
      if (root) act(() => root?.unmount());
    }
  });

  it('keeps loaded rows when page 2 fails, then loads it on retry', async () => {
    let root: RenderRoot | undefined;
    let failNextPage = true;
    mockAdminFetch.mockImplementation(async url => {
      if (url.includes('cursor=cursor-2')) {
        if (failNextPage) {
          failNextPage = false;
          // A transient failure: the operator keeps what they were reading.
          return new Response(JSON.stringify({ error: 'D1 timed out' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          });
        }
        return jsonResponse(requestPage(['a'], null));
      }
      return jsonResponse(requestPage(['c', 'b'], 'cursor-2'));
    });
    try {
      const modules = await loadModules();
      const rendered = await renderInteractive(
        createElement(modules.BenchmarkRequestsSection, SECTION_PROPS),
        modules,
        { pages: [requestPage(['c', 'b'], 'cursor-2')], pageParams: [null] }
      );
      root = rendered.root;

      await rendered.click('Load more benchmark requests');

      // The first page survives the failure, the alert names it, and the control offers a
      // retry instead of vanishing with the rows. Every one of those is a condition to wait
      // for: the alert appears only after React commits the failed page.
      await waitFor(
        () => renderedAlertText().includes('Older requests could not be loaded'),
        'list failure alert'
      );
      expect(renderedRowIds()).toEqual([uuidFor('c'), uuidFor('b')]);
      await waitFor(
        () => renderedButtonLabels().includes('Load more benchmark requests'),
        'list retry control'
      );
      expect(dom.container.textContent ?? '').toContain('Retry older requests');

      await rendered.click('Load more benchmark requests');
      await waitForRows(rows => rows.length === 3);
      expect(renderedRowIds()).toEqual([uuidFor('c'), uuidFor('b'), uuidFor('a')]);
    } finally {
      if (root) act(() => root?.unmount());
    }
  });

  it('keeps browsed pages when the list refreshes', async () => {
    let root: RenderRoot | undefined;
    mockAdminFetch.mockImplementation(async url =>
      url.includes('cursor=cursor-2')
        ? jsonResponse(requestPage(['a'], null))
        : jsonResponse(requestPage(['c', 'b'], 'cursor-2'))
    );
    try {
      const modules = await loadModules();
      const rendered = await renderInteractive(
        createElement(modules.BenchmarkRequestsSection, SECTION_PROPS),
        modules,
        { pages: [requestPage(['c', 'b'], 'cursor-2')], pageParams: [null] }
      );
      root = rendered.root;
      await rendered.click('Load more benchmark requests');
      await waitForRows(rows => rows.length === 3);

      // A refresh (the poll path) must not drop the page the operator already loaded.
      await act(async () => {
        await rendered.client.refetchQueries({ queryKey: ['auto-routing', 'benchmark-requests'] });
      });
      expect(renderedRowIds()).toEqual([uuidFor('c'), uuidFor('b'), uuidFor('a')]);
    } finally {
      if (root) act(() => root?.unmount());
    }
  });
});

describe('case paging retry', () => {
  // The progress response is parsed with the shared contract, so its ids must be real uuids.
  const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
  const seededPage = {
    status: 'active' as const,
    request: request({ id: REQUEST_ID }),
    cases: [
      {
        id: 'case-one',
        model: 'm',
        variant: null,
        caseId: 'case-one',
        repetition: 0,
        status: 'done' as const,
        coveredByKilo: false,
        billedModelRequests: 1,
        chargedMicrodollars: 0,
        reason: null,
      },
    ],
    nextCursor: 'cases-2' as string | null,
  };

  function pageTwo(cases: { id: string }[], nextCursor: string | null) {
    return {
      status: 'active' as const,
      request: request({ id: REQUEST_ID }),
      cases: cases.map(entry => ({
        id: entry.id,
        model: 'm',
        variant: null,
        caseId: entry.id,
        repetition: 0,
        status: 'done' as const,
        coveredByKilo: false,
        billedModelRequests: 1,
        chargedMicrodollars: 0,
        reason: null,
      })),
      nextCursor,
    };
  }

  it('keeps the loaded case when page 2 fails, then retries the same cursor', async () => {
    let root: RenderRoot | undefined;
    let failNextCasePage = true;
    const requestedCursors: string[] = [];
    mockAdminFetch.mockImplementation(async url => {
      if (url.includes('cursor=cases-2')) {
        requestedCursors.push('cases-2');
        if (failNextCasePage) {
          failNextCasePage = false;
          return new Response(JSON.stringify({ error: 'D1 timed out' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          });
        }
        return jsonResponse(pageTwo([{ id: 'case-two' }], null));
      }
      return jsonResponse(seededPage);
    });
    try {
      const modules = await loadModules();
      const client = new modules.QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      });
      // Seeded so the first case page is already on screen; no refetch can replace it.
      client.setQueryData(
        ['auto-routing', 'benchmark-request-progress', REQUEST_ID],
        { pages: [seededPage], pageParams: [null] },
        { updatedAt: Date.now() }
      );
      root = modules.createRoot(dom.container);
      await act(async () => {
        root?.render(
          createElement(
            modules.QueryClientProvider,
            { client },
            createElement(modules.RequestDetail, { request: request({ id: REQUEST_ID }) })
          )
        );
        await Promise.resolve();
      });
      const clickCaseControl = async () => {
        const button = [...dom.container.querySelectorAll('button')].find(
          candidate => candidate.getAttribute('aria-label') === 'Load more cases'
        );
        if (!button) throw new Error('case control missing');
        await act(async () => {
          button.dispatchEvent(new (dom.window.Event as typeof Event)('click', { bubbles: true }));
          await Promise.resolve();
        });
      };

      await waitFor(
        () => (dom.container.textContent ?? '').includes('case-one'),
        'first case page rendered'
      );
      await clickCaseControl();

      // The already-loaded case stays, and the failure is announced with a retry control.
      await waitFor(
        () => renderedAlertText().includes('More cases could not be loaded'),
        'case failure alert'
      );
      expect(dom.container.textContent ?? '').toContain('case-one');
      expect(dom.container.textContent ?? '').not.toContain('case-two');
      expect(dom.container.textContent ?? '').toContain('Retry more cases');

      await clickCaseControl();
      await waitFor(
        () => (dom.container.textContent ?? '').includes('case-two'),
        'retried case page rendered'
      );
      // The retry asked for the same cursor, and both cases are on screen now.
      expect(requestedCursors).toEqual(['cases-2', 'cases-2']);
      expect(dom.container.textContent ?? '').toContain('case-one');
      expect(dom.container.textContent ?? '').toContain('case-two');
    } finally {
      if (root) act(() => root?.unmount());
    }
  });
});

describe('case paging across a request switch', () => {
  it('drops a page that resolves after a different request is shown', async () => {
    let root: RenderRoot | undefined;
    let releaseOld: (() => void) | undefined;
    mockAdminFetch.mockImplementation(async url => {
      if (url.includes('request-old') && url.includes('cursor=old-2')) {
        // Held open until after the component has switched requests.
        await new Promise<void>(resolve => {
          releaseOld = resolve;
        });
        return jsonResponse({
          status: 'active',
          request: request(),
          cases: [
            {
              id: 'old-late-case',
              model: 'm',
              variant: null,
              caseId: 'old-late-case',
              repetition: 0,
              status: 'done',
              coveredByKilo: false,
              billedModelRequests: 1,
              chargedMicrodollars: 0,
              reason: null,
            },
          ],
          nextCursor: null,
        });
      }
      if (url.includes('request-old')) {
        return jsonResponse({
          status: 'active',
          request: request({ id: 'request-old' }),
          cases: [
            {
              id: 'old-first-case',
              model: 'm',
              variant: null,
              caseId: 'old-first-case',
              repetition: 0,
              status: 'done',
              coveredByKilo: false,
              billedModelRequests: 1,
              chargedMicrodollars: 0,
              reason: null,
            },
          ],
          nextCursor: 'old-2',
        });
      }
      return jsonResponse({
        status: 'active',
        request: request({ id: 'request-new' }),
        cases: [
          {
            id: 'new-case',
            model: 'm',
            variant: null,
            caseId: 'new-case',
            repetition: 0,
            status: 'done',
            coveredByKilo: false,
            billedModelRequests: 1,
            chargedMicrodollars: 0,
            reason: null,
          },
        ],
        nextCursor: null,
      });
    });
    try {
      const modules = await loadModules();
      const client = new modules.QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      });
      // Seed the first case page so the control exists immediately; the page it loads is the
      // one that must be discarded when the component switches requests.
      client.setQueryData(
        ['auto-routing', 'benchmark-request-progress', 'request-old'],
        {
          pages: [
            {
              status: 'active',
              request: request({ id: 'request-old' }),
              cases: [
                {
                  id: 'old-first-case',
                  model: 'm',
                  variant: null,
                  caseId: 'old-first-case',
                  repetition: 0,
                  status: 'done',
                  coveredByKilo: false,
                  billedModelRequests: 1,
                  chargedMicrodollars: 0,
                  reason: null,
                },
              ],
              nextCursor: 'old-2',
            },
          ],
          pageParams: [null],
        },
        { updatedAt: Date.now() }
      );
      client.setQueryData(
        ['auto-routing', 'benchmark-request-progress', 'request-new'],
        {
          pages: [
            {
              status: 'active',
              request: request({ id: 'request-new' }),
              cases: [
                {
                  id: 'new-case',
                  model: 'm',
                  variant: null,
                  caseId: 'new-case',
                  repetition: 0,
                  status: 'done',
                  coveredByKilo: false,
                  billedModelRequests: 1,
                  chargedMicrodollars: 0,
                  reason: null,
                },
              ],
              nextCursor: null,
            },
          ],
          pageParams: [null],
        },
        { updatedAt: Date.now() }
      );
      root = modules.createRoot(dom.container);
      await act(async () => {
        root?.render(
          createElement(
            modules.QueryClientProvider,
            { client },
            createElement(modules.RequestDetail, { request: request({ id: 'request-old' }) })
          )
        );
        await Promise.resolve();
      });
      const oldButton = [...dom.container.querySelectorAll('button')].find(
        candidate => candidate.getAttribute('aria-label') === 'Load more cases'
      );
      if (!oldButton) throw new Error('first page did not offer the case control');
      // Start a page fetch, then switch to another request before it resolves.
      await act(async () => {
        oldButton.dispatchEvent(new (dom.window.Event as typeof Event)('click', { bubbles: true }));
        await Promise.resolve();
      });
      expect(typeof releaseOld).toBe('function');
      await act(async () => {
        root?.render(
          createElement(
            modules.QueryClientProvider,
            { client },
            createElement(modules.RequestDetail, { request: request({ id: 'request-new' }) })
          )
        );
        await Promise.resolve();
      });
      await act(async () => {
        releaseOld?.();
        await Promise.resolve();
        await Promise.resolve();
      });

      const text = dom.container.textContent ?? '';
      expect(text).toContain('new-case');
      expect(text).not.toContain('old-late-case');
    } finally {
      if (root) act(() => root?.unmount());
    }
  });
});
