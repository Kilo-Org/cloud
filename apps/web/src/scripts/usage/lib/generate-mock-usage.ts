/**
 * Shared mock usage generator.
 *
 * Inserts `microdollar_usage` + `microdollar_usage_metadata` records
 * (plus lookup-table rows for `feature`, `mode`, `editor_name`, `api_kind`,
 * `auto_model`) so the Usage Analytics page has data to display.
 *
 * The density is weighted toward recent time so all period presets in the
 * sidebar (today, 7d, 30d, 1y) show meaningful charts:
 *   - Last 7 days: many records per hour (realistic working-hour shape)
 *   - Days 8-90: multiple records per day per user
 *   - Months 4-13: sparser — a few days per month per user
 *
 * Inserts into microdollar_usage only. Usage Analytics reads from Snowflake
 * (DBT_BACKEND_SANDBOX for local dev); no rollup step is needed.
 */
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/drizzle';
import {
  microdollar_usage,
  microdollar_usage_metadata,
  feature,
  mode as modeTable,
  editor_name as editorNameTable,
  api_kind as apiKindTable,
  auto_model as autoModelTable,
  type MicrodollarUsage,
} from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';
import {
  MOCK_MODELS,
  MOCK_MODES,
  MOCK_EDITORS,
  MOCK_AUTO_MODELS,
  MOCK_PROJECT_IDS,
  MOCK_FEATURES,
  MOCK_API_KINDS,
  AUTOCOMPLETE_MODEL_ID,
  FEATURE_WEIGHTS,
  MODE_WEIGHTS,
  EDITOR_WEIGHTS,
  API_KIND_WEIGHTS,
  weightedPick,
  type ModelSpec,
} from './mock-dimensions';

const INSERT_CHUNK_SIZE = 1000;

export type MockScope = {
  kiloUserIds: string[];
  organizationId: string | null;
};

export type MockLookupMaps = {
  feature: Map<string, number>;
  mode: Map<string, number>;
  editor_name: Map<string, number>;
  api_kind: Map<string, number>;
  auto_model: Map<string, number>;
};

export type GenerationStats = {
  recordCount: number;
  totalCostMicrodollars: number;
};

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Populate each lookup table with its pool of values (idempotent via
 * ON CONFLICT DO NOTHING). Then SELECT them all to build in-memory id
 * maps used by the generator.
 */
export async function ensureLookupsSeeded(): Promise<MockLookupMaps> {
  await db
    .insert(feature)
    .values(MOCK_FEATURES.map(f => ({ feature: f })))
    .onConflictDoNothing();
  await db
    .insert(modeTable)
    .values(MOCK_MODES.map(m => ({ mode: m })))
    .onConflictDoNothing();
  await db
    .insert(editorNameTable)
    .values(MOCK_EDITORS.map(e => ({ editor_name: e })))
    .onConflictDoNothing();
  await db
    .insert(apiKindTable)
    .values(MOCK_API_KINDS.map(k => ({ api_kind: k })))
    .onConflictDoNothing();
  await db
    .insert(autoModelTable)
    .values(MOCK_AUTO_MODELS.map(a => ({ auto_model: a })))
    .onConflictDoNothing();

  const [featureRows, modeRows, editorRows, apiKindRows, autoModelRows] = await Promise.all([
    db.select({ id: feature.feature_id, value: feature.feature }).from(feature),
    db.select({ id: modeTable.mode_id, value: modeTable.mode }).from(modeTable),
    db
      .select({ id: editorNameTable.editor_name_id, value: editorNameTable.editor_name })
      .from(editorNameTable),
    db.select({ id: apiKindTable.api_kind_id, value: apiKindTable.api_kind }).from(apiKindTable),
    db
      .select({ id: autoModelTable.auto_model_id, value: autoModelTable.auto_model })
      .from(autoModelTable),
  ]);

  const toMap = (rows: { id: number; value: string }[]): Map<string, number> =>
    new Map(rows.map(r => [r.value, r.id]));

  return {
    feature: toMap(featureRows),
    mode: toMap(modeRows),
    editor_name: toMap(editorRows),
    api_kind: toMap(apiKindRows),
    auto_model: toMap(autoModelRows),
  };
}

/**
 * Delete all microdollar_usage + metadata rows attributed to an organization.
 * Metadata is deleted first via the subquery pattern from
 * `seed-fake-usage-for-org.ts` to avoid orphaning rows.
 */
