import * as WebBrowser from 'expo-web-browser';
import { Linking } from 'react-native';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';

type ExternalLinkOptions = {
  label?: string;
  retryOnError?: boolean;
};

const WEB_URL_PATTERN = /^https?:\/\//i;
const PLATFORM_URL_PATTERN = /^(mailto|tel):/i;

async function openUrl(url: string) {
  if (WEB_URL_PATTERN.test(url)) {
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
  { label = i18n.t('common.link'), retryOnError = false }: ExternalLinkOptions = {}
) {
  try {
    await openUrl(url);
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
          void openExternalUrl(url, { label, retryOnError: true });
        },
      },
    });
  }
}
