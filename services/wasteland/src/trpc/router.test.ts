import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCallerFactory } from './init';
import { wastelandRouter } from './router';

vi.mock('./ownership', () => ({
  resolveWastelandOwnership: vi.fn(),
}));

vi.mock('../dos/Wasteland.do', () => ({
  getWastelandDOStub: vi.fn(),
}));

vi.mock('../dos/WastelandContainer.do', () => ({
  getWastelandContainerStub: vi.fn(),
}));

vi.mock('../dos/WastelandRegistry.do', () => ({
  getWastelandRegistryStub: vi.fn(),
}));

vi.mock('../wanted-board/wanted-board-ops', () => ({
  browseWantedBoard: vi.fn(),
  WantedBoardOpError: class WantedBoardOpError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'WantedBoardOpError';
      this.code = code;
    }
  },
}));

vi.mock('../util/dolthub-api.util', () => ({
  listPulls: vi.fn(),
  getPull: vi.fn(),
  mapWithLimit: vi.fn(),
  parseWlBranch: vi.fn(),
  buildPullWebUrl: vi.fn(() => 'https://www.dolthub.com/repositories/o/d/pulls/1'),
  runUnsafeSql: vi.fn(),
  runWrite: vi.fn(),
  createPull: vi.fn(),
  mergePull: vi.fn(),
  waitForMergeCompletion: vi.fn(),
  closePull: vi.fn(),
  deleteBranch: vi.fn(),
  DoltHubApiError: class DoltHubApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = 'DoltHubApiError';
      this.status = status;
    }
  },
}));

vi.mock('../util/crypto.util', () => ({
  deriveEncryptionKey: vi.fn(),
  encryptToken: vi.fn(),
  decryptToken: vi.fn(),
}));

vi.mock('../util/secret.util', () => ({
  resolveSecret: vi.fn(),
}));

vi.mock('../util/billing.util', () => ({
  meterEvent: vi.fn(),
}));

vi.mock('../util/analytics.util', () => ({
  writeEvent: vi.fn(),
}));

vi.mock('../inbox/inbox-classifier', () => ({
  parseCommitSubject: vi.fn(),
}));

import { resolveWastelandOwnership } from './ownership';
import { getWastelandDOStub } from '../dos/Wasteland.do';
import * as wantedBoard from '../wanted-board/wanted-board-ops';
import * as doltApi from '../util/dolthub-api.util';
import { resolveSecret } from '../util/secret.util';
import { decryptToken } from '../util/crypto.util';

const WASTELAND_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const USER_ID = 'user-001';

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    env: { WASTELAND_ENCRYPTION_KEY: 'test-key' } as unknown as Env,
    userId: USER_ID,
    isAdmin: false,
    apiTokenPepper: null,
    orgMemberships: [],
    ...overrides,
  };
}

const createCaller = createCallerFactory(wastelandRouter);

