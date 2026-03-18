/**
 * Migrates depleted promo users' code review model from Sonnet 4.6 to MiniMax M2.7 (free).
 *
 * Background:
 *   The Sonnet 4.6 free code review promo (Feb 18–25, 2026) attracted ~960 users.
 *   Many now have < $1 balance, meaning their code reviews will start then fail
 *   mid-stream when the LLM gateway enforces the balance gate — a poor experience.
 *   This script switches their review model to MiniMax M2.7 (free) so reviews
 *   can still complete without cost.
 *
 * What it does:
 *   1. Finds agent_configs with agent_type='code_review' and model_slug=Sonnet 4.6
 *      whose owner has balance < $1
 *   2. Updates each matching config's model_slug to MiniMax M2.7
 *
 * Usage:
 *   DRY RUN (default):
 *     pnpm script src/scripts/d2026-03-03_migrate-promo-users-to-minimax.ts
 *   LIVE:
 *     pnpm script src/scripts/d2026-03-03_migrate-promo-users-to-minimax.ts --run-actually
 */

import { db, closeAllDrizzleConnections, type DrizzleTransaction } from '@/lib/drizzle';
import { agent_configs, kilocode_users, organizations } from '@kilocode/db/schema';
import { sql, and, eq, inArray, lt } from 'drizzle-orm';
import { minimax_m27_free_model } from '@/lib/providers/minimax';
import { REVIEW_PROMO_MODEL } from '@/lib/code-reviews/core/constants';

const TARGET_MODEL = minimax_m27_free_model.public_id; // 'minimax/minimax-m2.7:free'
const MIN_BALANCE_MUSD = 1_000_000; // $1 in microdollars
const isDryRun = !process.argv.includes('--run-actually');

// ── Phase 1: Find candidate configs ───────────────────────────────────────

type CandidateConfig = {
  configId: string;
  platform: string;
  ownerType: 'user' | 'org';
  ownerId: string;
  ownerLabel: string;
  balanceUsd: number;
};

type DbOrTx = typeof db | DrizzleTransaction;

type CandidatesByOwnerType = {
  users: CandidateConfig[];
  orgs: CandidateConfig[];
};

async function findCandidateConfigs(): Promise<CandidatesByOwnerType> {
  const userRows = await db
    .select({
      configId: agent_configs.id,
      platform: agent_configs.platform,
      userId: kilocode_users.id,
      email: kilocode_users.google_user_email,
      balance_musd:
        sql<number>`(${kilocode_users.total_microdollars_acquired} - ${kilocode_users.microdollars_used})`.as(
          'balance_musd'
        ),
    })
    .from(agent_configs)
    .innerJoin(kilocode_users, eq(kilocode_users.id, agent_configs.owned_by_user_id))
    .where(
      and(
        eq(agent_configs.agent_type, 'code_review'),
        sql`${agent_configs.config}->>'model_slug' = ${REVIEW_PROMO_MODEL}`,
        lt(
          sql`(${kilocode_users.total_microdollars_acquired} - ${kilocode_users.microdollars_used})`,
          MIN_BALANCE_MUSD
        )
      )
    );

  const users: CandidateConfig[] = userRows.map(row => ({
    configId: row.configId,
    platform: row.platform,
    ownerType: 'user',
    ownerId: row.userId,
    ownerLabel: row.email,
    balanceUsd: Number(row.balance_musd) / 1_000_000,
  }));

  const orgRows = await db
    .select({
      configId: agent_configs.id,
      platform: agent_configs.platform,
      orgId: organizations.id,
      orgName: organizations.name,
      balance_musd:
        sql<number>`(${organizations.total_microdollars_acquired} - ${organizations.microdollars_used})`.as(
          'balance_musd'
        ),
    })
    .from(agent_configs)
    .innerJoin(organizations, eq(organizations.id, agent_configs.owned_by_organization_id))
    .where(
      and(
        eq(agent_configs.agent_type, 'code_review'),
        sql`${agent_configs.config}->>'model_slug' = ${REVIEW_PROMO_MODEL}`,
        lt(
          sql`(${organizations.total_microdollars_acquired} - ${organizations.microdollars_used})`,
          MIN_BALANCE_MUSD
        )
      )
    );

  const orgs: CandidateConfig[] = orgRows.map(row => ({
    configId: row.configId,
    platform: row.platform,
    ownerType: 'org',
    ownerId: row.orgId,
    ownerLabel: row.orgName ?? '(unnamed org)',
    balanceUsd: Number(row.balance_musd) / 1_000_000,
  }));

  return { users, orgs };
}

