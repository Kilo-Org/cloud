import * as WebBrowser from 'expo-web-browser';
import { Linking } from 'react-native';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';

type ExternalLinkOptions = {
  label?: string;
  retryOnError?: boolean;
  /**
   * Open http(s) links in the system browser instead of the in-app browser.
   * The app changelog uses this so the page is a first-class browser tab
   * (shareable, back-stack) rather than a modal the app has to dismiss.
   */
  preferSystemBrowser?: boolean;
};

const WEB_URL_PATTERN = /^https?:\/\//i;
const PLATFORM_URL_PATTERN = /^(mailto|tel):/i;

async function openUrl(url: string, preferSystemBrowser: boolean) {
  if (WEB_URL_PATTERN.test(url)) {
    if (preferSystemBrowser) {
      await Linking.openURL(url);
      return;
    }
    await WebBrowser.openBrowserAsync(url);
    return;
  }
  if (PLATFORM_URL_PATTERN.test(url)) {
    await Linking.openURL(url);
    return;
  }
  throw new Error('Unsupported URL scheme');
}

export async function openExternalUrl(
  url: string,
  {
    label = i18n.t('common.link'),
    retryOnError = false,
    preferSystemBrowser = false,
  }: ExternalLinkOptions = {}
) {
  try {
    await openUrl(url, preferSystemBrowser);
  } catch {
    const message = i18n.t('common.couldNotOpen', { label });
    if (!retryOnError) {
      toast.error(message);
      return;
    }

    toast.error(message, {
      action: {
        label: i18n.t('common.tryAgain'),
        onClick: () => {
          void openExternalUrl(url, { label, retryOnError: true, preferSystemBrowser });
        },
      },
    });
  }
}