describe('listClaims', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('filters claimed items by rigHandle', async () => {
    vi.mocked(resolveWastelandOwnership).mockResolvedValue({ type: 'user', userId: USER_ID });
    vi.mocked(wantedBoard.browseWantedBoard).mockResolvedValue([
      { id: 'w-1', title: 'Item 1', status: 'claimed', claimed_by: 'rig-alpha' },
      { id: 'w-2', title: 'Item 2', status: 'claimed', claimed_by: 'rig-beta' },
      { id: 'w-3', title: 'Item 3', status: 'open', claimed_by: null },
    ]);
    vi.mocked(resolveSecret).mockResolvedValue(null);

    const caller = createCaller(makeCtx());
    const result = await caller.listClaims({
      wastelandId: WASTELAND_ID,
      rigHandle: 'rig-alpha',
    });

    expect(result).toHaveLength(1);
    expect(result[0].item.id).toBe('w-1');
    expect(result[0].item.claimed_by).toBe('rig-alpha');
  });

  it('returns only claimed items when no rigHandle filter', async () => {
    vi.mocked(resolveWastelandOwnership).mockResolvedValue({ type: 'user', userId: USER_ID });
    vi.mocked(wantedBoard.browseWantedBoard).mockResolvedValue([
      { id: 'w-1', title: 'Item 1', status: 'claimed', claimed_by: 'rig-alpha' },
      { id: 'w-2', title: 'Item 2', status: 'open', claimed_by: null },
      { id: 'w-3', title: 'Item 3', status: 'claimed', claimed_by: 'rig-beta' },
    ]);
    vi.mocked(resolveSecret).mockResolvedValue(null);

    const caller = createCaller(makeCtx());
    const result = await caller.listClaims({ wastelandId: WASTELAND_ID });

    expect(result).toHaveLength(2);
    const ids = result.map(r => r.item.id);
    expect(ids).toContain('w-1');
    expect(ids).toContain('w-3');
  });

  it('returns pending_pr when DoltHub has matching open claim PR', async () => {
    vi.mocked(resolveWastelandOwnership).mockResolvedValue({ type: 'user', userId: USER_ID });
    vi.mocked(wantedBoard.browseWantedBoard).mockResolvedValue([
      { id: 'w-1', title: 'Item 1', status: 'claimed', claimed_by: 'rig-alpha' },
    ]);

    const mockStub = {
      getConfig: vi.fn().mockResolvedValue({ dolthub_upstream: 'org/repo', owner_user_id: USER_ID }),
      getCredential: vi.fn().mockResolvedValue({
        encrypted_token: 'enc',
        dolthub_org: 'org',
        rig_handle: 'rig-alpha',
        is_upstream_admin: true,
      }),
    };
    vi.mocked(getWastelandDOStub).mockReturnValue(mockStub as never);
    vi.mocked(resolveSecret).mockResolvedValue('secret-key');
    vi.mocked(decryptToken).mockResolvedValue('dolt-token');
    vi.mocked(doltApi.listPulls).mockResolvedValue([
      { pull_id: 'pr-1', creator_name: 'rig-alpha' },
    ]);
    vi.mocked(doltApi.mapWithLimit).mockImplementation(async (items, _limit, fn) => {
      return Promise.all(items.map(fn));
    });
    vi.mocked(doltApi.getPull).mockResolvedValue({
      pull_id: 'pr-1',
      from_branch_name: 'wl/rig-alpha/w-1',
      title: 'wl claim: w-1',
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    });
    vi.mocked(doltApi.parseWlBranch).mockReturnValue({ rigHandle: 'rig-alpha', itemId: 'w-1' });
    vi.mocked(doltApi.buildPullWebUrl).mockReturnValue('https://www.dolthub.com/repositories/org/repo/pulls/pr-1');

    const { parseCommitSubject } = await import('../inbox/inbox-classifier');
    vi.mocked(parseCommitSubject).mockReturnValue({ kind: 'wl', verb: 'claim', itemId: 'w-1' });

    const caller = createCaller(makeCtx());
    const result = await caller.listClaims({ wastelandId: WASTELAND_ID });

    expect(result).toHaveLength(1);
    const pr = result[0].pending_pr;
    expect(pr).not.toBeNull();
    expect(pr?.kind).toBe('claim');
    expect(pr?.pull_id).toBe('pr-1');
  });

  it('returns pending_pr with kind=done for done PRs', async () => {
    vi.mocked(resolveWastelandOwnership).mockResolvedValue({ type: 'user', userId: USER_ID });
    vi.mocked(wantedBoard.browseWantedBoard).mockResolvedValue([
      { id: 'w-2', title: 'Item 2', status: 'claimed', claimed_by: 'rig-alpha' },
    ]);

    const mockStub = {
      getConfig: vi.fn().mockResolvedValue({ dolthub_upstream: 'org/repo', owner_user_id: USER_ID }),
      getCredential: vi.fn().mockResolvedValue({
        encrypted_token: 'enc',
        dolthub_org: 'org',
        rig_handle: 'rig-alpha',
        is_upstream_admin: true,
      }),
    };
    vi.mocked(getWastelandDOStub).mockReturnValue(mockStub as never);
    vi.mocked(resolveSecret).mockResolvedValue('secret-key');
    vi.mocked(decryptToken).mockResolvedValue('dolt-token');
    vi.mocked(doltApi.listPulls).mockResolvedValue([
      { pull_id: 'pr-2', creator_name: 'rig-alpha' },
    ]);
    vi.mocked(doltApi.mapWithLimit).mockImplementation(async (items, _limit, fn) => {
      return Promise.all(items.map(fn));
    });
    vi.mocked(doltApi.getPull).mockResolvedValue({
      pull_id: 'pr-2',
      from_branch_name: 'wl/rig-alpha/w-2',
      title: 'wl done: w-2',
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    });
    vi.mocked(doltApi.parseWlBranch).mockReturnValue({ rigHandle: 'rig-alpha', itemId: 'w-2' });
    vi.mocked(doltApi.buildPullWebUrl).mockReturnValue('https://www.dolthub.com/repositories/org/repo/pulls/pr-2');

    const { parseCommitSubject } = await import('../inbox/inbox-classifier');
    vi.mocked(parseCommitSubject).mockReturnValue({ kind: 'wl', verb: 'done', itemId: 'w-2' });

    const caller = createCaller(makeCtx());
    const result = await caller.listClaims({ wastelandId: WASTELAND_ID });

    expect(result).toHaveLength(1);
    expect(result[0].pending_pr?.kind).toBe('done');
  });

  it('returns empty array when DoltHub enrichment fails', async () => {
    vi.mocked(resolveWastelandOwnership).mockResolvedValue({ type: 'user', userId: USER_ID });

    const { WantedBoardOpError } = await import('../wanted-board/wanted-board-ops');
    vi.mocked(wantedBoard.browseWantedBoard).mockRejectedValue(
      new WantedBoardOpError('Not configured', 'PRECONDITION_FAILED')
    );

    const caller = createCaller(makeCtx());
    const result = await caller.listClaims({ wastelandId: WASTELAND_ID });

    expect(result).toEqual([]);
  });

  it('sets pending_pr to null when credential loading fails', async () => {
    vi.mocked(resolveWastelandOwnership).mockResolvedValue({ type: 'user', userId: USER_ID });
    vi.mocked(wantedBoard.browseWantedBoard).mockResolvedValue([
      { id: 'w-1', title: 'Item 1', status: 'claimed', claimed_by: 'rig-alpha' },
    ]);

    const mockStub = {
      getConfig: vi.fn().mockResolvedValue({ dolthub_upstream: null }),
    };
    vi.mocked(getWastelandDOStub).mockReturnValue(mockStub as never);

    const caller = createCaller(makeCtx());
    const result = await caller.listClaims({ wastelandId: WASTELAND_ID });

    expect(result).toHaveLength(1);
    expect(result[0].pending_pr).toBeNull();
  });
});

