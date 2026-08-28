/* eslint-disable typescript-eslint/no-deprecated -- React Native provider tests use the installed DOM-free renderer */
/* eslint-disable require-await, typescript-eslint/require-await -- async act callbacks flush React updates; native fixture methods resolve synchronously */
/* eslint-disable max-lines -- mounted account, context, and membership races share one real QueryClient harness */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bumpAuthEpoch, currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { setSignOutActive } from '@/lib/auth/sign-out-state';
import {
  beginAuthenticatedOwner,
  contextScope,
  getAuthenticatedOwner,
  parseSelectedContext,
  selectedContextStorageKey,
  serializeSelectedContext,
} from './context-scope';
import { OrganizationProvider, useOrganization } from './organization-context';
import { ORGANIZATION_STORAGE_KEY } from './storage-keys';

const mocks = vi.hoisted(() => ({
  user: 'account-a',
  token: 'token-a' as string | undefined,
  getMe: vi.fn(),
  memberships: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
}));
vi.mock('expo-secure-store', () => ({ getItemAsync: mocks.read, setItemAsync: mocks.write }));
vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({ token: mocks.token, authEpoch: currentAuthEpoch(), isSigningOut: false }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    user: { getMe: { queryOptions: () => ({ queryKey: [['user', 'getMe'], { type: 'query' }] }) } },
  }),
  trpcClient: {
    user: { getMe: { query: mocks.getMe } },
    organizations: { list: { query: mocks.memberships } },
  },
}));

const bytes = new Map<string, string>();
let client = new QueryClient();
let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
const observed: { current: ReturnType<typeof useOrganization> | null } = { current: null };
function Probe() {
  const value = useOrganization();
  observed.current = value;
  return createElement('output', null, `${value.status}:${value.organizationId ?? 'none'}`);
}
function tree() {
  return createElement(
    QueryClientProvider,
    { client },
    createElement(OrganizationProvider, null, createElement(Probe))
  );
}
async function mount() {
  await act(async () => {
    renderer = TestRenderer.create(tree());
  });
}
function state() {
  if (!observed.current) {
    throw new Error('Context did not mount');
  }
  return observed.current;
}
function deferred<T>() {
  return Promise.withResolvers<T>();
}
async function replaceAccount(user: string) {
  await act(async () => {
    mocks.user = user;
    mocks.token = `token-${user}`;
    bumpAuthEpoch();
    beginAuthenticatedOwner();
    client.clear();
    renderer?.update(tree());
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  setSignOutActive(false);
  beginAuthenticatedOwner();
  bytes.clear();
  observed.current = null;
  mocks.user = 'account-a';
  mocks.token = 'token-a';
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mocks.getMe.mockImplementation(async () => ({
    id: mocks.user,
    email: `${mocks.user}@example.test`,
  }));
  mocks.memberships.mockResolvedValue([
    { organizationId: 'org-a' },
    { organizationId: 'personal' },
  ]);
  mocks.read.mockImplementation(async (key: string) => bytes.get(key) ?? null);
  mocks.write.mockImplementation(async (key: string, value: string) => {
    bytes.set(key, value);
  });
});
afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  client.clear();
});

