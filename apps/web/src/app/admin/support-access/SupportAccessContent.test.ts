import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import type { SupportAccessContent as ContentComponent } from './SupportAccessContent';

const requestId = 'aaaaaaaa-1111-4111-8111-111111111111';
const otherId = 'bbbbbbbb-2222-4222-8222-222222222222';
const requesterId = 'user-requester';
const approverId = 'user-approver';

type SupportRow = {
  id: string;
  actorKiloUserId: string;
  organizationId: string;
  actionClass: 'support_write';
  grantKind: 'standard' | 'emergency';
  status: 'pending' | 'active';
  reason: string;
  ticketReference: string | null;
  requestedAt: string;
  requestExpiresAt: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  approvedByKiloUserId: string | null;
  reviewRequired: boolean;
  reviewedAt: string | null;
  organizationName: string;
  actor: { id: string; name: string; email: string };
  approvedBy: null;
};

function writeRow(params: {
  id: string;
  actorKiloUserId: string;
  grantKind?: 'standard' | 'emergency';
  status?: 'pending' | 'active';
}): SupportRow {
  const emergency = params.grantKind === 'emergency';
  return {
    id: params.id,
    actorKiloUserId: params.actorKiloUserId,
    organizationId: 'org-customer-1',
    actionClass: 'support_write',
    grantKind: params.grantKind ?? 'standard',
    status: params.status ?? 'pending',
    reason: 'Investigating a customer incident',
    ticketReference: null,
    requestedAt: '2026-11-07T10:00:00.000Z',
    requestExpiresAt: '2026-11-07T11:00:00.000Z',
    issuedAt: emergency ? '2026-11-07T10:00:00.000Z' : null,
    expiresAt: '2026-11-07T10:15:00.000Z',
    approvedByKiloUserId: null,
    reviewRequired: emergency,
    reviewedAt: null,
    organizationName: 'Customer organization',
    actor: {
      id: params.actorKiloUserId,
      name: 'Grant holder',
      email: `holder-${params.actorKiloUserId}@example.com`,
    },
    approvedBy: null,
  };
}

let mockSession: { status: string; data: { kiloUserId: string } | null } = {
  status: 'loading',
  data: null,
};
const mockMine = { data: [] as SupportRow[], isLoading: false, error: null };
const mockPending = { data: undefined as SupportRow[] | undefined, error: null };
const mockActive = { data: [] as SupportRow[], error: null };
const mockEmergencies = { data: undefined as SupportRow[] | undefined, error: null };
const mockOrgSearch = { data: undefined, isFetching: false, error: null };
const mockMutate = jest.fn();

jest.mock('next-auth/react', () => ({ useSession: () => mockSession }));
// The spread in each component query erases wiring identity, so each options
// object carries a routing tag (kind) that the mocked useQuery switches on.
jest.mock('@tanstack/react-query', () => ({
  useQuery: (options: { kind?: string }) => {
    switch (options.kind) {
      case 'pending':
        return mockPending;
      case 'active':
        return mockActive;
      case 'emergencies':
        return mockEmergencies;
      case 'org-search':
        return mockOrgSearch;
      default:
        return mockMine;
    }
  },
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
  useMutation: () => ({ isPending: false, mutate: mockMutate }),
}));
jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    admin: {
      supportAccess: {
        listMine: { queryOptions: () => ({ kind: 'mine' }), queryKey: () => ['support-mine'] },
        listPending: {
          queryOptions: () => ({ kind: 'pending' }),
          queryKey: () => ['support-pending'],
        },
        listActive: {
          queryOptions: () => ({ kind: 'active' }),
          queryKey: () => ['support-active'],
        },
        listUnreviewedEmergency: {
          queryOptions: () => ({ kind: 'emergencies' }),
          queryKey: () => ['support-emergencies'],
        },
        request: { mutationOptions: jest.fn() },
        approve: { mutationOptions: jest.fn() },
        deny: { mutationOptions: jest.fn() },
        cancel: { mutationOptions: jest.fn() },
        revoke: { mutationOptions: jest.fn() },
        emergencyIssue: { mutationOptions: jest.fn() },
        review: { mutationOptions: jest.fn() },
      },
    },
    organizations: {
      admin: {
        search: { queryOptions: () => ({ kind: 'org-search' }) },
      },
    },
  }),
}));
jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
jest.mock('next/link', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => createElement('a', props),
}));

