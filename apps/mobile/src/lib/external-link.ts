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

/**
 * Opens `url` in the browser (https) or the platform handler (mailto/tel) and
 * toasts a retryable failure, like every external link in the app. Returns
 * whether the URL opened, so surfaces that sit above the app-root Toaster —
 * native modals and sheets never show a sonner toast (see the D2 ground truth
 * in `app-root-providers.tsx`) — can also report the failure inline.
 */
export async function openExternalUrl(
  url: string,
  { label = i18n.t('common.link'), retryOnError = false }: ExternalLinkOptions = {}
): Promise<boolean> {
  try {
    await openUrl(url);
    return true;
  } catch {
    const message = i18n.t('common.couldNotOpen', { label });
    if (!retryOnError) {
      toast.error(message);
      return false;
    }

    toast.error(message, {
      action: {
        label: i18n.t('common.tryAgain'),
        onClick: () => {
          void openExternalUrl(url, { label, retryOnError: true });
        },
      },
    });
    return false;
  }
}
