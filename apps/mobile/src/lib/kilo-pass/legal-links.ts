import { i18n } from '@/i18n';

type StoreLegalLink = {
  label: string;
  url: string;
};

/**
 * The one-off credit pack purchase links to the Terms and Privacy pages.
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
