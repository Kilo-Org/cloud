/**
 * Simulate a system-initiated model-access change for a given organization.
 *
 * Writes a real audit log entry (action `organization.settings.auto_change`,
 * null actor = "System") using the production code path, so you can verify
 * the rendering at `/organizations/<id>/audit-logs`.
 *
 * Usage:
 *   pnpm script:run audit-logs simulate-auto-model-change <org_id> [scenario]
 *
 * Scenarios:
 *   added     — new model from an already-allowed provider (default)
 *   removed   — model disappears from the provider catalog
 *   mixed     — additions + catalog removal in one entry
 *
 * Examples:
 *   pnpm script:run audit-logs simulate-auto-model-change 00000000-0000-0000-0000-000000000000
 *   pnpm script:run audit-logs simulate-auto-model-change 00000000-0000-0000-0000-000000000000 removed
 *   pnpm script:run audit-logs simulate-auto-model-change 00000000-0000-0000-0000-000000000000 mixed
 *
 * The org must be on the enterprise plan (otherwise the feature is a no-op).
 * The script will pick a provider slug from the org's allow list (or fabricate
 * one for legacy deny-list mode orgs) so the synthetic diff is relevant.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { organization_audit_logs, organizations } from '@kilocode/db/schema';
import type { NormalizedOpenRouterResponse } from '@/lib/ai-gateway/providers/openrouter/openrouter-types';
import { computeSnapshotDiff } from '@/lib/ai-gateway/providers/openrouter/snapshot-diff';
import {
  buildAutoChangeMessage,
  computeRelevantChangesForOrg,
  relevantChangesIsEmpty,
} from '@/lib/organizations/auto-model-change-log';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';

type Scenario = 'added' | 'removed' | 'mixed';

function buildSnapshot(
  providers: Array<{ slug: string; models: string[] }>
): NormalizedOpenRouterResponse {
  return {
    providers: providers.map(({ slug, models }) => ({
      name: slug,
      displayName: slug,
      slug,
      dataPolicy: { training: false, retainsPrompts: false, canPublish: false },
      models: models.map(modelSlug => ({
        slug: modelSlug,
        name: modelSlug,
        author: slug,
        description: '',
        context_length: 0,
        input_modalities: [],
        output_modalities: [],
        group: 'other',
        updated_at: '',
        endpoint: {
          provider_display_name: slug,
          is_free: false,
          pricing: { prompt: '0', completion: '0' },
        },
      })),
    })),
    total_providers: providers.length,
    total_models: providers.reduce((sum, p) => sum + p.models.length, 0),
    generated_at: new Date().toISOString(),
  };
}

function pickTargetProvider(settings: {
  provider_policy_mode?: 'allow';
  provider_allow_list?: string[];
  provider_deny_list?: string[];
}): { slug: string; mode: 'allow-list' | 'legacy' | 'default' } {
  if (settings.provider_policy_mode === 'allow' && settings.provider_allow_list?.length) {
    return { slug: settings.provider_allow_list[0], mode: 'allow-list' };
  }
  if (settings.provider_deny_list?.length) {
    return { slug: 'z-ai', mode: 'legacy' };
  }
  return { slug: 'z-ai', mode: 'default' };
}

function buildScenarioSnapshots(
  scenario: Scenario,
  providerSlug: string,
  suffix: string
): { oldSnapshot: NormalizedOpenRouterResponse; newSnapshot: NormalizedOpenRouterResponse } {
  const stableModel = `${providerSlug}/sim-stable-${suffix}`;
  const addedModel = `${providerSlug}/sim-added-${suffix}`;
  const removedModel = `${providerSlug}/sim-removed-${suffix}`;

  switch (scenario) {
    case 'added':
      return {
        oldSnapshot: buildSnapshot([{ slug: providerSlug, models: [stableModel] }]),
        newSnapshot: buildSnapshot([{ slug: providerSlug, models: [stableModel, addedModel] }]),
      };
    case 'removed':
      return {
        oldSnapshot: buildSnapshot([{ slug: providerSlug, models: [stableModel, removedModel] }]),
        newSnapshot: buildSnapshot([{ slug: providerSlug, models: [stableModel] }]),
      };
    case 'mixed':
      return {
        oldSnapshot: buildSnapshot([{ slug: providerSlug, models: [stableModel, removedModel] }]),
        newSnapshot: buildSnapshot([{ slug: providerSlug, models: [stableModel, addedModel] }]),
      };
  }
}

function parseScenario(raw: string | undefined): Scenario {
  if (!raw) return 'added';
  if (raw === 'added' || raw === 'removed' || raw === 'mixed') return raw;
  throw new Error(`Unknown scenario "${raw}". Expected: added | removed | mixed.`);
}

export async function run(orgId?: string, scenarioArg?: string): Promise<void> {
  if (!orgId) {
    console.error(
      'Usage: pnpm script:run audit-logs simulate-auto-model-change <org_id> [added|removed|mixed]'
    );
    process.exit(1);
  }

  const scenario = parseScenario(scenarioArg);

  const [organization] = await db.select().from(organizations).where(eq(organizations.id, orgId));

  if (!organization) {
    console.error(`Organization ${orgId} not found.`);
    process.exit(1);
  }

  if (organization.plan !== 'enterprise') {
    console.error(
      `Organization ${orgId} is on plan "${organization.plan}", not "enterprise". ` +
        `Auto-change audit logs only fire for enterprise orgs. Change the plan and re-run.`
    );
    process.exit(1);
  }

  const { slug: providerSlug, mode } = pickTargetProvider(organization.settings ?? {});
  const suffix = Math.random().toString(36).slice(2, 8);

  const { oldSnapshot, newSnapshot } = buildScenarioSnapshots(scenario, providerSlug, suffix);
  const diff = computeSnapshotDiff(oldSnapshot, newSnapshot);
  const changes = computeRelevantChangesForOrg(organization, diff);

  console.log(`Organization:   "${organization.name}" (${organization.id})`);
  console.log(`Plan:           ${organization.plan}`);
  console.log(`Policy mode:    ${mode}`);
  console.log(`Target provider: ${providerSlug}`);
  console.log(`Scenario:       ${scenario}`);
  console.log('');

  if (relevantChangesIsEmpty(changes)) {
    console.warn(
      `The synthetic diff produces no relevant changes for this org. ` +
        `Likely the chosen provider ("${providerSlug}") is not accessible under the org's ` +
        `effective restrictions. Check settings.provider_allow_list / provider_deny_list / ` +
        `model_deny_list, then re-run.`
    );
    process.exit(1);
  }

  const message = buildAutoChangeMessage(changes);
  console.log(`Message: ${message}`);

  const log = await createAuditLog({
    action: 'organization.settings.auto_change',
    actor_id: null,
    actor_email: null,
    actor_name: null,
    message,
    organization_id: organization.id,
  });

  console.log('');
  console.log(`Wrote audit log row id=${log.id} at ${log.created_at}`);
  console.log(
    `View it at: /organizations/${organization.id}/audit-logs (filter by action "settings.auto_change" or search "${providerSlug}")`
  );

  const recent = await db
    .select({
      id: organization_audit_logs.id,
      created_at: organization_audit_logs.created_at,
      action: organization_audit_logs.action,
      message: organization_audit_logs.message,
    })
    .from(organization_audit_logs)
    .where(eq(organization_audit_logs.organization_id, organization.id))
    .orderBy(organization_audit_logs.created_at)
    .limit(10);

  console.log('');
  console.log(`Recent audit log entries for this org (up to 10):`);
  for (const row of recent.slice(-10)) {
    console.log(`  [${row.created_at}] ${row.action}: ${row.message}`);
  }
}
