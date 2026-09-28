import 'server-only';

import { and, eq, gt, sql } from 'drizzle-orm';
import {
  microdollar_usage,
  spend_alert_deliveries,
  spend_alert_hourly,
  spend_alert_rule_state,
  spend_alert_rules,
  spend_alert_settings,
} from '@kilocode/db/schema';
import {
  BASELINE_MIN_BUCKETS,
  authorizedBillingContacts,
  parseSpendAlertScopeKey,
  type SpendAlertRecipients,
  type SpendAlertRuleKind,
  type SpendAlertRuleView,
} from './settings';
import type { db as defaultDb } from '@/lib/drizzle';

/**
 * The spend-alert engine. A sweep is one statement that re-derives the hourly
 * rollup for the scopes that had usage in the lookback window, and then a
 * decision for exactly those scopes — never a walk over the owner population.
 *
 * The rolled-up bucket is re-derived from `microdollar_usage`, never
 * incremented, so a replayed or overlapping window cannot double count. The
 * per-run cost is proportional to the usage rows written in the window: an idle
 * fleet costs one empty range scan. Nothing is added to the usage write path.
 */

/**
 * Rows per re-arm pass read. The set holds one row per scope with a still-firing
 * rule, so it tracks concurrently firing alerts rather than the owner
 * population, but a firing rule can stay latched for a whole window and the set
 * can be larger than one run should fetch at once. The run walks it with a
 * keyset (`scope_key > last`) until it is exhausted, so every firing scope is
 * re-armed before the next run: no fixed page size can starve the scopes that
 * sort after it. Scopes with fresh usage still arrive through the rollup delta.
 */
const FIRING_SCOPE_PAGE_SIZE = 500;

/**
 * Hours of usage re-derived on every run. Three hours is comfortably longer than
 * the five-minute cron interval, which covers clock skew between the sweep and
 * `created_at` and still repairs one missed run. The scan rides `idx_created_at`
 * on `microdollar_usage`.
 */
export const LOOKBACK_HOURS = 3;

/**
 * Hysteresis band. A firing condition clears only once its value falls below
 * this fraction of the threshold it crossed, so a value hovering on the line
 * cannot flap between fire and clear on consecutive sweeps.
 */
export const HYSTERESIS_RATIO = 0.95;

/**
 * Units of `multiplier_basis_points` per 1x the baseline. The spend view offers
 * 100 (1x) through 5000 (50x), so the stored unit is one hundredth of a
 * multiplier.
 */
const MULTIPLIER_UNITS_PER_X = 100;

/** Trailing window the anomaly baseline is computed over; matches the spend view. */
const BASELINE_WINDOW_DAYS = 14;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type Db = typeof defaultDb;

/** One rule row plus its live state and identity, as the sweep reads it. */
export type SpendAlertRuleSnapshot = SpendAlertRuleView & { ruleId: string };

/**
 * Everything one decision needs for one scope: the settings, both rules with
 * their state, and the spend aggregates the conditions are compared against.
 * The store produces it; `evaluateScope` decides over it without touching a
 * database, which is what makes the one-alert guarantee testable.
 */
export type SpendAlertScopeSnapshot = {
  scopeKey: string;
  enabled: boolean;
  rules: SpendAlertRuleSnapshot[];
  /** Rolling spend per configured threshold window, keyed by window hours. */
  windowMicrodollars: Record<number, number>;
  /** Spend in the partial hour bucket that contains `now`. */
  currentHourMicrodollars: number;
  /**
   * p95 of the complete hourly buckets in the trailing baseline window, exactly
   * as the spend view derives it. `null` below {@link BASELINE_MIN_BUCKETS}
   * buckets, which is what keeps the anomaly kind quiet on a new scope.
   */
  baselineHourlyMicrodollars: number | null;
};

/** Read seam of the sweep. Production reads Postgres; tests inject a stub. */
export interface SpendAlertSweepStore {
  loadScopeSnapshot(scopeKey: string, now: Date): Promise<SpendAlertScopeSnapshot | null>;
}

/** A rule liveness change the sweep has to persist. */
export type SpendAlertTransition = {
  action: 'fire' | 'clear';
  ruleId: string;
  kind: SpendAlertRuleKind;
  /**
   * When the firing episode started. Retained through a clear so the delivery
   * dedupe key of a later crossing in the same hour differs from the episode
   * that just ended; see {@link deliveryDedupeKey}.
   */
  conditionStartedAt: string | null;
  lastValueMicrodollars: number | null;
};

