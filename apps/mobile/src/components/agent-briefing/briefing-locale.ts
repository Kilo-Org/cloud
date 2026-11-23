import { useTranslation } from 'react-i18next';

/**
 * The tag whose catalog loaded, not the tag the person asked for.
 *
 * `i18next` keeps both: `language` is the requested tag (`en-US`), while
 * `resolvedLanguage` is the tag whose catalog actually loaded (`en`, because the
 * app ships `en` and not `en-US`). A formatter built on the requested tag writes
 * the digits, separators and date order of a catalog the labels never use, so
 * every locale-sensitive formatter in this unit reads the resolved tag.
 */
export function resolveBriefingLocale(i18n: {
  readonly resolvedLanguage?: string;
  readonly language: string;
}): string {
  return i18n.resolvedLanguage ?? i18n.language;
}

/**
 * The one locale every formatter in this unit reads: the tag whose catalog the
 * sentence around it is written in.
 */
export function useBriefingLocale(): string {
  const { i18n } = useTranslation();
  return resolveBriefingLocale(i18n);
}
