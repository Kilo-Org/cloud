import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as InfiniteRetentionModule from '@/lib/query/infinite-retention';

import { useConnectBitbucket, useReplaceBitbucketToken } from './use-bitbucket';

type MutationOptions = {
  onSuccess?: () => Promise<void>;
};

const invalidateQueriesMock = vi.fn(() => Promise.resolve());
const reconcileFirstPageMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const connectMutateMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ success: true })));
const replaceTokenMutateMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ success: true })));

// One object for every `useQueryClient` call, so an assertion can name the
// client the hook handed the reconcile.
const queryClientMock = { invalidateQueries: invalidateQueriesMock };

let lastCapturedOptions: MutationOptions | null = null;

vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: MutationOptions) => {
    lastCapturedOptions = opts;
    return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, isError: false };
  },
  useQuery: () => ({ data: undefined }),
  useQueryClient: () => queryClientMock,
}));

// The real module stays loaded (its probe never runs here); only the reconcile
// is replaced, so it records the call instead of touching a query cache this
// suite never builds.
vi.mock('@/lib/query/infinite-retention', async importOriginal => {
  const actual = await importOriginal<typeof InfiniteRetentionModule>();
  return { ...actual, reconcileFirstPage: reconcileFirstPageMock };
});

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    organizations: {
      reviewAgent: {
        getBitbucketReadiness: { queryKey: (input: unknown) => ['readiness', input] },
      },
      cloudAgentNext: {
        listBitbucketRepositories: { queryKey: (input: unknown) => ['repositories', input] },
      },
      bitbucket: { getStatus: { queryKey: (input: unknown) => ['status', input] } },
    },
    platformIntegrations: { listSetupStatus: { queryKey: (input: unknown) => ['setup', input] } },
  }),
  trpcClient: {
    organizations: {
      bitbucket: {
        connect: { mutate: connectMutateMock },
        replaceToken: { mutate: replaceTokenMutateMock },
      },
    },
  },
}));

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PERSONAL_SCOPE = 'personal';

function connectOptions(scope: string): MutationOptions {
  lastCapturedOptions = null;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useConnectBitbucket(scope);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!lastCapturedOptions) {
    throw new Error('mutation options for useConnectBitbucket were not captured');
  }
  return lastCapturedOptions;
}

function replaceTokenOptions(scope: string): MutationOptions {
  lastCapturedOptions = null;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useReplaceBitbucketToken(scope);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!lastCapturedOptions) {
    throw new Error('mutation options for useReplaceBitbucketToken were not captured');
  }
  return lastCapturedOptions;
}

beforeEach(() => {
  lastCapturedOptions = null;
  invalidateQueriesMock.mockClear();
  reconcileFirstPageMock.mockClear();
  connectMutateMock.mockClear();
  replaceTokenMutateMock.mockClear();
});

describe('useConnectBitbucket audit log refresh', () => {
  it('reconciles the audit log page one for an organization scope', async () => {
    await connectOptions(ORG_ID).onSuccess?.();

    expect(reconcileFirstPageMock).toHaveBeenCalledExactlyOnceWith(queryClientMock, [
      'organizations.auditLogs.list',
      ORG_ID,
    ]);
    // The stale-read refreshes this hook already made stay exactly as they were.
    expect(invalidateQueriesMock).toHaveBeenCalledTimes(5);
  });

  it('leaves the audit log alone for the personal scope', async () => {
    await connectOptions(PERSONAL_SCOPE).onSuccess?.();

    expect(reconcileFirstPageMock).not.toHaveBeenCalled();
    // The connection refreshes still run: only the audit reconcile is scoped.
    expect(invalidateQueriesMock).toHaveBeenCalledTimes(5);
  });
});

describe('useReplaceBitbucketToken audit log refresh', () => {
  it('reconciles the audit log page one for an organization scope', async () => {
    await replaceTokenOptions(ORG_ID).onSuccess?.();

    expect(reconcileFirstPageMock).toHaveBeenCalledExactlyOnceWith(queryClientMock, [
      'organizations.auditLogs.list',
      ORG_ID,
    ]);
    expect(invalidateQueriesMock).toHaveBeenCalledTimes(5);
  });

  it('leaves the audit log alone for the personal scope', async () => {
    await replaceTokenOptions(PERSONAL_SCOPE).onSuccess?.();

    expect(reconcileFirstPageMock).not.toHaveBeenCalled();
    expect(invalidateQueriesMock).toHaveBeenCalledTimes(5);
  });
});
