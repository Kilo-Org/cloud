// Mounted regression for the merge intent key (22-13): the key that admitted an
// ambiguous merge must survive the merge screen, because the server's ledger row
// does. The domain store is the real one; only the transport is faked.

import { createElement } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';
import { createTestQueryClient } from '@/test/render-with-providers';

import { useMergePullRequestMutation } from './use-pr-merge-mutations';
import {
  clearMergeOperationKeys,
  mergeOperationKey,
  retireMergeOperationKey,
} from './pr-merge-operation-key';

/** The merge input the transport records: the key is the only field asserted. */
type MergeCall = { readonly operationKey?: string };

const transport = vi.hoisted(() => ({
  merge: vi.fn<(vars: MergeCall) => Promise<unknown>>(),
  announce: vi.fn(),
}));

vi.mock('expo-crypto', () => {
  let n = 0;
  return {
    randomUUID: () => {
      n += 1;
      return `uuid-${n}`;
    },
  };
});

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    githubPrReview: {
      getPullRequest: { queryKey: () => ['githubPrReview', 'getPullRequest'] },
      listChecks: { pathFilter: () => ['githubPrReview', 'listChecks'] },
      listFiles: { pathFilter: () => ['githubPrReview', 'listFiles'] },
      updateBranch: { mutationOptions: () => ({}) },
    },
    providerReview: {
      getPullRequest: { queryKey: () => ['providerReview', 'getPullRequest'] },
      listChecks: { pathFilter: () => ['providerReview', 'listChecks'] },
      listFiles: { pathFilter: () => ['providerReview', 'listFiles'] },
    },
  }),
  trpcClient: {
    githubPrReview: {
      mergePullRequest: {
        mutate: (vars: MergeCall) => transport.merge(vars),
      },
    },
    providerReview: { mergePullRequest: { mutate: (vars: MergeCall) => transport.merge(vars) } },
  },
}));

vi.mock('@/lib/a11y/announce', () => ({ announceForA11y: transport.announce }));

vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));

// Rolldown cannot parse React Native's Flow source, and the announcement path
// imports it.
vi.mock('react-native', () => ({
  AccessibilityInfo: {
    announceForAccessibility: vi.fn(),
    setAccessibilityFocus: vi.fn(),
  },
  findNodeHandle: vi.fn(() => null),
}));

const REF = { platform: 'github', owner: 'octocat', repo: 'hello', number: 1 };

const MERGE_INPUT: MergeRequest = {
  owner: 'octocat',
  repo: 'hello',
  number: 1,
  method: 'squash',
  expectedHeadSha: 'a'.repeat(40),
};

/** The merge input this suite submits. */
type MergeRequest = {
  owner: string;
  repo: string;
  number: number;
  method: 'squash';
  expectedHeadSha: string;
};

/** The one part of the hook this suite drives. */
type MergeMutation = { mutateAsync: (vars: MergeRequest) => Promise<unknown> };

type Harness = { current: MergeMutation | null };

function MergeScreen({ handle }: { handle: Harness }) {
  handle.current = useMergePullRequestMutation(REF);
  return null;
}

function mountMergeScreen(): { renderer: TestRenderer.ReactTestRenderer; handle: Harness } {
  const handle: Harness = { current: null };
  const held: { renderer?: TestRenderer.ReactTestRenderer } = {};
  act(() => {
    held.renderer = TestRenderer.create(
      createElement(
        QueryClientProvider,
        { client: createTestQueryClient() },
        createElement(MergeScreen, { handle })
      )
    );
  });
  const { renderer } = held;
  if (!renderer || handle.current === null) {
    throw new Error('the merge screen did not mount');
  }
  return { renderer, handle };
}

/** Submits once and swallows the rejection: the assertions are about the key. */
async function submit(handle: Harness): Promise<void> {
  const mutation = handle.current;
  if (mutation === null) {
    throw new Error('the merge screen did not mount');
  }
  await act(async () => {
    try {
      await mutation.mutateAsync(MERGE_INPUT);
    } catch {
      // A failed merge is the subject of these tests, not a test failure.
    }
  });
}

