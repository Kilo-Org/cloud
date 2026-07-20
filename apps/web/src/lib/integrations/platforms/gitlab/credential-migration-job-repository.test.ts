/* eslint-disable drizzle/enforce-delete-with-where */

import { afterEach, describe, expect, it } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { gitlab_credential_migration_jobs } from '@kilocode/db/schema';
import { sql } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  acquireGitLabCredentialMigrationJobLease,
  cancelGitLabCredentialMigrationJob,
  createGitLabCredentialMigrationJob,
  getGitLabCredentialMigrationJob,
  GitLabCredentialMigrationJobConflictError,
  releaseGitLabCredentialMigrationJobLease,
} from './credential-migration-job-repository';

describe('GitLab credential migration job repository', () => {
  afterEach(async () => {
    await db.delete(gitlab_credential_migration_jobs);
  });

  it('allows only one queued or running job', async () => {
    const user = await insertTestUser({ is_admin: true });
    await createGitLabCredentialMigrationJob({ mode: 'audit', requestedByUserId: user.id });

    await expect(
      createGitLabCredentialMigrationJob({ mode: 'backfill', requestedByUserId: user.id })
    ).rejects.toBeInstanceOf(GitLabCredentialMigrationJobConflictError);
  });

  it('rejects a new job while another job is running', async () => {
    const user = await insertTestUser({ is_admin: true });
    await createGitLabCredentialMigrationJob({ mode: 'audit', requestedByUserId: user.id });
    await acquireGitLabCredentialMigrationJobLease();

    await expect(
      createGitLabCredentialMigrationJob({ mode: 'backfill', requestedByUserId: user.id })
    ).rejects.toBeInstanceOf(GitLabCredentialMigrationJobConflictError);
  });

  it('fences overlapping leases and allows recovery after a graceful release', async () => {
    const user = await insertTestUser({ is_admin: true });
    const created = await createGitLabCredentialMigrationJob({
      mode: 'audit',
      requestedByUserId: user.id,
    });
    const firstLease = await acquireGitLabCredentialMigrationJobLease();
    expect(firstLease).toEqual(expect.objectContaining({ id: created.id, status: 'running' }));
    expect(await acquireGitLabCredentialMigrationJobLease()).toBeNull();
    if (!firstLease) throw new Error('Expected first lease');

    await releaseGitLabCredentialMigrationJobLease(created.id, firstLease.lease_token);
    const recoveredLease = await acquireGitLabCredentialMigrationJobLease();
    expect(recoveredLease?.id).toBe(created.id);
    expect(recoveredLease?.lease_token).not.toBe(firstLease.lease_token);
  });

  it('cancels cooperatively and permits a new job', async () => {
    const user = await insertTestUser({ is_admin: true });
    const created = await createGitLabCredentialMigrationJob({
      mode: 'scrub',
      requestedByUserId: user.id,
    });
    await acquireGitLabCredentialMigrationJobLease();

    const cancelled = await cancelGitLabCredentialMigrationJob(created.id);
    expect(cancelled).toEqual(expect.objectContaining({ status: 'cancelled', lease_token: null }));
    await expect(
      createGitLabCredentialMigrationJob({ mode: 'audit', requestedByUserId: user.id })
    ).resolves.toEqual(expect.objectContaining({ status: 'queued' }));
  });

  it('rejects malformed persisted JSON job state', async () => {
    const user = await insertTestUser({ is_admin: true });
    const created = await createGitLabCredentialMigrationJob({
      mode: 'audit',
      requestedByUserId: user.id,
    });
    await db.execute(sql`
      UPDATE gitlab_credential_migration_jobs
      SET public_audit_counts = '{"not_a_count": true}'::jsonb
      WHERE id = ${created.id}::uuid
    `);

    await expect(getGitLabCredentialMigrationJob(created.id)).rejects.toThrow();
  });
});
