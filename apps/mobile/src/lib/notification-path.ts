import { type PushData } from '@kilocode/notifications/schemas';

import { providerPrRoutePath } from './pr-review/provider-pr-ref';
import { parseProviderPrUrl } from './pr-review/provider-pr-url';
import { getSecurityAgentPath } from './security-agent';

/**
 * The navigable PR-review path for a raise that carries a pull request, or
 * null when the payload has no parseable PR — the Open PR action falls back to
 * the session route instead of landing nowhere.
 */
export function prPathForData(data: PushData): string | null {
  if (data.type !== 'cloud_agent_session' || data.prUrl === undefined) {
    return null;
  }
  const ref = parseProviderPrUrl(data.prUrl);
  if (ref === null) {
    return null;
  }
  // providerPrRoutePath returns Href; coerce to string for query append (cast style of security-agent.ts).
  // A GitLab instance hint already rides as a query param, so the marker joins
  // with the right separator.
  const base = providerPrRoutePath(ref) as string;
  return `${base}${base.includes('?') ? '&' : '?'}via=push`;
}

export function notificationPathForData(
  data: Extract<PushData, { type: 'cloud_agent_session' }>
): string;
export function notificationPathForData(data: PushData): string | null;
export function notificationPathForData(data: PushData): string | null {
  // `via=push` marks the resulting session_viewed analytics event as
  // push-originated.
  switch (data.type) {
    case 'agent_briefing': {
      return '/(app)/agent-briefing?via=push';
    }
    case 'cloud_agent_session': {
      return `/(app)/agent-chat/${data.cliSessionId}?via=push`;
    }
    case 'low_balance': {
      return `/(app)/(tabs)/(3_profile)/organization/credit-activity?org=${data.organizationId}&via=push`;
    }
    case 'spend_alert': {
      // The alert's single CTA opens the scope's spend view: the caller's own
      // screen, or the named organization's.
      return data.scope === 'organization' && data.organizationId
        ? `/(app)/(tabs)/(3_profile)/spend-alerts?org=${data.organizationId}&via=push`
        : '/(app)/(tabs)/(3_profile)/spend-alerts?via=push';
    }
    case 'security_finding':
    case 'security_lifecycle': {
      // getSecurityAgentPath returns Href; coerce to string for query append (cast style of security-agent.ts).
      // security_lifecycle reuses the finding detail path: every WS1 event
      // value carries findingId + scope, and finding creation keeps the
      // visible security_finding push.
      const base = getSecurityAgentPath(data.scope, `findings/${data.findingId}`) as string;
      return `${base}?via=push`;
    }
    case 'account_security': {
      // Each notice opens the screen where its credential can be reviewed and
      // removed: passkeys, sign-in methods, or the signed-in sessions, which
      // include the device a sign-in or an approval created.
      const { event } = data;
      switch (event) {
        case 'passkey_added':
        case 'passkey_removed': {
          return '/(app)/(tabs)/(3_profile)/passkeys?via=push';
        }
        case 'sign_in_method_linked':
        case 'sign_in_method_unlinked': {
          return '/(app)/(tabs)/(3_profile)/login-methods?via=push';
        }
        case 'device_sign_in_approved':
        case 'new_sign_in':
        case 'api_key_reset':
        case 'browser_sessions_revoked': {
          return '/(app)/(tabs)/(3_profile)/device-sessions?via=push';
        }
        default: {
          const _exhaustiveEvent: never = event;
          return _exhaustiveEvent;
        }
      }
    }
    case 'active_agents_glanceable':
    case 'session_live_update': {
      // Neither glanceable payload opens a session chat by itself: the
      // aggregate carrier lands on the agents tab, and the session notification
      // the second one draws carries its own session deep link.
      return '/(app)/(tabs)/(2_agents)';
    }
    default: {
      // Exhaustiveness: new PushData variants must be handled above.
      const _exhaustive: never = data;
      return _exhaustive;
    }
  }
}
