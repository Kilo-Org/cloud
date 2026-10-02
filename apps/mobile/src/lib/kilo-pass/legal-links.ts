import { i18n } from '@/i18n';

export function kiloPassLegalDisclosure(platformOS: string): string {
  return i18n.t(
    platformOS === 'android' ? 'kiloPass.legalDisclosurePlay' : 'kiloPass.legalDisclosure'
  );
}

type StoreLegalLink = {
  label: string;
  url: string;
};

/**
 * The store-purchase legal links. Not Kilo Pass specific: the one-off credit
 * packs link to the same Terms and Privacy pages, so both purchase screens
 * share this helper.
 */
export function getStoreLegalLinks(webBaseUrl: string): readonly [StoreLegalLink, StoreLegalLink] {
  const baseUrl = webBaseUrl.replace(/\/+$/, '');

  return [
    {
      label: i18n.t('common.privacyPolicy'),
      url: `${baseUrl}/privacy-app`,
    },
    {
      label: i18n.t('kiloPass.legalTermsOfUse'),
      url: `${baseUrl}/terms-app`,
    },
  ];
}
