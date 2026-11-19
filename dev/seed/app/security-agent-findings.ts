import { randomUUID } from 'node:crypto';

import { kilocode_users, organization_memberships, security_findings } from '@kilocode/db/schema';
import { and, eq, inArray } from 'drizzle-orm';

import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import type { SeedResult } from '../index';

export const usage = '<email> [--empty | --denied <organization-id>]';

const SOURCE_IDS = ['seed-redos-1', 'seed-left-pad-1'] as const;

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:security-agent-findings ${usage}`);
  console.log('');
  console.log('Seeds the personal Security Agent of an existing seeded user with one dismissed');
  console.log('finding and one open finding that has an SLA deadline. Both carry advisory text');
  console.log('with the wrapped lines GitHub returns, so the finding detail screen is reachable');
  console.log('with real provider-shaped copy.');
  console.log('');
  console.log('Variants:');
  console.log(
    '  --empty            removes this topic\u2019s two findings, so the personal finding'
  );
  console.log('                     list is empty; the audit report has no recorded event either.');
  console.log('  --denied <org-id>  writes nothing and returns the links for an organization the');
  console.log('                     account is a plain member of: the audit report answers the');
  console.log('                     billing-role refusal and the settings screen is read-only.');
  console.log('                     Seed that membership first with app:mobile-org-states.');
  console.log('');
  console.log('Usage:');
  console.log('  pnpm dev:seed app:create-user "Security Fixture" sec@example.com');
  console.log('  pnpm dev:seed app:security-agent-findings sec@example.com');
  console.log('  pnpm dev:seed app:security-agent-findings sec@example.com --empty');
  console.log('  pnpm dev:seed app:security-agent-findings sec@example.com --denied <org-id>');
  console.log('');
  console.log('Open a finding with:');
  console.log('  adb shell "am start -a android.intent.action.VIEW \\');
  console.log(
    "    -d 'kiloapp:///(app)/security-agent/personal/findings/<id>' com.kilocode.kiloapp\""
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const [email, ...rest] = args;
  if (!email || email.startsWith('-')) {
    printUsage();
    throw new Error('email is required');
  }
  const emptyVariant = rest.length === 1 && rest[0] === '--empty';
  const deniedVariant = rest.length === 2 && rest[0] === '--denied' && rest[1].length > 0;
  if (rest.length > 0 && !emptyVariant && !deniedVariant) {
    throw new Error(
      `unexpected arguments: ${rest.join(' ')}; pass --empty or --denied <organization-id>`
    );
  }
  const deniedOrganizationId = deniedVariant ? rest[1] : null;

  assertLocalSeedDatabase('app:security-agent-findings');
  const db = getSeedDb();
  const normalizedEmail = normalizeSeedEmail(email.trim());
  const users = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(eq(kilocode_users.normalized_email, normalizedEmail))
    .limit(1);
  const user = users[0];
  if (!user) {
    throw new Error(
      `no user has the email ${email}; create one first with pnpm dev:seed app:create-user "<name>" ${email}`
    );
  }

  // Idempotent rerun: the two fixtures are the only rows this topic owns, so it
  // deletes them by their stable source ids before inserting fresh copies. The
  // returned rows are the ones `--empty` reports it removed.
  const removedFindings = await db
    .delete(security_findings)
    .where(
      and(
        eq(security_findings.owned_by_user_id, user.id),
        inArray(security_findings.source_id, [...SOURCE_IDS])
      )
    )
    .returning({ id: security_findings.id });

  if (deniedOrganizationId !== null) {
    // The denial is the server's role refusal, not a row: the audit-report
    // procedure is owner-or-billing-only, so a plain member's read is refused.
    // Check the membership here so a wrong id fails at the seed, not as a
    // silently different screen later.
    const [membership] = await db
      .select({ role: organization_memberships.role })
      .from(organization_memberships)
      .where(
        and(
          eq(organization_memberships.organization_id, deniedOrganizationId),
          eq(organization_memberships.kilo_user_id, user.id)
        )
      )
      .limit(1);
    if (!membership) {
      throw new Error(
        `${email} is not a member of ${deniedOrganizationId}; seed app:mobile-org-states first`
      );
    }
    if (membership.role !== 'member') {
      throw new Error(
        `${email} is ${membership.role} of ${deniedOrganizationId}; the denial needs a plain member`
      );
    }

    console.log('This fixture represents:');
    console.log('  An organization scope where the account is a plain member, so the audit');
    console.log('  report answers the billing-role refusal and the settings screen is read-only.');
    console.log('Suggested next step: open a returned deep link in the signed-in mobile app.');

    return {
      userId: user.id,
      email: email.trim(),
      organizationId: deniedOrganizationId,
      role: membership.role,
      auditReportPath: `/(app)/security-agent/${deniedOrganizationId}/audit-report`,
      auditReportDeepLink: `kiloapp:///(app)/security-agent/${deniedOrganizationId}/audit-report`,
      settingsDeepLink: `kiloapp:///(app)/security-agent/${deniedOrganizationId}/settings`,
    };
  }

  if (emptyVariant) {
    console.log('This fixture represents:');
    console.log('  The personal Security Agent as a fresh account sees it: no finding row, and');
    console.log('  no recorded audit event, so the finding list and the audit report both paint');
    console.log('  their empty states.');
    console.log('Suggested next step: open a returned deep link in the signed-in mobile app.');

    return {
      userId: user.id,
      email: email.trim(),
      removedFindingCount: removedFindings.length,
      findingsDeepLink: 'kiloapp:///(app)/security-agent/personal/findings',
      auditReportDeepLink: 'kiloapp:///(app)/security-agent/personal/audit-report',
    };
  }

  const dismissedFindingId = randomUUID();
  const openFindingId = randomUUID();

  await db.insert(security_findings).values([
    {
      id: dismissedFindingId,
      owned_by_user_id: user.id,
      repo_full_name: 'acme/billing-service',
      source: 'dependabot',
      source_id: SOURCE_IDS[0],
      severity: 'medium',
      ghsa_id: 'GHSA-0000-redos-fixture',
      package_name: 'undici',
      package_ecosystem: 'npm',
      vulnerable_version_range: '< 6.13.0',
      patched_version: '6.13.0',
      manifest_path: 'package.json',
      title: 'ReDoS in undici',
      description:
        'undici builds a regular expression from the Content-Length header before version 6.13.0.\n' +
        '     A response with a long, crafted header makes the parser backtrack quadratically,\n' +
        '   blocking the event loop until the process restarts.',
      status: 'ignored',
      ignored_reason: 'not_used',
      ignored_by: user.id,
      sla_due_at: iso(2 * DAY_MS),
      first_detected_at: iso(-21 * DAY_MS),
      updated_at: iso(-1 * DAY_MS),
    },
    {
      id: openFindingId,
      owned_by_user_id: user.id,
      repo_full_name: 'acme/billing-service',
      source: 'dependabot',
      source_id: SOURCE_IDS[1],
      severity: 'high',
      ghsa_id: 'GHSA-0000-left-pad-fixture',
      cve_id: 'CVE-2026-000000',
      package_name: 'left-pad',
      package_ecosystem: 'npm',
      vulnerable_version_range: '< 1.3.0',
      patched_version: '1.3.0',
      manifest_path: 'package.json',
      title: 'Prototype pollution in left-pad',
      description:
        'left-pad merges the options object recursively without checking the key name. A crafted\n' +
        '   input such as {"__proto__": {"isAdmin": true}} changes Object.prototype, so every\n' +
        ' object in the process sees the value the caller supplied.',
      status: 'open',
      sla_due_at: iso(2 * DAY_MS),
      first_detected_at: iso(-5 * DAY_MS),
      updated_at: iso(-60 * 60 * 1000),
      // The analysis tab draws the model, the analysed date and the located
      // paths from these fields, so the fixture carries what a completed run
      // stores rather than an empty tab.
      analysis_status: 'completed',
      analysis_started_at: iso(-4 * DAY_MS),
      analysis_completed_at: iso(-4 * DAY_MS + 5 * 60 * 1000),
      analysis: {
        triage: {
          needsSandboxAnalysis: true,
          needsSandboxReasoning: 'The package is imported by the server bundle.',
          suggestedAction: 'analyze_codebase',
          confidence: 'medium',
          triageAt: iso(-4 * DAY_MS + 60 * 1000),
        },
        sandboxAnalysis: {
          isExploitable: true,
          extractionStatus: 'succeeded',
          exploitabilityReasoning: 'The options object reaches the merge from the request body.',
          usageLocations: ['src/lib/render-template.js:24', 'package.json:17'],
          suggestedFix: 'Upgrade left-pad to 1.3.0.',
          suggestedAction: 'open_pr',
          summary: 'Reachable from the report renderer with a caller-supplied options object.',
          rawMarkdown: '## Summary\n\nThe merge is reachable from the request body.',
          analysisAt: iso(-4 * DAY_MS + 5 * 60 * 1000),
          modelUsed: 'kilo-auto/frontier',
        },
        analyzedAt: iso(-4 * DAY_MS + 5 * 60 * 1000),
        modelUsed: 'kilo-auto/frontier',
        analysisModel: 'kilo-auto/frontier',
      },
    },
  ]);

  console.log('This fixture represents:');
  console.log('  A personal Security Agent with one dismissed finding (dismissal date with no');
  console.log('  deadline left) and one open finding that still has an SLA deadline and a');
  console.log('  completed analysis.');
  console.log('Suggested next step:');
  console.log('  Open the dismiss links below to see the header action each finding offers.');

  return {
    userId: user.id,
    email: email.trim(),
    dismissedFindingId,
    dismissedPath: `/(app)/security-agent/personal/findings/${dismissedFindingId}`,
    openFindingId,
    openPath: `/(app)/security-agent/personal/findings/${openFindingId}`,
  };
}