describe('forceUnclaimWantedItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects empty reason via Zod validation', async () => {
    const caller = createCaller(makeCtx());
    await expect(
      caller.forceUnclaimWantedItem({
        wastelandId: WASTELAND_ID,
        itemId: 'w-1',
        reason: '',
      })
    ).rejects.toThrow();
  });

  it('rejects whitespace-only reason', async () => {
    const caller = createCaller(makeCtx());
    await expect(
      caller.forceUnclaimWantedItem({
        wastelandId: WASTELAND_ID,
        itemId: 'w-1',
        reason: '   ',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('requires upstream admin (isUpstreamAdmin=false yields FORBIDDEN)', async () => {
    vi.mocked(resolveWastelandOwnership).mockResolvedValue({ type: 'user', userId: USER_ID });

    const mockStub = {
      getConfig: vi.fn().mockResolvedValue({
        dolthub_upstream: 'org/repo',
        owner_user_id: USER_ID,
      }),
      getCredential: vi.fn().mockResolvedValue({
        encrypted_token: 'enc',
        dolthub_org: 'org',
        rig_handle: 'admin-rig',
        is_upstream_admin: false,
      }),
    };
    vi.mocked(getWastelandDOStub).mockReturnValue(mockStub as never);
    vi.mocked(resolveSecret).mockResolvedValue('secret-key');
    vi.mocked(decryptToken).mockResolvedValue('dolt-token');

    const caller = createCaller(makeCtx());
    await expect(
      caller.forceUnclaimWantedItem({
        wastelandId: WASTELAND_ID,
        itemId: 'w-1',
        reason: 'Stale claim',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects itemId with invalid characters', async () => {
    const caller = createCaller(makeCtx());
    await expect(
      caller.forceUnclaimWantedItem({
        wastelandId: WASTELAND_ID,
        itemId: 'w-1; DROP TABLE wanted--',
        reason: 'SQL injection test',
      })
    ).rejects.toThrow();
  });
});
