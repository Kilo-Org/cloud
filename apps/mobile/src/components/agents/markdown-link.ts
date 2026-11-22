import { type ReactNode } from 'react';
import { type AccessibilityActionInfo } from 'react-native';

import { i18n } from '@/i18n';

const URL_HOST_PATTERN = /^[a-z][a-z\d+.-]*:\/\/([^/?#]+)/i;

function getUrlHost(href: string): string | null {
  return URL_HOST_PATTERN.exec(href)?.[1] ?? null;
}

export function resolveLinkAccessibilityLabel(
  children: string | ReactNode[],
  href: string,
  title?: string
): string {
  if (title?.trim()) {
    return title.trim();
  }
  if (!Array.isArray(children) && children.trim()) {
    return children.trim();
  }
  return getUrlHost(href) ?? href;
}

export function getLinkAccessibilityActions(
  enabled: boolean
): AccessibilityActionInfo[] | undefined {
  return enabled
    ? [{ name: 'showLinkActions', label: i18n.t('agentChat.chatLink.showLinkActions') }]
    : undefined;
}
