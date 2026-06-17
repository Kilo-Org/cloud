import { describe, expect, it } from 'vitest';
import {
  SecurityAuditLogAction,
  SecurityAuditLogActorType,
  SecurityFindingAuditSourceContext,
} from '@kilocode/db/schema-types';
import {
  SECURITY_FINDING_AUDIT_SCHEMA_VERSION,
  SECURITY_FINDING_AUDIT_SYSTEM_ACTOR,
  buildSecurityFindingAuditHumanActor,
  buildSecurityFindingAuditLogValues,
  buildSecurityFindingAuditSnapshot,
  deriveSecurityFindingAuditEventKey,
  insertSecurityFindingAuditEvent,
  type NewSecurityFindingAuditLogValues,
  type SecurityFindingAuditEventFinding,
  type SecurityFindingAuditWriterDb,
} from './security-finding-audit';

const finding = {
  id: '11111111-1111-4111-8111-111111111111',
  owned_by_user_id: 'user_123',
  owned_by_organization_id: null,
  source: 'dependabot',
  source_id: '42',
  repo_full_name: 'kilo/example',
  title: 'lodash vulnerable to prototype pollution',
  severity: 'high',
  status: 'open',
  package_name: 'lodash',
  package_ecosystem: 'npm',
  manifest_path: 'package.json',
  patched_version: '4.17.21',
  ghsa_id: 'GHSA-xxxx-yyyy-zzzz',
  cve_id: 'CVE-2026-1234',
  cwe_ids: ['CWE-1321'],
  cvss_score: '7.5',
  dependabot_html_url: 'https://github.com/kilo/example/security/dependabot/42',
  first_detected_at: '2026-06-01 12:30:00.000+00',
  fixed_at: null,
  sla_due_at: '2026-06-08 12:30:00.000+00',
  session_id: 'ses_123',
} satisfies SecurityFindingAuditEventFinding;

const baseInput = {
  owner: { type: 'user' as const, userId: 'user_123' },
  finding,
  actor: buildSecurityFindingAuditHumanActor({
    id: 'user_123',
    email: 'owner@example.com',
    name: 'Owner User',
    isAdmin: false,
  }),
  action: SecurityAuditLogAction.FindingCreated,
  occurredAt: '2026-06-12T10:00:00.000Z',
  eventKey: deriveSecurityFindingAuditEventKey([
    'user',
    'user_123',
    finding.id,
    SecurityAuditLogAction.FindingCreated,
    'source:42',
  ]),
  sourceContext: SecurityFindingAuditSourceContext.SecuritySync,
  metadata: { source: 'dependabot', alert_number: 42 },
};

