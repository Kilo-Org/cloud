import { type SshSessionPhase } from './types';

export function sessionSurface(phase: SshSessionPhase, hasTerminal: boolean) {
  const reconnecting =
    hasTerminal && (phase.kind === 'connecting' || phase.kind === 'reconnecting');
  return {
    stage:
      phase.kind === 'closed' ||
      (!hasTerminal && (phase.kind === 'connecting' || phase.kind === 'reconnecting')),
    terminal: hasTerminal && phase.kind !== 'closed',
    reconnecting,
    inputEnabled: phase.kind === 'connected',
  };
}
