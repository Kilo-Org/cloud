import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ToolPart } from './types';
import type * as ToolPartDetailModule from './ToolPartDetail';
import type * as BashToolCardModule from './BashToolCard';

jest.mock('react-markdown', () =>
  process.getBuiltinModule('module').createRequire(__filename)('react-markdown')
);
jest.mock('remark-gfm', () =>
  process.getBuiltinModule('module').createRequire(__filename)('remark-gfm')
);

const personalQuery = jest.fn();
const organizationQuery = jest.fn();

jest.mock('@/lib/trpc/utils', () => ({
  useRawTRPCClient: () => ({
    cloudAgentNext: { getSessionToolPartDetail: { query: personalQuery } },
    organizations: { cloudAgentNext: { getSessionToolPartDetail: { query: organizationQuery } } },
  }),
}));

function installDom() {
  const requireFromHere = createRequire(__filename);
  const requireFromNext = createRequire(requireFromHere.resolve('next/package.json'));
  const { window, document } = (
    requireFromNext('linkedom') as {
      parseHTML: (html: string) => { window: Record<string, unknown>; document: Document };
    }
  ).parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  const values = {
    React,
    window,
    document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    getComputedStyle: () => ({ animationName: 'none', display: 'block' }),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => undefined,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(values).map(name => [name, globals[name]]));
  Object.assign(globals, values);
  const container = document.getElementById('root');
  if (!container) throw new Error('ToolPartDetail test root missing');
  return {
    container,
    cleanup: () => previous.forEach((value, name) => (globals[name] = value)),
  };
}

const marker = { version: 1, revision: 7, omitted: ['output'], omittedCount: 1, omittedBytes: 9 };
const SESSION = 'workspace_11111111-1111-4111-8111-111111111111';

function bash(output: string, cloudDetail?: unknown): ToolPart {
  return {
    id: 'prt_1',
    messageID: 'msg_1',
    sessionID: 'ses_root',
    type: 'tool',
    callID: 'call_1',
    tool: 'bash',
    state: {
      status: 'completed',
      input: { command: 'cat big.log' },
      output,
      title: 'cat',
      metadata: {},
      time: { start: 1, end: 2 },
    },
    ...(cloudDetail === undefined ? {} : { cloudDetail }),
  } as ToolPart;
}

async function flush() {
  // React Query publishes results on a zero-delay timer.
  for (let index = 0; index < 3; index++)
    await act(async () => {
      await new Promise(done => setTimeout(done, 0));
    });
}

describe('ToolPartDetailBoundary', () => {
  let root: Root | undefined;
  let container: HTMLElement;
  let cleanup: () => void;
  let modules: { boundary: typeof ToolPartDetailModule; bash: typeof BashToolCardModule };
  let queryClient: QueryClient;

  beforeAll(async () => {
    const dom = installDom();
    container = dom.container;
    cleanup = dom.cleanup;
    modules = { boundary: await import('./ToolPartDetail'), bash: await import('./BashToolCard') };
  });

  beforeEach(() => {
    personalQuery.mockReset();
    organizationQuery.mockReset();
    queryClient = new QueryClient();
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    queryClient.clear();
  });

  afterAll(() => cleanup());

  function render(parts: ToolPart[], organizationId: string | null = null, scoped = true) {
    const { ToolDetailScopeProvider, ToolPartDetailBoundary } = modules.boundary;
    act(() => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(ToolDetailScopeProvider, {
            scope: scoped
              ? { userId: 'user-1', organizationId, cloudAgentSessionId: SESSION }
              : null,
            children: parts.map((part, index) =>
              createElement(ToolPartDetailBoundary, {
                key: index,
                part,
                children: (shown: ToolPart) =>
                  createElement(modules.bash.BashToolCard, { toolPart: shown }),
              })
            ),
          })
        )
      );
    });
  }

  function expand(index = 0) {
    const trigger = container.querySelectorAll('button[aria-expanded]')[index] as HTMLElement;
    act(() => {
      trigger.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
    });
  }

  it('does not fetch closed previews and never fetches complete parts', async () => {
    render([bash('pre', marker), bash('complete')]);
    await flush();
    expand(1);
    await flush();
    expect(personalQuery).not.toHaveBeenCalled();
  });

  it('fetches once on expansion, deduplicates the same call, and shows complete output', async () => {
    let resolve: ((value: unknown) => void) | undefined;
    personalQuery.mockReturnValue(new Promise(done => (resolve = done)));
    render([bash('pre', marker), bash('pre', marker)]);
    expand(0);
    expand(1);
    await flush();
    expect(container.textContent).toContain('Showing a preview. Loading the full output');
    expect(container.querySelector('[aria-label="Copy output preview"]')).not.toBeNull();
    expect(personalQuery).toHaveBeenCalledTimes(1);
    expect(personalQuery).toHaveBeenCalledWith({
      sessionId: SESSION,
      kiloSessionId: 'ses_root',
      messageId: 'msg_1',
      partId: 'prt_1',
      callId: 'call_1',
    });
    resolve?.({
      kind: 'found',
      source: { version: 'v1' },
      revision: 7,
      part: bash('complete output'),
    });
    await flush();
    expect(container.textContent).toContain('complete output');
    expect(container.textContent).not.toContain('Showing a preview');
    expect(container.querySelector('[aria-label="Copy output"]')).not.toBeNull();
  });

  it('uses the organization procedure for organization transcripts', async () => {
    organizationQuery.mockResolvedValue({ kind: 'not_found' });
    render([bash('pre', marker)], 'org-1');
    expand();
    await flush();
    expect(organizationQuery).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', partId: 'prt_1' })
    );
    expect(personalQuery).not.toHaveBeenCalled();
    expect(container.textContent).toContain('The full output is no longer available');
  });

  it('reports denial at once and keeps a retry for transient failures', async () => {
    personalQuery.mockRejectedValueOnce({ data: { code: 'FORBIDDEN', httpStatus: 403 } });
    render([bash('pre', marker)]);
    expand();
    await flush();
    expect(personalQuery).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('no longer available');
    expect(container.textContent).not.toContain('Retry');

    act(() => root?.unmount());
    queryClient.clear();
    root = createRoot(container);
    personalQuery.mockReset();
    personalQuery
      .mockRejectedValueOnce({ data: { code: 'BAD_GATEWAY', httpStatus: 503 } })
      .mockRejectedValueOnce({ data: { code: 'BAD_GATEWAY', httpStatus: 503 } })
      .mockResolvedValueOnce({
        kind: 'found',
        source: { version: 'v1' },
        revision: 9,
        part: bash('recovered output'),
      });
    queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
    render([bash('pre', marker)]);
    expand();
    await flush();
    await flush();
    expect(container.textContent).toContain('Couldn’t load the full output');
    const retry = Array.from(container.querySelectorAll('button')).find(
      button => button.textContent === 'Retry'
    );
    act(() => {
      retry?.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(container.textContent).toContain('recovered output');
  });

  it('keeps the preview when no workspace scope is available', async () => {
    render([bash('pre', marker)], null, false);
    expand();
    await flush();
    expect(personalQuery).not.toHaveBeenCalled();
    expect(container.textContent).toContain('pre');
    expect(container.textContent).toContain('no longer available');
  });
});
