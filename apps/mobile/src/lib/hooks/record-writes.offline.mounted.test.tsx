import { type MobileRouter } from '@kilocode/trpc/mobile';
import { onlineManager } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestQueryClient, renderWithProviders, waitFor } from '@/test/render-with-providers';

import { type OrgModeConfigInput } from '@/components/organization/org-mode-form-model';
import { useConnectBitbucket } from '@/lib/hooks/use-bitbucket';
import { useDisconnectIntegration } from '@/lib/hooks/use-integrations';
import { useOrgGroupMutations } from '@/lib/hooks/use-org-groups-queries';
import { useOrgModeMutations } from '@/lib/hooks/use-org-modes-queries';
import { useOrganizationMutations } from '@/lib/hooks/use-organization-mutations';
import { useTodoListMutations } from '@/lib/hooks/use-todos';
import { trpcClient, TRPCProvider } from '@/lib/trpc';

/*
 * Record-form and integration writes while the device reports itself offline.
 *
 * React Query's default `networkMode: 'online'` pauses a mutation while the
 * online manager reports offline: no request is sent, `isPending` never leaves,
 * no `onError` runs, and the queued write lands silently once the connection
 * returns. A form whose Save button reads `isPending` therefore stays disabled
 * with a spinner and no failure copy — the organization mode form's Save did
 * exactly that, and stayed that way until the connection returned.
 *
 * Each case mounts the real hook against a real `QueryClient` and a transport
 * that rejects, flips the online manager to offline, and records two facts: was
 * the request attempted, and did the mutation settle. A paused mutation is
 * never awaited as a requirement: on the code before the fix its promise never
 * settles, so the case reads the recorded attempt instead, which is the exact
 * behaviour the change adds.
 */

const transport = vi.hoisted(() =>
  vi.fn<(input: RequestInfo | URL | string, init?: RequestInit) => Promise<Response>>()
);
const announceError = vi.hoisted(() => vi.fn());

// The mock factory is hoisted above this file's imports, so it imports lazily.
vi.mock('@/lib/trpc', async () => {
  const { createTRPCContext } = await import('@trpc/tanstack-react-query');
  const { createTRPCClient, httpLink } = await import('@trpc/client');
  return {
    ...createTRPCContext<MobileRouter>(),
    trpcClient: createTRPCClient<MobileRouter>({
      links: [httpLink({ url: 'https://record-writes.test/api/trpc', fetch: transport })],
    }),
  };
});
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: announceError, warning: vi.fn() },
}));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// The connect hand-off opens a browser through expo-web-browser, whose native
// module this node project cannot load. These cases exercise the disconnect and
// workspace writes, which never reach the hand-off.
vi.mock('@/lib/pr-review/connect-gate-platform', () => ({
  openAuthorizationAndWaitForReturn: vi.fn(),
  reportLateLaunchFailure: vi.fn(),
}));
vi.mock('@/lib/app-shell-handoff', () => ({ appShellHandoffUrl: vi.fn() }));
// The refusal hooks read the reader's role through the organization query
// chain, which pulls the Expo runtime this node project cannot load. These
// cases assert the attempt and its failure surface, not the role's copy.
vi.mock('@/lib/hooks/use-organization-queries', () => ({
  isMoneyRole: () => false,
  useOrgBoundary: () => ({ role: undefined }),
}));
vi.mock('@/lib/trial-refusal', () => ({
  useCanManageBilling: () => false,
  useBillingAction: () => undefined,
}));
vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
  useColorScheme: () => 'light',
}));

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MODE_ID = '11111111-1111-4111-8111-111111111111';
const INTEGRATION_ID = '22222222-2222-4222-8222-222222222222';

/** A mode config the procedures accept. The refused write never reads it. */
const MODE_CONFIG: OrgModeConfigInput = {
  roleDefinition: 'Review pull requests',
  groups: ['read', 'edit'],
};