export type SpendAlertChannel = 'email' | 'push';

/** One outbox row to enqueue, before recipients are resolved. */
export type SpendAlertDeliveryDraft = {
  /**
   * Unique per firing episode, channel and observed hour. The unique index on
   * `spend_alert_deliveries.dedupe_key` collapses a concurrent sweep of the
   * same episode onto one row.
   */
  dedupeKey: string;
  scopeKey: string;
  ruleId: string;
  kind: SpendAlertRuleKind;
  channel: SpendAlertChannel;
  firedAt: string;
  payload: {
    valueMicrodollars: number;
    thresholdMicrodollars: number;
    windowHours: number | null;
    multiplierBasisPoints: number | null;
    baselineHourlyMicrodollars: number | null;
  };
};

export type SpendAlertEvaluation = {
  scopeKey: string;
  transitions: SpendAlertTransition[];
  deliveries: SpendAlertDeliveryDraft[];
};

/**
 * The hour bucket a value or a delivery belongs to. Anchoring the dedupe key to
 * this (rather than the sweep's exact `now`) is what lets two concurrent sweeps
 * of the same hour compute the same key.
 */
function hourBucketStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
}

/**
 * Identity of one firing episode's alert on one channel:
 * `<scope>:<kind>:<channel>:<observed hour>:<previous episode>`.
 *
 * The observed hour keeps concurrent sweeps of one episode on the same key. The
 * previous episode's start (or `armed` for the first crossing) keeps a crossing
 * that clears and crosses again inside the same hour on a new key, because the
 * cleared state retains the episode watermark.
 */
function deliveryDedupeKey(
  scopeKey: string,
  kind: SpendAlertRuleKind,
  channel: SpendAlertChannel,
  now: Date,
  previousEpisodeStartedAt: string | null
): string {
  const episode =
    previousEpisodeStartedAt === null ? 'armed' : new Date(previousEpisodeStartedAt).toISOString();
  return `${scopeKey}:${kind}:${channel}:${hourBucketStart(now).toISOString()}:${episode}`;
}

/**
 * The value a rule's condition compares and the threshold it compares against,
 * or `null` when the rule cannot be evaluated (feature or rule disabled, or the
 * rule has no complete configuration yet).
 */
function ruleCondition(
  snapshot: SpendAlertScopeSnapshot,
  rule: SpendAlertRuleSnapshot
): { valueMicrodollars: number; thresholdMicrodollars: number } | null {
  if (!snapshot.enabled || !rule.enabled) return null;

  if (rule.kind === 'threshold') {
    if (rule.thresholdMicrodollars === null || rule.windowHours === null) return null;
    const windowSum = snapshot.windowMicrodollars[rule.windowHours];
    if (windowSum === undefined) return null;
    return { valueMicrodollars: windowSum, thresholdMicrodollars: rule.thresholdMicrodollars };
  }

  if (rule.multiplierBasisPoints === null || snapshot.baselineHourlyMicrodollars === null)
    return null;
  return {
    valueMicrodollars: snapshot.currentHourMicrodollars,
    thresholdMicrodollars: Math.round(
      (snapshot.baselineHourlyMicrodollars * rule.multiplierBasisPoints) / MULTIPLIER_UNITS_PER_X
    ),
  };
}

type RuleDecision = {
  transition: SpendAlertTransition;
  deliveries: SpendAlertDeliveryDraft[];
};

/**
 * One rule's decision. Rising crossing fires; while firing nothing fires again;
 * falling below the hysteresis band clears. A rule that cannot be evaluated
 * cannot fire, and one that was firing goes back to armed without an alert.
 */
function decideRule(
  snapshot: SpendAlertScopeSnapshot,
  rule: SpendAlertRuleSnapshot,
  now: Date
): RuleDecision | null {
  const condition = ruleCondition(snapshot, rule);

  if (condition === null) {
    return rule.firing ? { transition: clearTransition(rule, null), deliveries: [] } : null;
  }

  const { valueMicrodollars, thresholdMicrodollars } = condition;

  if (!rule.firing) {
    const crossed =
      rule.kind === 'threshold'
        ? valueMicrodollars >= thresholdMicrodollars
        : valueMicrodollars > thresholdMicrodollars;
    if (!crossed) return null;
    return fireDecision(snapshot, rule, now, valueMicrodollars, thresholdMicrodollars);
  }

  if (valueMicrodollars < thresholdMicrodollars * HYSTERESIS_RATIO) {
    return { transition: clearTransition(rule, valueMicrodollars), deliveries: [] };
  }

  return null;
}

