import 'server-only';

import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  kilocode_users,
  organization_memberships,
  spend_alert_hourly,
  spend_alert_rule_state,
  spend_alert_rules,
  spend_alert_settings,
  user_notification_preferences,
} from '@kilocode/db/schema';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import type { DrizzleTransaction, db as defaultDb } from '@/lib/drizzle';

/**
 * Storage unit of every money column in this feature: one US dollar is one
 * million microdollars.
 */
export const MICRODOLLARS_PER_USD = 1_000_000;

/**
 * Smallest USD threshold the wire accepts. `toStoredRule` rounds the USD value
 * to microdollars, so a smaller positive value would be stored as `0`: the rule
 * would then fire on any spend and its 95% hysteresis band would be zero, so it
 * could never clear. The web and mobile validators enforce the same floor.
 */
export const MIN_THRESHOLD_USD = 0.000_001;

/**
 * Minimum number of complete hourly buckets before the p95 anomaly baseline is
 * trusted. Below this the baseline is `null` (the anomaly rule cannot fire).
 * This is the prior-art floor; a scope needs a full day of history first.
 */
export const BASELINE_MIN_BUCKETS = 24;

/** Trailing window the p95 baseline is computed over. */
const BASELINE_WINDOW_DAYS = 14;

/** Prefixes of the server-only `spend_alert_*` scope key. */
const PERSONAL_SCOPE_PREFIX = 'user:';
const ORGANIZATION_SCOPE_PREFIX = 'org:';

/**
 * The owner a set of spend-alert settings belongs to. Either a user (personal
 * spend) or an organization (organization spend). This is the domain form of
 * the `scope_key` stored on every spend-alert table.
 */
export type SpendAlertScope =
  | { type: 'personal'; userId: string }
  | { type: 'organization'; organizationId: string };

export type SpendAlertRuleKind = 'threshold' | 'anomaly';

/** Persisted configuration of one alert rule. */
export type SpendAlertRuleConfig = {
  kind: SpendAlertRuleKind;
  enabled: boolean;
  /** Rolling-window threshold in microdollars; threshold kind only. */
  thresholdMicrodollars: number | null;
  /** Rolling window in hours; threshold kind only. */
  windowHours: number | null;
  /** How far above the hourly baseline counts as an anomaly; anomaly kind only. */
  multiplierBasisPoints: number | null;
  emailEnabled: boolean;
  pushEnabled: boolean;
};

/** Liveness of one rule, maintained by the sweep. */
export type SpendAlertRuleState = {
  firing: boolean;
  conditionStartedAt: string | null;
  lastValueMicrodollars: number | null;
};

/** A configured rule plus its current state, as the settings surfaces read it. */
export type SpendAlertRuleView = SpendAlertRuleConfig & SpendAlertRuleState;

export type SpendAlertSpend = {
  /** Rolling spend over the trailing 24 hours, including the current partial hour. */
  spend24hMicrodollars: number;
  /** Rolling spend over the trailing 7 days, including the current partial hour. */
  spend7dMicrodollars: number;
  /**
   * p95 of the per-hour spend over the trailing 14 days, excluding the current
   * partial hour. `null` until the scope has {@link BASELINE_MIN_BUCKETS} buckets.
   */
  baselineHourlyMicrodollars: number | null;
};

export type SpendAlertSettings = {
  scopeKey: string;
  enabled: boolean;
  rules: SpendAlertRuleView[];
  spend: SpendAlertSpend;
};

export type SaveSpendAlertSettingsInput = {
  enabled: boolean;
  rules: SpendAlertRuleConfig[];
  /**
   * The caller whose own mobile delivery gate agrees with the saved channel
   * choices. Organization rules are org-wide, but the notification-category
   * column is per viewer.
   */
  viewerUserId: string;
};

export type SpendAlertRecipients = {
  userIds: string[];
  emails: string[];
};

type Db = typeof defaultDb;
type DbOrTx = Db | DrizzleTransaction;

