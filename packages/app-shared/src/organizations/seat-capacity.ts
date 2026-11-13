import type { OrganizationRole } from './roles';

/**
 * The server's rejection when an invitation would take a seat the organization
 * does not have. Exported as one sentence so a client maps it to its own
 * localized copy instead of rendering the raw server text.
 *
 * `organizations.members.invite` throws it with `PRECONDITION_FAILED`.
 */
export const ORGANIZATION_INVITE_SEAT_LIMIT_REACHED =
  'This organization has no seats left. Add seats before inviting more members.';

/**
 * Whether a membership in `role` takes one of the organization's seats. A
 * billing manager does not: seat usage counts members and pending invitations
 * whose role is not `billing_manager`.
 */
export function inviteConsumesSeat(role: OrganizationRole): boolean {
  return role !== 'billing_manager';
}

type InviteSeatCapacity = {
  plan: string | undefined;
  requireSeats: boolean | undefined;
  usedSeats: number;
  totalSeats: number;
};

/**
 * Whether the organization can take one more seat-consuming member. Seats only
 * gate a plan that enforces them (`require_seats`), an enterprise plan is never
 * gated, and otherwise a free seat is `total - used > 0`.
 *
 * Web's invite dialog and mobile's invite sheet show this rule, and the invite
 * procedure enforces it; keep the three on one function.
 */
export function hasInviteSeatCapacity({
  plan,
  requireSeats,
  usedSeats,
  totalSeats,
}: InviteSeatCapacity): boolean {
  return requireSeats === false || plan === 'enterprise' || totalSeats - usedSeats > 0;
}