describe('security finding audit contract', () => {
  it('builds compact snapshots with normalized timestamps only', () => {
    const snapshot = buildSecurityFindingAuditSnapshot(finding);

    expect(snapshot).toMatchObject({
      finding_id: finding.id,
      source: 'dependabot',
      source_id: '42',
      repo_full_name: 'kilo/example',
      title: finding.title,
      severity: 'high',
      status: 'open',
      first_detected_at: '2026-06-01T12:30:00.000Z',
      sla_due_at: '2026-06-08T12:30:00.000Z',
    });
    expect(snapshot.fixed_at).toBeNull();
  });

  it('builds insert values with owner, finding, event, and snapshot fields', () => {
    const values = buildSecurityFindingAuditLogValues(baseInput);

    expect(values).toMatchObject({
      owned_by_user_id: 'user_123',
      owned_by_organization_id: null,
      actor_id: 'user_123',
      actor_email: 'owner@example.com',
      actor_name: 'Owner User',
      actor_type: SecurityAuditLogActorType.CustomerUser,
      action: SecurityAuditLogAction.FindingCreated,
      resource_type: 'security_finding',
      resource_id: finding.id,
      finding_id: finding.id,
      occurred_at: '2026-06-12T10:00:00.000Z',
      event_key: baseInput.eventKey,
      schema_version: SECURITY_FINDING_AUDIT_SCHEMA_VERSION,
      source_context: SecurityFindingAuditSourceContext.SecuritySync,
    });
  });

  it('persists authoritative admin and system actor classifications', () => {
    const adminValues = buildSecurityFindingAuditLogValues({
      ...baseInput,
      actor: buildSecurityFindingAuditHumanActor({
        id: 'admin_123',
        email: 'operator@example.com',
        name: 'Operator',
        isAdmin: true,
      }),
    });
    expect(adminValues).toMatchObject({
      actor_id: 'admin_123',
      actor_email: 'operator@example.com',
      actor_name: 'Operator',
      actor_type: SecurityAuditLogActorType.KiloAdmin,
    });

    const systemValues = buildSecurityFindingAuditLogValues({
      ...baseInput,
      actor: SECURITY_FINDING_AUDIT_SYSTEM_ACTOR,
    });
    expect(systemValues).toMatchObject({
      actor_id: null,
      actor_email: null,
      actor_name: null,
      actor_type: SecurityAuditLogActorType.System,
    });
  });

  it('requires a typed actor with stable identity for human events', () => {
    expect(() =>
      buildSecurityFindingAuditLogValues({
        ...baseInput,
        actor: undefined,
      } as never)
    ).toThrow();
    expect(() =>
      buildSecurityFindingAuditLogValues({
        ...baseInput,
        actor: {
          type: SecurityAuditLogActorType.CustomerUser,
          id: '',
          email: null,
          name: null,
        },
      })
    ).toThrow();
    expect(() =>
      buildSecurityFindingAuditLogValues({
        ...baseInput,
        actor: {
          type: SecurityAuditLogActorType.System,
          id: 'unexpected-human-id',
        },
      } as never)
    ).toThrow();
  });

  it('rejects owner mismatch before insert', () => {
    expect(() =>
      buildSecurityFindingAuditLogValues({
        ...baseInput,
        owner: { type: 'user', userId: 'other_user' },
      })
    ).toThrow('owner does not match');
  });

  it('rejects snapshot finding mismatch', () => {
    expect(() =>
      buildSecurityFindingAuditLogValues({
        ...baseInput,
        snapshot: {
          ...buildSecurityFindingAuditSnapshot(finding),
          finding_id: '22222222-2222-4222-8222-222222222222',
        },
      })
    ).toThrow('snapshot finding_id must match');
  });

  it('rejects non-reportable actions', () => {
    expect(() =>
      buildSecurityFindingAuditLogValues({
        ...baseInput,
        action: SecurityAuditLogAction.FindingAnalysisStarted,
      })
    ).toThrow('Action is not reportable');
  });

  it('rejects identity and sensitive values in JSON payloads', () => {
    expect(() =>
      buildSecurityFindingAuditLogValues({
        ...baseInput,
        metadata: { actor_email: 'owner@example.com' },
      })
    ).toThrow('Audit JSON field is not allowed');

    expect(() =>
      buildSecurityFindingAuditLogValues({
        ...baseInput,
        metadata: { rationale: 'contact owner@example.com' },
      })
    ).toThrow('appears to contain an email');
  });

  it('uses deterministic escaped event keys', () => {
    expect(deriveSecurityFindingAuditEventKey(['owner:user_123', 'finding/42'])).toBe(
      'security_finding_audit:v1:owner%3Auser_123:finding%2F42'
    );
  });

  it('inserts idempotently through caller-provided db or transaction', async () => {
    const insertedValues: NewSecurityFindingAuditLogValues[] = [];
    const db: SecurityFindingAuditWriterDb = {
      insert: () => ({
        values: values => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              insertedValues.push(values);
              return [{ id: 'audit_1' }];
            },
          }),
        }),
      }),
    };

    const result = await insertSecurityFindingAuditEvent(db, baseInput);

    expect(result).toEqual({ inserted: true, id: 'audit_1' });
    expect(insertedValues[0]?.event_key).toBe(baseInput.eventKey);
  });
});
