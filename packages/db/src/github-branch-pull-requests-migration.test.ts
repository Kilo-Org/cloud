import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { github_branch_pull_requests } from './schema';

describe('GitHub branch pull request integration provenance migration', () => {
  it('defines nullable integration provenance in the schema', () => {
    expect(github_branch_pull_requests.platform_integration_id.dataType).toBe('string');
    expect(github_branch_pull_requests.platform_integration_id.notNull).toBe(false);
  });

  it('keeps historical cache rows without inferring an integration', () => {
    const migration = fs.readFileSync(
      path.join(__dirname, 'migrations/0233_conscious_joseph.sql'),
      'utf8'
    );

    expect(migration).toContain(
      'ALTER TABLE "github_branch_pull_requests" ADD COLUMN "platform_integration_id" uuid;'
    );
    expect(migration).toContain(
      'FOREIGN KEY ("platform_integration_id") REFERENCES "public"."platform_integrations"("id") ON DELETE cascade'
    );
    expect(migration).not.toMatch(/ADD COLUMN "platform_integration_id" uuid NOT NULL/);
    expect(migration).not.toMatch(/\b(?:UPDATE|DELETE FROM)\s+"?github_branch_pull_requests"?/i);
  });

  it('separates pinned integration keys from null legacy keys for both tenant types', () => {
    const migration = fs.readFileSync(
      path.join(__dirname, 'migrations/0233_conscious_joseph.sql'),
      'utf8'
    );

    expect(migration).toContain(
      'CREATE UNIQUE INDEX "UQ_github_branch_prs_org_integration" ON "github_branch_pull_requests" USING btree ("git_url","git_branch","owned_by_organization_id","platform_integration_id")'
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "UQ_github_branch_prs_user_integration" ON "github_branch_pull_requests" USING btree ("git_url","git_branch","owned_by_user_id","platform_integration_id")'
    );
    expect(migration).toContain(
      '"owned_by_organization_id" IS NOT NULL AND "github_branch_pull_requests"."platform_integration_id" IS NULL'
    );
    expect(migration).toContain(
      '"owned_by_user_id" IS NOT NULL AND "github_branch_pull_requests"."platform_integration_id" IS NULL'
    );
  });
});
