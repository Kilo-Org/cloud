import type { AgentStatus, CloudStatus, SdkStatusMessageCode } from './types';

export type SessionStatusIndicator = {
  type: 'error' | 'warning' | 'info' | 'progress';
  message: string;
  timestamp: number;
  commitHash?: string;
  code?: SdkStatusMessageCode;
};

export function indicatorForCloudStatus(cs: CloudStatus): SessionStatusIndicator | null {
  const now = Date.now();
  if (cs.type === 'preparing') {
    return {
      type: 'progress',
      message: cs.message ?? 'Setting up environment…',
      timestamp: now,
      ...(cs.message === undefined ? { code: 'setting-up-environment' } : {}),
    };
  }
  if (cs.type === 'finalizing') {
    return {
      type: 'progress',
      message: cs.message ?? 'Wrapping up…',
      timestamp: now,
      ...(cs.message === undefined ? { code: 'wrapping-up' } : {}),
    };
  }
  if (cs.type === 'error') {
    // The DO writes this text, so it carries no SDK copy code.
    return { type: 'error', message: cs.message, timestamp: now };
  }
  return null; // 'ready' — no indicator
}

export function indicatorForStatus(s: AgentStatus): SessionStatusIndicator | null {
  const now = Date.now();
  if (s.type === 'autocommit') {
    const kind = s.step === 'failed' ? 'error' : s.step === 'completed' ? 'info' : 'progress';
    return {
      type: kind,
      message: s.message,
      timestamp: now,
      ...(s.step === 'completed' && s.commitHash ? { commitHash: s.commitHash } : {}),
      ...(s.code ? { code: s.code } : {}),
    } satisfies SessionStatusIndicator;
  }
  if (s.type === 'disconnected')
    return {
      type: 'error',
      message: 'Agent connection lost',
      timestamp: now,
      code: 'agent-connection-lost',
    };
  if (s.type === 'error')
    return {
      type: 'error',
      message: s.message,
      timestamp: now,
      ...(s.code ? { code: s.code } : {}),
    };
  if (s.type === 'interrupted')
    return { type: 'info', message: 'Session stopped', timestamp: now, code: 'session-stopped' };
  // A scheduled session renders no bottom-bar indicator: the session-detail
  // connection row owns that reading.
  if (s.type === 'scheduled') return null;
  return null;
}
