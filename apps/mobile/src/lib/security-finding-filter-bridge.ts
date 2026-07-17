import { type SecurityFindingFilters } from '@kilocode/app-shared/security-agent';

// Carries the filter sheet's draft in/out-of-band, same shape as the
// agent-chat picker bridges in picker-bridge.ts: the caller sets it right
// before pushing the formSheet route, the route reads it once focused, and
// clears it on blur so a stale bridge never leaks into the next visit.
type SecurityFindingFilterRepositoryOption = {
  fullName: string;
};

type SecurityFindingFilterBridge = {
  filters: SecurityFindingFilters;
  repositories: SecurityFindingFilterRepositoryOption[];
  onApply: (filters: SecurityFindingFilters) => void;
};

let bridge: SecurityFindingFilterBridge | null = null;

export function setSecurityFindingFilterBridge(next: SecurityFindingFilterBridge) {
  bridge = next;
}

export function getSecurityFindingFilterBridge() {
  return bridge;
}

export function clearSecurityFindingFilterBridge() {
  bridge = null;
}
