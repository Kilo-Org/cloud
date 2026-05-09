import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inferPrKind } from './claims.util';

describe('inferPrKind', () => {
  it('detects claim from title', () => {
    expect(inferPrKind('wl claim: w-abc123')).toBe('claim');
  });

  it('detects done from title', () => {
    expect(inferPrKind('wl done: w-abc123')).toBe('done');
  });

  it('detects unclaim from title', () => {
    expect(inferPrKind('wl unclaim: w-abc123')).toBe('unclaim');
  });

  it('detects edit from "update" keyword', () => {
    expect(inferPrKind('wl update: w-abc123')).toBe('edit');
  });

  it('detects edit from "edit" keyword', () => {
    expect(inferPrKind('Edit wanted item w-abc123')).toBe('edit');
  });

  it('returns unknown for unrecognized titles', () => {
    expect(inferPrKind('Some random PR title')).toBe('unknown');
  });

  it('is case-insensitive', () => {
    expect(inferPrKind('WL CLAIM: w-abc123')).toBe('claim');
    expect(inferPrKind('WL Done: w-abc123')).toBe('done');
  });

  it('prefers unclaim over claim (unclaim checked first)', () => {
    expect(inferPrKind('wl unclaim: w-abc123')).toBe('unclaim');
  });

  it('prefers done over claim when both present', () => {
    expect(inferPrKind('wl done: w-abc123 after claim')).toBe('done');
  });
});

// ── listClaims procedure tests ──────────────────────────────────────────

vi.mock('../util/dolthub-api.util', () => ({
  runUnsafeSql: vi.fn(),
  listPulls: vi.fn(),
  getPull: vi.fn(),
  parseWlBranch: vi.fn(),
  buildPullWebUrl: vi.fn(),
  mapWithLimit: vi.fn(),
  DoltHubApiError: class extends Error {
    status: number;
    constructor(msg: string, status: number) {
      super(msg);
      this.status = status;
    }
  },
}));

vi.mock('./ownership', () => ({
  resolveWastelandOwnership: vi.fn(),
}));

vi.mock('../dos/Wasteland.do', () => ({
  getWastelandDOStub: vi.fn(),
}));

vi.mock('../util/secret.util', () => ({
  resolveSecret: vi.fn(),
}));

vi.mock('../util/crypto.util', () => ({
  deriveEncryptionKey: vi.fn(),
  decryptToken: vi.fn(),
  encryptToken: vi.fn(),
}));

vi.mock('../util/analytics.util', () => ({
  writeEvent: vi.fn(),
}));

vi.mock('../util/billing.util', () => ({
  meterEvent: vi.fn(),
}));

vi.mock('../wanted-board/wanted-board-ops', () => ({
  WantedBoardOpError: class extends Error {},
}));

vi.mock('../dos/WastelandContainer.do', () => ({
  getWastelandContainerStub: vi.fn(),
}));

vi.mock('../dos/WastelandRegistry.do', () => ({
  getWastelandRegistryStub: vi.fn(),
}));

vi.mock('../inbox/inbox-classifier', () => ({
  classifyInbox: vi.fn(),
}));

import { TRPCError } from '@trpc/server';
import { wastelandRouter } from './router';
import * as doltApi from '../util/dolthub-api.util';
import { resolveWastelandOwnership } from './ownership';
import { getWastelandDOStub } from '../dos/Wasteland.do';
import { resolveSecret } from '../util/secret.util';
import { deriveEncryptionKey, decryptToken } from '../util/crypto.util';

const WASTELAND_ID = '550e8400-e29b-41d4-a716-446655440000';
const USER_ID = 'user-test-001';

const mockCtx = {
  env: {} as Env,
  userId: USER_ID,
  isAdmin: false,
  apiTokenPepper: null,
  orgMemberships: [] as Array<{ orgId: string; role: 'owner' | 'member' | 'billing_manager' }>,
};

function makeClaimedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'w-item1',
    title: 'Fix login bug',
    description: null,
    project: null,
    type: 'bug',
    priority: 'high',
    tags: null,
    posted_by: 'admin',
    claimed_by: 'rig-alpha',
    status: 'claimed',
    effort_level: null,
    evidence_url: null,
    sandbox_required: null,
    sandbox_scope: null,
    sandbox_min_tier: null,
    created_at: '2025-01-01 00:00:00',
    updated_at: '2025-01-02 00:00:00',
    ...overrides,
  };
}

