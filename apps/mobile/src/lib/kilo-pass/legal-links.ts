export const KILO_PASS_LEGAL_DISCLOSURE =
  'Subscriptions renew monthly until canceled. Manage or cancel anytime through your app store account settings.';

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
