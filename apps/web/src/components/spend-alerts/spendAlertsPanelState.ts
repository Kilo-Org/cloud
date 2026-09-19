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
 * [1e-6, 1_000_000] (the floor is the microdollar it is stored in), the window
 * is one of 24/168/720 hours, and the spike multiplier is a basis-point integer
 * in [100, 5000].
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

/**
 * Smallest limit that survives the router's conversion to microdollars
 * (`round(threshold * MICRODOLLARS_PER_USD)`). A smaller positive value rounds
 * to a zero-microdollar threshold, which fires on any spend and whose 95%
 * hysteresis band is zero, so it never clears.
 */
export const MIN_THRESHOLD_USD = 0.000_001;

/** Spike-multiplier bounds in basis points (100 = 1x). */
export const MIN_MULTIPLIER_BASIS_POINTS = 100;
export const MAX_MULTIPLIER_BASIS_POINTS = 5_000;

/**
 * Stand-ins submitted for a rule kind the owner has switched off. The router
 * requires a value for every kind whatever its `enabled` flag, so a switched-off
 * kind that is blank or out of range submits the smallest value its schema
 * accepts instead of making the owner repair a field for an alert that never
 * fires. A switched-off rule whose draft still holds a valid value keeps it.
 */
export const DISABLED_THRESHOLD_USD = 1;
export const DISABLED_MULTIPLIER_BASIS_POINTS = MIN_MULTIPLIER_BASIS_POINTS;

export const SPEND_ALERTS_LOAD_ERROR = "Couldn't load spend alerts.";
export const SPEND_ALERTS_SAVE_ERROR = "Couldn't save spend alerts.";
export const SPEND_ALERTS_FORBIDDEN = "You don't have permission to manage spend alerts.";
export const SPEND_ALERTS_OFF_IN_NOTIFICATIONS = 'Off in Notifications';
export const SPEND_ALERTS_PUSH_NEEDS_DEVICE = 'Get the mobile app';
export const SPEND_ALERTS_OFF_COPY =
  "Spend alerts are off. Turn them on to alert this scope's billing contacts.";
export const SPEND_ALERTS_SAVED = 'Spend alert settings saved';
export const THRESHOLD_FIELD_ERROR = 'Enter a limit over 0 and at most 1,000,000.';
export const MULTIPLIER_FIELD_ERROR = 'Enter a spike multiplier between 1x and 50x.';

/**
 * Where the web panel sends a viewer to fix a blocked push channel: the Kilo
 * mobile app page, which installs the app whose notification settings own the
 * spend-alerts category and whose device registration push delivery needs.
 *
 * A browser URL on purpose. The mobile app's own surface can deep-link to its
 * notification settings (`kiloapp:///notifications`), but on a desktop browser
 * that scheme is a dead end; the web remedy has to resolve over http(s).
 */
export const MOBILE_APP_SETUP_HREF = 'https://kilo.ai/mobile';

/**
 * The reserved height of the panel's slot: every render state (loading,
 * load-error, forbidden, ready) puts a Card carrying this class inside a
 * `@container` wrapper, so the slot is at least as tall as the ready form needs
 * at the card's own width and the dashboard below never moves when the settings
 * arrive, fail, or are refused.
 *
 * The ready form's height is a step function of the card width, not a single
 * number: the rule descriptions and the push channel note wrap differently
 * across a window of card widths, and how tall that window's step is varies
 * with the host's text metrics and with whether push is blocked. The bands
 * therefore reserve the *worst reported* ready-form height for their whole
 * range, not the common one — a form below the floor costs nothing but the
 * space the slot already holds.
 *
 * The `>= 580px` band was the one that shrank under the ready form: the e3 run
 * measured the loading slot at 47rem (752px) and the saved, enabled form at
 * 804px on the organization usage-details view at a 1024px viewport, so the
 * cards below the panel jumped 52px as the settings arrived
 * (`e3-slot-1024.log`). The e8 sweep recorded the same shape at 816px once the
 * push channel is blocked ("Get the mobile app" on both rules), and this band
 * has to cover both numbers under every resolution of the element query, so it
 * has no upper width boundary: a card whose width resolves the query to
 * `>= 580px` gets 52rem (832px). Narrower cards keep their own, larger floors
 * (measured worst 871.5px in 380-579px and 892.5px in 310-379px).
 *
 * Below a 310px card the form's height grows without bound as the copy wraps
 * one word per line (1101px at a 238px card, 1354px at 138px), so no finite
 * floor closes that band; it keeps the pre-existing 66rem.
 *
 * `spendAlertsPanelState.test.ts` parses this class and asserts that each band
 * covers the worst ready-form height recorded for it, so the numbers cannot
 * drift apart again. The constant lives in this React-free module for that
 * test: the web suite matches `*.test.ts` only, so a class written inline in
 * the component could not be pinned this way.
 *
 * The class string is written as one literal (rather than composed from a band
 * table) because Tailwind only generates utilities for candidates it can read
 * verbatim from the source.
 */
