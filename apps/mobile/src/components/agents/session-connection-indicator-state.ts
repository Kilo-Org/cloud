import { type AgentStatus, type ResolvedSession } from '@kilocode/cloud-agent-sdk';

export type SessionConnectionState = 'up' | 'down' | 'exhausted' | 'none';

export function resolveSessionConnectionState(input: {
  activeSessionType: ResolvedSession['type'] | null;
  agentStatusType: AgentStatus['type'];
  userWebConnected: boolean;
  reconnectExhausted: boolean;
}): SessionConnectionState {
  if (input.activeSessionType === 'remote') {
    if (!input.userWebConnected || input.agentStatusType === 'disconnected') {
      return input.reconnectExhausted ? 'exhausted' : 'down';
    }
    return 'up';
  }
  if (input.activeSessionType === 'cloud-agent') {
    return input.agentStatusType === 'disconnected' ? 'down' : 'up';
  }
  return 'none';
}
