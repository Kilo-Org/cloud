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

export type SessionConnectionDisplay =
  | 'connected'
  | 'connecting'
  | 'reconnecting'
  | 'lost'
  | 'scheduled';

export function resolveSessionConnectionDisplay(input: {
  transport: SessionConnectionState;
  userWebConnected: boolean;
  reconnectExhausted: boolean;
  everConnected: boolean;
  /**
   * The agent's own lifecycle status. A `scheduled` agent has no live work to
   * report, so an otherwise-connected transport reads as scheduled rather than
   * connected; a down, lost or exhausted transport still wins.
   */
  agentStatusType?: AgentStatus['type'];
  /** Cached transcript is readable, but session metadata still needs a refresh. */
  sessionRefresh?: { isLoading: boolean };
}): SessionConnectionDisplay {
  const downDisplay: SessionConnectionDisplay = input.everConnected ? 'reconnecting' : 'connecting';
  // A pending metadata refresh reads as connecting; a failed one reads as lost.
  if (input.sessionRefresh) {
    return input.sessionRefresh.isLoading ? downDisplay : 'lost';
  }
  let state = input.transport;
  if (state === 'none') {
    // A session with no live transport (read-only, unresolved) still has the
    // app-wide user-web leg to report, so the row always has a reading.
    if (input.reconnectExhausted) {
      state = 'exhausted';
    } else {
      state = input.userWebConnected ? 'up' : 'down';
    }
  }
  if (state === 'up') {
    return input.agentStatusType === 'scheduled' ? 'scheduled' : 'connected';
  }
  if (state === 'exhausted') {
    return 'lost';
  }
  return downDisplay;
}
