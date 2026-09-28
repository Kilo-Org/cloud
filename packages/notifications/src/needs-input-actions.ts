/**
 * Shared needs-input notification contract.
 *
 * The server and the mobile app must agree byte for byte on these ids: the
 * server registers the per-raise category (its id and the buttons it carries)
 * and the app's background action handler dispatches on the action id. Neither
 * side may derive an id from user copy, and no id may change with a translation.
 */

/** Action ids attached to a needs-input notification button. */
export const NEEDS_INPUT_ACTION_IDS = {
  approve: 'kilo:approve',
  reply: 'kilo:reply',
  openPr: 'kilo:open-pr',
  openSession: 'kilo:open-session',
} as const;
export type NeedsInputActionId =
  (typeof NEEDS_INPUT_ACTION_IDS)[keyof typeof NEEDS_INPUT_ACTION_IDS];

/**
 * What the waiting agent needs. `unknown` is the app-side default for a
 * producer that did not classify the raise; it offers both answer actions
 * because the app cannot tell which one applies.
 */
export const NEEDS_INPUT_KINDS = ['question', 'permission', 'unknown'] as const;
export type NeedsInputKind = (typeof NEEDS_INPUT_KINDS)[number];

const NEEDS_INPUT_CATEGORY_PREFIX = 'kilo-needs-input';

/**
 * The per-raise category id. `hasPr` adds the `-pr` suffix so a raise that can
 * open a pull request gets a category carrying the Open PR button.
 */
export function needsInputCategoryId({
  kind,
  hasPr,
}: {
  kind: NeedsInputKind;
  hasPr: boolean;
}): string {
  return `${NEEDS_INPUT_CATEGORY_PREFIX}:${kind}${hasPr ? '-pr' : ''}`;
}

export interface NeedsInputCategoryDescriptor {
  readonly id: string;
  readonly actionIds: readonly NeedsInputActionId[];
}

// Never register a button that cannot act: a question has nothing to approve,
// a permission has no text to reply with, and Open PR needs a pull request.
const NEEDS_INPUT_ACTIONS_BY_KIND: Record<NeedsInputKind, readonly NeedsInputActionId[]> = {
  question: [NEEDS_INPUT_ACTION_IDS.reply, NEEDS_INPUT_ACTION_IDS.openSession],
  permission: [NEEDS_INPUT_ACTION_IDS.approve, NEEDS_INPUT_ACTION_IDS.openSession],
  unknown: [
    NEEDS_INPUT_ACTION_IDS.approve,
    NEEDS_INPUT_ACTION_IDS.reply,
    NEEDS_INPUT_ACTION_IDS.openSession,
  ],
};

/**
 * The full category registry: one descriptor per (kind × hasPr) pair, each with
 * the exact id and ordered action ids the server must register.
 */
export function needsInputCategoryDescriptors(): readonly NeedsInputCategoryDescriptor[] {
  return NEEDS_INPUT_KINDS.flatMap(kind =>
    [false, true].map(hasPr => ({
      id: needsInputCategoryId({ kind, hasPr }),
      actionIds: hasPr
        ? [...NEEDS_INPUT_ACTIONS_BY_KIND[kind], NEEDS_INPUT_ACTION_IDS.openPr]
        : NEEDS_INPUT_ACTIONS_BY_KIND[kind],
    }))
  );
}