export async function deleteOrgUsageFor(organizationId: string): Promise<{ deleted: number }> {
  await db.execute(sql`
    DELETE FROM microdollar_usage_metadata
    WHERE id IN (
      SELECT id FROM microdollar_usage WHERE organization_id = ${organizationId}
    )
  `);
  const result = await db
    .delete(microdollar_usage)
    .where(eq(microdollar_usage.organization_id, organizationId));
  return { deleted: result.rowCount ?? 0 };
}

/**
 * Delete personal-scope microdollar_usage + metadata for a single user
 * (organization_id IS NULL). Org-scoped rows the user also appears in are
 * left alone.
 */
export async function deletePersonalUsageFor(kiloUserId: string): Promise<{ deleted: number }> {
  await db.execute(sql`
    DELETE FROM microdollar_usage_metadata
    WHERE id IN (
      SELECT id FROM microdollar_usage
      WHERE kilo_user_id = ${kiloUserId} AND organization_id IS NULL
    )
  `);
  const result = await db.execute(sql`
    DELETE FROM microdollar_usage
    WHERE kilo_user_id = ${kiloUserId} AND organization_id IS NULL
  `);
  return { deleted: result.rowCount ?? 0 };
}

/**
 * Density profile for a given date. Returns the probability that a day
 * produces records, the target record count per active user, and the
 * number of active users.
 */
type DayProfile = {
  pNoUsage: number;
  pLowUsage: number;
  lowUsageUserFraction: [number, number];
  normalUsageUserFraction: [number, number];
  recordsPerActiveUser: [number, number];
};

function profileForAgeDays(ageDays: number): DayProfile {
  if (ageDays <= 7) {
    return {
      pNoUsage: 0.05,
      pLowUsage: 0.2,
      lowUsageUserFraction: [0.1, 0.3],
      normalUsageUserFraction: [0.5, 0.95],
      recordsPerActiveUser: [5, 40],
    };
  }
  if (ageDays <= 90) {
    return {
      pNoUsage: 0.2,
      pLowUsage: 0.3,
      lowUsageUserFraction: [0.05, 0.2],
      normalUsageUserFraction: [0.3, 0.8],
      recordsPerActiveUser: [1, 15],
    };
  }
  // Older than 90 days — sparser, mostly quiet
  return {
    pNoUsage: 0.75,
    pLowUsage: 0.2,
    lowUsageUserFraction: [0.05, 0.15],
    normalUsageUserFraction: [0.1, 0.4],
    recordsPerActiveUser: [1, 4],
  };
}

/**
 * Bias timestamps toward 08:00-18:00 UTC but still spread across the day.
 * `maxHour` caps the result (inclusive); used to avoid future-dated records
 * on the current UTC day.
 */
function randomHourOfDay(maxHour: number = 23): number {
  const cappedMax = Math.min(23, Math.max(0, maxHour));
  // 70% in working hours, capped by maxHour when that range is available
  if (cappedMax >= 8 && Math.random() < 0.7) {
    return randomInt(8, Math.min(18, cappedMax));
  }
  return randomInt(0, cappedMax);
}

function assignProjectPoolForUser(userIndex: number): string[] {
  // Each user prefers 2-3 projects out of the pool
  const pool = [...MOCK_PROJECT_IDS];
  // Deterministic-ish rotation so it's still stable-ish per user index
  const start = userIndex % pool.length;
  const size = 2 + (userIndex % 2);
  const picked: string[] = [];
  for (let i = 0; i < size; i++) {
    picked.push(pool[(start + i) % pool.length]);
  }
  return picked;
}

/**
 * Pick a model. When the chosen feature is `autocomplete`, force the
 * autocomplete model so the autocomplete metric cards show data.
 */
function pickModel(featureValue: string): ModelSpec {
  if (featureValue === 'autocomplete') {
    const m = MOCK_MODELS.find(m => m.id === AUTOCOMPLETE_MODEL_ID);
    if (m) return m;
  }
  return weightedPick(MOCK_MODELS.map(m => ({ value: m, weight: m.weight })));
}

type RecordPair = {
  core: MicrodollarUsage;
  metadata: typeof microdollar_usage_metadata.$inferInsert;
};

