import { randomUUID } from 'node:crypto';

import { agent_configs, kilocode_users, security_findings } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { getSeedDb } from '../lib/db';

export const usage = '<fake-email>';

/** Stable row id, so a rerun replaces the same finding and the same deep link keeps working. */
const FINDING_ID = '11111111-2222-4333-8444-555555555555';

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed security:finding ${usage}`);
  console.log('Seeds a local-only fake account with one open Dependabot finding and its');
  console.log('Security Agent configuration, so the finding-detail screen renders without');
  console.log('a GitHub connection or a synced provider.');
  console.log('Requires a localhost database and SKIP_STRIPE_API=true; never calls a provider.');
  console.log('Open the returned deep link in a signed-in mobile development client.');
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  const [email, ...extra] = args;
  if (!email || extra.length || !/^kilo-[a-z0-9-]+@example\.com$/.test(email)) {
    printUsage();
    throw new Error('Provide one owned fake email matching kilo-<name>@example.com.');
  }
  const databaseUrl = new URL(process.env.POSTGRES_URL ?? '');
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname) ||
    process.env.NODE_ENV === 'production' ||
    process.env.SKIP_STRIPE_API !== 'true'
  ) {
    throw new Error('This fixture requires a local development database and SKIP_STRIPE_API=true.');
  }
  const db = getSeedDb();
  const userId = `dev-seed:security-finding:${email}`;
  const [existing] = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(eq(kilocode_users.normalized_email, email));
  if (existing && existing.id !== userId) {
    throw new Error('The requested email belongs to a different account; choose a new fake email.');
  }
  await db
    .insert(kilocode_users)
    .values({
      id: userId,
      google_user_email: email,
      normalized_email: email,
      google_user_name: 'Security finding tester',
      google_user_image_url: '',
      stripe_customer_id: `cus_local_security_finding_${randomUUID()}`,
      has_validation_stytch: false,
      customer_source: 'dev-seed',
    })
    .onConflictDoNothing();

  // A synced scope carries a configuration; without one the scope shows the
  // connect-GitHub entry instead of the findings it already holds.
  await db.delete(agent_configs).where(eq(agent_configs.owned_by_user_id, userId));
  await db.insert(agent_configs).values({
    owned_by_user_id: userId,
    agent_type: 'security_scan',
    platform: 'github',
    config: {
      repository_selection_mode: 'all',
      auto_sync_enabled: true,
    },
    created_by: userId,
  });

  await db.delete(security_findings).where(eq(security_findings.owned_by_user_id, userId));
  await db.insert(security_findings).values({
    id: FINDING_ID,
    owned_by_user_id: userId,
    repo_full_name: 'kilo-fixture/web',
    source: 'dependabot',
    source_id: '42',
    severity: 'high',
    ghsa_id: 'GHSA-35jh-r3h4-6jhm',
    cve_id: 'CVE-2021-23337',
    package_name: 'lodash',
    package_ecosystem: 'npm',
    vulnerable_version_range: '< 4.17.21',
    patched_version: '4.17.21',
    manifest_path: 'package.json',
    title: 'Command injection in lodash',
    description: 'A template option in lodash reaches the native Function constructor.',
    status: 'open',
    dependabot_html_url: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm',
    dependency_scope: 'runtime',
    analysis_status: 'completed',
    analysis_started_at: '2026-10-01T09:05:00.000Z',
    analysis_completed_at: '2026-10-01T09:20:00.000Z',
    analysis: {
      triage: {
        needsSandboxAnalysis: true,
        needsSandboxReasoning: 'The package is imported by the server bundle, so reachability needs a check.',
        suggestedAction: 'analyze_codebase',
        confidence: 'medium',
        triageAt: '2026-10-01T09:06:00.000Z',
      },
      sandboxAnalysis: {
        isExploitable: true,
        extractionStatus: 'succeeded',
        exploitabilityReasoning: 'The template option is passed user input in the report renderer.',
        usageLocations: ['src/lib/report-template.js:24', 'package.json:17'],
        suggestedFix: 'Upgrade lodash to 4.17.21.',
        suggestedAction: 'open_pr',
        summary: 'Reachable from the report renderer with attacker-controlled templates.',
        rawMarkdown: '## Summary\n\nThe vulnerable template option is reachable.',
        analysisAt: '2026-10-01T09:20:00.000Z',
        modelUsed: 'kilo-auto/frontier',
      },
      analyzedAt: '2026-10-01T09:20:00.000Z',
      modelUsed: 'kilo-auto/frontier',
      analysisModel: 'kilo-auto/frontier',
    },
    first_detected_at: '2026-10-01T09:00:00.000Z',
    last_synced_at: '2026-10-01T09:00:00.000Z',
    updated_at: '2026-10-02T09:00:00.000Z',
  });

  console.log(
    'This fixture represents: a synced personal scope whose one open finding carries a version range, a patched version, a CVE, a GHSA id, a package, a repository and a manifest path.'
  );
  console.log(
    'No provider request ran: the screen reads the seeded snapshot. The finding carries one completed analysis; no remediation attempt is seeded.'
  );
  return {
    email,
    userId,
    findingId: FINDING_ID,
    vulnerableVersionRange: '< 4.17.21',
    findingDeepLink: `kiloapp:///(app)/security-agent/personal/findings/${FINDING_ID}`,
  };
}
