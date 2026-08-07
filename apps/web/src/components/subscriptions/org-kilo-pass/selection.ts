import { z } from 'zod';
import type { OrgKiloPassAllocation, OrgKiloPassTier } from './types';

const orgKiloPassSelectionSchema = z.object({
  tier: z.enum(['tier_19', 'tier_49', 'tier_199']),
  allocations: z.array(
    z.object({
      organizationId: z.string(),
      organizationName: z.string(),
      kind: z.enum(['parent', 'child']),
      passCount: z.number().int().nonnegative(),
    })
  ),
});

export type OrgKiloPassSelection = z.infer<typeof orgKiloPassSelectionSchema> & {
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
    const selection = orgKiloPassSelectionSchema.safeParse(JSON.parse(raw));
    return selection.success ? selection.data : null;
  } catch {
    return null;
  }
}