describe('OrganizationProvider owner-bound restoration', () => {
  it.each(['FORBIDDEN', 'NOT_FOUND', 'UNAUTHORIZED'])(
    'marks membership %s as unavailable rather than retryable',
    async code => {
      bytes.set(
        selectedContextStorageKey('account-a'),
        serializeSelectedContext('account-a', contextScope('org-a'))
      );
      mocks.memberships.mockRejectedValueOnce({ data: { code } });
      await mount();
      expect(state()).toMatchObject({
        status: 'unavailable',
        reason: 'membership-revoked',
        isReady: false,
      });
    }
  );
  it('does not let a late membership restore replace a deliberate choice', async () => {
    bytes.set(
      selectedContextStorageKey('account-a'),
      serializeSelectedContext('account-a', contextScope('org-a'))
    );
    const gate = deferred<{ organizationId: string }[]>();
    mocks.memberships.mockReturnValueOnce(gate.promise);
    await mount();
    await act(async () => {
      state().setOrganizationId(null);
    });
    await act(async () => {
      gate.resolve([{ organizationId: 'org-a' }]);
    });
    expect(state()).toMatchObject({ status: 'ready', organizationId: null });
  });
  it('keeps an already-started old-account write bound to its original owner', async () => {
    await mount();
    const gate = deferred<undefined>();
    mocks.write.mockImplementationOnce(async (storageKey: string, value: string) => {
      await gate.promise;
      bytes.set(storageKey, value);
    });
    await act(async () => {
      state().setOrganizationId('org-a');
    });
    await replaceAccount('account-b');
    await act(async () => {
      gate.resolve(undefined);
    });
    expect(state()).toMatchObject({
      status: 'ready',
      organizationId: null,
      owner: { userId: 'account-b' },
    });
    expect(bytes.has(selectedContextStorageKey('account-b'))).toBe(false);
    expect(
      parseSelectedContext(bytes.get(selectedContextStorageKey('account-a')) ?? null, 'account-a')
    ).toEqual({ status: 'present', context: contextScope('org-a') });
  });
  it('restores saved Personal without importing the legacy organization', async () => {
    bytes.set(
      selectedContextStorageKey('account-a'),
      serializeSelectedContext('account-a', contextScope(null))
    );
    bytes.set(ORGANIZATION_STORAGE_KEY, 'org-a');
    await mount();
    expect(state()).toMatchObject({
      status: 'ready',
      isLoaded: true,
      organizationId: null,
      context: { kind: 'personal' },
    });
    expect(bytes.get(ORGANIZATION_STORAGE_KEY)).toBe('org-a');
  });
  it('admits Personal after successful absence with an empty organization list', async () => {
    mocks.memberships.mockResolvedValue([]);
    await mount();
    await act(async () => {
      state().setOrganizationId(null);
    });
    expect(state()).toMatchObject({ status: 'ready', context: { kind: 'personal' } });
  });
  it('does not label unresolved identity as Personal', async () => {
    mocks.token = undefined;
    await mount();
    expect(state()).toMatchObject({ status: 'unresolved', isReady: false, context: null });
    expect(renderer?.toJSON()).toMatchObject({ children: ['unresolved:none'] });
  });
  it('does not promote a cached getMe from a previous account into owner proof', async () => {
    const gate = deferred<{ id: string; email: string }>();
    mocks.getMe.mockReturnValue(gate.promise);
    client.setQueryData([['user', 'getMe'], { type: 'query' }], {
      id: 'previous',
      email: 'old@example.test',
    });
    await mount();
    expect(state()).toMatchObject({ status: 'unresolved', isReady: false });
    expect(getAuthenticatedOwner().userId).toBeNull();
    await act(async () => {
      gate.resolve({ id: 'account-a', email: 'a@example.test' });
      await new Promise(resolve => {
        setTimeout(resolve, 0);
      });
    });
    expect(getAuthenticatedOwner().userId).toBe('account-a');
    expect(state().status).toBe('ready');
  });
  it('waits for authoritative membership before admitting a saved organization', async () => {
    bytes.set(
      selectedContextStorageKey('account-a'),
      serializeSelectedContext('account-a', contextScope('org-a'))
    );
    const gate = deferred<{ organizationId: string }[]>();
    mocks.memberships.mockReturnValue(gate.promise);
    await mount();
    expect(state()).toMatchObject({
      status: 'unresolved',
      reason: 'membership',
      isReady: false,
      context: null,
    });
    await act(async () => {
      gate.resolve([{ organizationId: 'org-a' }]);
    });
    expect(state()).toMatchObject({ status: 'ready', organizationId: 'org-a' });
  });
  it('keeps revoked membership unavailable instead of falling back to Personal', async () => {
    bytes.set(
      selectedContextStorageKey('account-a'),
      serializeSelectedContext('account-a', contextScope('org-a'))
    );
    mocks.memberships.mockResolvedValue([]);
    await mount();
    expect(state()).toMatchObject({
      status: 'unavailable',
      reason: 'membership-revoked',
      isReady: false,
      context: null,
    });
  });
  it('retains a rejected storage read and recovers only on Retry', async () => {
    const saved = serializeSelectedContext('account-a', contextScope('org-a'));
    bytes.set(selectedContextStorageKey('account-a'), saved);
    mocks.read.mockRejectedValueOnce(new Error('temporary keychain failure'));
    await mount();
    expect(state()).toMatchObject({ status: 'failed', reason: 'storage', isLoaded: false });
    expect(bytes.get(selectedContextStorageKey('account-a'))).toBe(saved);
    await act(async () => {
      state().retry();
    });
    expect(state()).toMatchObject({ status: 'ready', organizationId: 'org-a' });
  });
  it('keeps retryable membership failure distinct from revoked membership', async () => {
    bytes.set(
      selectedContextStorageKey('account-a'),
      serializeSelectedContext('account-a', contextScope('org-a'))
    );
    mocks.memberships.mockRejectedValueOnce(new Error('offline'));
    await mount();
    expect(state()).toMatchObject({ status: 'failed', reason: 'membership', isReady: false });
    await act(async () => {
      state().retry();
    });
    expect(state().organizationId).toBe('org-a');
  });
  it.each(['{', '{"version":1,"userId":"account-b","context":{"kind":"personal"}}'])(
    'protects invalid owner records: %s',
    async value => {
      bytes.set(selectedContextStorageKey('account-a'), value);
      await mount();
      expect(state()).toMatchObject({ status: 'unavailable', isReady: false });
      expect(bytes.get(selectedContextStorageKey('account-a'))).toBe(value);
    }
  );
  it('does not let a late restore replace a deliberate Personal selection', async () => {
    const gate = deferred<string | null>();
    mocks.read.mockReturnValueOnce(gate.promise);
    await mount();
    await act(async () => {
      state().setOrganizationId(null);
    });
    await act(async () => {
      gate.resolve(serializeSelectedContext('account-a', contextScope('org-a')));
    });
    expect(state()).toMatchObject({ status: 'ready', organizationId: null });
    expect(
      parseSelectedContext(bytes.get(selectedContextStorageKey('account-a')) ?? null, 'account-a')
    ).toEqual({ status: 'present', context: { kind: 'personal' } });
  });
  it('abandons an old account context read during direct sign-in', async () => {
    const gate = deferred<string | null>();
    mocks.read.mockReturnValueOnce(gate.promise);
    await mount();
    await replaceAccount('account-b');
    await act(async () => {
      gate.resolve(serializeSelectedContext('account-a', contextScope('org-a')));
    });
    expect(state()).toMatchObject({
      status: 'ready',
      organizationId: null,
      owner: { userId: 'account-b' },
    });
  });
  it('abandons an old membership result during direct sign-in', async () => {
    bytes.set(
      selectedContextStorageKey('account-a'),
      serializeSelectedContext('account-a', contextScope('org-a'))
    );
    const gate = deferred<{ organizationId: string }[]>();
    mocks.memberships.mockReturnValueOnce(gate.promise);
    await mount();
    await replaceAccount('account-b');
    await act(async () => {
      gate.resolve([{ organizationId: 'org-a' }]);
    });
    expect(state()).toMatchObject({
      status: 'ready',
      organizationId: null,
      owner: { userId: 'account-b' },
    });
  });
  it('requires an explicit validated legacy selection and preserves its original bytes', async () => {
    bytes.set(ORGANIZATION_STORAGE_KEY, 'org-a');
    await mount();
    expect(state()).toMatchObject({
      status: 'unresolved',
      reason: 'selection-required',
      legacyOrganizationId: 'org-a',
    });
    expect(bytes.has(selectedContextStorageKey('account-a'))).toBe(false);
    await act(async () => {
      state().selectLegacyOrganization();
    });
    expect(state()).toMatchObject({ status: 'ready', organizationId: 'org-a' });
    expect(
      parseSelectedContext(bytes.get(selectedContextStorageKey('account-a')) ?? null, 'account-a')
    ).toEqual({ status: 'present', context: contextScope('org-a') });
    expect(bytes.get(ORGANIZATION_STORAGE_KEY)).toBe('org-a');
  });
  it('rejects an explicit legacy organization that no longer has membership', async () => {
    bytes.set(ORGANIZATION_STORAGE_KEY, 'revoked');
    await mount();
    await act(async () => {
      state().selectLegacyOrganization();
    });
    expect(state()).toMatchObject({ status: 'unavailable', reason: 'membership-revoked' });
    expect(bytes.has(selectedContextStorageKey('account-a'))).toBe(false);
    expect(bytes.get(ORGANIZATION_STORAGE_KEY)).toBe('revoked');
  });
  it('does not publish a failed context write as ready and Retry retains the deliberate selection', async () => {
    await mount();
    mocks.write.mockRejectedValueOnce(new Error('keychain unavailable'));
    await act(async () => {
      state().setOrganizationId('org-a');
    });
    expect(state()).toMatchObject({ status: 'failed', reason: 'write', isReady: false });
    await act(async () => {
      state().retry();
    });
    expect(state()).toMatchObject({ status: 'ready', organizationId: 'org-a' });
  });
  it('serializes selections so a held write cannot replace the later choice', async () => {
    await mount();
    const gate = deferred<undefined>();
    mocks.write.mockImplementationOnce(async (key: string, value: string) => {
      await gate.promise;
      bytes.set(key, value);
    });
    await act(async () => {
      state().setOrganizationId('org-a');
    });
    await act(async () => {
      state().setOrganizationId(null);
    });
    await act(async () => {
      gate.resolve(undefined);
    });
    expect(state()).toMatchObject({ status: 'ready', organizationId: null });
    expect(
      parseSelectedContext(bytes.get(selectedContextStorageKey('account-a')) ?? null, 'account-a')
    ).toEqual({ status: 'present', context: { kind: 'personal' } });
  });
});