type DefaultRulesByKind = Record<SpendAlertRuleKind, SpendAlertRuleView>;

/** Schema defaults for a scope that has never saved settings (`enabled: false`). */
const DEFAULT_RULES: DefaultRulesByKind = {
  threshold: {
    kind: 'threshold',
    enabled: true,
    thresholdMicrodollars: null,
    windowHours: null,
    multiplierBasisPoints: null,
    emailEnabled: true,
    pushEnabled: false,
    firing: false,
    conditionStartedAt: null,
    lastValueMicrodollars: null,
  },
  anomaly: {
    kind: 'anomaly',
    enabled: true,
    thresholdMicrodollars: null,
    windowHours: null,
    multiplierBasisPoints: null,
    emailEnabled: true,
    pushEnabled: false,
    firing: false,
    conditionStartedAt: null,
    lastValueMicrodollars: null,
  },
};

const RULE_KIND_ORDER: SpendAlertRuleKind[] = ['threshold', 'anomaly'];

/** `user:<kilocode_users.id>` — the personal scope key. */
export function personalScopeKey(userId: string): string {
  return `${PERSONAL_SCOPE_PREFIX}${userId}`;
}

/** `org:<organizations.id>` — the organization scope key. */
export function organizationScopeKey(organizationId: string): string {
  return `${ORGANIZATION_SCOPE_PREFIX}${organizationId}`;
}

/** The stored `scope_key` for a scope. Shared with the sweep. */
export function spendAlertScopeKey(scope: SpendAlertScope): string {
  return scope.type === 'personal'
    ? personalScopeKey(scope.userId)
    : organizationScopeKey(scope.organizationId);
}

/**
 * Inverse of {@link personalScopeKey}/{@link organizationScopeKey}. Returns
 * `null` for a key that names neither scope. The sweep reads only scope keys, so
 * this is how it recovers the owner to authorize and to query.
 */
export function parseSpendAlertScopeKey(key: string): SpendAlertScope | null {
  if (key.startsWith(PERSONAL_SCOPE_PREFIX)) {
    const userId = key.slice(PERSONAL_SCOPE_PREFIX.length);
    return userId === '' ? null : { type: 'personal', userId };
  }
  if (key.startsWith(ORGANIZATION_SCOPE_PREFIX)) {
    const organizationId = key.slice(ORGANIZATION_SCOPE_PREFIX.length);
    return organizationId === '' ? null : { type: 'organization', organizationId };
  }
  return null;
}

/**
 * The mobile notification category the spend view's push channel agrees with:
 * true when any enabled rule asks for push, false otherwise. Pure so the
 * agreement is testable without a database.
 */
export function derivePushCategoryEnabled(
  rules: Pick<SpendAlertRuleConfig, 'enabled' | 'pushEnabled'>[]
): boolean {
  return rules.some(rule => rule.enabled && rule.pushEnabled);
}

/**
 * Whether a save changes the push agreement between a scope's rules and the
 * caller's own mobile notification category.
 *
 * {@link derivePushCategoryEnabled} answers what the agreement *should* be;
 * this answers whether *this* save is the one that moves it. The category is a
 * per-viewer setting the Notifications screen owns, so a save that re-sends a
 * stored push rule (editing a threshold, toggling email) must leave the column
 * where the caller put it — only a save that turns a push channel on, or the
 * last one off, agrees the category again.
 */
export function pushCategoryChanges(
  storedRules: Pick<SpendAlertRuleConfig, 'enabled' | 'pushEnabled'>[],
  nextRules: Pick<SpendAlertRuleConfig, 'enabled' | 'pushEnabled'>[]
): boolean {
  return derivePushCategoryEnabled(storedRules) !== derivePushCategoryEnabled(nextRules);
}

/**
 * Whether a rule's push would actually be delivered to a viewer. Push is only
 * effective when the rule asks for push AND the viewer's own category is on —
 * the rule cannot override an individual's notification settings. Pure, so both
 * the web spend view and the mobile settings screen read the same rule.
 */