function clearTransition(
  rule: SpendAlertRuleSnapshot,
  valueMicrodollars: number | null
): SpendAlertTransition {
  return {
    action: 'clear',
    ruleId: rule.ruleId,
    kind: rule.kind,
    // Retained, not nulled: the next crossing's dedupe key needs the episode
    // that just ended to tell itself apart from a crossing in the same hour.
    conditionStartedAt: rule.conditionStartedAt,
    lastValueMicrodollars: valueMicrodollars ?? rule.lastValueMicrodollars,
  };
}

function fireDecision(
  snapshot: SpendAlertScopeSnapshot,
  rule: SpendAlertRuleSnapshot,
  now: Date,
  valueMicrodollars: number,
  thresholdMicrodollars: number
): RuleDecision {
  const firedAt = now.toISOString();
  const channels: SpendAlertChannel[] = [];
  if (rule.emailEnabled) channels.push('email');
  if (rule.pushEnabled) channels.push('push');

  return {
    transition: {
      action: 'fire',
      ruleId: rule.ruleId,
      kind: rule.kind,
      conditionStartedAt: firedAt,
      lastValueMicrodollars: valueMicrodollars,
    },
    // Push delivery still honors each recipient's own notification category;
    // the sender filters on it, the sweep just enqueues the channel.
    deliveries: channels.map(channel => ({
      dedupeKey: deliveryDedupeKey(
        snapshot.scopeKey,
        rule.kind,
        channel,
        now,
        rule.conditionStartedAt
      ),
      scopeKey: snapshot.scopeKey,
      ruleId: rule.ruleId,
      kind: rule.kind,
      channel,
      firedAt,
      payload: {
        valueMicrodollars,
        thresholdMicrodollars,
        windowHours: rule.kind === 'threshold' ? rule.windowHours : null,
        multiplierBasisPoints: rule.kind === 'anomaly' ? rule.multiplierBasisPoints : null,
        baselineHourlyMicrodollars: snapshot.baselineHourlyMicrodollars,
      },
    })),
  };
}

/**
 * Decides one scope. Pure over the store's snapshot: it writes nothing, and the
 * returned transitions plus delivery rows are the whole effect of a sweep, so
 * the one-alert guarantee is testable without a database.
 */
export async function evaluateScope(
  store: SpendAlertSweepStore,
  scopeKey: string,
  now: Date
): Promise<SpendAlertEvaluation> {
  const snapshot = await store.loadScopeSnapshot(scopeKey, now);
  if (snapshot === null) return { scopeKey, transitions: [], deliveries: [] };

  const transitions: SpendAlertTransition[] = [];
  const deliveries: SpendAlertDeliveryDraft[] = [];

  for (const rule of snapshot.rules) {
    const decision = decideRule(snapshot, rule, now);
    if (decision === null) continue;
    transitions.push(decision.transition);
    deliveries.push(...decision.deliveries);
  }

  return { scopeKey, transitions, deliveries };
}

// ---------------------------------------------------------------------------
// Rollup
// ---------------------------------------------------------------------------

/**
 * The instant the rollup's range scan starts from: the start of the hour that
 * contains `now - lookbackHours`, not that raw instant.
 *
 * Flooring to the bucket boundary is required by the statement's write-back
 * semantics below. The rollup re-derives each bucket as the sum of every row in
 * that hour and writes that sum over the stored one, so a scan starting
 * mid-hour would write the hour's *partial* sum and no later run would revisit
 * it — the window only ever moves forward, so the bucket would stay permanently
 * undercounted. Starting on the boundary makes the oldest bucket the statement
 * touches one it re-derives from all of its rows.
 */
export function rollupWindowStart(now: Date, lookbackHours: number): Date {
  return hourBucketStart(new Date(now.getTime() - lookbackHours * HOUR_MS));
}

/**
 * Re-derives the hourly buckets for every scope with usage in the lookback
 * window, in one statement, and returns the scope keys it touched — the delta
 * the sweep decides over.
 *
 * The window starts on an hour boundary ({@link rollupWindowStart}), so the
 * oldest bucket in range is summed from all of its rows. The bucket is set to
 * the re-derived sum rather than incremented, so the statement is idempotent:
 * an overlapping window or a replayed run cannot double count. `RETURNING`
 * names each re-derived bucket, so the returned set is deduplicated here to one
 * key per scope.
 */
