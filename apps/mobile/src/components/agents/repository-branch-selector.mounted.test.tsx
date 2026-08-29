/* eslint-disable typescript-eslint/no-deprecated -- mounted React Native contract tests use the DOM-free renderer */
import TestRenderer, { act } from 'react-test-renderer';
import { notifyManager, QueryClient, QueryClientProvider, skipToken } from '@tanstack/react-query';
import { type TRPCQueryKey } from '@trpc/tanstack-react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type LaunchRepositoryReference } from '@kilocode/app-shared/code-review/repository-identity';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { type ProviderLaunchSelection } from './provider-launch-input';
import { normalizeSessionRepository } from './new-session-repository-state';
import {
  RepositoryBranchContext,
  RepositoryBranchSelector,
  useRepositoryBranchSelection,
} from './repository-branch-selector';

const native = vi.hoisted(() => ({
  choose: undefined as ((index?: number) => void) | undefined,
  options: [] as string[],
  selection: null as ProviderLaunchSelection | null,
  destination: '',
}));
vi.mock('react-native', () => ({ View: 'View', ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/accessible-status', () => ({
  AccessibleStatus: ({ message }: { message: string | null }) => <Text>{message}</Text>,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://web.test' }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/hooks/use-current-user-id', () => ({ useCurrentUserId: vi.fn() }));
vi.mock('@/lib/pr-review/connect-gate-platform', () => ({
  openAuthorizationAndWaitForReturn: vi.fn(),
}));
vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({
    showActionSheetWithOptions: (
      sheet: { options: string[] },
      onSelect: (index?: number) => void
    ) => {
      native.options = sheet.options;
      native.choose = onSelect;
    },
  }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    cloudAgentNext: { listRepositoryBranches: { infiniteQueryOptions: options } },
    organizations: {
      cloudAgentNext: { listRepositoryBranches: { infiniteQueryOptions: options } },
    },
  }),
}));

type Page = {
  branches: { name: string; isDefault: boolean }[];
  defaultBranch: string | null;
  nextCursor: string | null;
};
type Input = LaunchRepositoryReference & { organizationId?: string; cursor?: string };
const requests: { input: Input; response: ReturnType<typeof Promise.withResolvers<Page>> }[] = [];
function options(input: Input | typeof skipToken) {
  return {
    queryKey: [
      ['branches'],
      { input: input === skipToken ? undefined : input, type: 'infinite' },
    ] satisfies TRPCQueryKey,
    initialPageParam: undefined,
    queryFn:
      input === skipToken
        ? skipToken
        : async ({ pageParam }: { pageParam?: string }) => {
            const response = Promise.withResolvers<Page>();
            requests.push({ input: { ...input, cursor: pageParam }, response });
            const page = await response.promise;
            return page;
          },
  };
}
const reference: LaunchRepositoryReference = {
  repository: {
    provider: 'gitlab',
    instanceUrl: 'https://git.example.com/base',
    repositoryId: '7',
    fullName: 'group/nested/repo',
    defaultBranch: 'develop',
  },
  authorization: {
    kind: 'ownerIntegration',
    owner: { type: 'org', id: 'org-1' },
    integrationId: 'integration-1',
  },
};
function Harness({
  reference: ref,
  accountId,
}: {
  reference: LaunchRepositoryReference | null;
  accountId: string;
}) {
  const organizationId =
    ref?.authorization.owner.type === 'org' ? ref.authorization.owner.id : undefined;
  const repository = ref
    ? normalizeSessionRepository(
        { private: true, repositoryReference: ref },
        accountId,
        organizationId
      )
    : null;
  const state = useRepositoryBranchSelection(repository, accountId, organizationId);
  native.selection = state.launchSelection;
  return (
    <RepositoryBranchContext value={state}>
      <RepositoryBranchSelector
        disabled={false}
        connectLabel="connect"
        onConnect={() => {
          native.destination = state.repository?.reference.authorization.integrationId ?? '';
        }}
      />
    </RepositoryBranchContext>
  );
}
let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
async function flush(action: () => void) {
  await act(async () => {
    action();
    // Keep deferred query notifications inside React's asynchronous act scope.
    await Promise.resolve();
  });
}
async function render(ref: LaunchRepositoryReference | null = reference, accountId = 'user-1') {
  await flush(() => {
    const tree = (
      <QueryClientProvider client={client}>
        <Harness reference={ref} accountId={accountId} />
      </QueryClientProvider>
    );
    if (renderer) {
      renderer.update(tree);
    } else {
      renderer = TestRenderer.create(tree);
    }
  });
}
function text() {
  return JSON.stringify(renderer?.toJSON());
}
async function respond(
  index: number,
  names = ['develop', 'feature'],
  page: Partial<Omit<Page, 'branches'>> = {}
) {
  await flush(() => {
    const defaultBranch = page.defaultBranch === undefined ? 'develop' : page.defaultBranch;
    requests[index]?.response.resolve({
      branches: names.map(name => ({ name, isDefault: name === defaultBranch })),
      defaultBranch,
      nextCursor: null,
      ...page,
    });
  });
}
async function press(label: string, branch?: string) {
  const button = renderer?.root
    .findAllByType(Button)
    .find(
      node =>
        (node.props as { accessibilityLabel?: string }).accessibilityLabel === label ||
        node.findAllByType(Text).some(child => child.children.includes(label))
    );
  if (!button) {
    throw new Error(`Missing button: ${label}`);
  }
  await flush(() => {
    (button.props as { onPress: () => void }).onPress();
    if (branch) {
      native.choose?.(native.options.indexOf(branch));
    }
  });
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  notifyManager.setScheduler(queueMicrotask);
  requests.length = 0;
  native.destination = '';
});
afterEach(async () => {
  await flush(() => {
    renderer?.unmount();
  });
  renderer = undefined;
  client.clear();
  notifyManager.setScheduler(task => {
    setTimeout(task, 0);
  });
  vi.unstubAllGlobals();
});

