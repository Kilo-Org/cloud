import { Alert } from 'react-native';

import { i18n } from '@/i18n';
import {
  formatTrustedImageHost,
  getTrustedImageHostsHasLoaded,
  isTrustedImageHost,
  subscribeTrustedImageHosts,
  trustImageHost,
} from '@/lib/hooks/use-trusted-image-hosts';

/**
 * Per-auth-session memory of confirmed markdown image URIs. Keyed by the
 * source URI so a FlashList recycle never re-shows the Load affordance for a
 * URI the user already confirmed in this session. Cleared on sign-in and
 * sign-out so one account's confirmations never auto-load for another.
 *
 * A one-time confirmation never grants host trust: the trusted-image-host
 * preference is the only path to auto-loading later images.
 */
const confirmedUris = new Set<string>();
const listeners = new Set<() => void>();

function subscribeMarkdownImageConfirmMemory(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function isMarkdownImageConfirmed(uri: string): boolean {
  return confirmedUris.has(uri);
}

export function confirmMarkdownImage(uri: string): void {
  if (!confirmedUris.has(uri)) {
    confirmedUris.add(uri);
    for (const listener of listeners) {
      listener();
    }
  }
}

export function clearMarkdownImageConfirmMemory(): void {
  if (confirmedUris.size === 0) {
    return;
  }
  confirmedUris.clear();
  for (const listener of listeners) {
    listener();
  }
}

/** Whether the URI's normalized host is in the trusted-image-host preference. */
function isMarkdownImageHostTrusted(uri: string): boolean {
  const host = formatTrustedImageHost(uri);
  return host !== null && getTrustedImageHostsHasLoaded() && isTrustedImageHost(host);
}

/**
 * Subscribes to both the per-URI confirmations and the trusted-image-host
 * preference, so a revoke re-gates an auto-loaded image and a trust lets later
 * images mount without another read.
 */
export function subscribeMarkdownImageLoadAllowed(listener: () => void): () => void {
  const unsubscribeConfirm = subscribeMarkdownImageConfirmMemory(listener);
  const unsubscribeHosts = subscribeTrustedImageHosts(listener);
  return () => {
    unsubscribeConfirm();
    unsubscribeHosts();
  };
}

/** One-time confirmation for this URI, or a trusted host, auto-loads the image. */
export function isMarkdownImageLoadAllowed(uri: string): boolean {
  return isMarkdownImageConfirmed(uri) || isMarkdownImageHostTrusted(uri);
}

/**
 * First HTTPS image from an untrusted host: the native image-trust dialog asks
 * whether to load this URI once or to trust the whole host. "Load once" stays
 * one-time; "Trust this host" records the normalized host so later images
 * auto-load. Never fetches or logs the image URL.
 */
export function requestMarkdownImageTrust(uri: string): void {
  const host = formatTrustedImageHost(uri);
  if (host === null) {
    // A URL that parses to no hostname has no host to name in the dialog and
    // nothing to add to the trusted list. Fall back to the per-URI one-time
    // confirmation so an otherwise-valid HTTPS image stays loadable instead of
    // stranding the Load control.
    confirmMarkdownImage(uri);
    return;
  }
  Alert.alert(
    i18n.t('agentChat.markdownImage.trustTitle', { host }),
    i18n.t('agentChat.markdownImage.trustMessage', { host }),
    [
      { text: i18n.t('common.cancel'), style: 'cancel' },
      {
        text: i18n.t('agentChat.markdownImage.loadOnce'),
        onPress: () => {
          confirmMarkdownImage(uri);
        },
      },
      {
        text: i18n.t('agentChat.markdownLink.trustThisHost'),
        onPress: () => {
          trustImageHost(host);
        },
      },
    ]
  );
}
