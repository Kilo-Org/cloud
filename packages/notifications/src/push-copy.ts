import { translatePush } from './i18n';
import { type PushData } from './push-data';

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
  // The one generic title: content-free and identical for every variant, so
  // only each body's key and fallback differ below. Reading it here per branch,
  // rather than once above the switch, keeps it off the unreachable default.
  const genericTitle = () => translatePush(locale, 'generic.title', undefined, 'Kilo');
  switch (data.type) {
    case 'cloud_agent_session':
      return {
        title: genericTitle(),
        body: translatePush(
          locale,
          'generic.body.cloudAgentSession',
          undefined,
          'Your agent session has an update'
        ),
      };
    case 'chat.message':
      return {
        title: genericTitle(),
        body: translatePush(
          locale,
          'generic.body.chatMessage',
          undefined,
          'You have a new message'
        ),
      };
    case 'instance-lifecycle':
      return {
        title: genericTitle(),
        body: translatePush(
          locale,
          'generic.body.instanceLifecycle',
          undefined,
          'Your instance has an update'
        ),
      };
    case 'scheduled-action':
      return {
        title: genericTitle(),
        body: translatePush(
          locale,
          'generic.body.scheduledAction',
          undefined,
          'A scheduled action has an update'
        ),
      };
    case 'low_balance':
      return {
        title: genericTitle(),
        body: translatePush(
          locale,
          'generic.body.lowBalance',
          undefined,
          'Your balance needs attention'
        ),
      };
    case 'spend_alert':
      return {
        title: genericTitle(),
        body: translatePush(
          locale,
          'generic.body.spendAlert',
          undefined,
          'Your spend needs attention'
        ),
      };
    case 'security_finding':
      return {
        title: genericTitle(),
        body: translatePush(
          locale,
          'generic.body.securityFinding',
          undefined,
          'A security finding needs attention'
        ),
      };
    case 'security_lifecycle':
      // A status change (analysis finished, remediation queued, …) is not an
      // outstanding finding, so it must not reuse the finding body.
      return {
        title: genericTitle(),
        body: translatePush(
          locale,
          'generic.body.securityUpdate',
          undefined,
          'A security check has an update'
        ),
      };
    case 'agent_briefing':
    case 'active_agents_glanceable':
      // Generic, count-free lock-screen banner copy: the ongoing notification
      // never leaks how many agents are running or which sessions they are.
      return {
        title: genericTitle(),
        body: translatePush(
          locale,
          'generic.body.activeAgentsGlanceable',
          undefined,
          'Active agents have an update'
        ),
      };
    case 'session_live_update':
      // Data-only: the app draws the notification. Never the session title.
      return {
        title: genericTitle(),
        body: translatePush(
          locale,
          'generic.body.cloudAgentSession',
          undefined,
          'Your agent session has an update'
        ),
      };
    default: {
      // Exhaustiveness: new PushData variants must be handled above.
      const _exhaustive: never = data;
      return _exhaustive;
    }
  }
}
