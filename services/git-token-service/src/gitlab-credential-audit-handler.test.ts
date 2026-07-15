import { getWorkerDb } from '@kilocode/db/client';
import { describe, expect, it } from 'vitest';
import { buildGitLabCredentialAuditAdminQuery } from './gitlab-credential-audit-handler.js';

describe('GitLab credential audit operator authorization', () => {
  it('requires the exact caller to be both an admin and unblocked in the database', () => {
    const query = buildGitLabCredentialAuditAdminQuery(
      getWorkerDb('postgres://query-builder'),
      'admin-1'
    ).toSQL();

    expect(query.sql).toContain('from "kilocode_users"');
    expect(query.sql).toContain('"kilocode_users"."id" =');
    expect(query.sql).toContain('"kilocode_users"."is_admin" =');
    expect(query.sql).toContain('"kilocode_users"."blocked_reason" is null');
    expect(query.params).toContain('admin-1');
    expect(query.params).toContain(true);
  });
});
