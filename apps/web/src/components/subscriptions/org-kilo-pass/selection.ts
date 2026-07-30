import type { OrgKiloPassAllocation, OrgKiloPassTier } from './types';

export type OrgKiloPassSelection = {
  tier: OrgKiloPassTier;
  allocations: OrgKiloPassAllocation[];
};

const storageKey = (organizationId: string) => `org-kilo-pass-selection:${organizationId}`;

export function childAllocationInput(allocations: OrgKiloPassAllocation[]) {
  const input: { childOrganizationId: string; passCount: number }[] = [];
  for (const allocation of allocations) {
    if (allocation.kind === 'child' && allocation.passCount > 0) {
      input.push({
        childOrganizationId: allocation.organizationId,
        passCount: allocation.passCount,
      });
    }
  }
  return input;
}

export function saveOrgKiloPassSelection(organizationId: string, selection: OrgKiloPassSelection) {
  sessionStorage.setItem(storageKey(organizationId), JSON.stringify(selection));
}

export function loadOrgKiloPassSelection(organizationId: string): OrgKiloPassSelection | null {
  const raw = sessionStorage.getItem(storageKey(organizationId));
  if (!raw) return null;
  try {
    const selection = JSON.parse(raw) as Partial<OrgKiloPassSelection>;
    if (
      (selection.tier !== 'tier_19' &&
        selection.tier !== 'tier_49' &&
        selection.tier !== 'tier_199') ||
      !Array.isArray(selection.allocations)
    ) {
      return null;
    }
    return {
      tier: selection.tier,
      allocations: selection.allocations.filter(
        (allocation): allocation is OrgKiloPassAllocation =>
          typeof allocation === 'object' &&
          allocation !== null &&
          typeof allocation.organizationId === 'string' &&
          typeof allocation.organizationName === 'string' &&
          (allocation.kind === 'parent' || allocation.kind === 'child') &&
          typeof allocation.passCount === 'number' &&
          Number.isInteger(allocation.passCount) &&
          allocation.passCount >= 0
      ),
    };
  } catch {
    return null;
  }
}
