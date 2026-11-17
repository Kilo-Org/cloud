import { type InternalDispatchSecurityFindingRequest } from './rpc-schemas';

/** The security-finding kinds the internal dispatch producer can send. */
type SecurityFindingNotificationKind = InternalDispatchSecurityFindingRequest['notificationKind'];

/**
 * The catalog entry that carries each security-finding kind's title. The three
 * kinds differ only in that line, so they read one shared body entry
 * (`SECURITY_FINDING_PUSH_BODY_KEY`); a push names its title key in `i18nKey`.
 */
export const SECURITY_FINDING_PUSH_TITLE_KEYS = {
  new_finding: 'internal.securityFindingNew',
  sla_warning: 'internal.securityFindingSlaWarning',
  sla_breach: 'internal.securityFindingSlaBreach',
} as const satisfies Record<SecurityFindingNotificationKind, string>;

/** The one catalog entry the three security-finding kinds read their body from. */
export const SECURITY_FINDING_PUSH_BODY_KEY = 'internal.securityFinding.body';

/**
 * The title-key values of `SECURITY_FINDING_PUSH_TITLE_KEYS`. Membership means
 * the push's body line comes from `SECURITY_FINDING_PUSH_BODY_KEY`, not from
 * `<i18nKey>.body`.
 */
const SECURITY_FINDING_TITLE_I18N_KEYS: ReadonlySet<string> = new Set(
  Object.values(SECURITY_FINDING_PUSH_TITLE_KEYS)
);

/**
 * The catalog key a push reads its body line from. A push names one `i18nKey`
 * and the runtime appends no suffix of its own, so most kinds keep the body
 * under `<i18nKey>.body` and the security-finding kinds read the shared entry.
 */
export function pushBodyCatalogKey(i18nKey: string): string {
  return SECURITY_FINDING_TITLE_I18N_KEYS.has(i18nKey)
    ? SECURITY_FINDING_PUSH_BODY_KEY
    : `${i18nKey}.body`;
}
