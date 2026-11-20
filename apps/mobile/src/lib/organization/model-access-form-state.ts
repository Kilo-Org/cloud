import { draftsEqual, type ModelAccessDraft } from '@/lib/organization/model-access';

/**
 * The form's own state: the saved lists it is synced to, the baseline a cancel
 * returns to, the draft on screen, and whether the provider rows came from the
 * policy-filtered list while the catalog was unavailable. It is one object
 * because one render can move both the saved lists and the provider rows, and
 * two setters rebasing from that render's values would let the second write back
 * the deny list the first had just synced.
 */
export type FormState = Readonly<{
  /** The `serverKey` the form's baseline was last synced to. */
  syncedKey: string;
  baseline: ModelAccessDraft;
  draft: ModelAccessDraft;
  providerRowsProvisional: boolean;
  /** Whether the draft's provider list differs from the baseline, so an arrival keeps it. */
  providerListEdited: boolean;
}>;

/**
 * Rebases the form onto the lists the server answered.
 *
 * A refetch that moved the saved lists rebases the baseline, and the draft too
 * unless the admin holds edits of its own: those win, and the next save replaces
 * the newer policy.
 *
 * The provider rows are provisional while the catalog is unavailable or names
 * no provider: they hold only the providers the organization's own models name,
 * and no provider toggle is possible then. When the rows arrive the baseline
 * rebases to the whole gateway catalog, deny edits stay, a provider list the
 * admin moved stays, and a provisional one takes the arriving catalog. Without
 * this the first toggle after a retry would write the provisional rows as the
 * organization's whole allow list.
 *
 * Both rebases compose here, so a catalog that arrives in the same render as a
 * newer deny list keeps that deny list instead of restoring the values the
 * render started from.
 */
export function syncedFormState(params: {
  state: FormState;
  serverKey: string;
  serverDraft: ModelAccessDraft;
  providerRowsIncomplete: boolean;
}): FormState {
  const { state } = params;
  const savedListsMoved = params.serverKey !== state.syncedKey;
  const rowsArrived = state.providerRowsProvisional && !params.providerRowsIncomplete;
  const unchanged =
    !savedListsMoved &&
    !rowsArrived &&
    state.providerRowsProvisional === params.providerRowsIncomplete;
  if (unchanged) {
    return state;
  }
  const clean = draftsEqual(state.draft, state.baseline);
  let baseline = savedListsMoved ? params.serverDraft : state.baseline;
  let draft = savedListsMoved && clean ? params.serverDraft : state.draft;
  if (rowsArrived) {
    baseline = {
      providerAllowList: params.serverDraft.providerAllowList,
      modelDenyList: baseline.modelDenyList,
    };
    // A list the admin edited stays; a provisional one, from the saved rows,
    // takes the arriving catalog so a save cannot write it as the whole list.
    if (!state.providerListEdited) {
      draft = {
        providerAllowList: params.serverDraft.providerAllowList,
        modelDenyList: draft.modelDenyList,
      };
    }
  }
  return {
    syncedKey: savedListsMoved ? params.serverKey : state.syncedKey,
    baseline,
    draft,
    providerRowsProvisional: params.providerRowsIncomplete,
    providerListEdited: savedListsMoved && clean ? false : state.providerListEdited,
  };
}
