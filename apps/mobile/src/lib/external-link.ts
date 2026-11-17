import * as WebBrowser from 'expo-web-browser';
import { Linking } from 'react-native';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';

type ExternalLinkOptions = {
  label?: string;
  retryOnError?: boolean;
};

/**
 * Something that produces the URL at the moment it opens. A one-time hand-off
 * URL has to be produced inside the open, because the first attempt consumes
 * it; "Try again" produces a fresh one.
 */
export type ExternalUrlProducer = () => Promise<string>;

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
 * Resolves the URL and opens it, reporting a failure that keeps the retry, so
 * "Try again" produces the URL again instead of replaying a spent one.
 */
export async function openProducedUrl(
  produce: ExternalUrlProducer,
  { label = i18n.t('common.link'), retryOnError = false }: ExternalLinkOptions = {}
) {
  try {
    await openUrl(await produce());
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
          void openProducedUrl(produce, { label, retryOnError: true });
        },
      },
    });
  }
}

export async function openExternalUrl(url: string, options: ExternalLinkOptions = {}) {
  await openProducedUrl(() => Promise.resolve(url), options);
}