it('loads only a selected identity and uses its provider default before an explicit branch', async () => {
  await render(null);
  expect(requests).toEqual([]);
  await render();
  expect(text()).toContain('agentChat.newSession.loadingBranches');
  expect(native.selection).toBeNull();
  await respond(0);
  expect(requests[0]?.input).toMatchObject({ ...reference, organizationId: 'org-1' });
  expect(native.selection).toEqual({ reference, upstreamBranch: 'develop' });
  await press('agentChat.newSession.branch', 'feature');
  expect(native.selection).toEqual({ reference, upstreamBranch: 'feature' });
});

it.each(['owner', 'integration', 'instance', 'repository', 'account'])(
  'rejects late pages and native choices after a changed %s',
  async change => {
    await render();
    await respond(0);
    await press('agentChat.newSession.branch', 'feature');
    const oldChoice = native.choose;
    await flush(() => {
      void client.refetchQueries();
    });
    const next = structuredClone(reference);
    if (change === 'owner') {
      next.authorization.owner.id = 'org-2';
    }
    if (change === 'integration') {
      next.authorization.integrationId = 'integration-2';
    }
    if (change === 'instance') {
      next.repository.instanceUrl = 'https://git.example.com/other';
    }
    if (change === 'repository') {
      next.repository.repositoryId = '8';
    }
    await render(next, change === 'account' ? 'user-2' : 'user-1');
    expect(native.selection).toBeNull();
    await respond(1, ['old-branch'], { defaultBranch: 'old-branch' });
    await flush(() => {
      oldChoice?.(1);
    });
    expect(native.selection).toBeNull();
    await respond(2, ['release'], { defaultBranch: 'release' });
    expect(native.selection).toEqual({ reference: next, upstreamBranch: 'release' });
  }
);

it('distinguishes empty branches from a failed refresh and recovers through retry', async () => {
  await render();
  await respond(0, [], { defaultBranch: null });
  expect(text()).toContain('agentChat.newSession.noBranches');
  expect(native.selection).toBeNull();
  await press('common.refresh');
  await flush(() => {
    requests[1]?.response.reject(new Error('Offline'));
  });
  expect(text()).toContain('agentChat.newSession.couldNotLoadBranches');
  expect(native.selection).toBeNull();
  await press('common.retry');
  await respond(2);
  expect(native.selection?.upstreamBranch).toBe('develop');
});

it('retains loaded branches and retries only the failed next page', async () => {
  await render();
  await respond(0, ['develop'], { nextCursor: 'page-2' });
  await press('agentChat.newSession.loadMoreBranches');
  await flush(() => {
    requests[1]?.response.reject(new Error('Offline'));
  });
  expect(text()).toContain('agentChat.newSession.couldNotLoadBranches');
  expect(native.selection?.upstreamBranch).toBe('develop');
  await press('common.retry');
  expect(requests.map(request => request.input.cursor)).toEqual([undefined, 'page-2', 'page-2']);
  await respond(2, ['feature']);
  await press('agentChat.newSession.branch', 'feature');
  expect(native.selection?.upstreamBranch).toBe('feature');
});

it.each([
  ['FORBIDDEN', 'branchAccessDenied', true],
  ['UNAUTHORIZED', 'branchAccessDenied', true],
  ['PRECONDITION_FAILED', 'branchAccessDenied', true],
  ['BAD_REQUEST', 'invalidRepositorySelection', false],
  ['NOT_FOUND', 'repositoryUnavailable', false],
] as const)(
  'blocks %s and exposes only applicable recovery',
  async (code, message, canReconnect) => {
    await render();
    await respond(0);
    await flush(() => {
      void client.refetchQueries();
    });
    await flush(() => {
      requests[1]?.response.reject(Object.assign(new Error('Unavailable'), { data: { code } }));
    });
    expect(text()).toContain(`agentChat.newSession.${message}`);
    expect(text()).not.toContain('common.retry');
    expect(native.selection).toBeNull();
    expect(text().includes('"connect"')).toBe(canReconnect);
    if (canReconnect) {
      await press('connect');
    }
    expect(native.destination).toBe(canReconnect ? 'integration-1' : '');
  }
);
