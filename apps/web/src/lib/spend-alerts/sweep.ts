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
import { sentryLogger } from '@/lib/utils.server';
import type { db as defaultDb } from '@/lib/drizzle';

/**
 * The spend-alert engine. A sweep is one statement that re-derives the hourly
 * rollup for the scopes that had usage in the lookback window, and then a
 * decision for exactly those scopes — never a walk over the owner population.
 *
 * The decision reads are set-based: a run decides its candidate scopes in
 * bounded batches, and each batch costs one settings+rules+state read and (for
 * the scopes that saved settings) one hourly aggregate, never a round trip per
 * scope. The run also has a ceiling on how many scopes it decides, so one tick
 * cannot outgrow the route's time budget.
 *
 * The ceiling defers, it never drops. The rollup hands back every scope it
 * re-derived, not only the ones whose bucket moved, so a scope the run defers is
 * still a candidate on the next tick for as long as its usage stays inside the
 * lookback window. Within the candidate set the run decides the scopes whose
 * decision can have changed — the buckets the rollup actually rewrote and the
 * rules still firing — ahead of the rest, and it tiles a rotating window over
 * each stretch by the slots that stretch was actually granted, so nothing in it
 * waits longer than the rollup window. See {@link MAX_SCOPE_DECISIONS_PER_RUN}.
 *
 * The rolled-up bucket is re-derived from `microdollar_usage`, never
 * incremented, so a replayed or overlapping window cannot double count. The
 * per-run cost is proportional to the usage rows written in the window: an idle
 * fleet costs one empty range scan. Nothing is added to the usage write path.
 */

/**
 * Rules per re-arm pass read. The set holds one row per still-firing rule, so
 * it tracks concurrently firing alerts rather than the owner population, but a
 * firing rule can stay latched for a whole window and the set can be larger
 * than one run should fetch at once. The run walks it with a keyset on the
 * primary key (`rule_id > last`) until it is exhausted, so every page is an
 * index range scan of the state table rather than a scan of the whole firing
 * set. Scopes with fresh usage still arrive through the re-derived set.
 */
const FIRING_SCOPE_PAGE_SIZE = 500;

/**
 * Scopes per batched read. A chunk costs one settings+rules+state read and, for
 * the scopes in it that saved settings, one aggregate — a bounded number of
 * round trips that does not grow with the candidate count.
 */
export const SCOPE_BATCH_SIZE = 500;

/**
 * Scopes one run decides at most. The candidate set (the scopes the rollup
 * re-derived plus the still-firing rules) can outgrow a single tick, and one
 * tick has to stay inside the route's 300 s budget and leave the delivery drain
 * its share of the request.
 *
 * The cap defers the candidate set, it does not truncate it. The rollup returns
 * every scope it re-derived, so a deferred scope is a candidate again on the
 * next tick even though its bucket no longer changes, and the run walks both the
 * required set (the rollup's real delta plus the still-firing rules) and the
 * remainder of the re-derived set with windows that tile by the slots each
 * stretch was granted. The required set gets every slot the remainder's reserved
 * floor does not take — a scope with a new value to decide is deferred only
 * when the delta alone outgrows the cap — and the remainder keeps a floor of
 * one window so it always advances even then. That floor is capped at
 * {@link MAX_REMAINDER_FLOOR} whenever the required set is non-empty, so a
 * 90 k-scope remainder cannot zero the delta. Every candidate is reached within
 * the {@link LOOKBACK_HOURS} rollup window, so a scope the cap deferred is
 * re-decided rather than dropped once its bucket stops moving.
 */
export const MAX_SCOPE_DECISIONS_PER_RUN = 5000;

/**
 * Ticks the remainder floor is sized to cover. Half the rollup window (3 h of
 * {@link LOOKBACK_HOURS} at the five-minute cron): `ceil(n / SKIP_PATH_ROTATION_TICKS)`
 * is the slots the remainder would need per tick to finish in that many ticks.
 * The actual rotation advances by the slots granted, not by this window, so a
 * stretch that receives fewer slots still tiles instead of skipping.
 */
const SKIP_PATH_ROTATION_TICKS = 18;

