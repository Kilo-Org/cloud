import type en from './locales/en.json';
import { type InternalDispatchSecurityFindingRequest } from './rpc-schemas';

/**
 * Every dotted leaf path the English push catalog defines, e.g. `'generic.title'`
 * or `'generic.body.securityFinding'`.
 *
 * The catalog import is type-only, so this module and the `./schemas` entry
 * still load no locale catalog at runtime, while a key `en.json` no longer
 * defines is a compile error rather than a silent lookup miss.
 */
export type PushCatalogKey<T = typeof en> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${PushCatalogKey<T[K]>}`;
}[keyof T & string];

/** A catalog section whose own title line lives at `<section>.title`. */
type PushCatalogTitleSection<Path extends string = PushCatalogKey> =
  Path extends `${infer Section}.title` ? Section : never;

/** The content-free product name, the title every unnamed push shows. */
export const GENERIC_PUSH_TITLE_KEY = 'generic.title' satisfies PushCatalogKey;

/** The one catalog entry that carries a session title, whoever sends the push. */
const SESSION_TITLE_KEY = 'session.title' satisfies PushCatalogKey;

/** The payload key the security-lifecycle producer sends. */
export const SECURITY_LIFECYCLE_I18N_KEY = 'internal.securityLifecycle';

/** The payload key the agent-session notification producer sends. */
export const AGENT_SESSION_NOTIFICATION_I18N_KEY = 'agentSession.notification';

/** The payload key the session-ready producer sends. */
export const SESSION_READY_I18N_KEY = 'sessionReady';

/** The leaf of the generic body the security-lifecycle notice reads. */
export const SECURITY_LIFECYCLE_BODY_LEAF = 'securityUpdate';

/**
 * The catalog key of one generic body leaf, for a producer that names the leaf
 * alone.
 */
export function genericBodyCatalogKey<Leaf extends keyof typeof en.generic.body>(
  leaf: Leaf
): `generic.body.${Leaf}` {
  return `generic.body.${leaf}`;
}

/** The one catalog entry the security-lifecycle push reads its body from. */
const SECURITY_LIFECYCLE_BODY_KEY = genericBodyCatalogKey(
  SECURITY_LIFECYCLE_BODY_LEAF
) satisfies PushCatalogKey;

/** The security-finding kinds the internal dispatch producer can send. */
type SecurityFindingNotificationKind = InternalDispatchSecurityFindingRequest['notificationKind'];

/**
 * The catalog entry that carries each security-finding kind's title. A push
 * names its title key in `i18nKey`.
 */
export const SECURITY_FINDING_PUSH_TITLE_KEYS = {
  new_finding: 'internal.securityFindingNew',
  sla_warning: 'internal.securityFindingSlaWarning',
  sla_breach: 'internal.securityFindingSlaBreach',
} as const satisfies Record<SecurityFindingNotificationKind, PushCatalogTitleSection>;

/** The one catalog entry the three security-finding kinds read their body from. */
export const SECURITY_FINDING_PUSH_BODY_KEY =
  'internal.securityFinding.body' satisfies PushCatalogKey;

/**
 * The shared title entry of each push kind, by the `i18nKey` the push names.
 *
 * A kind joins this map when the copy it shows belongs to no single event: the
 * security lifecycle notice announces the product name, and both session kinds
 * announce the session title. Every other kind keeps its own
 * `<i18nKey>.title`.
 */
const SHARED_TITLE_KEYS: ReadonlyMap<string, PushCatalogKey> = new Map([
  [SECURITY_LIFECYCLE_I18N_KEY, GENERIC_PUSH_TITLE_KEY],
  [AGENT_SESSION_NOTIFICATION_I18N_KEY, SESSION_TITLE_KEY],
  [SESSION_READY_I18N_KEY, SESSION_TITLE_KEY],
]);

/**
 * The shared body entry of each push kind, by the `i18nKey` the push names.
 *
 * The three security-finding kinds differ only in their title line, so they
 * read one body entry. The lifecycle notice states a status change, which is
 * the generic security-update sentence. Every other kind keeps its own
 * `<i18nKey>.body`.
 */
const SHARED_BODY_KEYS: ReadonlyMap<string, PushCatalogKey> = new Map([
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
