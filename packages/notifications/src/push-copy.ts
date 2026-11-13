import { translatePush } from './i18n';
import { type PushData } from './push-data';

type GenericBodyCopy = { key: string; fallback: string };

// Both session variants show one body: the session_live_update carrier is
// data-only (the app draws that notification), and neither variant may show the
// session title.
const SESSION_UPDATE_BODY: GenericBodyCopy = {
  key: 'generic.body.cloudAgentSession',
  fallback: 'Your agent session has an update',
};

// Generic, count-free lock-screen banner copy: the ongoing notification never
// leaks how many agents are running or which sessions they are.
const ACTIVE_AGENTS_BODY: GenericBodyCopy = {
  key: 'generic.body.activeAgentsGlanceable',
  fallback: 'Active agents have an update',
};

/**
 * The one body per `PushData` variant. The map is total over `PushData['type']`,
 * so a new variant fails typecheck here until it has an entry.
 */
const GENERIC_BODY_BY_TYPE: Record<PushData['type'], GenericBodyCopy> = {
  cloud_agent_session: SESSION_UPDATE_BODY,
  session_live_update: SESSION_UPDATE_BODY,
  'chat.message': {
    key: 'generic.body.chatMessage',
    fallback: 'You have a new message',
  },
  'instance-lifecycle': {
    key: 'generic.body.instanceLifecycle',
    fallback: 'Your instance has an update',
  },
  'scheduled-action': {
    key: 'generic.body.scheduledAction',
    fallback: 'A scheduled action has an update',
  },
  low_balance: {
    key: 'generic.body.lowBalance',
    fallback: 'Your balance needs attention',
  },
  spend_alert: {
    key: 'generic.body.spendAlert',
    fallback: 'Your spend needs attention',
  },
  security_finding: {
    key: 'generic.body.securityFinding',
    fallback: 'A security finding needs attention',
  },
  // A status change (analysis finished, remediation queued, …) is not an
  // outstanding finding, so it must not reuse the finding body.
  security_lifecycle: {
    key: 'generic.body.securityUpdate',
    fallback: 'A security check has an update',
  },
  agent_briefing: ACTIVE_AGENTS_BODY,
  active_agents_glanceable: ACTIVE_AGENTS_BODY,
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
  // Old callers omit locale; remove the default when every caller passes a token locale.
  locale: string | null | undefined = 'en'
): { title: string; body: string } {
  // The one generic title is content-free and identical for every variant, so
  // only the body's key and fallback differ.
  const body = GENERIC_BODY_BY_TYPE[data.type];
  return {
    title: translatePush(locale, 'generic.title', undefined, 'Kilo'),
    body: translatePush(locale, body.key, undefined, body.fallback),
  };
}
