type AppsFlyerConsentState = {
  readonly hasToken: boolean;
  readonly consentChecked: boolean;
  readonly needsConsent: boolean;
};

export function shouldStartAppsFlyer({
  hasToken,
  consentChecked,
  needsConsent,
}: AppsFlyerConsentState): boolean {
  return hasToken && consentChecked && !needsConsent;
}
