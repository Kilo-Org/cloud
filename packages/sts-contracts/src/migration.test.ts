import { describe, expect, it } from 'vitest';
import { AuditEventSchema } from './audit';
import {
  GithubRunAttestationRequestSchema,
  GithubRunAttestationResultSchema,
  MIGRATION_PROXY_AUDIT_TYPES,
  migrationProxyAuditSource,
  migrationProxyAuditStream,
} from './migration';

const github = {
  repositoryId: '1145038391',
  repositoryOwnerId: '201822503',
  environment: 'production',
  ref: 'refs/heads/main',
  sha: '0123456789abcdef0123456789abcdef01234567',
  eventName: 'workflow_run',
  jobWorkflowRef: 'Kilo-Org/cloud/.github/workflows/deploy-production.yml@refs/heads/main',
  runId: '123',
  runAttempt: '1',
};

describe('migration attestation contracts', () => {
  it('bounds the token at 8192 characters', () => {
    expect(GithubRunAttestationRequestSchema.safeParse({ token: 'x'.repeat(8192) }).success).toBe(
      true
    );
    expect(GithubRunAttestationRequestSchema.safeParse({ token: 'x'.repeat(8193) }).success).toBe(
      false
    );
    expect(GithubRunAttestationRequestSchema.safeParse({ token: '' }).success).toBe(false);
  });

  it('parses each answer and refuses an unknown reason or a malformed sha', () => {
    const ok = {
      status: 'ok',
      workload: 'ci-db-migrate',
      github,
      expiresAt: new Date().toISOString(),
    };
    expect(GithubRunAttestationResultSchema.parse(ok)).toEqual(ok);
    for (const reason of [
      'identity_rejected',
      'unknown_workload',
      'environment_mismatch',
      'grant_not_allowed',
      'caller_not_allowed',
    ]) {
      expect(GithubRunAttestationResultSchema.safeParse({ status: 'denied', reason }).success).toBe(
        true
      );
    }
    expect(
      GithubRunAttestationResultSchema.safeParse({ status: 'denied', reason: 'other_run' }).success
    ).toBe(false);
    expect(
      GithubRunAttestationResultSchema.safeParse({ ...ok, github: { ...github, sha: 'ABC' } })
        .success
    ).toBe(false);
    expect(
      GithubRunAttestationResultSchema.safeParse({ status: 'unavailable', retryAfterSeconds: 30 })
        .success
    ).toBe(true);
  });

  it('names every proxy audit type as the audit schema requires, session_sampled and the review checks included', () => {
    const types = Object.values(MIGRATION_PROXY_AUDIT_TYPES).map(entry => entry.type);
    expect(types).toEqual([
      'ai.kilo.migration_proxy.run_started',
      'ai.kilo.migration_proxy.migration_applied',
      'ai.kilo.migration_proxy.session_terminated',
      'ai.kilo.migration_proxy.run_finished',
      'ai.kilo.migration_proxy.session_sampled',
      'ai.kilo.migration_proxy.run_denied',
      'ai.kilo.migration_proxy.review_check_passed',
      'ai.kilo.migration_proxy.review_check_failed',
    ]);
    for (const { type, activityId } of Object.values(MIGRATION_PROXY_AUDIT_TYPES)) {
      const event = {
        specversion: '1.0',
        id: crypto.randomUUID(),
        source: migrationProxyAuditSource('staging'),
        type,
        time: new Date().toISOString(),
        datacontenttype: 'application/json',
        data: {
          classUid: 6003,
          activityId,
          outcome: 'success',
          actor: { kind: 'system', id: 'migration-proxy' },
          attributes: {},
        },
      };
      expect(AuditEventSchema.safeParse(event).success, type).toBe(true);
    }
    expect(migrationProxyAuditStream('production')).toBe('migration-proxy:production:runs');
  });
});