function operationKeyAt(index: number): string | undefined {
  return transport.merge.mock.calls.at(index)?.[0].operationKey;
}

/** One fingerprint two accounts can both name, so the boundary is the only reset. */
const MERGE_FINGERPRINT = '{"resource":["octocat","hello",1],"method":"squash"}';

/** The key the merge store holds for a fingerprint; a refusal is a test failure. */
function heldMergeKey(fingerprint: string): string {
  const key = mergeOperationKey(fingerprint);
  if (key === null) {
    throw new Error(`no merge key was admitted for ${fingerprint}`);
  }
  return key;
}

beforeEach(() => {
  transport.merge.mockReset();
  transport.announce.mockReset();
  clearMergeOperationKeys();
});

afterEach(() => {
  clearMergeOperationKeys();
  vi.clearAllMocks();
});

describe('merge intent key across a dismissed merge screen', () => {
  it('replays the same operation key after an unmount and remount', async () => {
    // A transport drop the ledger classifies as retryable: the intent stays open.
    transport.merge.mockRejectedValueOnce(new Error('operation_in_progress'));
    const first = mountMergeScreen();
    await submit(first.handle);
    const admitted = operationKeyAt(0);
    expect(admitted).toBeDefined();
    first.renderer.unmount();

    transport.merge.mockResolvedValueOnce({
      merged: true,
      sha: 'a'.repeat(40),
      branchDeleted: true,
    });
    const second = mountMergeScreen();
    await submit(second.handle);

    // The server's ledger row for the ambiguous attempt survived the dismissal,
    // so the reopened screen must present the same intent key rather than a new
    // one that would execute the merge again.
    expect(operationKeyAt(1)).toBe(admitted);
    second.renderer.unmount();
  });

  it('rotates the key after a terminal failure, so the next submit is a new intent', async () => {
    const refused = new Error('Cannot merge this pull request');
    Object.assign(refused, { data: { code: 'BAD_REQUEST' } });
    transport.merge.mockRejectedValueOnce(refused);
    const { renderer, handle } = mountMergeScreen();

    await submit(handle);
    const first = operationKeyAt(0);

    transport.merge.mockRejectedValueOnce(refused);
    await submit(handle);

    expect(operationKeyAt(1)).not.toBe(first);
    renderer.unmount();
  });

  it('retires the key after a stale-head rejection, so its slot is not held forever', async () => {
    // The router settled that row: the head moved, so the intent is over and the
    // retained entry must not keep one of the store's slots.
    const moved = new Error(
      'The merge request changed since it was loaded. Reload the merge request and try again.'
    );
    Object.assign(moved, { data: { code: 'CONFLICT' } });
    transport.merge.mockRejectedValueOnce(moved);
    const { renderer, handle } = mountMergeScreen();

    await submit(handle);
    const first = operationKeyAt(0);

    // The next submit of the same intent is a new write, so it mints a new key.
    transport.merge.mockRejectedValueOnce(moved);
    await submit(handle);

    expect(operationKeyAt(1)).not.toBe(first);
    renderer.unmount();
  });
});

describe('merge intent retirement across the account boundary', () => {
  it('retires only its own account’s key when an earlier request settles late', () => {
    // Account A's merge is still out when the account boundary clears the store,
    // and account B admits the same fingerprint with a key of its own.
    const accountAKey = heldMergeKey(MERGE_FINGERPRINT);
    clearMergeOperationKeys();
    const accountBKey = heldMergeKey(MERGE_FINGERPRINT);
    expect(accountBKey).not.toBe(accountAKey);

    // A's late terminal outcome names the key it captured, so it retires A's
    // intent only: B's entry must survive, or B's retry would mint a fresh key
    // and execute the merge again.
    retireMergeOperationKey(MERGE_FINGERPRINT, accountAKey);
    expect(heldMergeKey(MERGE_FINGERPRINT)).toBe(accountBKey);

    // B's own outcome is the authoritative retirement of B's entry.
    retireMergeOperationKey(MERGE_FINGERPRINT, accountBKey);
    expect(heldMergeKey(MERGE_FINGERPRINT)).not.toBe(accountBKey);
  });
});
