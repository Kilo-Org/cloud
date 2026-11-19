import { translatePush } from './i18n';
import en from './locales/en.json';
import { type PushData } from './push-data';
import { GENERIC_PUSH_TITLE_KEY, SECURITY_LIFECYCLE_BODY_LEAF } from './push-i18n-keys';

type GenericBodyLeaf = keyof typeof en.generic.body;

// Both session variants show one body: the session_live_update carrier is
// data-only (the app draws that notification), and neither variant may show the
// session title.
const SESSION_UPDATE_LEAF: GenericBodyLeaf = 'cloudAgentSession';

// Generic, count-free lock-screen banner copy: the ongoing notification never
// leaks how many agents are running or which sessions they are.
const ACTIVE_AGENTS_LEAF: GenericBodyLeaf = 'activeAgentsGlanceable';

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
  agent_briefing: ACTIVE_AGENTS_LEAF,
  active_agents_glanceable: ACTIVE_AGENTS_LEAF,
};

/**
 * Content-free push copy for the `generic` preview mode. Never embeds a
 * session title, message body, org name, amount, or id — the OS lock-screen
 * text must not leak private content.
 *
 * It is the only push module that reads the locale catalogs, so it stays out of
 * the `./schemas` entry: a consumer that only routes or validates a payload
 * must not load them.
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
    title: translatePush(locale, GENERIC_PUSH_TITLE_KEY, undefined, en.generic.title),
    body: translatePush(locale, `generic.body.${leaf}`, undefined, en.generic.body[leaf]),
  };
}
