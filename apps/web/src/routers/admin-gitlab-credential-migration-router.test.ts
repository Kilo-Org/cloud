import type { User } from '@kilocode/db/schema';
import { createCallerFactory } from '@/lib/trpc/init';

const mockBackfillBatch = jest.fn();
const mockScrubBatch = jest.fn();
const mockVerifyBatch = jest.fn();
const mockCheckKeys = jest.fn();
const mockRepairBatch = jest.fn();

jest.mock('@/lib/integrations/platforms/gitlab/credential-migration', () => ({
  backfillGitLabCredentialBatch: (...args: unknown[]) => mockBackfillBatch(...args),
  scrubGitLabCredentialBatch: (...args: unknown[]) => mockScrubBatch(...args),
}));
jest.mock('@/lib/integrations/platforms/gitlab/credential-migration-verify', () => ({
  verifyGitLabCredentialDecryptabilityBatch: (...args: unknown[]) => mockVerifyBatch(...args),
  checkGitLabCredentialKeysMatch: (...args: unknown[]) => mockCheckKeys(...args),
}));
jest.mock('@/lib/integrations/platforms/gitlab/credential-migration-repair', () => ({
  repairGitLabCustomOAuthClientSecretsBatch: (...args: unknown[]) => mockRepairBatch(...args),
}));

import { adminGitLabCredentialMigrationRouter } from './admin-gitlab-credential-migration-router';

const createCaller = createCallerFactory(adminGitLabCredentialMigrationRouter);
const admin = () => createCaller({ user: { id: 'admin-user', is_admin: true } as User });

describe('admin GitLab credential migration router', () => {
  beforeEach(() => {
    mockBackfillBatch.mockReset();
    mockScrubBatch.mockReset();
    mockVerifyBatch.mockReset();
    mockCheckKeys.mockReset();
    mockRepairBatch.mockReset();
  });

  it('uses ordinary admin protection', async () => {
    const caller = createCaller({ user: { id: 'user', is_admin: false } as User });

    await expect(caller.backfillNextBatch({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.verifyDecryptability({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.repairCustomOAuthClientSecrets({})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      caller.scrubNextBatch({ confirmation: 'SCRUB GITLAB PLAINTEXT' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockBackfillBatch).not.toHaveBeenCalled();
    expect(mockScrubBatch).not.toHaveBeenCalled();
    expect(mockRepairBatch).not.toHaveBeenCalled();
  });

  it('passes keyset paging through to the backfill batch', async () => {
    mockBackfillBatch.mockResolvedValue({
      processed: 2,
      mutated: 2,
      unmappable: 0,
      nextCursor: '00000000-0000-4000-8000-00000000000a',
    });

    await expect(
      admin().backfillNextBatch({ afterId: '00000000-0000-4000-8000-000000000001', limit: 50 })
    ).resolves.toMatchObject({ processed: 2, nextCursor: '00000000-0000-4000-8000-00000000000a' });
    expect(mockBackfillBatch).toHaveBeenCalledWith({
      limit: 50,
      afterId: '00000000-0000-4000-8000-000000000001',
    });
  });

  it('returns the verification batch and maps errors by retryability', async () => {
    mockVerifyBatch.mockResolvedValueOnce({
      kind: 'ok',
      batch: { keyMatches: true, batchPasses: true },
    });
    await expect(admin().verifyDecryptability({})).resolves.toEqual({
      keyMatches: true,
      batchPasses: true,
    });
    expect(mockVerifyBatch).toHaveBeenCalledWith({ requestedByUserId: 'admin-user', cursor: null });

    mockVerifyBatch.mockResolvedValueOnce({
      kind: 'error',
      errorCode: 'private_public_key_mismatch',
      retryable: false,
    });
    await expect(admin().verifyDecryptability({})).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    mockVerifyBatch.mockResolvedValueOnce({
      kind: 'error',
      errorCode: 'audit_unavailable',
      retryable: true,
    });
    await expect(admin().verifyDecryptability({})).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
  });

  it('passes repair paging through and maps errors by retryability', async () => {
    mockRepairBatch.mockResolvedValueOnce({
      kind: 'ok',
      batch: { counts: { candidates: 4, repaired: 4 }, nextCursor: null },
    });
    await expect(
      admin().repairCustomOAuthClientSecrets({
        afterId: '00000000-0000-4000-8000-000000000001',
        limit: 50,
      })
    ).resolves.toEqual({ counts: { candidates: 4, repaired: 4 }, nextCursor: null });
    expect(mockRepairBatch).toHaveBeenCalledWith({
      requestedByUserId: 'admin-user',
      afterId: '00000000-0000-4000-8000-000000000001',
      limit: 50,
    });

    mockRepairBatch.mockResolvedValueOnce({
      kind: 'error',
      errorCode: 'repair_unavailable',
      retryable: true,
    });
    await expect(admin().repairCustomOAuthClientSecrets({})).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
  });

  it('refuses to scrub without exact confirmation', async () => {
    await expect(admin().scrubNextBatch({ confirmation: 'nope' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockCheckKeys).not.toHaveBeenCalled();
    expect(mockScrubBatch).not.toHaveBeenCalled();
  });

  it('refuses to scrub when the web and service keys do not match', async () => {
    mockCheckKeys.mockResolvedValue({ ok: false, errorCode: 'private_public_key_mismatch' });

    await expect(
      admin().scrubNextBatch({ confirmation: 'SCRUB GITLAB PLAINTEXT' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockCheckKeys).toHaveBeenCalledWith('admin-user');
    expect(mockScrubBatch).not.toHaveBeenCalled();
  });

  it('scrubs a batch once confirmation and the key match pass', async () => {
    mockCheckKeys.mockResolvedValue({ ok: true });
    mockScrubBatch.mockResolvedValue({
      processed: 1,
      scrubbed: 1,
      skipped: 0,
      nextCursor: null,
    });

    await expect(
      admin().scrubNextBatch({ confirmation: 'SCRUB GITLAB PLAINTEXT', limit: 10 })
    ).resolves.toEqual({ processed: 1, scrubbed: 1, skipped: 0, nextCursor: null });
    expect(mockScrubBatch).toHaveBeenCalledWith({ limit: 10, afterId: null });
  });
});
