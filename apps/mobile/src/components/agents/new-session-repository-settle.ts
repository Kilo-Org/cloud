/**
 * Whether the new-session form's repository region has reached its final height.
 *
 * The provider cards under the repository picker are the reason this signal
 * exists. A card's height is data-dependent: nothing while a provider loads, an
 * expanded connect prompt for a provider that is not connected, a compact row
 * once a repository is selected. The form paints the rows below the section
 * (`Changes`, `Environment`, the advanced configuration) on this one signal, so
 * the cards and those rows enter in a single render: a card that arrived after
 * them pushed every one of them down once, which the explorer recorded as a late
 * layout jump after the screen had settled.
 *
 * Kept in its own module rather than beside the section's other rules because it
 * is read by the screen body (which owns the queries and the draft) and by the
 * form, not only by the section.
 */
export function isRepositoryRegionSettled(input: {
  /**
   * Every provider query finished its first load. `isLoading` is false for a
   * paused or disabled query, so an offline screen still settles.
   */
  providerQueriesResolved: boolean;
  /** The persisted connect-card collapse list has been read, so no card resizes on load. */
  connectCtasLoaded: boolean;
  /** The durable repository draft for this account and scope has loaded. */
  draftSettled: boolean;
  /**
   * The route prefill can still replace the selection with a repository, which
   * would turn an expanded connect card into the compact row. A seed only
   * arrives while a provider query is still in flight, so this is false once
   * the queries resolve even when the lists came back empty or failed. A
   * prefill that names no repository never seeds one, so a form with no request
   * is already final.
   */
  seedPending: boolean;
  /** A stored selection its provider's list no longer contains, still to be dropped. */
  storedSelectionGone: boolean;
}): boolean {
  return (
    input.providerQueriesResolved &&
    input.connectCtasLoaded &&
    input.draftSettled &&
    !input.seedPending &&
    !input.storedSelectionGone
  );
}
