/**
 * Pure derivation of the active interaction surface for `SessionDetailContent`.
 *
 * Exactly one interaction surface is visible at a time. The precedence is
 * fixed: question > permission > suggestion. The composer is hidden for
 * any active interaction so the user can only act on the surface they are
 * being asked to respond to.
 */

type ActiveInteractionLike = { requestId: string } | null | undefined;

export function hasActiveInteraction(args: {
  activeQuestion: ActiveInteractionLike;
  activePermission: ActiveInteractionLike;
  activeSuggestion: ActiveInteractionLike;
}): boolean {
  return (
    Boolean(args.activeQuestion) || Boolean(args.activePermission) || Boolean(args.activeSuggestion)
  );
}

/**
 * Returns the precedence winner for which interaction card to render.
 * `kind: 'none'` means no interaction card should render and the composer
 * is allowed (subject to its other disabled flags).
 */
export function pickActiveInteractionSurface(args: {
  activeQuestion: ActiveInteractionLike;
  activePermission: ActiveInteractionLike;
  activeSuggestion: ActiveInteractionLike;
}): { kind: 'question' } | { kind: 'permission' } | { kind: 'suggestion' } | { kind: 'none' } {
  if (args.activeQuestion) {
    return { kind: 'question' };
  }
  if (args.activePermission) {
    return { kind: 'permission' };
  }
  if (args.activeSuggestion) {
    return { kind: 'suggestion' };
  }
  return { kind: 'none' };
}
