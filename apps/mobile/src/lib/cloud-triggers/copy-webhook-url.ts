/**
 * Copying a trigger's webhook URL.
 *
 * The URL is the whole secret an inbound caller needs, so the copy is announced
 * through the accessibility channel as well as the toast: a screen-reader user
 * who cannot see a toast still hears that the URL is on the clipboard.
 */

import * as Clipboard from 'expo-clipboard';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import { announcingToast } from '@/lib/a11y/announcing-toast';

export async function copyWebhookUrl(url: string): Promise<void> {
  try {
    await Clipboard.setStringAsync(url);
    announcingToast.success(i18n.t('cloudAgent.triggers.urlCopied'));
  } catch {
    toast.error(i18n.t('common.couldNotCopyToClipboard'));
  }
}
