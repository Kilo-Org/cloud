/**
 * Pure state for the spend-alerts panel: which of the panel's render states to
 * show, how the wire settings become an editable draft, whether the scope has
 * saved settings at all (a never-configured scope looks like one saved with the
 * feature off), the bounds the draft is validated against before a save, and the
 * push/mobile-category agreement.
 *
 * Kept free of React and of the database so `jest` (which runs the web suite in
 * a node environment and matches `*.test.ts` only) can cover every state
 * exhaustively; the component file stays a thin renderer over this module, the
 * same split `usageDataState.ts` uses for the usage dashboard.
 *
 * The bounds here mirror `SpendAlertRuleInputSchema` in
 * `apps/web/src/routers/spend-alert-router.ts` (s3): the limit is USD in
 * (0, 1_000_000], the window is one of 24/168/720 hours, and the spike
 * multiplier is a basis-point integer in [100, 5000].
 */
import {
  canManageOrganizationBilling,
  type OrganizationRole,
} from '@kilocode/app-shared/organizations';

export type SpendAlertRuleKind = 'threshold' | 'anomaly';

/** Rolling-window choices, in hours. Mirrors `SpendAlertWindowHoursSchema`. */
export const SPEND_ALERT_WINDOW_HOURS = [24, 168, 720] as const;
export type SpendAlertWindowHours = (typeof SPEND_ALERT_WINDOW_HOURS)[number];

export const WINDOW_LABELS: Record<SpendAlertWindowHours, string> = {
  24: '24 hours',
  168: '7 days',
  720: '30 days',
};

/** Inclusive upper bound on a rolling-window limit, in USD. */
export const MAX_THRESHOLD_USD = 1_000_000;

/** Spike-multiplier bounds in basis points (100 = 1x). */
export const MIN_MULTIPLIER_BASIS_POINTS = 100;
export const MAX_MULTIPLIER_BASIS_POINTS = 5_000;

export const SPEND_ALERTS_LOAD_ERROR = "Couldn't load spend alerts.";
export const SPEND_ALERTS_SAVE_ERROR = "Couldn't save spend alerts.";
export const SPEND_ALERTS_FORBIDDEN = "You don't have permission to manage spend alerts.";
export const SPEND_ALERTS_OFF_IN_NOTIFICATIONS = 'Off in Notifications';
export const SPEND_ALERTS_OFF_COPY =
  "Spend alerts are off. Turn them on to alert this scope's billing contacts.";
export const SPEND_ALERTS_SAVED = 'Spend alert settings saved';
export const THRESHOLD_FIELD_ERROR = 'Enter a limit over 0 and at most 1,000,000.';
export const MULTIPLIER_FIELD_ERROR = 'Enter a spike multiplier between 1x and 50x.';

/**
 * Deep link into the mobile app's notification settings, where this account's
 * spend-alerts push category lives. The app registers the `kiloapp` scheme
 * (`apps/mobile/app.config.ts`) and serves the screen at `/notifications`
 * (`apps/mobile/src/app/(app)/(tabs)/(3_profile)/notifications.tsx`).
 */
export const MOBILE_NOTIFICATION_SETTINGS_HREF = 'kiloapp:///notifications';

/** One rule as the router returns it: USD threshold, basis-point multiplier. */
export type SpendAlertRuleWire = {
  kind: SpendAlertRuleKind;
  enabled: boolean;
  threshold: number | null;
  windowHours: number | null;
  multiplierBasisPoints: number | null;
  emailEnabled: boolean;
  pushEnabled: boolean;
  firing: boolean;
};

/**
 * What the settings query resolved to. Structural on purpose: the component
 * passes the tRPC result straight in, and a caller who may not manage the scope
 * simply has no `enabled`/`rules`.
 */
export type SpendAlertsQueryData = {
  canManage: boolean;
  /** The viewer's own mobile notification category, the push delivery gate. */
  pushCategoryEnabled: boolean;
  enabled?: boolean;
  rules?: SpendAlertRuleWire[];
};

/** One rule as the panel edits it. Numeric fields stay text while being typed. */
export type SpendAlertRuleDraft = {
  kind: SpendAlertRuleKind;
  enabled: boolean;
  /** Rolling-window limit in USD, as typed. */
  thresholdUsd: string;
  windowHours: SpendAlertWindowHours;
  /** Spike multiplier in "times", as typed (2.5 means 2.5x). */
  multiplier: string;
  emailEnabled: boolean;
  pushEnabled: boolean;
};

export type SpendAlertsDraft = {
  enabled: boolean;
  rules: SpendAlertRuleDraft[];
};

/** The rule kinds the panel always renders, in a stable order. */
const RULE_KINDS: SpendAlertRuleKind[] = ['threshold', 'anomaly'];
const DEFAULT_WINDOW_HOURS: SpendAlertWindowHours = 24;

