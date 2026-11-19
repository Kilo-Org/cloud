import { type InternalDispatchSecurityFindingRequest } from './rpc-schemas';

/** The content-free product name, the title every unnamed push shows. */
export const GENERIC_PUSH_TITLE_KEY = 'generic.title';

/** The one catalog entry that carries a session title, whoever sends the push. */
const SESSION_TITLE_KEY = 'session.title';

/** The payload key the security-lifecycle producer sends. */
export const SECURITY_LIFECYCLE_I18N_KEY = 'internal.securityLifecycle';

/** The leaf of the generic body the security-lifecycle notice reads. */
export const SECURITY_LIFECYCLE_BODY_LEAF = 'securityUpdate';

/** The one catalog entry the security-lifecycle push reads its body from. */
const SECURITY_LIFECYCLE_BODY_KEY = `generic.body.${SECURITY_LIFECYCLE_BODY_LEAF}`;

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
 * The shared title entry of each push kind, by the `i18nKey` the push names.
 *
 * A kind joins this map when the copy it shows belongs to no single event: the
 * security lifecycle notice announces the product name, and both session kinds
 * announce the session title. Every other kind keeps its own
 * `<i18nKey>.title`.
 */
const SHARED_TITLE_KEYS: ReadonlyMap<string, string> = new Map([
  [SECURITY_LIFECYCLE_I18N_KEY, GENERIC_PUSH_TITLE_KEY],
  ['agentSession.notification', SESSION_TITLE_KEY],
  ['sessionReady', SESSION_TITLE_KEY],
]);

/**
 * The shared body entry of each push kind, by the `i18nKey` the push names.
 *
 * The three security-finding kinds differ only in their title line, so they
 * read one body entry. The lifecycle notice states a status change, which is
 * the generic security-update sentence. Every other kind keeps its own
 * `<i18nKey>.body`.
 */
const SHARED_BODY_KEYS: ReadonlyMap<string, string> = new Map([
  [SECURITY_LIFECYCLE_I18N_KEY, SECURITY_LIFECYCLE_BODY_KEY],
  ...Object.values(SECURITY_FINDING_PUSH_TITLE_KEYS).map(
    titleKey => [titleKey, SECURITY_FINDING_PUSH_BODY_KEY] as const
  ),
]);

/**
 * The catalog key a push reads its title line from. A push names one `i18nKey`
 * and the runtime appends no suffix of its own, so most kinds keep the title
 * under `<i18nKey>.title` and the kinds in `SHARED_TITLE_KEYS` read the shared
 * entry.
 */
export function pushTitleCatalogKey(i18nKey: string): string {
  return SHARED_TITLE_KEYS.get(i18nKey) ?? `${i18nKey}.title`;
}

/**
 * The catalog key a push reads its body line from. A push names one `i18nKey`
 * and the runtime appends no suffix of its own, so most kinds keep the body
 * under `<i18nKey>.body` and the kinds in `SHARED_BODY_KEYS` read the shared
 * entry.
 */
export function pushBodyCatalogKey(i18nKey: string): string {
  return SHARED_BODY_KEYS.get(i18nKey) ?? `${i18nKey}.body`;
}
