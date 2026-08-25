import { Alert } from 'react-native';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import { openExternalUrl } from '@/lib/external-link';
import { getTrustedHostsHasLoaded, isTrustedHost, trustHost } from '@/lib/hooks/use-trusted-hosts';

/**
 * Display key for a link's host: lowercased hostname, plus ":port" only when
 * the port is not the protocol default. Returns null when the URL cannot be
 * parsed.
 */
export function formatLinkHost(href: string): string | null {
  try {
    const url = new URL(href);
    const hostname = url.hostname.toLowerCase();
    const port = url.port;
    const isDefaultPort =
      (url.protocol === 'http:' && (port === '' || port === '80')) ||
      (url.protocol === 'https:' && (port === '' || port === '443'));
    return port !== '' && !isDefaultPort ? `${hostname}:${port}` : hostname;
  } catch {
    return null;
  }
}

/**
 * Opens a markdown link. HTTP(S) links confirm the host first unless it is
 * already trusted; every other scheme opens through openExternalUrl directly.
 * Never returns a promise so callers can fire-and-forget it like the default
 * renderer press.
 */
export function confirmAndOpenMarkdownLink(href: string, { label }: { label?: string } = {}): void {
  if (!/^https?:\/\//i.test(href)) {
    void openExternalUrl(href, { label });
    return;
  }

  const host = formatLinkHost(href);
  if (host === null) {
    toast.error(i18n.t('agentChat.markdownLink.invalidLink'));
    return;
  }

  // Never skip confirm before the trusted-host store has loaded: an untrusted
  // default must still show the Alert.
  if (getTrustedHostsHasLoaded() && isTrustedHost(host)) {
    void openExternalUrl(href, { label, retryOnError: true });
    return;
  }

  Alert.alert(
    i18n.t('agentChat.markdownLink.hostConfirmTitle'),
    i18n.t('agentChat.markdownLink.hostConfirmMessage', { host }),
    [
      { text: i18n.t('common.cancel'), style: 'cancel' },
      {
        text: i18n.t('agentChat.markdownLink.open'),
        onPress: () => {
          void openExternalUrl(href, { label, retryOnError: true });
        },
      },
      {
        text: i18n.t('agentChat.markdownLink.trustThisHost'),
        onPress: () => {
          trustHost(host);
          void openExternalUrl(href, { label, retryOnError: true });
        },
      },
    ]
  );
}