describe('SupportAccessContent', () => {
  let container: HTMLElement;
  let root: Root;
  let cleanup: () => void;
  let Content: typeof ContentComponent;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSession = { status: 'loading', data: null };
    mockMine.data = [];
    mockPending.data = undefined;
    mockActive.data = [];
    mockEmergencies.data = undefined;
    const { parseHTML } = createRequire(__filename)('linkedom') as {
      parseHTML: (html: string) => { window: typeof globalThis; document: Document };
    };
    const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
    document.oninput = null;
    const globals = {
      React,
      window,
      document,
      HTMLElement: window.HTMLElement,
      HTMLTextAreaElement: window.HTMLTextAreaElement,
      Event: window.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = new Map(
      Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
    );
    Object.assign(globalThis, globals);
    cleanup = () => {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    };
    const element = document.getElementById('root');
    if (!element) throw new Error('Test root missing');
    container = element;
    // Dynamic import is required: the jest.mock factories above reference
    // top-level let bindings that only hold their per-test values after
    // beforeEach runs, so the component module must load after mock setup
    // (same pattern as OrganizationFeaturesContent.test.ts).
    const { createRoot } = await import('react-dom/client');
    ({ SupportAccessContent: Content } = await import('./SupportAccessContent'));
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    cleanup?.();
  });

  function render() {
    act(() => root.render(createElement(Content)));
  }

  function rowFor(rowText: string): { find: (label: string) => HTMLButtonElement } {
    const rows = Array.from(container.querySelectorAll('tr')).filter(
      row => row.textContent?.includes(rowText) ?? false
    );
    expect(rows).toHaveLength(1);
    return {
      find: (label: string) => {
        const found = Array.from(rows[0].querySelectorAll('button')).find(
          candidate => candidate.textContent === label
        );
        if (!found) throw new Error(`Button missing: ${label}`);
        return found as HTMLButtonElement;
      },
    };
  }

  it('disables Approve and Deny for the viewer’s own request while the session is unresolved', () => {
    mockPending.data = [writeRow({ id: requestId, actorKiloUserId: requesterId })];
    mockSession = { status: 'loading', data: null };
    render();

    const row = rowFor('holder-user-requester@example.com');
    expect(row.find('Approve').disabled).toBe(true);
    expect(row.find('Deny').disabled).toBe(true);
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('disables Approve and Deny when the session never resolves on a failed fetch', () => {
    mockPending.data = [writeRow({ id: requestId, actorKiloUserId: requesterId })];
    mockSession = { status: 'unauthenticated', data: null };
    render();

    const row = rowFor('holder-user-requester@example.com');
    expect(row.find('Approve').disabled).toBe(true);
    expect(row.find('Deny').disabled).toBe(true);
  });

  it('keeps the viewer’s own request disabled once the session resolves', () => {
    mockPending.data = [writeRow({ id: requestId, actorKiloUserId: requesterId })];
    mockSession = { status: 'authenticated', data: { kiloUserId: requesterId } };
    render();

    const row = rowFor('holder-user-requester@example.com');
    expect(row.find('Approve').disabled).toBe(true);
    expect(row.find('Deny').disabled).toBe(true);
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('enables Approve and Deny for a request raised by someone else', () => {
    mockPending.data = [writeRow({ id: otherId, actorKiloUserId: approverId })];
    mockSession = { status: 'authenticated', data: { kiloUserId: requesterId } };
    render();

    const row = rowFor('holder-user-approver@example.com');
    expect(row.find('Approve').disabled).toBe(false);
    expect(row.find('Deny').disabled).toBe(false);
    act(() => row.find('Approve').click());
    expect(mockMutate).toHaveBeenCalledWith({ grantId: otherId });
    act(() => row.find('Deny').click());
    expect(mockMutate).toHaveBeenCalledWith({ grantId: otherId });
  });

  it('resolves the session for a different viewer of the same row', () => {
    mockPending.data = [writeRow({ id: otherId, actorKiloUserId: approverId })];
    mockSession = { status: 'authenticated', data: { kiloUserId: 'user-third' } };
    render();

    const row = rowFor('holder-user-approver@example.com');
    expect(row.find('Approve').disabled).toBe(false);
    expect(row.find('Deny').disabled).toBe(false);
  });

  it('disables Mark reviewed while the session is unresolved and for the issuing viewer', () => {
    mockEmergencies.data = [
      writeRow({
        id: requestId,
        actorKiloUserId: requesterId,
        grantKind: 'emergency',
        status: 'active',
      }),
    ];
    mockSession = { status: 'loading', data: null };
    render();
    expect(rowFor('holder-user-requester@example.com').find('Mark reviewed').disabled).toBe(true);

    mockSession = { status: 'authenticated', data: { kiloUserId: requesterId } };
    render();
    expect(rowFor('holder-user-requester@example.com').find('Mark reviewed').disabled).toBe(true);
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('enables Mark reviewed for a grant issued by someone else', () => {
    const thirdId = 'user-third';
    mockEmergencies.data = [
      writeRow({
        id: requestId,
        actorKiloUserId: requesterId,
        grantKind: 'emergency',
        status: 'active',
      }),
      writeRow({ id: otherId, actorKiloUserId: thirdId, grantKind: 'emergency', status: 'active' }),
    ];
    mockSession = { status: 'authenticated', data: { kiloUserId: approverId } };
    render();

    expect(rowFor('holder-user-requester@example.com').find('Mark reviewed').disabled).toBe(false);
    expect(rowFor('holder-user-third@example.com').find('Mark reviewed').disabled).toBe(false);
    const other = rowFor('holder-user-third@example.com');
    act(() => other.find('Mark reviewed').click());
    expect(mockMutate).toHaveBeenCalledWith({ grantId: otherId });
  });

  it('disables Mark reviewed for the issuer’s own grant', () => {
    mockEmergencies.data = [
      writeRow({
        id: requestId,
        actorKiloUserId: requesterId,
        grantKind: 'emergency',
        status: 'active',
      }),
      writeRow({
        id: otherId,
        actorKiloUserId: approverId,
        grantKind: 'emergency',
        status: 'active',
      }),
    ];
    mockSession = { status: 'authenticated', data: { kiloUserId: requesterId } };
    render();

    expect(rowFor('holder-user-requester@example.com').find('Mark reviewed').disabled).toBe(true);
    expect(rowFor('holder-user-approver@example.com').find('Mark reviewed').disabled).toBe(false);
    expect(mockMutate).not.toHaveBeenCalled();
  });
});