/** Wire rule → editable draft. `null` wire values become empty inputs. */
export function toDraft(data: SpendAlertsQueryData): SpendAlertsDraft {
  const rules = data.rules ?? [];
  return {
    enabled: data.enabled ?? false,
    rules: RULE_KINDS.map(kind => {
      const rule = rules.find(candidate => candidate.kind === kind);
      return {
        kind,
        enabled: rule?.enabled ?? true,
        thresholdUsd: rule?.threshold == null ? '' : formatUsdInput(rule.threshold),
        windowHours: isWindowHours(rule?.windowHours) ? rule.windowHours : DEFAULT_WINDOW_HOURS,
        multiplier:
          rule?.multiplierBasisPoints == null
            ? ''
            : formatMultiplierInput(rule.multiplierBasisPoints),
        emailEnabled: rule?.emailEnabled ?? true,
        pushEnabled: rule?.pushEnabled ?? false,
      };
    }),
  };
}

function isWindowHours(value: number | null | undefined): value is SpendAlertWindowHours {
  return SPEND_ALERT_WINDOW_HOURS.some(hours => hours === value);
}

function formatUsdInput(value: number): string {
  return `${value}`;
}

function formatMultiplierInput(basisPoints: number): string {
  return `${basisPoints / 100}`;
}

/**
 * Whether this scope already has saved settings.
 *
 * The panel has to tell a scope that was never switched on from one whose owner
 * saved the feature off: only the second one can post `enabled: false`, and the
 * never-configured one keeps the master switch as its only action. The query
 * output carries no explicit flag for it, so this reads the values a saved row
 * cannot leave null: `SpendAlertRuleInputSchema` in
 * `apps/web/src/routers/spend-alert-router.ts` requires a positive limit and a
 * window on the threshold rule and a multiplier in [100, 5000] basis points on
 * the anomaly rule, and `saveSpendAlertSettings` is the only writer of a
 * settings row — while a scope with no row reads back the schema defaults from
 * `readSpendAlertSettings`, every value null.
 *
 * If the query output ever grows a `hasSettings` flag, return it here and drop
 * the derivation; the rest of the module reads this function only.
 */
export function hasSettingsRow(data: SpendAlertsQueryData): boolean {
  return (data.rules ?? []).some(
    rule =>
      rule.threshold !== null ||
      rule.windowHours !== null ||
      rule.multiplierBasisPoints !== null
  );
}

/** Parse a USD text field. `null` for blank or non-numeric input. */
export function parseUsdInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** Parse a spike-multiplier text field. `null` for blank or non-numeric input. */
export function parseMultiplierInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

export type SpendAlertSaveRule = {
  kind: SpendAlertRuleKind;
  enabled: boolean;
  threshold: number | null;
  windowHours: SpendAlertWindowHours | null;
  multiplierBasisPoints: number | null;
  emailEnabled: boolean;
  pushEnabled: boolean;
};

export type SpendAlertSaveInput = {
  enabled: boolean;
  rules: SpendAlertSaveRule[];
};

/** Inline messages keyed by the field they belong to. */
export type SpendAlertFieldErrors = {
  threshold?: string;
  multiplier?: string;
};

export type SpendAlertValidation =
  | { ok: true; input: SpendAlertSaveInput; errors: SpendAlertFieldErrors }
  | { ok: false; input: null; errors: SpendAlertFieldErrors };

/**
 * Draft → the payload `spendAlerts.save` accepts. Fails (and reports which
 * field is wrong) exactly when the router's zod schema would reject the same
 * values, so a disabled Save always means the server would refuse.
 */
export function toSaveInput(draft: SpendAlertsDraft): SpendAlertValidation {
  const errors: SpendAlertFieldErrors = {};
  const rules: SpendAlertSaveRule[] = [];

  for (const rule of draft.rules) {
    if (rule.kind === 'threshold') {
      const threshold = parseUsdInput(rule.thresholdUsd);
      const valid = threshold !== null && threshold > 0 && threshold <= MAX_THRESHOLD_USD;
      if (!valid) errors.threshold = THRESHOLD_FIELD_ERROR;
      rules.push({
        kind: 'threshold',
        enabled: rule.enabled,
        threshold: valid ? threshold : null,
        windowHours: rule.windowHours,
        multiplierBasisPoints: null,
        emailEnabled: rule.emailEnabled,
        pushEnabled: rule.pushEnabled,
      });
      continue;
    }

    const multiplier = parseMultiplierInput(rule.multiplier);
    const basisPoints = multiplier === null ? null : Math.round(multiplier * 100);
    const valid =
      basisPoints !== null &&
      basisPoints >= MIN_MULTIPLIER_BASIS_POINTS &&
      basisPoints <= MAX_MULTIPLIER_BASIS_POINTS;
    if (!valid) errors.multiplier = MULTIPLIER_FIELD_ERROR;
    rules.push({
      kind: 'anomaly',
      enabled: rule.enabled,
      threshold: null,
      windowHours: null,
      multiplierBasisPoints: valid ? basisPoints : null,
      emailEnabled: rule.emailEnabled,
      pushEnabled: rule.pushEnabled,
    });
  }

  const ok = errors.threshold === undefined && errors.multiplier === undefined;
  return ok
    ? { ok, input: { enabled: draft.enabled, rules }, errors }
    : { ok, input: null, errors };
}

