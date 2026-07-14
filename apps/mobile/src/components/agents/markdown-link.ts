import { type ReactNode } from 'react';

const URL_HOST_PATTERN = /^[a-z][a-z\d+.-]*:\/\/([^/?#]+)/i;

function getUrlHost(href: string): string | null {
  return URL_HOST_PATTERN.exec(href)?.[1] ?? null;
}

/** Accessible label for a markdown link: explicit title, else visible link text, else the URL host. */
export function resolveLinkAccessibilityLabel(
  children: string | ReactNode[],
  href: string,
  title?: string
): string {
  if (title?.trim()) {
    return title.trim();
  }
  if (typeof children === 'string' && children.trim()) {
    return children.trim();
  }
  return getUrlHost(href) ?? href;
}