// ── Phase 2: Update agent_configs ──────────────────────────────────────────

type UpdateResult = {
  updated: number;
  details: string[];
  migratedConfigIds: string[];
};

function configAsRecord(config: unknown): Record<string, unknown> | null {
  if (!isRecord(config)) return null;
  return config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getModelSlug(config: unknown): string | null {
  const r = configAsRecord(config);
  return typeof r?.model_slug === 'string' ? r.model_slug : null;
}

async function migrateReviewModelsForDb(
  dbOrTx: DbOrTx,
  candidates: CandidateConfig[],
  result: UpdateResult
): Promise<void> {
  for (const candidate of candidates) {
    if (!isDryRun) {
      await dbOrTx
        .update(agent_configs)
        .set({
          config: sql`${agent_configs.config} || ${JSON.stringify({ model_slug: TARGET_MODEL })}::jsonb`,
        })
        .where(eq(agent_configs.id, candidate.configId));
    }
    result.updated++;
    result.migratedConfigIds.push(candidate.configId);
    result.details.push(
      `  [UPDATE] ${candidate.ownerType}:${candidate.ownerLabel} (${candidate.platform}) — $${candidate.balanceUsd.toFixed(2)} balance`
    );
  }
}

async function migrateReviewModels(candidates: CandidateConfig[]): Promise<UpdateResult> {
  const result: UpdateResult = { updated: 0, details: [], migratedConfigIds: [] };

  await db.transaction(async tx => {
    await migrateReviewModelsForDb(tx, candidates, result);
  });

  return result;
}

// ── Phase 3: Verification ──────────────────────────────────────────────────

async function verify(migratedConfigIds: string[]): Promise<void> {
  const uniqueConfigIds = [...new Set(migratedConfigIds)];
  if (uniqueConfigIds.length === 0) {
    console.log('Verification: no configs were updated');
    return;
  }

  const configs = await db
    .select({
      id: agent_configs.id,
      owned_by_user_id: agent_configs.owned_by_user_id,
      owned_by_organization_id: agent_configs.owned_by_organization_id,
      platform: agent_configs.platform,
      config: agent_configs.config,
    })
    .from(agent_configs)
    .where(inArray(agent_configs.id, uniqueConfigIds));

  let onTarget = 0;
  let notOnTarget = 0;
  const foundConfigIds = new Set<string>();

  for (const c of configs) {
    foundConfigIds.add(c.id);
    const model = getModelSlug(c.config);
    if (model === TARGET_MODEL) {
      onTarget++;
    } else {
      notOnTarget++;
      console.log(
        `  [WARN] ${c.owned_by_user_id ?? c.owned_by_organization_id} (${c.platform}) still on '${model ?? '(missing model_slug)'}'`
      );
    }
  }

  const missingConfigCount = uniqueConfigIds.filter(id => !foundConfigIds.has(id)).length;
  if (missingConfigCount > 0) {
    console.log(
      `  [WARN] ${missingConfigCount} migrated configs were not found during verification`
    );
  }

  console.log(
    `Verification: ${onTarget} configs on MiniMax, ${notOnTarget} not on MiniMax, ${missingConfigCount} missing`
  );
}

// ── Main ───────────────────────────────────────────────────────────────────

async function run() {
  console.log(isDryRun ? 'DRY RUN — no changes will be made\n' : 'LIVE RUN\n');

  // Phase 1
  console.log('Phase 1: Finding candidate configs...');
  const { users, orgs } = await findCandidateConfigs();
  const allCandidates = [...users, ...orgs];
  console.log(
    `Found ${allCandidates.length} candidates (${users.length} users, ${orgs.length} orgs)\n`
  );

  if (allCandidates.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  // Phase 2
  console.log('Phase 2: Updating agent_configs...');
  const result = await migrateReviewModels(allCandidates);
  for (const line of result.details) {
    console.log(line);
  }
  console.log(`\nPhase 2 complete: ${result.updated} updated\n`);

  // Phase 3
  if (!isDryRun) {
    console.log('Phase 3: Verification...');
    await verify(result.migratedConfigIds);
  }
}

void run()
  .then(async () => {
    console.log('\nScript completed successfully');
    await closeAllDrizzleConnections();
    process.exit(0);
  })
  .catch(async error => {
    console.error('Script failed:', error);
    await closeAllDrizzleConnections();
    process.exit(1);
  });
