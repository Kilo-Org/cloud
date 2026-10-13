import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRequire } from 'node:module';
import type {
  GetWorktreeFileOutput,
  WorktreeChangesSnapshot,
  WorktreeFileQuery,
} from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import type { useWorktreeFile as UseWorktreeFile } from './useWorktreeFile';

const snapshot: WorktreeChangesSnapshot = {
  schemaVersion: 2,
  revision: 7,
  capturedAt: '2026-10-13T10:00:00Z',
  comparison: { baseRef: 'origin/main', mergeBase: 'a'.repeat(40), head: 'b'.repeat(40) },
  files: ['uncommitted', 'against-base-branch'].map(scope => ({
    path: 'file.ts',
    scope: scope as WorktreeFileQuery['scope'],
    revision: 7,
    status: 'modified',
    additions: 1,
    deletions: 1,
    tracked: true,
    binary: false,
    countsComplete: true,
  })),
  truncated: false,
};
const mockSavedRefetch =
  jest.fn<() => Promise<{ isError: boolean; data: { snapshot: WorktreeChangesSnapshot } }>>();
const mockFileRefetch = jest.fn<() => Promise<void>>();
let mockSnapshot = snapshot;
let mockFile: GetWorktreeFileOutput | undefined;
const mockPersonalOptions = jest.fn<(input: unknown) => { queryKey: unknown[] }>(input => ({
  queryKey: ['personal', input],
}));
const mockOrgOptions = jest.fn<(input: unknown) => { queryKey: unknown[] }>(input => ({
  queryKey: ['organization', input],
}));
const mockUseQuery = jest.fn<(options: unknown) => unknown>();

jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    cloudAgentNext: { getWorktreeFile: { queryOptions: mockPersonalOptions } },
    organizations: { cloudAgentNext: { getWorktreeFile: { queryOptions: mockOrgOptions } } },
  }),
}));
jest.mock('./useSavedWorktreeChanges', () => ({
  useSavedWorktreeChanges: () => ({
    saved: {
      data: { snapshot: mockSnapshot },
      isError: false,
      isFetching: false,
      refetch: mockSavedRefetch,
    },
  }),
}));
jest.mock('@tanstack/react-query', () => ({
  useQuery: (options: unknown) => mockUseQuery(options),
}));

type Props = { organizationId?: string; scope?: WorktreeFileQuery['scope'] };
let useWorktreeFile: typeof UseWorktreeFile;
let latest: ReturnType<typeof UseWorktreeFile>;
function Probe(props: Props) {
  latest = useWorktreeFile({ cloudAgentSessionId: 'workspace_test', path: 'file.ts', ...props });
  return null;
}
let root: Root;
let restoreDom: () => void;

beforeEach(async () => {
  ({ useWorktreeFile } = await import('./useWorktreeFile'));
  const requireFromNext = createRequire(createRequire(__filename).resolve('next/package.json'));
  const { window } = requireFromNext('linkedom').parseHTML(
    '<html><body><div id="root"></div></body></html>'
  );
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  const previous = new Map<string, unknown>();
  for (const [key, value] of Object.entries({
    React,
    window,
    document: window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, globals[key]);
    globals[key] = value;
  }
  restoreDom = () =>
    previous.forEach((value, key) => {
      globals[key] = value;
    });
  root = createRoot(window.document.getElementById('root'));
  mockSnapshot = snapshot;
  mockFile = undefined;
  mockPersonalOptions.mockClear();
  mockOrgOptions.mockClear();
  mockUseQuery.mockReset().mockImplementation(() => ({
    data: mockFile,
    isError: false,
    isFetching: false,
    refetch: mockFileRefetch,
  }));
  mockSavedRefetch.mockReset().mockResolvedValue({ isError: false, data: { snapshot } });
  mockFileRefetch.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => root.unmount());
  restoreDom();
});
async function render(props: Props = {}) {
  await act(async () => root.render(createElement(Probe, props)));
}

function lastQueryKey(options: typeof mockPersonalOptions) {
  const result = options.mock.results.at(-1);
  if (!result || result.type !== 'return') throw new Error('Missing query options');
  return result.value.queryKey;
}

describe('saved worktree file scope forwarding', () => {
  it.each([undefined, 'org-one'])(
    'forwards selected scope and separates query keys for %s',
    async organizationId => {
      const options = organizationId ? mockOrgOptions : mockPersonalOptions;
      await render({ organizationId });
      expect(options).toHaveBeenLastCalledWith({
        cloudAgentSessionId: 'workspace_test',
        path: 'file.ts',
        scope: 'uncommitted',
        expectedRevision: 7,
        ...(organizationId ? { organizationId } : {}),
      });
      const firstKey = lastQueryKey(options);
      await render({ organizationId, scope: 'against-base-branch' });
      expect(options).toHaveBeenLastCalledWith({
        cloudAgentSessionId: 'workspace_test',
        path: 'file.ts',
        scope: 'against-base-branch',
        expectedRevision: 7,
        ...(organizationId ? { organizationId } : {}),
      });
      expect(lastQueryKey(options)).not.toEqual(firstKey);
      await render({ organizationId });
      expect(lastQueryKey(options)).toEqual(firstKey);
    }
  );

  it('keeps legacy unscoped selection and disables missing explicit scopes', async () => {
    mockSnapshot = {
      ...snapshot,
      files: snapshot.files.map(({ scope: _scope, ...file }) => file).slice(0, 1),
    };
    await render();
    expect(mockPersonalOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: undefined })
    );
    expect(mockUseQuery).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));
    await render({ scope: 'uncommitted' });
    expect(mockUseQuery).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
    expect(latest.state.status).toBe('no_longer_listed');
  });

  it('forwards uncommitted scope for standalone queries even when committed entries come first', async () => {
    mockSnapshot = { ...snapshot, files: snapshot.files.toReversed() };
    await render();
    expect(mockPersonalOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: 'uncommitted' })
    );
  });

  it('retries independently per layer at the same path and revision', async () => {
    mockFile = { status: 'stale', currentRevision: 7 };
    await render({ scope: 'uncommitted' });
    expect(mockSavedRefetch).toHaveBeenCalledTimes(1);
    expect(mockFileRefetch).toHaveBeenCalledTimes(1);
    await render({ scope: 'against-base-branch' });
    expect(mockSavedRefetch).toHaveBeenCalledTimes(2);
    expect(mockFileRefetch).toHaveBeenCalledTimes(2);
  });

  it('does not refetch the old layer when standalone selection changes while reloading', async () => {
    let resolve!: (value: {
      isError: boolean;
      data: { snapshot: WorktreeChangesSnapshot };
    }) => void;
    mockSavedRefetch.mockReturnValue(
      new Promise(done => {
        resolve = done;
      })
    );
    await render();
    const reload = latest.reload();
    mockSnapshot = { ...snapshot, files: snapshot.files.slice(1) };
    await render();
    await act(async () => {
      resolve({ isError: false, data: { snapshot: mockSnapshot } });
      await reload;
    });
    expect(mockFileRefetch).not.toHaveBeenCalled();
  });
});