/**
 * Largest share of {@link MAX_SCOPE_DECISIONS_PER_RUN} the remainder floor may
 * reserve while the required set still has work. Without this,
 * `ceil(rederived.length / SKIP_PATH_ROTATION_TICKS)` reaches the whole cap
 * once the re-derived set is ~90 k scopes (89,983: `ceil(n / 18) = 5000`), and
 * neither the delta nor a still-firing rule would be decided again.
 */
const MAX_REMAINDER_FLOOR = Math.floor(MAX_SCOPE_DECISIONS_PER_RUN / 2);

/**
 * The cron interval the rotation window is keyed on (the five-minute schedule in
 * `apps/web/vercel.json:136`). Two runs in the same five-minute tick compute the
 * same window, so overlapping sweeps stay idempotent; consecutive ticks advance
 * it by the slots that stretch was granted.
 */
const TICK_INTERVAL_MS = 5 * 60 * 1000;

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

/**
 * The rolling windows a threshold rule may configure, exactly the set
 * `SpendAlertWindowHoursSchema` accepts (`spend-alert-router.ts:28`). The
 * batched aggregate precomputes one sum per window, so selecting a scope's
 * configured window is a lookup rather than another round trip.
 */
const WINDOW_HOURS_CHOICES = [24, 168, 720] as const;

/**
 * Longest rolling window; keep in sync with {@link WINDOW_HOURS_CHOICES}. It is
 * the lower bound of the per-scope aggregate, so the read touches one range of
 * the unique `(scope_key, hour_start)` index instead of every bucket the scope
 * ever stored.
 */
const MAX_WINDOW_HOURS = 720;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type Db = typeof defaultDb;

/** One rule row plus its live state and identity, as the sweep reads it. */
export type SpendAlertRuleSnapshot = SpendAlertRuleView & { ruleId: string };

/**
 * Everything one decision needs for one scope: the settings, both rules with
 * their state, and the spend aggregates the conditions are compared against.
 * The store produces it; `evaluateSnapshot` decides over it without touching a
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

/**
 * Read seam of the sweep. Production reads Postgres; tests inject a stub. The
 * batch form is what keeps a run's round trips bounded: one call reads one
 * chunk of scope keys in a fixed number of statements, whether the chunk holds
 * one scope or {@link SCOPE_BATCH_SIZE}.
 */