/**
 * Whether a rule's push would actually reach this viewer. Mirrors
 * `effectivePushFor` in `apps/web/src/lib/spend-alerts/settings.ts` (s3) — that
 * module is `server-only` (it opens the database), so the client panel cannot
 * import it and keeps the one-line rule here instead.
 */
export function effectivePushFor(
  viewerCategoryEnabled: boolean,
  rule: Pick<SpendAlertRuleDraft, 'pushEnabled'>
): boolean {
  return rule.pushEnabled && viewerCategoryEnabled;
}

export type ChannelAgreement = {
  message: string;
  href: string;
};

/**
 * The agreement note for a rule's push row: shown only when the rule asks for
 * push but the viewer's own mobile category is off, so the control reads as
 * effective either way. `null` when push is effective (or not wanted).
 */
export function pushChannelNote(
  viewerCategoryEnabled: boolean,
  rule: Pick<SpendAlertRuleDraft, 'pushEnabled'>
): ChannelAgreement | null {
  if (effectivePushFor(viewerCategoryEnabled, rule)) return null;
  if (!rule.pushEnabled) return null;
  return { message: SPEND_ALERTS_OFF_IN_NOTIFICATIONS, href: MOBILE_NOTIFICATION_SETTINGS_HREF };
}

export type SpendAlertsPanelView =
  /** Non-retryable: this caller has no spend-alert settings to manage. */
  | { status: 'hidden' }
  | { status: 'loading' }
  /** Retryable: the settings query failed with nothing cached to keep. */
  | { status: 'load-error'; message: string }
  /** Non-retryable: the server refused to manage this scope's settings. */
  | { status: 'forbidden'; message: string }
  /**
   * The settings are theirs to edit. `draft.enabled === false` with
   * `hasSettings === false` is the empty state.
   */
  | {
      status: 'ready';
      draft: SpendAlertsDraft;
      /** Whether the scope already has a saved settings row. */
      hasSettings: boolean;
      save: { isPending: boolean; error: string | null };
    };

/**
 * Whether the ready panel shows its editing controls — the rule fields and the
 * Save row — rather than the empty state's read-only defaults.
 *
 * A scope with no saved settings reads back the defaults, which `toSaveInput`
 * rejects, so until its master switch is on its only action is that switch.
 * Once a row exists the controls stay live with the feature off: switching it
 * off is itself a change worth saving (without this, `enabled: false` could
 * never be posted and the feature could never be turned off), and the saved
 * values stay editable so they can be adjusted without turning alerts back on.
 */
export function panelControlsVisible(
  draft: Pick<SpendAlertsDraft, 'enabled'>,
  hasSettings: boolean
): boolean {
  return draft.enabled || hasSettings;
}

export type SpendAlertsQueryState = {
  isLoading: boolean;
  isError: boolean;
  data: SpendAlertsQueryData | undefined;
};

export type SpendAlertsMutationState = {
  isPending: boolean;
  isError: boolean;
};

/**
 * Which panel state to render.
 *
 * - An organization caller whose role cannot manage billing gets no panel at
 *   all: spend-alert settings are a billing surface, and a member has nothing
 *   to do with them (no controls, no call to action).
 * - A failed query with no cached settings is retryable.
 * - A resolved query that says `canManage: false` is the non-retryable
 *   refusal; the server is authoritative, so the panel says so instead of
 *   offering a control it would reject. No retry: the answer will not change.
 */
export function derivePanelView(
  query: SpendAlertsQueryState,
  callerRole: OrganizationRole | undefined,
  mutation: SpendAlertsMutationState
): SpendAlertsPanelView {
  if (callerRole !== undefined && !canManageOrganizationBilling(callerRole)) {
    return { status: 'hidden' };
  }

  if (query.data === undefined) {
    if (query.isError) return { status: 'load-error', message: SPEND_ALERTS_LOAD_ERROR };
    return { status: 'loading' };
  }

  if (!query.data.canManage) {
    return { status: 'forbidden', message: SPEND_ALERTS_FORBIDDEN };
  }

  return {
    status: 'ready',
    draft: toDraft(query.data),
    hasSettings: hasSettingsRow(query.data),
    save: {
      isPending: mutation.isPending,
      error: mutation.isError ? SPEND_ALERTS_SAVE_ERROR : null,
    },
  };
}
