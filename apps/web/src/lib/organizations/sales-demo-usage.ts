import { randomUUID } from 'node:crypto';
import type { DrizzleTransaction } from '@/lib/drizzle';
import {
  feature,
  mode,
  microdollar_usage,
  microdollar_usage_daily,
  microdollar_usage_metadata,
  organizations,
  type Organization,
  type User,
} from '@kilocode/db/schema';
import { eq, inArray, sql } from 'drizzle-orm';
import { grantEntityCreditForCategory } from '@/lib/promotionalCredits';
import {
  mutateOrganizationUsage,
  updateOrganizationUserLimit,
} from '@/lib/organizations/organization-usage';
import { DEFAULT_MEMBER_DAILY_LIMIT_USD } from '@/lib/organizations/constants';
import { CLAUDE_OPUS_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/anthropic.constants';
import { CLAUDE_SONNET_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/anthropic.constants';
import { GPT_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/openai';
import { GLM_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/zai';
import { KIMI_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/moonshotai';
import { MINIMAX_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/minimax';
import { demoOrganizationSettings, SALES_DEMO_REMAINING_MICRODOLLARS } from './sales-demo';
import type { FEATURE_VALUES } from '@/lib/feature-detection';

// Stable per-1K-token rates (microdollars) for the current paid models. Rates
// are illustrative only; the seed step needs determinism, not exact billing.
const MODELS = [
  { id: CLAUDE_SONNET_CURRENT_MODEL_ID, inputPer1k: 3000, outputPer1k: 15000 },
  { id: CLAUDE_OPUS_CURRENT_MODEL_ID, inputPer1k: 15000, outputPer1k: 75000 },
  { id: GPT_CURRENT_MODEL_ID, inputPer1k: 2500, outputPer1k: 10000 },
  { id: GLM_CURRENT_MODEL_ID, inputPer1k: 1000, outputPer1k: 4000 },
  { id: KIMI_CURRENT_MODEL_ID, inputPer1k: 600, outputPer1k: 2400 },
  { id: MINIMAX_CURRENT_MODEL_ID, inputPer1k: 300, outputPer1k: 1200 },
] as const;

const FEATURES = [
  'vscode-extension',
  'jetbrains-extension',
  'cli',
  'autocomplete',
  'cloud-agent',
] as const satisfies ReadonlyArray<(typeof FEATURE_VALUES)[number]>;
const MODES = ['code', 'build', 'architect', 'ask', 'debug', 'plan'] as const;
const PROJECT_IDS = [
  'checkout-service',
  'mobile-app',
  'docs-site',
  'billing-api',
  'data-pipeline',
  'design-system',
] as const;

const DAY_MS = 86_400_000;
const DAY_COUNT = 30;
const INSERT_CHUNK_SIZE = 500;

type PlannedMetadataRow = {
  id: string;
  message_id: string;
  system_prompt_length: number;
  max_tokens: number;
  has_middle_out_transform: boolean;
  feature: string;
  mode: string;
};

type PlannedUsage = {
  rawRows: (typeof microdollar_usage.$inferInsert)[];
  metadataRows: PlannedMetadataRow[];
  seededMicrodollars: number;
  perUserDayTotals: { kiloUserId: string; usageDate: string; total: number }[];
  usedFeatures: string[];
  usedModes: string[];
};

// FNV-1a 32-bit hash. Deterministic across runs.
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// mulberry32 PRNG. Returns a function producing values in [0, 1).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rand: () => number, min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min;
}

function pick<T>(rand: () => number, values: readonly T[]): T {
  return values[Math.floor(rand() * values.length)];
}

function modelProvider(modelId: string): string {
  return modelId.slice(0, modelId.indexOf('/'));
}

/**
 * Builds the deterministic usage plan for a sales demo org. The RNG is seeded
 * from the org id plus the UTC date string, so the same inputs produce the same
 * seeded total and per-user-day totals.
 */
export function buildSalesDemoUsagePlan(
  organizationId: string,
  memberIds: string[],
  now: Date
): PlannedUsage {
  const dateStr = now.toISOString().slice(0, 10);
  const rand = mulberry32(fnv1a32(`${organizationId}:${dateStr}`));

  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  const rawRows: PlannedUsage['rawRows'] = [];
  const metadataRows: PlannedMetadataRow[] = [];
  const usedFeatures = new Set<string>();
  const usedModes = new Set<string>();
  const totalsByUserDay = new Map<
    string,
    { kiloUserId: string; usageDate: string; total: number }
  >();
  let seededMicrodollars = 0;

  const forcedMemberIds = memberIds.slice(0, 3);

  // Decide active members per day. Skip some member-days for an uneven mix but
  // never skip a whole org-day and give every member (owner included) some days.
  const activeByDay: string[][] = [];
  for (let d = 0; d < DAY_COUNT; d++) {
    const active: string[] = [];
    for (const memberId of memberIds) {
      if (rand() < 0.55) active.push(memberId);
    }
    if (active.length === 0) active.push(pick(rand, memberIds));
    activeByDay.push(active);
  }
  for (const memberId of memberIds) {
    if (!activeByDay.some(dayMembers => dayMembers.includes(memberId))) {
      activeByDay[randInt(rand, 0, DAY_COUNT - 1)].push(memberId);
    }
  }

  const emitRow = (
    memberId: string,
    dayStart: Date,
    model: (typeof MODELS)[number],
    inputTokens: number,
    outputTokens: number,
    cacheWriteTokens: number,
    cacheHitTokens: number
  ): void => {
    const inputCost = Math.floor((inputTokens / 1000) * model.inputPer1k);
    const outputCost = Math.floor((outputTokens / 1000) * model.outputPer1k);
    const cost = inputCost + outputCost;
    const id = randomUUID();
    const featureValue = pick(rand, FEATURES);
    const modeValue = pick(rand, MODES);
    const projectId = rand() < 0.9 ? pick(rand, PROJECT_IDS) : null;
    const createdAt = new Date(
      dayStart.getTime() +
        randInt(rand, 0, 23) * 3_600_000 +
        randInt(rand, 0, 59) * 60_000 +
        randInt(rand, 0, 59) * 1_000
    );
    const usageDate = dayStart.toISOString().slice(0, 10);

    usedFeatures.add(featureValue);
    usedModes.add(modeValue);

    rawRows.push({
      id,
      kilo_user_id: memberId,
      organization_id: organizationId,
      cost,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_write_tokens: cacheWriteTokens,
      cache_hit_tokens: cacheHitTokens,
      created_at: createdAt.toISOString(),
      provider: modelProvider(model.id),
      model: model.id,
      requested_model: model.id,
      cache_discount: null,
      abuse_classification: 0,
      has_error: false,
      inference_provider: modelProvider(model.id),
      project_id: projectId,
    });
    metadataRows.push({
      id,
      message_id: randomUUID(),
      system_prompt_length: randInt(rand, 100, 1000),
      max_tokens: randInt(rand, 1000, 4000),
      has_middle_out_transform: false,
      feature: featureValue,
      mode: modeValue,
    });

    const key = `${memberId}\u0000${usageDate}`;
    const existing = totalsByUserDay.get(key);
    if (existing) {
      existing.total += cost;
    } else {
      totalsByUserDay.set(key, { kiloUserId: memberId, usageDate, total: cost });
    }
    seededMicrodollars += cost;
  };

  const emitNormalRow = (memberId: string, dayStart: Date): void => {
    const model = pick(rand, MODELS);
    const inputTokens = randInt(rand, 500, 20_000);
    const outputTokens = randInt(rand, 200, 8_000);
    const cacheWriteTokens = rand() < 0.4 ? randInt(rand, 0, 2_000) : 0;
    const cacheHitTokens = rand() < 0.4 ? randInt(rand, 0, 5_000) : 0;
    emitRow(memberId, dayStart, model, inputTokens, outputTokens, cacheWriteTokens, cacheHitTokens);
  };

  // Normal rows across the last 30 UTC days. Today's rows for the three
  // limit-bearing members are generated separately below.
  for (let d = 0; d < DAY_COUNT; d++) {
    const dayStart = new Date(todayUtc - d * DAY_MS);
    const isToday = d === 0;
    for (const memberId of activeByDay[d]) {
      if (isToday && forcedMemberIds.includes(memberId)) continue;
      const rowCount = randInt(rand, 1, 6);
      for (let r = 0; r < rowCount; r++) {
        emitNormalRow(memberId, dayStart);
      }
    }
  }

  // Force today's cost for members 01..03 into 80-95% of the daily limit so
  // their daily-limit cards look nearly consumed.
  const TARGET_MIN = Math.floor(DEFAULT_MEMBER_DAILY_LIMIT_USD * 1_000_000 * 0.8);
  const opus = MODELS[1];
  const todayStart = new Date(todayUtc);
  for (const memberId of forcedMemberIds) {
    let total = 0;
    const fillerCount = randInt(rand, 2, 4);
    for (let i = 0; i < fillerCount; i++) {
      const inputTokens = randInt(rand, 1_000, 20_000);
      const outputTokens = randInt(rand, 500, 4_000);
      const cacheWriteTokens = rand() < 0.4 ? randInt(rand, 0, 2_000) : 0;
      const cacheHitTokens = rand() < 0.4 ? randInt(rand, 0, 5_000) : 0;
      emitRow(
        memberId,
        todayStart,
        opus,
        inputTokens,
        outputTokens,
        cacheWriteTokens,
        cacheHitTokens
      );
      total +=
        Math.floor((inputTokens / 1000) * opus.inputPer1k) +
        Math.floor((outputTokens / 1000) * opus.outputPer1k);
    }
    // One final output-only row sized to bring today's total into the band.
    // The filler cost is far below TARGET_MIN, so `kMin` always exists.
    const step = opus.outputPer1k;
    const k = Math.max(1, Math.ceil((TARGET_MIN - total) / step));
    emitRow(memberId, todayStart, opus, 0, k * 1000, 0, 0);
  }

  return {
    rawRows,
    metadataRows,
    seededMicrodollars,
    perUserDayTotals: [...totalsByUserDay.values()],
    usedFeatures: [...usedFeatures],
    usedModes: [...usedModes],
  };
}

async function upsertLookupIds(
  values: string[],
  run: (unique: string[]) => Promise<Array<{ value: string; id: number }>>
): Promise<Map<string, number>> {
  const unique = [...new Set(values)];
  if (unique.length === 0) return new Map();
  const rows = await run(unique);
  return new Map(rows.map(row => [row.value, row.id]));
}

/**
 * Populates a sales demo org with 30 days of deterministic seeded usage, grants
 * the credit row covering seeded spend plus the $25.03 remaining balance, and
 * writes the daily limits for members 01..03. Runs entirely on the given txn.
 */
export async function populateSalesDemoUsage(
  txn: DrizzleTransaction,
  args: {
    organization: Organization;
    actorUser: User;
    memberIds: string[];
    now: Date;
  }
): Promise<{ seededMicrodollars: number; perUserDayTotals: PlannedUsage['perUserDayTotals'] }> {
  const { organization, actorUser, memberIds, now } = args;

  const plan = buildSalesDemoUsagePlan(organization.id, memberIds, now);

  const featureIds = await upsertLookupIds(plan.usedFeatures, async unique => {
    await txn
      .insert(feature)
      .values(unique.map(value => ({ feature: value })))
      .onConflictDoNothing({ target: feature.feature });
    return txn
      .select({ value: feature.feature, id: feature.feature_id })
      .from(feature)
      .where(inArray(feature.feature, unique));
  });
  const modeIds = await upsertLookupIds(plan.usedModes, async unique => {
    await txn
      .insert(mode)
      .values(unique.map(value => ({ mode: value })))
      .onConflictDoNothing({ target: mode.mode });
    return txn
      .select({ value: mode.mode, id: mode.mode_id })
      .from(mode)
      .where(inArray(mode.mode, unique));
  });

  const creditResult = await grantEntityCreditForCategory(
    { user: actorUser, organization },
    {
      credit_category: 'sales-demo',
      counts_as_selfservice: false,
      amount_usd: (plan.seededMicrodollars + SALES_DEMO_REMAINING_MICRODOLLARS) / 1_000_000,
      dbOrTx: txn,
    }
  );
  if (!creditResult.success) {
    throw new Error(`Failed to grant credits: ${creditResult.message}`);
  }

  for (let i = 0; i < plan.rawRows.length; i += INSERT_CHUNK_SIZE) {
    await txn.insert(microdollar_usage).values(plan.rawRows.slice(i, i + INSERT_CHUNK_SIZE));
  }

  const metadataInserts = plan.metadataRows.map(row => ({
    id: row.id,
    message_id: row.message_id,
    system_prompt_length: row.system_prompt_length,
    max_tokens: row.max_tokens,
    has_middle_out_transform: row.has_middle_out_transform,
    feature_id: featureIds.get(row.feature) ?? null,
    mode_id: modeIds.get(row.mode) ?? null,
  }));
  for (let i = 0; i < metadataInserts.length; i += INSERT_CHUNK_SIZE) {
    await txn
      .insert(microdollar_usage_metadata)
      .values(metadataInserts.slice(i, i + INSERT_CHUNK_SIZE));
  }

  for (const { kiloUserId, usageDate, total } of plan.perUserDayTotals) {
    await txn.execute(sql`
      INSERT INTO ${microdollar_usage_daily} (
        kilo_user_id, organization_id, usage_date, total_cost_microdollars
      )
      SELECT
        ${kiloUserId},
        ${organization.id}::uuid,
        ${usageDate}::date,
        ${total}::bigint
      ON CONFLICT (kilo_user_id, organization_id, usage_date) WHERE organization_id IS NOT NULL
      DO UPDATE SET
        total_cost_microdollars =
          ${microdollar_usage_daily.total_cost_microdollars} + EXCLUDED.total_cost_microdollars,
        updated_at = NOW()
    `);

    await mutateOrganizationUsage(txn, {
      kilo_user_id: kiloUserId,
      organization_id: organization.id,
      cost: total,
      created_at: `${usageDate}T12:00:00.000Z`,
    });
  }

  await txn
    .update(organizations)
    .set({
      settings: {
        ...demoOrganizationSettings(now),
        sales_demo_seeded_microdollars: plan.seededMicrodollars,
        enable_usage_limits: true,
      },
    })
    .where(eq(organizations.id, organization.id));

  for (const memberId of memberIds.slice(0, 3)) {
    await updateOrganizationUserLimit(
      organization.id,
      memberId,
      DEFAULT_MEMBER_DAILY_LIMIT_USD,
      'daily',
      txn
    );
  }

  return {
    seededMicrodollars: plan.seededMicrodollars,
    perUserDayTotals: plan.perUserDayTotals,
  };
}
