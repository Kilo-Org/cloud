import type { User } from '@kilocode/db/schema';
import { createCallerFactory } from '@/lib/trpc/init';

const mockCreateJob = jest.fn();
const mockAcquireJobLease = jest.fn();
const mockAdvanceJob = jest.fn();
const mockReleaseJobLease = jest.fn();

jest.mock('@/lib/integrations/platforms/gitlab/credential-migration-job-repository', () => ({
  acquireGitLabCredentialMigrationJobLease: (...args: unknown[]) => mockAcquireJobLease(...args),
  createGitLabCredentialMigrationJob: (...args: unknown[]) => mockCreateJob(...args),
  cancelGitLabCredentialMigrationJob: jest.fn(),
  failGitLabCredentialMigrationJob: jest.fn(),
  getGitLabCredentialMigrationJob: jest.fn(),
  listRecentGitLabCredentialMigrationJobs: jest.fn(),
  releaseGitLabCredentialMigrationJobLease: (...args: unknown[]) => mockReleaseJobLease(...args),
  GitLabCredentialMigrationJobConflictError: class GitLabCredentialMigrationJobConflictError extends Error {},
}));
jest.mock('@/lib/integrations/platforms/gitlab/credential-migration-job', () => ({
  advanceGitLabCredentialMigrationJob: (...args: unknown[]) => mockAdvanceJob(...args),
}));

import { adminGitLabCredentialMigrationRouter } from './admin-gitlab-credential-migration-router';

const createCaller = createCallerFactory(adminGitLabCredentialMigrationRouter);

const job = {
  id: '00000000-0000-4000-8000-000000000001',
  requested_mode: 'backfill' as const,
  phase: 'backfill' as const,
  status: 'queued' as const,
  requested_by_user_id: 'admin-user',
  cursor: null,
  lease_token: null,
  lease_expires_at: null,
  scanned_integrations: 0,
  mutated_integrations: 0,
  public_audit_counts: {
    legacyTokenBearingIntegrations: 0,
    oauthMissingCredentials: 0,
    patMissingCredentials: 0,
    projectMissingCredentials: 0,
    credentialProfileMismatches: 0,
    providerMetadataMismatches: 0,
    crossTablePrimaryCredentialDuplicates: 0,
    malformedMetadata: 0,
    unmappableLegacyEntries: 0,
    integrationTypeDisagreements: 0,
    legacySecretFields: 0,
  },
  private_audit_counts: {
    credentials: 0,
    secrets: 0,
    passedCredentials: 0,
    profileFailures: 0,
    configurationFailures: 0,
    parseFailures: 0,
    unknownKeyFailures: 0,
    decryptOrAadFailures: 0,
  },
  private_audit_key_id: null,
  private_audit_public_key_sha256: null,
  retry_count: 0,
  issue_integration_ids: [],
  error_code: null,
  started_at: null,
  completed_at: null,
  created_at: '2026-07-16T00:00:00.000Z',
  updated_at: '2026-07-16T00:00:00.000Z',
};

describe('admin GitLab credential migration router', () => {
  beforeEach(() => {
    mockCreateJob.mockReset();
    mockAcquireJobLease.mockReset();
    mockAdvanceJob.mockReset();
    mockReleaseJobLease.mockReset();
  });

  it('uses ordinary admin protection', async () => {
    const caller = createCaller({ user: { id: 'user', is_admin: false } as User });

    await expect(caller.startGitLabCredentialMigrationJob({ mode: 'audit' })).rejects.toMatchObject(
      { code: 'FORBIDDEN' }
    );
    await expect(caller.runGitLabCredentialMigrationJob()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mockCreateJob).not.toHaveBeenCalled();
    expect(mockAcquireJobLease).not.toHaveBeenCalled();
  });

  it('requires exact confirmation and takes the requester only from auth context', async () => {
    const caller = createCaller({ user: { id: 'admin-user', is_admin: true } as User });
    await expect(
      caller.startGitLabCredentialMigrationJob({ mode: 'backfill' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    mockCreateJob.mockResolvedValue(job);
    await caller.startGitLabCredentialMigrationJob({
      mode: 'backfill',
      confirmation: 'BACKFILL GITLAB CREDENTIALS',
    });
    expect(mockCreateJob).toHaveBeenCalledWith({
      mode: 'backfill',
      requestedByUserId: 'admin-user',
    });
  });

  it('returns noop when no migration job is available', async () => {
    const caller = createCaller({ user: { id: 'admin-user', is_admin: true } as User });
    mockAcquireJobLease.mockResolvedValue(null);

    await expect(caller.runGitLabCredentialMigrationJob()).resolves.toEqual({
      status: 'noop',
      job: null,
    });
    expect(mockAdvanceJob).not.toHaveBeenCalled();
  });

  it('advances exactly one batch and releases its lease', async () => {
    const caller = createCaller({ user: { id: 'admin-user', is_admin: true } as User });
    const leasedJob = {
      ...job,
      lease_token: '00000000-0000-4000-8000-000000000002',
      lease_expires_at: '2026-07-16T00:05:00.000Z',
      status: 'running' as const,
    };
    mockAcquireJobLease.mockResolvedValue(leasedJob);
    mockAdvanceJob.mockResolvedValue({ kind: 'advanced', job: leasedJob });

    await expect(caller.runGitLabCredentialMigrationJob()).resolves.toMatchObject({
      status: 'advanced',
      job: { id: job.id, status: 'running' },
    });
    expect(mockAdvanceJob).toHaveBeenCalledTimes(1);
    expect(mockAdvanceJob).toHaveBeenCalledWith(leasedJob);
    expect(mockReleaseJobLease).toHaveBeenCalledWith(job.id, leasedJob.lease_token);
  });
});
