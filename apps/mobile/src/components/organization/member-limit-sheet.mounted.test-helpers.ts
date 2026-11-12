/**
 * The organization boundary the organization sheet surfaces read in their
 * mounted suite.
 *
 * The invite sheet reads the organization's plan, `require_seats` and seat
 * usage to decide whether Send is available, so the fixture carries them. Seat
 * enforcement is off: these surfaces test their own states, not capacity.
 */
export type OrganizationBoundaryFixture = {
  organizationId: string | null;
  role: string;
  org: {
    organizationId: string;
    plan: string;
    requireSeats: boolean;
    seatCount: { used: number; total: number };
  } | null;
  isResolving: boolean;
};

export function resetOrganizationBoundary(boundary: OrganizationBoundaryFixture): void {
  boundary.organizationId = 'org-1';
  boundary.org = {
    organizationId: 'org-1',
    plan: 'teams',
    requireSeats: false,
    seatCount: { used: 1, total: 5 },
  };
  boundary.role = 'owner';
  boundary.isResolving = false;
}