export function effectivePushFor(
  viewerCategoryEnabled: boolean,
  rule: Pick<SpendAlertRuleConfig, 'pushEnabled'>
): boolean {
  return rule.pushEnabled && viewerCategoryEnabled;
}

function isDatabase(database: DbOrTx): database is Db {
  // `drizzle()` attaches `$client` to database instances; transactions never have it.
  return typeof (database as { $client?: unknown }).$client !== 'undefined';
}

/** Runs `work` in its own transaction, or inline when given an open transaction. */
async function inTransaction<T>(
  database: DbOrTx,
  work: (tx: DrizzleTransaction) => Promise<T>
): Promise<T> {
  return isDatabase(database) ? database.transaction(work) : work(database);
}

/**
 * Reads everything the settings surfaces need for one scope in a single
 * transaction: the settings row, both rules and their state, and the rolling
 * spend plus the anomaly baseline. A scope with no settings row is the feature
 * off with schema defaults, not an error.
 */
export async function readSpendAlertSettings(
  database: DbOrTx,
  scope: SpendAlertScope
): Promise<SpendAlertSettings> {
  const scopeKey = spendAlertScopeKey(scope);

  return inTransaction(database, async tx => {
    const [settingsRow] = await tx
      .select({ id: spend_alert_settings.id, enabled: spend_alert_settings.enabled })
      .from(spend_alert_settings)
      .where(eq(spend_alert_settings.scope_key, scopeKey))
      .limit(1);

    const rules = settingsRow
      ? await readRules(tx, settingsRow.id)
      : RULE_KIND_ORDER.map(kind => ({ ...DEFAULT_RULES[kind] }));

    const spend = await readSpend(tx, scopeKey);

    return {
      scopeKey,
      enabled: settingsRow?.enabled ?? false,
      rules,
      spend,
    };
  });
}

async function readRules(
  tx: DrizzleTransaction,
  settingsId: string
): Promise<SpendAlertRuleView[]> {
  const ruleRows = await tx
    .select({
      id: spend_alert_rules.id,
      kind: spend_alert_rules.kind,
      enabled: spend_alert_rules.enabled,
      thresholdMicrodollars: spend_alert_rules.threshold_microdollars,
      windowHours: spend_alert_rules.window_hours,
      multiplierBasisPoints: spend_alert_rules.multiplier_basis_points,
      emailEnabled: spend_alert_rules.email_enabled,
      pushEnabled: spend_alert_rules.push_enabled,
    })
    .from(spend_alert_rules)
    .where(eq(spend_alert_rules.settings_id, settingsId));

  const stateByRuleId = new Map<string, SpendAlertRuleState>();
  if (ruleRows.length > 0) {
    const stateRows = await tx
      .select({
        ruleId: spend_alert_rule_state.rule_id,
        firing: spend_alert_rule_state.firing,
        conditionStartedAt: spend_alert_rule_state.condition_started_at,
        lastValueMicrodollars: spend_alert_rule_state.last_value_microdollars,
      })
      .from(spend_alert_rule_state)
      .where(
        inArray(
          spend_alert_rule_state.rule_id,
          ruleRows.map(rule => rule.id)
        )
      );
    for (const state of stateRows) {
      stateByRuleId.set(state.ruleId, {
        firing: state.firing,
        conditionStartedAt: state.conditionStartedAt,
        lastValueMicrodollars: state.lastValueMicrodollars,
      });
    }
  }

  const rulesByKind = new Map<SpendAlertRuleKind, SpendAlertRuleView>();
  for (const rule of ruleRows) {
    rulesByKind.set(rule.kind, {
      kind: rule.kind,
      enabled: rule.enabled,
      thresholdMicrodollars: rule.thresholdMicrodollars,
      windowHours: rule.windowHours,
      multiplierBasisPoints: rule.multiplierBasisPoints,
      emailEnabled: rule.emailEnabled,
      pushEnabled: rule.pushEnabled,
      ...(stateByRuleId.get(rule.id) ?? {
        firing: false,
        conditionStartedAt: null,
        lastValueMicrodollars: null,
      }),
    });
  }

  // Always return both kinds in a stable order, filling a missing rule with
  // defaults so the surfaces never have to handle a half-configured scope.
  return RULE_KIND_ORDER.map(kind => rulesByKind.get(kind) ?? { ...DEFAULT_RULES[kind] });
}

