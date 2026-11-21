import { translatePush } from './i18n';
import en from './locales/en.json';
import { SECURITY_FINDING_PUSH_TITLE_KEYS } from './push-i18n-keys';

/** The severity values a security finding carries, as the finding enum spells them. */
type SecurityFindingSeverity = keyof typeof en.internal.securityFindingSeverity;

/**
 * The catalog entry that translates each security-finding severity. Every value
 * is a literal so the catalog audit sees it, and the map is total over the
 * severity values `en.json` names, so a level added there fails typecheck here
 * until its entry exists.
 */
export const SECURITY_FINDING_SEVERITY_KEYS = {
  critical: 'internal.securityFindingSeverity.critical',
  high: 'internal.securityFindingSeverity.high',
  medium: 'internal.securityFindingSeverity.medium',
  low: 'internal.securityFindingSeverity.low',
} as const satisfies Record<SecurityFindingSeverity, string>;

/** The push kinds whose title interpolates a finding's severity. */
const SECURITY_FINDING_PUSH_TITLE_KEY_SET: ReadonlySet<string> = new Set(
  Object.values(SECURITY_FINDING_PUSH_TITLE_KEYS)
);

/** Runtime membership in the severity set, which is also `SECURITY_FINDING_SEVERITY_KEYS`' key set. */
function isSecurityFindingSeverity(value: string | undefined): value is SecurityFindingSeverity {
  return value !== undefined && Object.hasOwn(SECURITY_FINDING_SEVERITY_KEYS, value);
}

/**
 * The push params with a security finding's severity translated into `locale`.
 *
 * The finding producer stores the severity as the raw enum value, and the title
 * template interpolates its params verbatim, so every other language would
 * render `(high)`. This is the one param that is a fixed set of words rather
 * than the user's own text — a finding title, a repo name, and an organization
 * name pass through untouched.
 *
 * Params are returned as given for every other push kind, for params without a
 * severity, and for a severity this build does not know: a level added after
 * this build must still reach the lock screen, raw rather than dropped.
 */
export function localizedPushParams(
  locale: string | null | undefined,
  i18nKey: string | undefined,
  params: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (params === undefined || i18nKey === undefined) {
    return params;
  }
  const { severity } = params;
  if (!SECURITY_FINDING_PUSH_TITLE_KEY_SET.has(i18nKey) || !isSecurityFindingSeverity(severity)) {
    return params;
  }
  return {
    ...params,
    // The English label is the fallback, so a catalog that lost this entry shows
    // the level rather than a raw key.
    severity: translatePush(
      locale,
      SECURITY_FINDING_SEVERITY_KEYS[severity],
      undefined,
      en.internal.securityFindingSeverity[severity]
    ),
  };
}
