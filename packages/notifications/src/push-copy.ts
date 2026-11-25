import { translatePush } from './i18n';
import en from './locales/en.json';
import { type AccountSecurityEvent, type PushData } from './push-data';
import {
  ACCOUNT_SECURITY_BODY_LEAF,
  ACCOUNT_SECURITY_PUSH_BODY_KEYS,
  ACCOUNT_SECURITY_PUSH_TITLE_KEYS,
  accountSecurityPushI18nKey,
  type AccountSecurityPushContext,
  GENERIC_PUSH_TITLE_KEY,
  SECURITY_LIFECYCLE_BODY_LEAF,
} from './push-i18n-keys';
import { type AccountSecurityOrigin } from './rpc-schemas';

type GenericBodyLeaf = keyof typeof en.generic.body;

// Both session variants show one body: the session_live_update carrier is
// data-only (the app draws that notification), and neither variant may show the
// session title.
const SESSION_UPDATE_LEAF: GenericBodyLeaf = 'cloudAgentSession';

// Generic, count-free lock-screen banner copy: the ongoing notification never
// leaks how many agents are running or which sessions they are.
const ACTIVE_AGENTS_LEAF: GenericBodyLeaf = 'activeAgentsGlanceable';

// A scheduled brief is not the ongoing agents card: it announces one report the
// reader can open, so it must not tell the reader their running agents changed.
// It still names no session, count, amount, or brief content.
const BRIEFING_LEAF: GenericBodyLeaf = 'agentBriefing';

/**
 * The one body per `PushData` variant, named by the leaf its sentence lives
 * under in `en.generic.body`. The map is total over `PushData['type']`, so a new
 * variant fails typecheck here until it has an entry, and every value is a key
 * of that catalog subtree, so a leaf `en.json` does not define is a compile
 * error. The key and the English fallback both come from this one leaf.
 */
const GENERIC_BODY_LEAF_BY_TYPE: Record<PushData['type'], GenericBodyLeaf> = {
  cloud_agent_session: SESSION_UPDATE_LEAF,
  session_live_update: SESSION_UPDATE_LEAF,
  low_balance: 'lowBalance',
  spend_alert: 'spendAlert',
  security_finding: 'securityFinding',
  // A status change (analysis finished, remediation queued, …) is not an
  // outstanding finding, so it must not reuse the finding body.
  security_lifecycle: SECURITY_LIFECYCLE_BODY_LEAF,
  agent_briefing: BRIEFING_LEAF,
  // Names no event, device, or place: the lock screen only says that
  // something happened to the account.
  account_security: ACCOUNT_SECURITY_BODY_LEAF,
  active_agents_glanceable: ACTIVE_AGENTS_LEAF,
};

/**
 * The content-free product name a push shows as its title, in `locale`. The
 * English entry is the fallback, so a catalog that lost the entry shows the
 * product name rather than a raw key.
 */
export function genericPushTitle(locale: string | null | undefined): string {
  return translatePush(locale, GENERIC_PUSH_TITLE_KEY, undefined, en.generic.title);
}

/**
 * Content-free push copy for the `generic` preview mode. Never embeds a
 * session title, message body, org name, amount, or id — the OS lock-screen
 * text must not leak private content.
 *
 * It reads the locale catalogs, so it stays out of the `./schemas` entry: a
 * consumer that only routes or validates a payload must not load them.
 */
export function genericPushContentForPushData(
  data: PushData,
  // A token with no locale is English; resolvePushLocale owns that rule.
  locale?: string | null
): { title: string; body: string } {
  // The one generic title is content-free and identical for every variant, so
  // only the body's leaf differs.
  const leaf = GENERIC_BODY_LEAF_BY_TYPE[data.type];
  return {
    title: genericPushTitle(locale),
    body: translatePush(locale, `generic.body.${leaf}`, undefined, en.generic.body[leaf]),
  };
}

function accountSecurityPushContext(origin: AccountSecurityOrigin): AccountSecurityPushContext {
  if (origin.actor === 'support') return 'support';
  if (origin.device !== null && origin.location !== null) return 'deviceAndLocation';
  if (origin.device !== null) return 'device';
  if (origin.location !== null) return 'location';
  return 'unknown';
}

function accountSecurityPushParams(origin: AccountSecurityOrigin): Record<string, string> {
  if (origin.actor === 'support') return {};
  return {
    ...(origin.device !== null ? { device: origin.device } : {}),
    ...(origin.location !== null ? { location: origin.location } : {}),
  };
}

/**
 * The full-preview copy of an account-security notice: a title naming the
 * event and a body naming who acted: the owner's device and approximate
 * location when the request carried them, or Kilo support. `title` and `body`
 * are the English rendering, which the channel shows when a token's catalog
 * cannot resolve `i18nKey`; the generic product copy stands in if even
 * English lost an entry, so the push is never blank.
 */
export function accountSecurityPushCopy(input: {
  event: AccountSecurityEvent;
  origin: AccountSecurityOrigin;
}): { title: string; body: string; i18nKey: string; i18nParams: Record<string, string> } {
  const context = accountSecurityPushContext(input.origin);
  const i18nParams = accountSecurityPushParams(input.origin);
  return {
    title: translatePush(
      'en',
      ACCOUNT_SECURITY_PUSH_TITLE_KEYS[input.event],
      i18nParams,
      en.generic.title
    ),
    body: translatePush(
      'en',
      ACCOUNT_SECURITY_PUSH_BODY_KEYS[context],
      i18nParams,
      en.generic.body[ACCOUNT_SECURITY_BODY_LEAF]
    ),
    i18nKey: accountSecurityPushI18nKey(input.event, context),
    i18nParams,
  };
}
