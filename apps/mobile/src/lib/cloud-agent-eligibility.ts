/**
 * The Cloud Agent access state the new-session composer shows before a press.
 *
 * The web composer reads the same eligibility procedures
 * (`cloudAgentNext.checkEligibility` for the personal account,
 * `organizations.cloudAgentNext.checkEligibility` for the organization the
 * session starts in) and derives two facts from one answer: whether the account
 * has enough balance, and whether the model list has to stay on the models the
 * balance does not pay for. This module is the mobile form of that decision, as
 * pure functions so the gates and the picker filter are testable without a
 * render.
 *
 * The server stays the authority: `prepareSession` refuses a session the account
 * cannot pay for, and this state only stops the composer offering what the
 * server would refuse.
 */
import { type ModelOption } from '@/lib/hooks/use-available-models';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

/**
 * The eligibility answer's shape, as the router returns it
 * (`buildAccessLevelEligibility`): `minBalance` in dollars, `accessLevel` from
 * the balance alone. The router only ever answers `full` or `limited`:
 * `blocked` is in the type and is produced by no path today, so a future
 * `blocked` answer is treated exactly like `limited` — the conservative side,
 * because it keeps Start gated.
 */
export type CloudAgentEligibility = {
  balance: number;
  minBalance: number;
  accessLevel: 'full' | 'limited' | 'blocked';
  isEligible: boolean;
};

/**
 * The read's state as the composer renders it, one tag per phase. `pending`
 * claims nothing: no notice, the full model list, and Start unrestricted, so a
 * slow or failed read never invents a balance the server did not report.
 */
export type CloudAgentEligibilityState =
  | { readonly kind: 'pending' }
  | { readonly kind: 'ready'; readonly eligibility: CloudAgentEligibility }
  | { readonly kind: 'failed' };

/** The state that claims nothing: the form's state before an answer, and for a target that never asks. */
export const PENDING_ELIGIBILITY: CloudAgentEligibilityState = { kind: 'pending' };

/** The eligibility read's answer, as the query hook reports it. */
export type CloudAgentEligibilityQuery = {
  data: CloudAgentEligibility | undefined;
  isPending: boolean;
  isError: boolean;
};

/**
 * Resolve the read's phase. Data wins over a concurrent error: a refetch that
 * fails keeps the last answer the server gave, which is a better basis for the
 * gate than no answer at all.
 */
export function resolveCloudAgentEligibilityState(
  query: CloudAgentEligibilityQuery
): CloudAgentEligibilityState {
  if (query.data !== undefined) {
    return { kind: 'ready', eligibility: query.data };
  }
  return query.isError || !query.isPending ? { kind: 'failed' } : { kind: 'pending' };
}

/**
 * True when the account's balance leaves the model list to the models it does
 * not have to pay for. `!isEligible` and `accessLevel === 'limited'` are the
 * same answer from the router; both are checked so a future answer that moves
 * one and not the other still gates here.
 */
export function isLimitedAccess(state: CloudAgentEligibilityState): boolean {
  return (
    state.kind === 'ready' &&
    (!state.eligibility.isEligible || state.eligibility.accessLevel !== 'full')
  );
}

/**
 * Whether a model is usable on a balance that cannot pay for one. The catalog
 * carries both flags as optional, and a row that carries neither is not free:
 * a missing flag must never read as "allowed", or the composer would offer a
 * model the server refuses.
 */
export function limitedAccessAllowsModel(
  option: Pick<ModelOption, 'isFree' | 'hasUserByokAvailable'> | SessionModelOption
): boolean {
  return option.isFree === true || option.hasUserByokAvailable === true;
}

/**
 * The model list the picker shows. Under limited access only the free and BYOK
 * rows remain; every other state keeps the catalog as it arrived, and the
 * pending and failed states keep it whole because neither knows a balance.
 */
export function filterModelOptionsForLimitedAccess<
  T extends Pick<ModelOption, 'isFree' | 'hasUserByokAvailable'>,
>(options: readonly T[], state: CloudAgentEligibilityState): T[] {
  if (!isLimitedAccess(state)) {
    return [...options];
  }
  return options.filter(option => limitedAccessAllowsModel(option));
}

/**
 * Whether the selected model keeps Start disabled: limited access plus a
 * selection that needs credits. A selection the catalog does not carry
 * (`option` undefined) is still gated — the server would refuse it the same
 * way, and the row the picker shows for it carries no free flag either.
 */
export function selectionNeedsCredits(input: {
  state: CloudAgentEligibilityState;
  selection: string;
  option: Pick<ModelOption, 'isFree' | 'hasUserByokAvailable'> | SessionModelOption | undefined;
}): boolean {
  if (!isLimitedAccess(input.state) || input.selection === '') {
    return false;
  }
  return input.option === undefined || !limitedAccessAllowsModel(input.option);
}