function generateOneRecord(
  kiloUserId: string,
  organizationId: string | null,
  createdAt: Date,
  projectPool: string[],
  lookups: MockLookupMaps
): RecordPair {
  const featureValue = weightedPick(FEATURE_WEIGHTS);
  const model = pickModel(featureValue);
  const modeValue = weightedPick(MODE_WEIGHTS);
  const editorValue = weightedPick(EDITOR_WEIGHTS);
  const apiKindValue = weightedPick(API_KIND_WEIGHTS);

  const inputTokens = randomInt(100, 20_000);
  const outputTokens = randomInt(50, 5_000);
  const cacheWriteTokens = Math.random() < 0.4 ? randomInt(100, 2_000) : 0;
  const cacheHitTokens = Math.random() < 0.5 ? randomInt(100, 5_000) : 0;

  const isFree = Math.random() < 0.1;
  const isByok = Math.random() < 0.05;
  const hasError = Math.random() < 0.015;
  const cancelled = Math.random() < 0.03;
  const streamed = Math.random() < 0.8;
  const hasTools = Math.random() < 0.3;
  const isUserByok = isByok && Math.random() < 0.5;

  const marketCost =
    Math.floor((inputTokens * model.inputCostPerMTokens) / 1_000_000) +
    Math.floor((outputTokens * model.outputCostPerMTokens) / 1_000_000);
  const cost = isFree || isByok ? 0 : marketCost;

  // Some records attribute to no project (NULL → `none` sentinel in rollup)
  const projectId = Math.random() < 0.15 ? null : projectPool[randomInt(0, projectPool.length - 1)];

  // Auto model only set ~20% of the time, matching `weight=70 null` in benchmark
  const autoModelValue =
    Math.random() < 0.2 ? MOCK_AUTO_MODELS[randomInt(0, MOCK_AUTO_MODELS.length - 1)] : null;

  const id = randomUUID();
  const createdAtIso = createdAt.toISOString();

  const core: MicrodollarUsage = {
    id,
    kilo_user_id: kiloUserId,
    organization_id: organizationId,
    provider: model.provider,
    cost,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_write_tokens: cacheWriteTokens,
    cache_hit_tokens: cacheHitTokens,
    created_at: createdAtIso,
    model: model.id,
    requested_model: model.id,
    cache_discount: null,
    has_error: hasError,
    abuse_classification: 0,
    inference_provider: model.provider,
    project_id: projectId,
  };

  const metadata: typeof microdollar_usage_metadata.$inferInsert = {
    id,
    message_id: `mock-msg-${id}`,
    created_at: createdAtIso,
    system_prompt_length: randomInt(100, 5_000),
    max_tokens: randomInt(1_000, 8_000),
    has_middle_out_transform: false,
    status_code: hasError ? 500 : 200,
    upstream_id: `mock-up-${id.slice(0, 8)}`,
    latency: Math.random() * 5_000,
    moderation_latency: Math.random() * 100,
    generation_time: Math.random() * 3_000,
    is_byok: isByok,
    is_user_byok: isUserByok,
    streamed,
    cancelled,
    has_tools: hasTools,
    machine_id: `mock-machine-${kiloUserId.slice(0, 8)}`,
    session_id: `mock-session-${randomUUID()}`,
    market_cost: marketCost,
    is_free: isFree,
    feature_id: lookups.feature.get(featureValue) ?? null,
    mode_id: lookups.mode.get(modeValue) ?? null,
    editor_name_id: lookups.editor_name.get(editorValue) ?? null,
    api_kind_id: lookups.api_kind.get(apiKindValue) ?? null,
    auto_model_id: autoModelValue ? (lookups.auto_model.get(autoModelValue) ?? null) : null,
  };

  return { core, metadata };
}

/**
 * Enumerate each day from `monthsBack` months ago through today (UTC).
 */
function* iterateDaysFromMonthsBack(
  monthsBack: number
): Generator<{ date: Date; ageDays: number }> {
  const today = new Date();
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const start = new Date(end);
  start.setUTCMonth(start.getUTCMonth() - monthsBack);

  const cursor = new Date(start);
  while (cursor.getTime() <= end.getTime()) {
    const ageDays = Math.floor((end.getTime() - cursor.getTime()) / (24 * 60 * 60 * 1000));
    yield { date: new Date(cursor), ageDays };
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

function pickActiveUsers(userIds: string[], fraction: number): string[] {
  const count = Math.max(1, Math.round(userIds.length * fraction));
  // Shuffle copy
  const shuffled = [...userIds];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}

async function insertCoreChunked(rows: MicrodollarUsage[]): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
    await db.insert(microdollar_usage).values(rows.slice(i, i + INSERT_CHUNK_SIZE));
  }
}

