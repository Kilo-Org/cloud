/**
 * Pure dialog-state rules for OrganizationAdminServiceFeeExemption, extracted
 * so the pending-mutation dismiss guards are testable without a DOM (the repo
 * has no component-test runner).
 */

// Mirrors ORGANIZATION_SERVICE_FEE_EXEMPTION_REASON_* in
// @/lib/service-fees/organization-exemptions, which is server-only and cannot
// be imported from a client component. The router remains the enforcement
// boundary; these only drive client-side enablement and hints.
export const SERVICE_FEE_EXEMPTION_REASON_MIN_LENGTH = 3;
export const SERVICE_FEE_EXEMPTION_REASON_MAX_LENGTH = 500;

export type ServiceFeeExemptionDialogOpenChange = {
  open: boolean;
  resetMutation: boolean;
};

/**
 * Radix fires onOpenChange for the trigger, Cancel, the close button, Escape,
 * and overlay pointer-down. While the set-exemption mutation is in flight,
 * every open/close request must be ignored: closing would discard the pending
 * UI, and a close-then-reopen would reset the mutation state, clear the
 * isPending guard, and allow a duplicate mutation.
 *
 * Returns null when the request must be ignored, otherwise the next dialog
 * state. The mutation is reset only on a fresh open so a previous error does
 * not leak into the next attempt.
 */
export function resolveServiceFeeExemptionDialogOpenChange(input: {
  requestedOpen: boolean;
  isMutationPending: boolean;
}): ServiceFeeExemptionDialogOpenChange | null {
  if (input.isMutationPending) return null;
  return { open: input.requestedOpen, resetMutation: input.requestedOpen };
}

/**
 * Guarding onOpenChange alone is not enough for a controlled dialog: Radix
 * processes Escape and overlay pointer-down in its own handlers before asking
 * React, so DialogContent must also preventDefault those events while the
 * mutation is pending. This predicate drives all three content-level guards
 * (onEscapeKeyDown, onPointerDownOutside, onInteractOutside).
 */
export function shouldBlockServiceFeeExemptionDialogDismiss(input: {
  isMutationPending: boolean;
}): boolean {
  return input.isMutationPending;
}

/**
 * Confirm stays inert until the trimmed reason is within the allowed length
 * and no mutation is in flight, so double-clicks or repeated Enter presses
 * cannot fire a duplicate mutation.
 */
export function canSubmitServiceFeeExemption(input: {
  trimmedReasonLength: number;
  isMutationPending: boolean;
}): boolean {
  return (
    !input.isMutationPending &&
    input.trimmedReasonLength >= SERVICE_FEE_EXEMPTION_REASON_MIN_LENGTH &&
    input.trimmedReasonLength <= SERVICE_FEE_EXEMPTION_REASON_MAX_LENGTH
  );
}
