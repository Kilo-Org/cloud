import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, skipToken } from '@tanstack/react-query';
import type { PreviewTarget } from '../../../../../services/cloud-agent-next/src/shared/preview-target';
import type { usePreviewServices as UsePreviewServices } from './use-preview';

type PreviewResult = {
  services: Array<{ port: number; name: string; description?: string }>;
  status: 'running' | 'not_running' | 'not_ready' | 'unsupported';
};

const sessionId = 'workspace_00000000-0000-4000-8000-000000000001' as const;
const worktreeId = 'worktree_00000000-0000-4000-8000-000000000001' as const;
const sessionTarget = { cloudAgentSessionId: sessionId } satisfies PreviewTarget;
const worktreeTarget = { worktreeId } satisfies PreviewTarget;

const mockPersonalList = jest.fn<() => Promise<PreviewResult>>();
const mockOrganizationList = jest.fn<() => Promise<PreviewResult>>();

function listOptions(
  kind: 'personal' | 'organization',
  input: unknown,
  queryFn: () => Promise<PreviewResult>
) {
  if (input === skipToken) {
    return { queryKey: ['preview-services', kind, 'skip'], queryFn: skipToken };
  }
  return { queryKey: ['preview-services', kind, input], queryFn };
}

const mockTrpc = {
  cloudAgentNext: {
    listPreviewServices: {
      queryOptions: jest.fn((input: unknown) => listOptions('personal', input, mockPersonalList)),
    },
  },
  organizations: {
    cloudAgentNext: {
      listPreviewServices: {
        queryOptions: jest.fn((input: unknown) =>
          listOptions('organization', input, mockOrganizationList)
        ),
      },
    },
  },
};

jest.mock('@/lib/trpc/utils', () => ({ useTRPC: () => mockTrpc }));

let usePreviewServices: typeof UsePreviewServices;

beforeAll(async () => {
  ({ usePreviewServices } = await import('./use-preview'));
});

type ObservedOptions = {
  queryKey: readonly unknown[];
  queryFn?: unknown;
  staleTime?: number;
  retry?: unknown;
  refetchOnWindowFocus?: unknown;
  refetchOnReconnect?: unknown;
  refetchInterval?: unknown;
};

function installDom() {
  const requireFromHere = createRequire(__filename);
  const requireFromNext = createRequire(requireFromHere.resolve('next/package.json'));
  const { parseHTML } = requireFromNext('linkedom') as {
    parseHTML: (html: string) => { window: Record<string, unknown>; document: Document };
  };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  const previous = new Map<string, unknown>();
  const replacements = {
    React,
    window,
    document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(replacements)) {
    previous.set(name, globals[name]);
    globals[name] = value;
  }
  const container = document.getElementById('root');
  if (!container) throw new Error('linkedom root missing');
  return {
    container,
    cleanup: () => previous.forEach((value, name) => (globals[name] = value)),
  };
}

describe('usePreviewServices', () => {
  let root: Root;
  let dom: ReturnType<typeof installDom>;
  let queryClient: QueryClient;
  let latest: ReturnType<typeof usePreviewServices> | undefined;

  function Harness({ target, organizationId }: { target: PreviewTarget; organizationId?: string }) {
    latest = usePreviewServices(target, organizationId);
    return null;
  }

  function render(target: PreviewTarget, organizationId?: string) {
    act(() =>
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Harness, { target, organizationId })
        )
      )
    );
  }

  async function settle() {
    for (let index = 0; index < 5; index++) {
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
      });
    }
  }

  function optionsFor(kind: 'personal' | 'organization'): ObservedOptions {
    const query = queryClient
      .getQueryCache()
      .getAll()
      .find(candidate => candidate.options.queryKey?.[1] === kind);
    if (!query) throw new Error(`${kind} preview query was not registered`);
    return query.options as unknown as ObservedOptions;
  }

  beforeEach(() => {
    dom = installDom();
    root = createRoot(dom.container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retryDelay: 0 } },
    });
    latest = undefined;
    mockPersonalList
      .mockReset()
      .mockResolvedValue({ status: 'running', services: [{ name: 'Vite', port: 5173 }] });
    mockOrganizationList
      .mockReset()
      .mockResolvedValue({ status: 'running', services: [{ name: 'API', port: 3000 }] });
    mockTrpc.cloudAgentNext.listPreviewServices.queryOptions.mockClear();
    mockTrpc.organizations.cloudAgentNext.listPreviewServices.queryOptions.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    dom.cleanup();
  });

  it('uses the personal query with no focus, reconnect or polling refetches', async () => {
    render(sessionTarget);
    await settle();

    expect(mockPersonalList).toHaveBeenCalledTimes(1);
    expect(mockOrganizationList).not.toHaveBeenCalled();
    expect(mockTrpc.cloudAgentNext.listPreviewServices.queryOptions).toHaveBeenCalledWith(
      sessionTarget
    );
    expect(
      mockTrpc.organizations.cloudAgentNext.listPreviewServices.queryOptions
    ).toHaveBeenCalledWith(skipToken);
    expect(latest?.data).toEqual({ status: 'running', services: [{ name: 'Vite', port: 5173 }] });

    const options = optionsFor('personal');
    expect(options).toMatchObject({
      staleTime: 0,
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    });
    expect(options.refetchInterval).toBeFalsy();
    expect(options.queryFn).not.toBe(skipToken);
  });

  it('uses the organization query and skips the personal one when an organization is selected', async () => {
    render(sessionTarget, 'organization-1');
    await settle();

    expect(mockOrganizationList).toHaveBeenCalledTimes(1);
    expect(mockPersonalList).not.toHaveBeenCalled();
    expect(
      mockTrpc.organizations.cloudAgentNext.listPreviewServices.queryOptions
    ).toHaveBeenCalledWith({ ...sessionTarget, organizationId: 'organization-1' });
    expect(mockTrpc.cloudAgentNext.listPreviewServices.queryOptions).toHaveBeenCalledWith(
      skipToken
    );
    expect(latest?.data).toEqual({ status: 'running', services: [{ name: 'API', port: 3000 }] });

    const options = optionsFor('organization');
    expect(options).toMatchObject({
      staleTime: 0,
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    });
    expect(options.refetchInterval).toBeFalsy();
    expect(options.queryFn).not.toBe(skipToken);
  });

  it('forwards a worktree target to personal and organization discovery', async () => {
    render(worktreeTarget);
    await settle();

    expect(mockTrpc.cloudAgentNext.listPreviewServices.queryOptions).toHaveBeenCalledWith(
      worktreeTarget
    );
    expect(
      mockTrpc.organizations.cloudAgentNext.listPreviewServices.queryOptions
    ).toHaveBeenCalledWith(skipToken);

    render(worktreeTarget, 'organization-1');
    await settle();

    expect(
      mockTrpc.organizations.cloudAgentNext.listPreviewServices.queryOptions
    ).toHaveBeenCalledWith({ ...worktreeTarget, organizationId: 'organization-1' });
    expect(mockTrpc.cloudAgentNext.listPreviewServices.queryOptions).toHaveBeenCalledWith(
      skipToken
    );
  });
});