async function insertMetadataChunked(
  rows: (typeof microdollar_usage_metadata.$inferInsert)[]
): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
    await db.insert(microdollar_usage_metadata).values(rows.slice(i, i + INSERT_CHUNK_SIZE));
  }
}

/**
 * Generate mock usage records spanning `monthsBack` months (default 13)
 * and insert them in batches. Returns the total record count and summed
 * cost in microdollars.
 */
export async function generateAndInsertMockUsage(
  scope: MockScope,
  lookups: MockLookupMaps,
  opts: { monthsBack?: number } = {}
): Promise<GenerationStats> {
  const monthsBack = opts.monthsBack ?? 13;
  if (monthsBack < 1) {
    throw new Error(`generateAndInsertMockUsage: monthsBack must be >= 1, got ${monthsBack}`);
  }
  if (scope.kiloUserIds.length === 0) {
    throw new Error('generateAndInsertMockUsage: scope.kiloUserIds must not be empty');
  }

  const projectPools = new Map<string, string[]>(
    scope.kiloUserIds.map((userId, index) => [userId, assignProjectPoolForUser(index)])
  );

  // Heavy-user bias: ~30% of users (at least 1) dominate usage (Pareto-ish),
  // so the user breakdown has obvious leaders.
  const heavyCount = Math.max(1, Math.ceil(scope.kiloUserIds.length * 0.3));
  const heavyUserIds = new Set(scope.kiloUserIds.slice(0, heavyCount));

  const coreRecords: MicrodollarUsage[] = [];
  const metadataRecords: (typeof microdollar_usage_metadata.$inferInsert)[] = [];
  let totalCost = 0;
  const nowMs = Date.now();

  for (const { date, ageDays } of iterateDaysFromMonthsBack(monthsBack)) {
    const profile = profileForAgeDays(ageDays);

    const roll = Math.random();
    if (roll < profile.pNoUsage) continue;

    const isLowUsage = roll < profile.pNoUsage + profile.pLowUsage;
    const [fracMin, fracMax] = isLowUsage
      ? profile.lowUsageUserFraction
      : profile.normalUsageUserFraction;
    const fraction = fracMin + Math.random() * (fracMax - fracMin);

    const activeUsers = pickActiveUsers(scope.kiloUserIds, fraction);
    const [recordsMin, recordsMax] = profile.recordsPerActiveUser;

    // Cap hour for today so records don't appear in the future. The current
    // "today" period on the UI ends at `now`, so future-dated rows would be
    // invisible there and only surface on later days.
    const isCurrentDay = ageDays === 0;
    const maxHour = isCurrentDay ? new Date(nowMs).getUTCHours() : 23;

    for (const userId of activeUsers) {
      const userMultiplier = heavyUserIds.has(userId) ? 2 : 1;
      const recordCount = randomInt(recordsMin, recordsMax) * userMultiplier;

      for (let i = 0; i < recordCount; i++) {
        const recordDate = new Date(date);
        recordDate.setUTCHours(randomHourOfDay(maxHour), randomInt(0, 59), randomInt(0, 59), 0);

        // Belt-and-suspenders: if minute/second pushed us past `now` on the
        // current hour, skip rather than emitting a future-dated record.
        if (recordDate.getTime() > nowMs) continue;

        const projectPool = projectPools.get(userId) ?? [...MOCK_PROJECT_IDS];
        const { core, metadata } = generateOneRecord(
          userId,
          scope.organizationId,
          recordDate,
          projectPool,
          lookups
        );

        coreRecords.push(core);
        metadataRecords.push(metadata);
        totalCost += core.cost;
      }
    }
  }

  console.log(
    `Generated ${coreRecords.length} records (total cost ${totalCost} microdollars = $${(totalCost / 1_000_000).toFixed(2)}).`
  );

  console.log('Inserting microdollar_usage rows...');
  await insertCoreChunked(coreRecords);

  console.log('Inserting microdollar_usage_metadata rows...');
  await insertMetadataChunked(metadataRecords);

  return { recordCount: coreRecords.length, totalCostMicrodollars: totalCost };
}