async function readSpend(tx: DrizzleTransaction, scopeKey: string): Promise<SpendAlertSpend> {
  const totals = await tx.execute<{
    spend_24h: string | number | null;
    spend_7d: string | number | null;
  }>(
    sql`
      SELECT
        COALESCE(
          SUM(${spend_alert_hourly.cost_microdollars})
            FILTER (WHERE ${spend_alert_hourly.hour_start} > now() - interval '24 hours'),
          0
        ) AS spend_24h,
        COALESCE(
          SUM(${spend_alert_hourly.cost_microdollars})
            FILTER (WHERE ${spend_alert_hourly.hour_start} > now() - interval '7 days'),
          0
        ) AS spend_7d
      FROM ${spend_alert_hourly}
      WHERE ${spend_alert_hourly.scope_key} = ${scopeKey}
    `
  );

  // The current partial hour is deliberately excluded: it is still filling, and
  // including it would drag the baseline down every time the sweep reads it.
  const baseline = await tx.execute<{
    buckets: string | number;
    baseline: string | number | null;
  }>(sql`
    SELECT
      COUNT(*) AS buckets,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY ${spend_alert_hourly.cost_microdollars}) AS baseline
    FROM ${spend_alert_hourly}
    WHERE ${spend_alert_hourly.scope_key} = ${scopeKey}
      AND ${spend_alert_hourly.hour_start} >= now() - interval '${sql.raw(String(BASELINE_WINDOW_DAYS))} days'
      AND ${spend_alert_hourly.hour_start} < date_trunc('hour', now())
  `);

  const totalsRow = totals.rows[0];
  const baselineRow = baseline.rows[0];
  const buckets = Number(baselineRow?.buckets ?? 0);
  const baselineMicrodollars =
    baselineRow?.baseline === null || baselineRow?.baseline === undefined
      ? null
      : Math.round(Number(baselineRow.baseline));

  return {
    spend24hMicrodollars: Number(totalsRow?.spend_24h ?? 0),
    spend7dMicrodollars: Number(totalsRow?.spend_7d ?? 0),
    baselineHourlyMicrodollars: buckets >= BASELINE_MIN_BUCKETS ? baselineMicrodollars : null,
  };
}

/**
 * The channel choices a scope's stored rules carry, read inside the save
 * transaction before this save overwrites them. Empty for a scope with no
 * settings row, which is the same as no rule asking for push.
 */
async function readStoredRuleChannels(
  tx: DrizzleTransaction,
  scopeKey: string
): Promise<Pick<SpendAlertRuleConfig, 'enabled' | 'pushEnabled'>[]> {
  const [settingsRow] = await tx
    .select({ id: spend_alert_settings.id })
    .from(spend_alert_settings)
    .where(eq(spend_alert_settings.scope_key, scopeKey))
    .limit(1);
  if (!settingsRow) {
    return [];
  }
  return tx
    .select({
      enabled: spend_alert_rules.enabled,
      pushEnabled: spend_alert_rules.push_enabled,
    })
    .from(spend_alert_rules)
    .where(eq(spend_alert_rules.settings_id, settingsRow.id));
}

/**
 * Writes the settings row and both rules, and — in the same transaction — the
 * caller's `spend_alerts_enabled` agreement column when this save changes the
 * push channel choice. Upserts are keyed on the unique indexes the schema
 * declares, so a replayed save is idempotent.
 */