function procedureOf(input: RequestInfo | URL): string {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  return url.pathname.replace(/^\/api\/trpc\//, '');
}

function callsTo(procedure: string): number {
  return transport.mock.calls.filter(([input]) => procedureOf(input as RequestInfo) === procedure)
    .length;
}

const queryClientRef = { current: createTestQueryClient() };

function wrapper({ children }: { children: ReactNode }) {
  return (
    <TRPCProvider trpcClient={trpcClient} queryClient={queryClientRef.current}>
      {children}
    </TRPCProvider>
  );
}

/**
 * One write under test: the call it makes, with its own input closed over, and
 * the hook's busy flag. Closing over the input keeps every call site typed by
 * the real hook, so no case asserts a shape the procedure does not take.
 */
type Probe = {
  write: (() => Promise<unknown>) | null;
  pending: boolean;
};

function RecordModeCreateProbe({ holder }: { holder: Probe }) {
  const modes = useOrgModeMutations(ORG_ID);
  holder.write = () =>
    modes.create.mutateAsync({ name: 'Reviewer', slug: 'reviewer', config: MODE_CONFIG });
  holder.pending = modes.create.isPending;
  return null;
}

function RecordModeUpdateProbe({ holder }: { holder: Probe }) {
  const modes = useOrgModeMutations(ORG_ID);
  holder.write = () =>
    modes.update.mutateAsync({
      modeId: MODE_ID,
      name: 'Reviewer',
      slug: 'reviewer',
      config: MODE_CONFIG,
    });
  holder.pending = modes.update.isPending;
  return null;
}

function RecordGroupCreateProbe({ holder }: { holder: Probe }) {
  const groups = useOrgGroupMutations(ORG_ID);
  holder.write = () => groups.create.mutateAsync({ name: 'Design', description: null });
  holder.pending = groups.create.isPending;
  return null;
}

function RecordInviteProbe({ holder }: { holder: Probe }) {
  const members = useOrganizationMutations(ORG_ID);
  holder.write = () => members.invite.mutateAsync({ email: 'member@example.test', role: 'member' });
  holder.pending = members.invite.isPending;
  return null;
}

function RecordTodoCreateProbe({ holder }: { holder: Probe }) {
  const todos = useTodoListMutations(null);
  holder.write = () => todos.create.mutateAsync({ name: 'Today' });
  holder.pending = todos.create.isPending;
  return null;
}

function RecordBitbucketProbe({ holder }: { holder: Probe }) {
  const connect = useConnectBitbucket(ORG_ID);
  holder.write = () => connect.mutateAsync({ accessToken: 'token' });
  holder.pending = connect.isPending;
  return null;
}

function RecordDisconnectProbe({ holder }: { holder: Probe }) {
  const disconnect = useDisconnectIntegration(ORG_ID);
  holder.write = () =>
    disconnect.mutateAsync({ provider: 'github', integrationId: INTEGRATION_ID });
  holder.pending = disconnect.isPending;
  return null;
}

type ProbeComponent = ({ holder }: { holder: Probe }) => null;

async function mountProbe(Probe: ProbeComponent) {
  const queryClient = createTestQueryClient();
  queryClientRef.current = queryClient;
  const holder: Probe = { write: null, pending: false };
  const view = await renderWithProviders(<Probe holder={holder} />, {
    queryClient,
    wrapper,
  });
  await waitFor(() => holder.write !== null);
  return { view, holder };
}

/** Let TanStack Query's scheduler and the transport's promise chain run. */
async function flushQueryUpdates(): Promise<void> {
  // A predicate that never holds is the point: the helper yields to the
  // macrotask queue between attempts, which flushes the observer notifications
  // this suite reads, then throws, so the throw is swallowed here.
  await waitFor(() => false, 8).catch(() => undefined);
}

/** Consume a write's rejection without awaiting it; the hook announces it. */
function ignoreRejection(attempt: Promise<unknown> | null): void {
  const consume = async (): Promise<void> => {
    try {
      await attempt;
    } catch {
      // Expected: the transport rejects while the device has no route.
    }
  };
  if (attempt !== null) {
    void consume();
  }
}

type OfflineWrite = Readonly<{
  /** Requests the transport saw for this procedure while offline. */
  attempted: number;
  /** The hook's `isPending` after the flush: what a Save button renders. */
  stillPending: boolean;
}>;

/**
 * Runs one write while the device reports itself offline. The caller has
 * already made the transport reject, which is what a device with no route sees.
 *
 * The write is not awaited: on the code before the fix it is paused, so its
 * promise never settles, and awaiting it would hang the case. What a person
 * sees is the busy flag and the failure announcement, so those are the facts
 * the case reads after the query scheduler flushes.
 */
async function runOfflineWrite(Probe: ProbeComponent, procedure: string): Promise<OfflineWrite> {
  const { view, holder } = await mountProbe(Probe);
  onlineManager.setOnline(false);
  // The write is not awaited: on the pre-fix code it never settles, so awaiting
  // it would hang the case. Its rejection is what the hook's own failure surface
  // announces, so this helper consumes it.
  ignoreRejection(holder.write?.() ?? null);
  await flushQueryUpdates();
  const write: OfflineWrite = {
    attempted: callsTo(procedure),
    stillPending: holder.pending,
  };
  view.unmount();
  onlineManager.setOnline(true);
  return write;
}

function failWith() {
  transport.mockImplementation(() => Promise.reject(new TypeError('Network request failed')));
}

describe('record writes while the device reports itself offline', () => {
  beforeEach(() => {
    transport.mockReset();
    announceError.mockReset();
    onlineManager.setOnline(true);
  });

  it('attempts an organization mode create instead of pausing it', async () => {
    failWith();
    const write = await runOfflineWrite(RecordModeCreateProbe, 'organizations.modes.create');

    // The attempt is the fix: a paused mutation sends nothing and never settles,
    // which leaves the form's Save busy with no failure copy.
    expect(write.attempted).toBe(1);
    // Save is usable again: a paused mutation leaves this true forever.
    expect(write.stillPending).toBe(false);
    expect(announceError).toHaveBeenCalledTimes(1);
  });

  it('attempts an organization mode update instead of pausing it', async () => {
    failWith();
    const write = await runOfflineWrite(RecordModeUpdateProbe, 'organizations.modes.update');

    expect(write.attempted).toBe(1);
    // Save is usable again: a paused mutation leaves this true forever.
    expect(write.stillPending).toBe(false);
    expect(announceError).toHaveBeenCalledTimes(1);
  });

  it('attempts an organization group create instead of pausing it', async () => {
    failWith();
    const write = await runOfflineWrite(RecordGroupCreateProbe, 'organizations.groups.create');

    expect(write.attempted).toBe(1);
    // Save is usable again: a paused mutation leaves this true forever.
    expect(write.stillPending).toBe(false);
    expect(announceError).toHaveBeenCalledTimes(1);
  });

  it('attempts a member invitation instead of pausing it', async () => {
    failWith();
    const write = await runOfflineWrite(RecordInviteProbe, 'organizations.members.invite');

    expect(write.attempted).toBe(1);
    // Save is usable again: a paused mutation leaves this true forever.
    expect(write.stillPending).toBe(false);
  });

  it('attempts a to-do list create instead of pausing it', async () => {
    failWith();
    const write = await runOfflineWrite(RecordTodoCreateProbe, 'todos.lists.create');

    expect(write.attempted).toBe(1);
    // Save is usable again: a paused mutation leaves this true forever.
    expect(write.stillPending).toBe(false);
  });

  it('attempts a Bitbucket workspace connect instead of pausing it', async () => {
    failWith();
    const write = await runOfflineWrite(RecordBitbucketProbe, 'organizations.bitbucket.connect');

    expect(write.attempted).toBe(1);
    // Save is usable again: a paused mutation leaves this true forever.
    expect(write.stillPending).toBe(false);
  });

  it('attempts an integration disconnect instead of pausing it', async () => {
    failWith();
    const write = await runOfflineWrite(RecordDisconnectProbe, 'githubApps.uninstallApp');

    expect(write.attempted).toBe(1);
    // Save is usable again: a paused mutation leaves this true forever.
    expect(write.stillPending).toBe(false);
    expect(announceError).toHaveBeenCalledTimes(1);
  });
});
