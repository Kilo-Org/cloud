type MasterGateLeadingPresentationArgs = Readonly<{
  permissionLoading: boolean;
  permissionError: boolean;
  gateSettled: boolean;
  notificationsEnabled: boolean;
}>;

/**
 * Leading content for the master notifications row (icon, dimming, subtitle).
 *
 * While the gate is unsettled (permission still loading, or permission OK but
 * token queries not settled), do not assert the "off" state — that is the same
 * transient-wrong-state class the trailing Switch/CTA already avoid. Permission
 * error keeps the settled "off" presentation (gateSettled is true when granted
 * is falsy).
 */
export function deriveMasterGateLeadingPresentation({
  permissionLoading,
  permissionError,
  gateSettled,
  notificationsEnabled,
}: MasterGateLeadingPresentationArgs): 'neutral' | 'on' | 'off' {
  if (permissionLoading || (!permissionError && !gateSettled)) {
    return 'neutral';
  }
  return notificationsEnabled ? 'on' : 'off';
}
