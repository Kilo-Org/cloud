// The five GitHub dismissal reasons the backend's DismissReasonSchema accepts
// (apps/web/src/lib/security-agent/core/schemas.ts) — exact value/label pairs,
// matching web's dismissal reason picker. The sheet renders them as one pill
// group and reads the stored draft's reason back through `isDismissReason`, so
// the table has one owner.
export const DISMISS_REASONS = [
  { value: 'fix_started', labelKey: 'securityAgent.dismiss.reasonFixStarted' },
  { value: 'no_bandwidth', labelKey: 'securityAgent.dismiss.reasonNoBandwidth' },
  { value: 'tolerable_risk', labelKey: 'securityAgent.dismiss.reasonTolerableRisk' },
  { value: 'inaccurate', labelKey: 'securityAgent.dismiss.reasonInaccurate' },
  { value: 'not_used', labelKey: 'securityAgent.dismiss.reasonNotUsed' },
] as const;

export type DismissReason = (typeof DISMISS_REASONS)[number]['value'];

/** Narrows a stored draft's reason to one this backend accepts. */
export function isDismissReason(value: string): value is DismissReason {
  return DISMISS_REASONS.some(reason => reason.value === value);
}
