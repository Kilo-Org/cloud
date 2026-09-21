import { type PushData } from '@kilocode/notifications';

import { chatConversationRoute, chatSandboxRoute } from './kilo-chat-routes';
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

export function notificationPathForData(data: PushData): string {
  // `via=push` marks the resulting session_viewed analytics event as
  // push-originated.
  switch (data.type) {
    case 'cloud_agent_session': {
      return `/(app)/agent-chat/${data.cliSessionId}?via=push`;
    }
    case 'chat.message': {
      return `${chatConversationRoute(data.sandboxId, data.conversationId)}?via=push`;
    }
    case 'low_balance': {
      return `/(app)/(tabs)/(3_profile)/organization/credit-activity?org=${data.organizationId}&via=push`;
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
    case 'instance-lifecycle':
    case 'scheduled-action': {
      return chatSandboxRoute(data.sandboxId);
    }
    case 'active_agents_glanceable': {
      // The aggregate glanceable payload never opens a session chat; it lands
      // on the agents tab.
      return '/(app)/(tabs)/(2_agents)';
    }
    default: {
      // Exhaustiveness: new PushData variants must be handled above.
      const _exhaustive: never = data;
      return _exhaustive;
    }
  }
}