describe('listClaims', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (resolveWastelandOwnership as ReturnType<typeof vi.fn>).mockResolvedValue({
      type: 'user',
      userId: USER_ID,
    });
  });

  async function callListClaims(input: {
    wastelandId?: string;
    rigHandle?: string;
    limit?: number;
  }) {
    const caller = wastelandRouter.createCaller(mockCtx);
    return caller.listClaims({
      wastelandId: input.wastelandId ?? WASTELAND_ID,
      rigHandle: input.rigHandle,
      limit: input.limit,
    });
  }

  function setupAdminContext() {
    const mockStub = {
      getConfig: vi.fn().mockResolvedValue({
        dolthub_upstream: 'hop/wl-commons',
        status: 'active',
      }),
      getCredential: vi.fn().mockResolvedValue({
        encrypted_token: 'enc-token',
        is_upstream_admin: true,
        rig_handle: 'rig-alpha',
        dolthub_org: 'rig-alpha',
      }),
    };
    (getWastelandDOStub as ReturnType<typeof vi.fn>).mockReturnValue(mockStub);
    (resolveSecret as ReturnType<typeof vi.fn>).mockResolvedValue('test-key');
    (deriveEncryptionKey as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (decryptToken as ReturnType<typeof vi.fn>).mockResolvedValue('dolt-token');
  }

  it('returns all claimed items when no rigHandle filter', async () => {
    setupAdminContext();
    (doltApi.runUnsafeSql as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: [
        makeClaimedRow({ id: 'w-1', claimed_by: 'rig-alpha' }),
        makeClaimedRow({ id: 'w-2', claimed_by: 'rig-beta', title: 'Add feature' }),
      ],
    });
    (doltApi.listPulls as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (doltApi.mapWithLimit as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const result = await callListClaims({});

    expect(result.claims).toHaveLength(2);
    expect(result.claims[0].item.id).toBe('w-1');
    expect(result.claims[1].item.id).toBe('w-2');
    expect(result.claims[0].pending_pr).toBeNull();
    expect(result.claims[1].pending_pr).toBeNull();

    const sql = (doltApi.runUnsafeSql as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(sql).toContain("WHERE status = 'claimed'");
    expect(sql).not.toContain("AND claimed_by =");
  });

  it('scopes SQL to rigHandle when provided', async () => {
    setupAdminContext();
    (doltApi.runUnsafeSql as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: [makeClaimedRow({ id: 'w-1', claimed_by: 'rig-alpha' })],
    });
    (doltApi.listPulls as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (doltApi.mapWithLimit as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const result = await callListClaims({ rigHandle: 'rig-alpha' });

    expect(result.claims).toHaveLength(1);
    const sql = (doltApi.runUnsafeSql as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(sql).toContain("claimed_by = 'rig-alpha'");
  });

  it('returns empty claims when credentials are missing', async () => {
    const mockStub = {
      getConfig: vi.fn().mockResolvedValue({
        dolthub_upstream: 'hop/wl-commons',
        status: 'active',
      }),
      getCredential: vi.fn().mockResolvedValue(null),
    };
    (getWastelandDOStub as ReturnType<typeof vi.fn>).mockReturnValue(mockStub);

    const result = await callListClaims({});

    expect(result.claims).toEqual([]);
  });

  it('returns claims with pending_pr null when DoltHub PR list fails', async () => {
    setupAdminContext();
    (doltApi.runUnsafeSql as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: [makeClaimedRow({ id: 'w-1' })],
    });
    (doltApi.listPulls as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('DoltHub unavailable')
    );

    const result = await callListClaims({});

    expect(result.claims).toHaveLength(1);
    expect(result.claims[0].pending_pr).toBeNull();
  });

  it('attaches pending_pr when an open PR matches a claimed item', async () => {
    setupAdminContext();
    (doltApi.runUnsafeSql as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: [makeClaimedRow({ id: 'w-item1', claimed_by: 'rig-alpha' })],
    });

    const openPulls = [
      { pull_id: '42', creator_name: 'rig-alpha', state: 'Open' },
    ];
    (doltApi.listPulls as ReturnType<typeof vi.fn>).mockResolvedValue(openPulls);

    const pullDetail = {
      pull_id: '42',
      title: 'wl claim: w-item1',
      state: 'Open',
      from_branch_name: 'wl/rig-alpha/w-item1',
      from_branch: null,
      creator_name: 'rig-alpha',
      created_at: '2025-01-03T00:00:00Z',
      updated_at: '2025-01-03T01:00:00Z',
    };
    (doltApi.mapWithLimit as ReturnType<typeof vi.fn>).mockImplementation(
      async (items: unknown[], _limit: number, fn: (p: unknown) => Promise<unknown>) =>
        Promise.all(items.map(fn))
    );
    (doltApi.getPull as ReturnType<typeof vi.fn>).mockResolvedValue(pullDetail);
    (doltApi.parseWlBranch as ReturnType<typeof vi.fn>).mockReturnValue({
      rigHandle: 'rig-alpha',
      itemId: 'w-item1',
    });
    (doltApi.buildPullWebUrl as ReturnType<typeof vi.fn>).mockReturnValue(
      'https://www.dolthub.com/repositories/hop/wl-commons/pulls/42'
    );

    const result = await callListClaims({});

    expect(result.claims).toHaveLength(1);
    expect(result.claims[0].pending_pr).not.toBeNull();
    expect(result.claims[0].pending_pr!.pull_id).toBe('42');
    expect(result.claims[0].pending_pr!.kind).toBe('claim');
    expect(result.claims[0].pending_pr!.from_branch).toBe('wl/rig-alpha/w-item1');
    expect(result.claims[0].pending_pr!.state).toBe('Open');
  });

  it('returns empty claims when SQL query fails', async () => {
    setupAdminContext();
    (doltApi.runUnsafeSql as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('SQL failed')
    );

    const result = await callListClaims({});

    expect(result.claims).toEqual([]);
  });

  it('throws FORBIDDEN when caller is not an owner', async () => {
    (resolveWastelandOwnership as ReturnType<typeof vi.fn>).mockResolvedValue({
      type: 'org',
      orgId: 'org-1',
    });
    mockCtx.orgMemberships = [{ orgId: 'org-1', role: 'member' }];

    await expect(callListClaims({})).rejects.toThrow(/Only wasteland owners/);
  });
});