export async function saveSpendAlertSettings(
  database: DbOrTx,
  scope: SpendAlertScope,
  input: SaveSpendAlertSettingsInput
): Promise<SpendAlertSettings> {
  const scopeKey = spendAlertScopeKey(scope);
  const categoryEnabled = derivePushCategoryEnabled(input.rules);

  await inTransaction(database, async tx => {
    // Read the channel choice this save replaces before any upsert touches it.
    const storedChannels = await readStoredRuleChannels(tx, scopeKey);

    const [settingsRow] = await tx
      .insert(spend_alert_settings)
      .values({
        scope_key: scopeKey,
        kilo_user_id: scope.type === 'personal' ? scope.userId : null,
        organization_id: scope.type === 'organization' ? scope.organizationId : null,
        enabled: input.enabled,
      })
      .onConflictDoUpdate({
        target: spend_alert_settings.scope_key,
        set: { enabled: input.enabled, updated_at: sql`now()` },
      })
      .returning({ id: spend_alert_settings.id });

    for (const rule of input.rules) {
      await tx
        .insert(spend_alert_rules)
        .values({
          settings_id: settingsRow.id,
          kind: rule.kind,
          enabled: rule.enabled,
          threshold_microdollars: rule.thresholdMicrodollars,
          window_hours: rule.windowHours,
          multiplier_basis_points: rule.multiplierBasisPoints,
          email_enabled: rule.emailEnabled,
          push_enabled: rule.pushEnabled,
        })
        .onConflictDoUpdate({
          target: [spend_alert_rules.settings_id, spend_alert_rules.kind],
          set: {
            enabled: rule.enabled,
            threshold_microdollars: rule.thresholdMicrodollars,
            window_hours: rule.windowHours,
            multiplier_basis_points: rule.multiplierBasisPoints,
            email_enabled: rule.emailEnabled,
            push_enabled: rule.pushEnabled,
            updated_at: sql`now()`,
          },
        });
    }

    // The mobile category and the spend view's push channel must not disagree:
    // a save that turns a push channel on enables the caller's own category,
    // and one that drops the last push turns it back off. A save that leaves
    // the channel choices where they were writes nothing: the Notifications
    // screen owns the column, and re-deriving it from every rule on every save
    // silently re-enabled a category the caller had turned off there.
    if (pushCategoryChanges(storedChannels, input.rules)) {
      await tx
        .insert(user_notification_preferences)
        .values({ user_id: input.viewerUserId, spend_alerts_enabled: categoryEnabled })
        .onConflictDoUpdate({
          target: user_notification_preferences.user_id,
          set: { spend_alerts_enabled: categoryEnabled, updated_at: sql`now()` },
        });
    }
  });

  return readSpendAlertSettings(database, scope);
}

/**
 * The users authorized to receive this scope's spend alerts, and their email
 * addresses. Organization scope: every member holding a billing role
 * ({@link ORGANIZATION_BILLING_ROLES}); personal scope: the owner alone. The
 * query is scoped to the one organization, so no other owner's contacts can
 * leak into the result.
 */
export async function authorizedBillingContacts(
  database: DbOrTx,
  scope: SpendAlertScope
): Promise<SpendAlertRecipients> {
  if (scope.type === 'personal') {
    const rows = await database
      .select({ userId: kilocode_users.id, email: kilocode_users.google_user_email })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, scope.userId));
    return {
      userIds: rows.map(row => row.userId),
      emails: rows.map(row => row.email),
    };
  }

  const rows = await database
    .select({
      userId: organization_memberships.kilo_user_id,
      email: kilocode_users.google_user_email,
    })
    .from(organization_memberships)
    .innerJoin(kilocode_users, eq(kilocode_users.id, organization_memberships.kilo_user_id))
    .where(
      and(
        eq(organization_memberships.organization_id, scope.organizationId),
        inArray(organization_memberships.role, ORGANIZATION_BILLING_ROLES)
      )
    );
  return {
    userIds: rows.map(row => row.userId),
    emails: rows.map(row => row.email),
  };
}
