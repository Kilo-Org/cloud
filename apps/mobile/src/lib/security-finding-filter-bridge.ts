import { type SecurityFindingFilters } from '@kilocode/app-shared/security-agent';

import { SECURITY_FILTER_ROUTE_KEY, securityFilterSlot } from './route-registry';

// Carries the filter sheet's draft in/out-of-band, same shape as the
// agent-chat picker bridges: the caller sets it right before pushing the
// formSheet route, the route reads it once focused, and clears it on blur so
// a stale bridge never leaks into the next visit. Stored in the route
// registry under a fixed key (the producer does not pass its scope through
// the bridge); the route clears it on unmount.
type SecurityFindingFilterRepositoryOption = {
  fullName: string;
};

export type SecurityFindingFilterBridge = {
  filters: SecurityFindingFilters;
  repositories: SecurityFindingFilterRepositoryOption[];
  onApply: (filters: SecurityFindingFilters) => void;
};

export function setSecurityFindingFilterBridge(next: SecurityFindingFilterBridge) {
  securityFilterSlot.set(SECURITY_FILTER_ROUTE_KEY, next);
}
