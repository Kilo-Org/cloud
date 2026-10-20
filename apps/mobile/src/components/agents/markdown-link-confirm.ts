import { Alert } from 'react-native';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import { openExternalUrl } from '@/lib/external-link';
import { getTrustedHostsHasLoaded, isTrustedHost, trustHost } from '@/lib/hooks/use-trusted-hosts';

import { parseMarkdownLinkTarget } from './markdown-link-target';

/**
 * Display key for a link's host: lowercased hostname, plus ":port" only when
 * the port is not the protocol default. Returns null when the href is not a
 * web link this module opens.
 */
export function formatLinkHost(href: string): string | null {
  const target = parseMarkdownLinkTarget(href);
  return target?.kind === 'web' ? target.host : null;
}

/**
 * Opens a markdown link. Every href is parsed first: web links confirm the
 * parsed host unless it is already trusted and then open the canonical URL,
 * allowlisted non-web schemes open through openExternalUrl, and anything that
 * does not parse or whose scheme is not allowed shows the invalid-link toast.
 *
 * Never returns a promise so callers can fire-and-forget it like the default
 * renderer press.
 */
export function confirmAndOpenMarkdownLink(href: string, { label }: { label?: string } = {}): void {
  const target = parseMarkdownLinkTarget(href);
  if (target === null) {
    toast.error(i18n.t('agentChat.markdownLink.invalidLink'));
    return;
  }

  if (target.kind === 'scheme') {
    void openExternalUrl(target.href, { label });
    return;
  }

  const { host, href: canonicalHref } = target;

  // Never skip confirm before the trusted-host store has loaded: an untrusted
  // default must still show the Alert.
  if (getTrustedHostsHasLoaded() && isTrustedHost(host)) {
    void openExternalUrl(canonicalHref, { label, retryOnError: true });
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
          void openExternalUrl(canonicalHref, { label, retryOnError: true });
        },
      },
      {
        text: i18n.t('agentChat.markdownLink.trustThisHost'),
        onPress: () => {
          trustHost(host);
          void openExternalUrl(canonicalHref, { label, retryOnError: true });
        },
      },
    ]
  );
}