export interface SpendAlertSweepStore {
  /**
   * Reads the settings, rules and aggregates for a batch of scope keys. A key
   * with no settings row is absent from the map; the unconfigured owners stay
   * cheap to skip.
   */
  loadScopeSnapshots(scopeKeys: string[], now: Date): Promise<Map<string, SpendAlertScopeSnapshot>>;
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
 * Decides one scope from an already-read snapshot. Pure over the snapshot: it
 * writes nothing, and the returned transitions plus delivery rows are the whole
 * effect of a sweep, so the one-alert guarantee is testable without a database.
 */
export function evaluateSnapshot(
  snapshot: SpendAlertScopeSnapshot,
  now: Date
): SpendAlertEvaluation {
  const transitions: SpendAlertTransition[] = [];
  const deliveries: SpendAlertDeliveryDraft[] = [];

  for (const rule of snapshot.rules) {
    const decision = decideRule(snapshot, rule, now);
    if (decision === null) continue;
    transitions.push(decision.transition);
    deliveries.push(...decision.deliveries);
  }

  return { scopeKey: snapshot.scopeKey, transitions, deliveries };
}

/**
 * Decides one scope through the store's batch read: the single-scope form of
 * {@link evaluateSnapshot}, kept for callers that hold one scope.
 */
export async function evaluateScope(
  store: SpendAlertSweepStore,
  scopeKey: string,
  now: Date
): Promise<SpendAlertEvaluation> {
  const snapshots = await store.loadScopeSnapshots([scopeKey], now);
  const snapshot = snapshots.get(scopeKey);
  if (snapshot === undefined) return { scopeKey, transitions: [], deliveries: [] };
  return evaluateSnapshot(snapshot, now);
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
 * One rollup statement's result: every scope it re-derived from the usage
 * window, and the subset whose stored bucket it actually rewrote.
 */
export type SpendAlertRollup = {
  /**
   * Every scope with usage in the rollup window, in scope-key order — the
   * candidate reservoir the run decides from. A scope the run defers is still
   * here on every later tick for as long as its usage stays inside the window,
   * which is what makes the run's cap defer instead of drop.
   */
  scopeKeys: string[];
  /**
   * The scopes whose stored bucket the guarded upsert actually rewrote: the real
   * delta, not every scope with usage in the window. A scope absent from this
   * list has no new value for the rules to compare, so the run orders these
   * ahead of the rest of the reservoir.
   */
  changedScopeKeys: string[];
};

/**
 * Re-derives the hourly buckets for every scope with usage in the lookback
 * window, in one statement, and returns both the re-derived set and the scope
 * keys whose stored cost actually changed — the delta the sweep decides over.
 *
 * The window starts on an hour boundary ({@link rollupWindowStart}), so the
 * oldest bucket in range is summed from all of its rows. The bucket is set to
 * the re-derived sum rather than incremented, so the statement is idempotent:
 * an overlapping window or a replayed run cannot double count.
 *
 * The update is guarded by `IS DISTINCT FROM`, so a bucket whose sum did not
 * move is not rewritten: the hourly row-version churn stays proportional to
 * spend that changed. The guard narrows what the statement *writes*, never what
 * it *returns*: the re-derived set comes from the aggregate, not from
 * `RETURNING`, so a scope the guard skipped is still a candidate on the next
 * tick. Returning only the guarded delta would drop every scope the run's cap
 * deferred, because a deferred bucket has already been rewritten and never
 * changes again. A still-firing rule the delta does not mention is re-armed by
 * the run's firing walk, so the one-alert guarantee does not depend on this
 * statement touching every scope.
 *
 * The scan stops at `now`: `microdollar_usage.created_at` is sender-supplied and
 * can sit ahead of our clock, and a future-dated row must not create a bucket
 * for an hour that has not started — the anomaly rule and the baseline both
 * assume the newest bucket is the partial current hour. Such a row rolls up
 * normally on the first run after its timestamp.
 */
export async function sweepHourlyBuckets(
  database: Db,
  options: { lookbackHours?: number; now?: Date } = {}
): Promise<SpendAlertRollup> {
  const lookbackHours = options.lookbackHours ?? LOOKBACK_HOURS;
  const now = options.now ?? new Date();
  const from = rollupWindowStart(now, lookbackHours);

  // One scan feeds both answers: `rederived` is the aggregate over the window,
  // `rewritten` the guarded upsert over it, and the outer select joins the
  // guarded write back onto the aggregate so the re-derived set survives the
  // guard. Two separate statements would scan `microdollar_usage` twice.
  const rows = await database.execute<{ scope_key: string; changed: boolean }>(sql`
    WITH rederived AS (
      SELECT
        CASE
          WHEN ${microdollar_usage.organization_id} IS NULL
            THEN 'user:' || ${microdollar_usage.kilo_user_id}
          ELSE 'org:' || ${microdollar_usage.organization_id}
        END AS scope_key,
        date_trunc('hour', ${microdollar_usage.created_at}) AS hour_start,
        SUM(${microdollar_usage.cost}) AS cost_microdollars
      FROM ${microdollar_usage}
      WHERE ${microdollar_usage.created_at} >= ${from}
        AND ${microdollar_usage.created_at} <= ${now}
      GROUP BY 1, 2
    ),
    rewritten AS (
      INSERT INTO ${spend_alert_hourly} (scope_key, hour_start, cost_microdollars, updated_at)
      SELECT scope_key, hour_start, cost_microdollars, now()
      FROM rederived
      ON CONFLICT (scope_key, hour_start)
      DO UPDATE SET
        cost_microdollars = EXCLUDED.cost_microdollars,
        updated_at = now()
      WHERE ${spend_alert_hourly.cost_microdollars} IS DISTINCT FROM EXCLUDED.cost_microdollars
      RETURNING scope_key
    )
    SELECT
      rederived.scope_key AS scope_key,
      bool_or(rewritten.scope_key IS NOT NULL) AS changed
    FROM rederived
    LEFT JOIN rewritten ON rewritten.scope_key = rederived.scope_key
    GROUP BY rederived.scope_key
    ORDER BY rederived.scope_key
  `);

  const scopeKeys: string[] = [];
  const changedScopeKeys: string[] = [];
  for (const row of rows.rows) {
    scopeKeys.push(row.scope_key);
    if (row.changed) changedScopeKeys.push(row.scope_key);
  }
  return { scopeKeys, changedScopeKeys };
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
 * The distinct windows a scope's rules actually compare against. A window with
 * no complete configuration cannot be evaluated, so it is not summed. The
 * batched aggregate returns the same three windows for every scope; a
 * configured window outside that set has no precomputed sum and the rule cannot
 * be evaluated.
 */
function configuredWindows(rules: SpendAlertRuleSnapshot[]): number[] {
  return [
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
}

/**
 * Reads a batch of scope snapshots. Two statements serve the whole batch: one
 * settings+rules+state read, and — for the scopes in the batch that saved
 * settings — one hourly aggregate grouped by scope. A scope that never saved
 * settings produces no snapshot, so the owners who never configured spend
 * alerts stay cheap to skip, and they cost no aggregate at all.
 */
export function createSpendAlertSweepStore(database: Db): SpendAlertSweepStore {
  return {
    async loadScopeSnapshots(
      scopeKeys: string[],
      now: Date
    ): Promise<Map<string, SpendAlertScopeSnapshot>> {
      const snapshots = new Map<string, SpendAlertScopeSnapshot>();

      // A key that names neither scope has no settings to read. The rollup and
      // the settings row both produce well-formed keys, so this only drops
      // malformed input.
      const keys = [...new Set(scopeKeys)].filter(key => parseSpendAlertScopeKey(key) !== null);
      if (keys.length === 0) return snapshots;

      // One read for the whole batch: the settings row, its rules and their live
      // state, over `scope_key = ANY($1)`.
      const ruleRows = await database
        .select({
          scopeKey: spend_alert_settings.scope_key,
          enabled: spend_alert_settings.enabled,
          ruleId: spend_alert_rules.id,
          kind: spend_alert_rules.kind,
          ruleEnabled: spend_alert_rules.enabled,
          thresholdMicrodollars: spend_alert_rules.threshold_microdollars,
          windowHours: spend_alert_rules.window_hours,
          multiplierBasisPoints: spend_alert_rules.multiplier_basis_points,
          emailEnabled: spend_alert_rules.email_enabled,
          pushEnabled: spend_alert_rules.push_enabled,
          firing: spend_alert_rule_state.firing,
          conditionStartedAt: spend_alert_rule_state.condition_started_at,
          lastValueMicrodollars: spend_alert_rule_state.last_value_microdollars,
        })
        .from(spend_alert_settings)
        .leftJoin(spend_alert_rules, eq(spend_alert_rules.settings_id, spend_alert_settings.id))
        .leftJoin(spend_alert_rule_state, eq(spend_alert_rule_state.rule_id, spend_alert_rules.id))
        .where(sql`${spend_alert_settings.scope_key} = ANY(${sql.param(keys)}::text[])`);

      const rulesByScope = new Map<string, SpendAlertRuleSnapshot[]>();
      const enabledByScope = new Map<string, boolean>();
      for (const row of ruleRows) {
        enabledByScope.set(row.scopeKey, row.enabled);
        if (!rulesByScope.has(row.scopeKey)) rulesByScope.set(row.scopeKey, []);

        // A settings row without rules (or a missing state row) still yields a
        // snapshot: `enabledByScope` always gets the scope, so a half-written
        // scope is decided with no rules rather than being mistaken for an
        // unconfigured owner and skipped.
        const ruleId: string | null = row.ruleId ?? null;
        const kind: SpendAlertRuleKind | null = row.kind ?? null;
        if (ruleId === null || kind === null) continue;

        rulesByScope.get(row.scopeKey)?.push({
          ruleId,
          kind,
          // The rule columns are NOT NULL; the fallbacks only satisfy the left
          // join's nullable type and cannot be reached once `ruleId` is set.
          enabled: row.ruleEnabled ?? true,
          thresholdMicrodollars: row.thresholdMicrodollars,
          windowHours: row.windowHours,
          multiplierBasisPoints: row.multiplierBasisPoints,
          emailEnabled: row.emailEnabled ?? true,
          pushEnabled: row.pushEnabled ?? false,
          firing: row.firing ?? false,
          conditionStartedAt: row.conditionStartedAt ?? null,
          lastValueMicrodollars: row.lastValueMicrodollars ?? null,
        });
      }

      if (enabledByScope.size === 0) return snapshots;

      const hourStart = hourBucketStart(now);
      const baselineFrom = new Date(now.getTime() - BASELINE_WINDOW_DAYS * DAY_MS);
      const lowerBound = windowStart(now, MAX_WINDOW_HOURS);
      const configured = [...enabledByScope.keys()];

      // One aggregate for the batch: the partial hour the anomaly compares, the
      // p95 baseline over the complete buckets (the same percentile and floor
      // the spend view shows), and one rolling sum per window the router allows.
      // The `hour_start` lower bound is the longest window, so the read is a
      // range of `uq_spend_alert_hourly_scope_hour` rather than every bucket the
      // scope ever stored (the window sums are FILTERs Postgres cannot push into
      // the index qual).
      const aggregate = sql`
        SELECT
          ${spend_alert_hourly.scope_key} AS scope_key,
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
          ${sql.join(
            WINDOW_HOURS_CHOICES.map(
              windowHours => sql`,
                COALESCE(
                  SUM(${spend_alert_hourly.cost_microdollars})
                    FILTER (WHERE ${spend_alert_hourly.hour_start} > ${windowStart(now, windowHours)}),
                  0
                ) AS ${sql.identifier(windowAlias(windowHours))}`
            ),
            sql``
          )}
        FROM ${spend_alert_hourly}
        WHERE ${spend_alert_hourly.scope_key} = ANY(${sql.param(configured)}::text[])
          AND ${spend_alert_hourly.hour_start} >= ${lowerBound}
        GROUP BY ${spend_alert_hourly.scope_key}
      `;

      const totalsByScope = new Map<string, Record<string, string | number | null>>();
      const totalsRows = (await database.execute<Record<string, string | number | null>>(aggregate))
        .rows;
      for (const totals of totalsRows) {
        const scopeKey = totals.scope_key;
        if (typeof scopeKey === 'string') totalsByScope.set(scopeKey, totals);
      }

      for (const [scopeKey, enabled] of enabledByScope) {
        const rules = rulesByScope.get(scopeKey) ?? [];
        const totals = totalsByScope.get(scopeKey);
        const baselineBuckets = Number(totals?.baseline_buckets ?? 0);
        const baseline = totals?.baseline;

        const windowMicrodollars: Record<number, number> = {};
        for (const windowHours of configuredWindows(rules)) {
          windowMicrodollars[windowHours] = Number(totals?.[windowAlias(windowHours)] ?? 0);
        }

        snapshots.set(scopeKey, {
          scopeKey,
          enabled,
          rules,
          windowMicrodollars,
          currentHourMicrodollars: Number(totals?.current_hour ?? 0),
          baselineHourlyMicrodollars:
            baseline === null || baseline === undefined || baselineBuckets < BASELINE_MIN_BUCKETS
              ? null
              : Math.round(Number(baseline)),
        });
      }

      return snapshots;
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

/** Per-phase wall-clock of one run, with the work it deferred to the next tick. */
export type SpendAlertSweepPhaseTimings = {
  /** Milliseconds spent re-deriving the hourly buckets (the rollup statement). */
  rollupMs: number;
  /** Milliseconds spent deciding and persisting the candidate scopes. */
  decisionMs: number;
  /** Milliseconds spent reading the still-firing rule set. */
  rearmMs: number;
  /** Candidate scopes left to a later tick by {@link MAX_SCOPE_DECISIONS_PER_RUN}. */
  deferredScopes: number;
};

export type SpendAlertSweepResult = {
  /**
   * Scopes whose stored bucket this run actually rewrote: the usage delta, not
   * every scope with usage in the window.
   */
  sweptScopes: number;
  /** Scopes decided: the delta, the rules still firing, and the rotating rest. */
  candidateScopes: number;
  fired: number;
  cleared: number;
  deliveriesEnqueued: number;
  /**
   * Optional so a caller that only mocks the sweep for its counts is not forced
   * to invent phase timings; {@link runSpendAlertSweep} always sets it.
   */
  timings?: SpendAlertSweepPhaseTimings;
};

/** A still-firing rule and the scope it belongs to. */
type FiringRule = { ruleId: string; scopeKey: string };

/**
 * The `take` scopes this tick decides from `scopeKeys`, wrapping. Consecutive
 * ticks advance by `take` (the slots this stretch was actually granted), so the
 * windows tile: a stretch that receives fewer slots than
 * `ceil(n / SKIP_PATH_ROTATION_TICKS)` still reaches every key, instead of
 * stepping by n/18 and skipping the tail of each window.
 *
 * The offset is keyed on the cron tick so two sweeps of the same five-minute
 * tick choose the same window and stay idempotent.
 */
function rotatedSlice(scopeKeys: string[], now: Date, take: number): string[] {
  if (scopeKeys.length === 0 || take <= 0) return [];
  const count = Math.min(take, scopeKeys.length);
  const tick = Math.floor(now.getTime() / TICK_INTERVAL_MS);
  const offset = (tick * count) % scopeKeys.length;
  const tail = scopeKeys.length - offset;
  if (count <= tail) return scopeKeys.slice(offset, offset + count);
  return [...scopeKeys.slice(offset), ...scopeKeys.slice(0, count - tail)];
}

/**
 * Runs one sweep: re-derive the buckets, decide the scopes the rollup re-derived
 * plus the rules that are still firing, in bounded batches.
 *
 * Nothing here enumerates owners: the candidate set is the re-derived usage set
 * plus the currently firing rules. A scope is decided once, the whole set is
 * capped at {@link MAX_SCOPE_DECISIONS_PER_RUN}, and the cap is decided in
 * batches of {@link SCOPE_BATCH_SIZE}, each batch costing one settings read and
 * one aggregate rather than one round trip per scope.
 *
 * The cap defers, it never drops. The scopes whose decision can have changed —
 * the rollup's real delta and the still-firing rules — are served first, so they
 * are deferred only when the delta alone outgrows the cap; the remainder of the
 * re-derived set keeps a floor of one window, capped at
 * {@link MAX_REMAINDER_FLOOR} while the required set is non-empty, so it always
 * advances even then without zeroing the delta; and both stretches tile by the
 * slots they were granted, so a scope either stretch deferred is reached again
 * without depending on its bucket changing a second time.
 */
export async function runSpendAlertSweep(
  database: Db,
  deps: SpendAlertSweepDeps,
  options: SpendAlertSweepOptions
): Promise<SpendAlertSweepResult> {
  const { now } = options;

  const rollupStartedAt = Date.now();
  const rollup = await sweepHourlyBuckets(database, { lookbackHours: LOOKBACK_HOURS, now });
  const rollupMs = Date.now() - rollupStartedAt;

  // A scope is decided once per run, however it entered the candidate set (the
  // rollup delta or the firing walk), so a scope in both is not evaluated twice;
  // the remainder below is everything the rollup re-derived that neither named.
  const seen = new Set<string>();
  const required: string[] = [];
  const addRequired = (scopeKey: string): void => {
    if (seen.has(scopeKey)) return;
    seen.add(scopeKey);
    required.push(scopeKey);
  };

  // Walk the still-firing rules with a keyset on the primary key until the set
  // is exhausted. Each page is bounded and each page is an index range scan of
  // `spend_alert_rule_state`; the cursor is the last rule id of the previous
  // page, so no page rescans the whole firing set the way a keyset on the
  // joined `scope_key` did. A scope's two rules collapse into one candidate.
  const rearmStartedAt = Date.now();
  let cursor: string | undefined;
  for (;;) {
    const page = await readFiringRules(database, cursor);
    for (const rule of page) addRequired(rule.scopeKey);
    if (page.length < FIRING_SCOPE_PAGE_SIZE) break;
    const last = page.at(-1);
    if (last === undefined) break;
    cursor = last.ruleId;
  }
  const rearmMs = Date.now() - rearmStartedAt;

  // The rollup's real delta: the scopes whose stored bucket moved, so their
  // rules have a new value to compare. They go ahead of the rest of the
  // re-derived set because a bucket that has been rewritten does not change
  // again, so the rollup will never name one of them a second time.
  const changed = new Set(rollup.changedScopeKeys);
  for (const scopeKey of rollup.scopeKeys) {
    if (changed.has(scopeKey)) addRequired(scopeKey);
  }

  // Everything else the rollup re-derived: the durable remainder. A scope with
  // no settings row cannot produce a decision, so deciding one is a no-op, but a
  // scope the cap deferred out of the required set lands here on a later tick —
  // its bucket no longer changes, so the rollup only re-derives it — and this
  // stretch is what decides it.
  const rederived = rollup.scopeKeys.filter(scopeKey => !seen.has(scopeKey));

  // The remainder keeps a floor of one rotation window, so its window advances
  // even when the required set alone fills the cap; the rest of the cap goes to
  // the required scopes. That floor cannot exceed {@link MAX_REMAINDER_FLOOR}
  // while the required set is non-empty: once the re-derived set is ~90 k
  // scopes, `ceil(n / 18)` equals the whole cap, and without the bound the
  // delta and the still-firing rules would get zero slots every tick. Both
  // stretches tile by the slots they were granted, so when one is larger than
  // that, consecutive ticks walk through it instead of deciding the same head
  // every tick and starving the tail.
  const remainderFloor = Math.min(
    rederived.length,
    rederived.length === 0 ? 0 : Math.ceil(rederived.length / SKIP_PATH_ROTATION_TICKS),
    required.length === 0 ? MAX_SCOPE_DECISIONS_PER_RUN : MAX_REMAINDER_FLOOR
  );
  const requiredSlots = Math.min(
    required.length,
    MAX_SCOPE_DECISIONS_PER_RUN - remainderFloor
  );
  const remainderSlots = Math.min(
    rederived.length,
    MAX_SCOPE_DECISIONS_PER_RUN - requiredSlots
  );
  const decided = [
    ...rotatedSlice(required, now, requiredSlots),
    ...rotatedSlice(rederived, now, remainderSlots),
  ];
  const deferredScopes = required.length + rederived.length - decided.length;

  const timings: SpendAlertSweepPhaseTimings = {
    rollupMs,
    decisionMs: 0,
    rearmMs,
    deferredScopes,
  };
  const result: SpendAlertSweepResult = {
    sweptScopes: rollup.changedScopeKeys.length,
    candidateScopes: 0,
    fired: 0,
    cleared: 0,
    deliveriesEnqueued: 0,
    timings,
  };

  const decisionStartedAt = Date.now();
  for (let offset = 0; offset < decided.length; offset += SCOPE_BATCH_SIZE) {
    const batch = decided.slice(offset, offset + SCOPE_BATCH_SIZE);
    const snapshots = await deps.store.loadScopeSnapshots(batch, now);

    for (const scopeKey of batch) {
      const snapshot = snapshots.get(scopeKey);
      if (snapshot === undefined) continue;

      const evaluation = evaluateSnapshot(snapshot, now);
      if (evaluation.transitions.length === 0 && evaluation.deliveries.length === 0) continue;

      for (const transition of evaluation.transitions) {
        if (transition.action === 'fire') result.fired += 1;
        else result.cleared += 1;
      }
      result.deliveriesEnqueued += await persistEvaluation(database, evaluation);
    }
  }
  timings.decisionMs = Date.now() - decisionStartedAt;

  result.candidateScopes = decided.length;

  sentryLogger('cron', 'info')('Spend alert sweep phases completed', {
    sweptScopes: result.sweptScopes,
    rederivedScopes: rollup.scopeKeys.length,
    candidateScopes: result.candidateScopes,
    fired: result.fired,
    cleared: result.cleared,
    deliveriesEnqueued: result.deliveriesEnqueued,
    timings: result.timings,
  });

  return result;
}

/**
 * One page of still-firing rules, ordered by rule id and read with a keyset so
 * the walk never repeats a row. Paging on the primary key of
 * `spend_alert_rule_state` makes each page an index range scan; the joins only
 * recover the scope key the decision needs. This is the re-arm pass's candidate
 * set, not the owner population.
 */
async function readFiringRules(database: Db, after: string | undefined): Promise<FiringRule[]> {
  return database
    .select({
      ruleId: spend_alert_rule_state.rule_id,
      scopeKey: spend_alert_settings.scope_key,
    })
    .from(spend_alert_rule_state)
    .innerJoin(spend_alert_rules, eq(spend_alert_rules.id, spend_alert_rule_state.rule_id))
    .innerJoin(spend_alert_settings, eq(spend_alert_settings.id, spend_alert_rules.settings_id))
    .where(
      after === undefined
        ? eq(spend_alert_rule_state.firing, true)
        : and(eq(spend_alert_rule_state.firing, true), gt(spend_alert_rule_state.rule_id, after))
    )
    .orderBy(spend_alert_rule_state.rule_id)
    .limit(FIRING_SCOPE_PAGE_SIZE);
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
