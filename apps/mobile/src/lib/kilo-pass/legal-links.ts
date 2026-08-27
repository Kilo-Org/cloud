import { i18n } from '@/i18n';

export function kiloPassLegalDisclosure(platformOS: string): string {
  return i18n.t(
    platformOS === 'android' ? 'kiloPass.legalDisclosurePlay' : 'kiloPass.legalDisclosure'
  );
}

type KiloPassLegalLink = {
  label: string;
  url: string;
};

export function getKiloPassLegalLinks(
  webBaseUrl: string
): readonly [KiloPassLegalLink, KiloPassLegalLink] {
  const baseUrl = webBaseUrl.replace(/\/+$/, '');

  return [
    {
      label: i18n.t('kiloPass.legalPrivacyPolicy'),
      url: `${baseUrl}/privacy-app`,
    },
    {
      label: i18n.t('kiloPass.legalTermsOfUse'),
      url: `${baseUrl}/terms-app`,
    },
  ];
}