export const SPEND_ALERTS_PANEL_SLOT_CLASS =
  'min-h-[66rem] @min-[310px]:min-h-[58rem] @min-[380px]:min-h-[55rem] @min-[580px]:min-h-[52rem]';

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
  /**
   * True when the viewer has no registered mobile device, so push cannot reach
   * them whatever the category says (`isPushChannelBlocked` in
   * `apps/web/src/routers/spend-alert-router.ts`).
   */
  pushChannelBlocked: boolean;
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
      rule.threshold !== null || rule.windowHours !== null || rule.multiplierBasisPoints !== null
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
 * Draft → the payload `spendAlerts.save` accepts. A rule kind the owner has
 * switched off is not being edited, so its fields are not validated and never
 * report an error; the router still needs one value per kind, so such a rule
 * submits the smallest value its schema accepts unless the draft already holds
 * a valid one. An enabled rule is validated exactly as the router's zod schema
 * would, so a disabled Save always means the server would refuse.
 */
export function toSaveInput(draft: SpendAlertsDraft): SpendAlertValidation {
  const errors: SpendAlertFieldErrors = {};
  const rules: SpendAlertSaveRule[] = [];

  for (const rule of draft.rules) {
    if (rule.kind === 'threshold') {
      const threshold = parseUsdInput(rule.thresholdUsd);
      const valid =
        threshold !== null && threshold >= MIN_THRESHOLD_USD && threshold <= MAX_THRESHOLD_USD;
      if (!valid && rule.enabled) errors.threshold = THRESHOLD_FIELD_ERROR;
      rules.push({
        kind: 'threshold',
        enabled: rule.enabled,
        // Only an enabled rule can block Save on a bad limit; a switched-off one
        // falls back to a schema-valid stand-in.
        threshold: valid ? threshold : DISABLED_THRESHOLD_USD,
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
    if (!valid && rule.enabled) errors.multiplier = MULTIPLIER_FIELD_ERROR;
    rules.push({
      kind: 'anomaly',
      enabled: rule.enabled,
      threshold: null,
      windowHours: null,
      multiplierBasisPoints: valid ? basisPoints : DISABLED_MULTIPLIER_BASIS_POINTS,
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
 * Whether a rule's push passes the viewer's own category gate. Mirrors
 * `effectivePushFor` in `apps/web/src/lib/spend-alerts/settings.ts` (s3) — that
 * module is `server-only` (it opens the database), so the client panel cannot
 * import it and keeps the one-line rule here instead. A registered device is
 * the other half of delivery; that gate blocks every rule and is the
 * `pushChannelBlocked` input of {@link pushChannelNote}.
 */
export function effectivePushFor(
  viewerCategoryEnabled: boolean,
  rule: Pick<SpendAlertRuleDraft, 'pushEnabled'>
): boolean {
  return rule.pushEnabled && viewerCategoryEnabled;
}

export type ChannelAgreement = {
  /** Short reason the push control is not effective; rendered as the link text. */
  message: string;
  /** Browser-resolvable destination that fixes it. */
  href: string;
};

/**
 * The note beside a rule's push row, whenever push would not reach the viewer.
 *
 * - No registered device: push cannot reach them whatever the rule says, so
 *   every row's switch is disabled and each one says where to register one.
 * - A registered device but the viewer's own mobile category off: the rule's
 *   push is stored, not delivered, so the rows that ask for push say so.
 *
 * Both remedies live in the mobile app, and both hrefs resolve in a browser:
 * the web spend view has no notification settings of its own, so it must not
 * send the viewer to the mobile-only `kiloapp://` scheme. `null` when push is
 * effective or not wanted — the control reads as effective either way.
 */
export function pushChannelNote(
  viewerCategoryEnabled: boolean,
  pushChannelBlocked: boolean,
  rule: Pick<SpendAlertRuleDraft, 'pushEnabled'>
): ChannelAgreement | null {
  if (pushChannelBlocked) {
    return { message: SPEND_ALERTS_PUSH_NEEDS_DEVICE, href: MOBILE_APP_SETUP_HREF };
  }
  if (rule.pushEnabled && !effectivePushFor(viewerCategoryEnabled, rule)) {
    return { message: SPEND_ALERTS_OFF_IN_NOTIFICATIONS, href: MOBILE_APP_SETUP_HREF };
  }
  return null;
}

/**
 * Whether a rule's push switch is unusable. Two reasons, both ending in the
 * note above: the panel is showing its read-only empty-state rules, or the
 * viewer has no registered device — a push choice that could never be
 * delivered, so the panel must not record one and report it as enabled.
 */
export function pushControlDisabled(panelDisabled: boolean, pushChannelBlocked: boolean): boolean {
  return panelDisabled || pushChannelBlocked;
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