export async function sweepHourlyBuckets(
  database: Db,
  options: { lookbackHours?: number; now?: Date } = {}
): Promise<{ scopeKeys: string[] }> {
  const lookbackHours = options.lookbackHours ?? LOOKBACK_HOURS;
  const from = rollupWindowStart(options.now ?? new Date(), lookbackHours);

  const rows = await database.execute<{ scope_key: string }>(sql`
    INSERT INTO ${spend_alert_hourly} (scope_key, hour_start, cost_microdollars, updated_at)
    SELECT
      CASE
        WHEN ${microdollar_usage.organization_id} IS NULL
          THEN 'user:' || ${microdollar_usage.kilo_user_id}
        ELSE 'org:' || ${microdollar_usage.organization_id}
      END,
      date_trunc('hour', ${microdollar_usage.created_at}),
      SUM(${microdollar_usage.cost}),
      now()
    FROM ${microdollar_usage}
    WHERE ${microdollar_usage.created_at} >= ${from}
    GROUP BY 1, 2
    ON CONFLICT (scope_key, hour_start)
    DO UPDATE SET
      cost_microdollars = EXCLUDED.cost_microdollars,
      updated_at = now()
    RETURNING scope_key
  `);

  const scopeKeys = new Set<string>();
  for (const row of rows.rows) scopeKeys.add(row.scope_key);
  return { scopeKeys: [...scopeKeys] };
}

// ---------------------------------------------------------------------------
// Postgres reads
// ---------------------------------------------------------------------------

/** Window start a rolling threshold sums from; the boundary the spend view uses. */
function windowStart(now: Date, windowHours: number): Date {
  return new Date(now.getTime() - windowHours * HOUR_MS);
}

function windowAlias(windowHours: number): string {
  return `window_${windowHours}`;
}

/**
 * Reads one scope's snapshot: the settings row, both rules with their state, and
 * the aggregates the conditions compare against. A scope that never saved
 * settings answers with a single indexed lookup, so the owners who never
 * configured spend alerts stay cheap to skip.
 */
