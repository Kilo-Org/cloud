import { type AgentStatus, type ResolvedSession } from '@kilocode/cloud-agent-sdk';

export type SessionConnectionState = 'up' | 'down' | 'none';

export function resolveSessionConnectionState(input: {
  activeSessionType: ResolvedSession['type'] | null;
  agentStatusType: AgentStatus['type'];
  userWebConnected: boolean;
}): SessionConnectionState {
  if (input.activeSessionType === 'remote') {
    return !input.userWebConnected || input.agentStatusType === 'disconnected' ? 'down' : 'up';
  }
  if (input.activeSessionType === 'cloud-agent') {
    return input.agentStatusType === 'disconnected' ? 'down' : 'up';
  }
  return 'none';
}
