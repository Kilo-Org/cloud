export const KILO_PASS_LEGAL_DISCLOSURE =
  'Kilo Pass is an auto-renewable monthly subscription. Payment is charged to your Apple ID at confirmation of purchase. Subscriptions renew automatically each month at the price shown unless canceled at least 24 hours before the end of the current period. Manage or cancel anytime in your App Store account settings.';

type KiloPassLegalLink = {
  label: 'Privacy Policy' | 'Terms of Use (EULA)';
  url: string;
};

export function getKiloPassLegalLinks(
  webBaseUrl: string
): readonly [KiloPassLegalLink, KiloPassLegalLink] {
  const baseUrl = webBaseUrl.replace(/\/+$/, '');

  return [
    {
      label: 'Privacy Policy',
      url: `${baseUrl}/privacy-app`,
    },
    {
      label: 'Terms of Use (EULA)',
      url: `${baseUrl}/terms-app`,
    },
  ];
}