export function createSpendAlertSweepStore(database: Db): SpendAlertSweepStore {
  return {
    async loadScopeSnapshot(scopeKey: string, now: Date): Promise<SpendAlertScopeSnapshot | null> {
      const scope = parseSpendAlertScopeKey(scopeKey);
      if (scope === null) return null;

      const [settingsRow] = await database
        .select({ id: spend_alert_settings.id, enabled: spend_alert_settings.enabled })
        .from(spend_alert_settings)
        .where(eq(spend_alert_settings.scope_key, scopeKey))
        .limit(1);
      if (settingsRow === undefined) return null;

      const ruleRows = await database
        .select({
          ruleId: spend_alert_rules.id,
          kind: spend_alert_rules.kind,
          enabled: spend_alert_rules.enabled,
          thresholdMicrodollars: spend_alert_rules.threshold_microdollars,
          windowHours: spend_alert_rules.window_hours,
          multiplierBasisPoints: spend_alert_rules.multiplier_basis_points,
          emailEnabled: spend_alert_rules.email_enabled,
          pushEnabled: spend_alert_rules.push_enabled,
          firing: spend_alert_rule_state.firing,
          conditionStartedAt: spend_alert_rule_state.condition_started_at,
          lastValueMicrodollars: spend_alert_rule_state.last_value_microdollars,
        })
        .from(spend_alert_rules)
        .leftJoin(spend_alert_rule_state, eq(spend_alert_rule_state.rule_id, spend_alert_rules.id))
        .where(eq(spend_alert_rules.settings_id, settingsRow.id));

      const rules: SpendAlertRuleSnapshot[] = ruleRows.map(row => ({
        ruleId: row.ruleId,
        kind: row.kind,
        enabled: row.enabled,
        thresholdMicrodollars: row.thresholdMicrodollars,
        windowHours: row.windowHours,
        multiplierBasisPoints: row.multiplierBasisPoints,
        emailEnabled: row.emailEnabled,
        pushEnabled: row.pushEnabled,
        firing: row.firing ?? false,
        conditionStartedAt: row.conditionStartedAt ?? null,
        lastValueMicrodollars: row.lastValueMicrodollars ?? null,
      }));

      const windows = [
        ...new Set(
          rules
            .filter(
              rule =>
                rule.kind === 'threshold' &&
                rule.enabled &&
                rule.windowHours !== null &&
                rule.thresholdMicrodollars !== null
            )
            .map(rule => rule.windowHours as number)
        ),
      ].sort((left, right) => left - right);

      const hourStart = hourBucketStart(now);
      const baselineFrom = new Date(now.getTime() - BASELINE_WINDOW_DAYS * DAY_MS);

      // One aggregate per scope: the partial hour the anomaly compares, the p95
      // baseline over the complete buckets (the same percentile and floor the
      // spend view shows), and one rolling sum per configured threshold window.
      const aggregate = sql`
        SELECT
          COALESCE(
            SUM(${spend_alert_hourly.cost_microdollars})
              FILTER (WHERE ${spend_alert_hourly.hour_start} = ${hourStart}),
            0
          ) AS current_hour,
          COUNT(*) FILTER (
            WHERE ${spend_alert_hourly.hour_start} >= ${baselineFrom}
              AND ${spend_alert_hourly.hour_start} < ${hourStart}
          ) AS baseline_buckets,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY ${spend_alert_hourly.cost_microdollars})
            FILTER (
              WHERE ${spend_alert_hourly.hour_start} >= ${baselineFrom}
                AND ${spend_alert_hourly.hour_start} < ${hourStart}
            ) AS baseline
          ${
            windows.length === 0
              ? sql``
              : sql`, ${sql.join(
                  windows.map(
                    windowHours => sql`
                      COALESCE(
                        SUM(${spend_alert_hourly.cost_microdollars})
                          FILTER (WHERE ${spend_alert_hourly.hour_start} > ${windowStart(now, windowHours)}),
                        0
                      ) AS ${sql.identifier(windowAlias(windowHours))}
                    `
                  ),
                  sql`, `
                )}`
          }
        FROM ${spend_alert_hourly}
        WHERE ${spend_alert_hourly.scope_key} = ${scopeKey}
      `;

      const [totals] = (await database.execute<Record<string, string | number | null>>(aggregate))
        .rows;

      const baselineBuckets = Number(totals?.baseline_buckets ?? 0);
      const baseline = totals?.baseline;
      const windowMicrodollars: Record<number, number> = {};
      for (const windowHours of windows) {
        windowMicrodollars[windowHours] = Number(totals?.[windowAlias(windowHours)] ?? 0);
      }

      return {
        scopeKey,
        enabled: settingsRow.enabled,
        rules,
        windowMicrodollars,
        currentHourMicrodollars: Number(totals?.current_hour ?? 0),
        baselineHourlyMicrodollars:
          baseline === null || baseline === undefined || baselineBuckets < BASELINE_MIN_BUCKETS
            ? null
            : Math.round(Number(baseline)),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export type SpendAlertSweepDeps = {
  /**
   * Read seam. The write path is the sweep's own SQL so a rule's state change
   * and its delivery rows commit in one transaction.
   */
  store: SpendAlertSweepStore;
};

export type SpendAlertSweepOptions = { now: Date };

export type SpendAlertSweepResult = {
  /** Scopes whose buckets this run re-derived: the usage delta. */
  sweptScopes: number;
  /** Scopes decided: the delta plus the rules that were still firing. */
  candidateScopes: number;
  fired: number;
  cleared: number;
  deliveriesEnqueued: number;
};

/**
 * Runs one sweep: re-derive the buckets, decide the scopes the rollup returned,
 * then re-arm the rules that are still firing so a window that decayed while its
 * scope was quiet goes back to armed without waiting for new usage.
 *
 * Nothing here enumerates owners: the candidate set is the usage delta plus the
 * currently firing rules, and the firing rules are walked with a keyset so the
 * run reads bounded pages while still re-arming every one of them.
 */
export async function runSpendAlertSweep(
  database: Db,
  deps: SpendAlertSweepDeps,
  options: SpendAlertSweepOptions
): Promise<SpendAlertSweepResult> {
  const { now } = options;
  const { scopeKeys } = await sweepHourlyBuckets(database, { lookbackHours: LOOKBACK_HOURS, now });

  const result: SpendAlertSweepResult = {
    sweptScopes: scopeKeys.length,
    candidateScopes: 0,
    fired: 0,
    cleared: 0,
    deliveriesEnqueued: 0,
  };

  // A scope is decided once per run, however it entered the candidate set (the
  // rollup delta or the re-arm walk), so a scope in both is not evaluated twice.
  const decided = new Set<string>();
  const decide = async (scopeKey: string): Promise<void> => {
    if (decided.has(scopeKey)) return;
    decided.add(scopeKey);

    const evaluation = await evaluateScope(deps.store, scopeKey, now);
    if (evaluation.transitions.length === 0 && evaluation.deliveries.length === 0) return;

    for (const transition of evaluation.transitions) {
      if (transition.action === 'fire') result.fired += 1;
      else result.cleared += 1;
    }
    result.deliveriesEnqueued += await persistEvaluation(database, evaluation);
  };

  for (const scopeKey of scopeKeys) await decide(scopeKey);

  // Walk the still-firing rules with a keyset until the set is exhausted. Each
  // page is bounded, and the cursor is the last key of the previous page, so a
  // scope is never read twice and no scope is left behind by a fixed ceiling:
  // deciding a scope can only remove it from the firing set, never add to it.
  let cursor: string | undefined;
  for (;;) {
    const page = await readFiringScopeKeys(database, cursor);
    for (const scopeKey of page) await decide(scopeKey);
    if (page.length < FIRING_SCOPE_PAGE_SIZE) break;
    const last = page.at(-1);
    if (last === undefined) break;
    cursor = last;
  }

  result.candidateScopes = decided.size;
  return result;
}

/**
 * One page of scope keys with at least one rule in the firing state, ordered by
 * scope key and read with a keyset so the run can walk the whole set in bounded
 * statements. `selectDistinct` collapses the two rules a scope may have into one
 * key; `after` is the previous page's last key, so the walk never repeats a row.
 * This is the re-arm pass's candidate set, not the owner population.
 */
async function readFiringScopeKeys(database: Db, after: string | undefined): Promise<string[]> {
  const rows = await database
    .selectDistinct({ scopeKey: spend_alert_settings.scope_key })
    .from(spend_alert_rule_state)
    .innerJoin(spend_alert_rules, eq(spend_alert_rules.id, spend_alert_rule_state.rule_id))
    .innerJoin(spend_alert_settings, eq(spend_alert_settings.id, spend_alert_rules.settings_id))
    .where(
      after === undefined
        ? eq(spend_alert_rule_state.firing, true)
        : and(eq(spend_alert_rule_state.firing, true), gt(spend_alert_settings.scope_key, after))
    )
    .orderBy(spend_alert_settings.scope_key)
    .limit(FIRING_SCOPE_PAGE_SIZE);
  return rows.map(row => row.scopeKey);
}

/**
 * Persists one scope's transitions and enqueues its deliveries in one
 * transaction, so a rule can never end up firing with no outbox row. The
 * delivery insert is keyed on `dedupe_key`, which is what collapses a
 * concurrent sweep of the same episode onto a single delivery. Returns the
 * number of rows actually enqueued.
 */
async function persistEvaluation(database: Db, evaluation: SpendAlertEvaluation): Promise<number> {
  const recipients: SpendAlertRecipients | null =
    evaluation.deliveries.length === 0
      ? null
      : await resolveRecipients(database, evaluation.scopeKey);

  return database.transaction(async tx => {
    for (const transition of evaluation.transitions) {
      await tx
        .insert(spend_alert_rule_state)
        .values({
          rule_id: transition.ruleId,
          firing: transition.action === 'fire',
          condition_started_at: transition.conditionStartedAt,
          last_value_microdollars: transition.lastValueMicrodollars,
        })
        .onConflictDoUpdate({
          target: spend_alert_rule_state.rule_id,
          set: {
            firing: transition.action === 'fire',
            condition_started_at: transition.conditionStartedAt,
            last_value_microdollars: transition.lastValueMicrodollars,
            updated_at: sql`now()`,
          },
        });
    }

    if (recipients === null) return 0;

    const enqueued = await tx
      .insert(spend_alert_deliveries)
      .values(
        evaluation.deliveries.map(draft => ({
          dedupe_key: draft.dedupeKey,
          scope_key: draft.scopeKey,
          rule_id: draft.ruleId,
          kind: draft.kind,
          channel: draft.channel,
          fired_at: draft.firedAt,
          recipients,
          payload: draft.payload,
        }))
      )
      .onConflictDoNothing({ target: spend_alert_deliveries.dedupe_key })
      .returning({ id: spend_alert_deliveries.id });

    return enqueued.length;
  });
}

/** The authorized billing contacts of an evaluation's scope, or `null` if unknown. */
async function resolveRecipients(
  database: Db,
  scopeKey: string
): Promise<SpendAlertRecipients | null> {
  const scope = parseSpendAlertScopeKey(scopeKey);
  if (scope === null) return null;
  return authorizedBillingContacts(database, scope);
}
