export const SUPPORT_REASON_MIN_LENGTH = 10;

export function missingSupportRequestRequirements(params: {
  organizationId: string;
  reason: string;
  durationError?: string;
}): string[] {
  const missing: string[] = [];
  if (!params.organizationId) missing.push('Select an organization');
  const reasonLength = params.reason.trim().length;
  if (reasonLength < SUPPORT_REASON_MIN_LENGTH) {
    missing.push(
      `Reason needs at least ${SUPPORT_REASON_MIN_LENGTH} characters (${reasonLength}/${SUPPORT_REASON_MIN_LENGTH})`
    );
  }
  if (params.durationError) missing.push(params.durationError);
  return missing;
}
