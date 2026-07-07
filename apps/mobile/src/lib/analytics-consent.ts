type AnalyticsConsentState = {
  readonly hasToken: boolean;
  readonly consentChecked: boolean;
  readonly needsConsent: boolean;
};

export function shouldStartAnalytics({
  hasToken,
  consentChecked,
  needsConsent,
}: AnalyticsConsentState): boolean {
  return hasToken && consentChecked && !needsConsent;
}
