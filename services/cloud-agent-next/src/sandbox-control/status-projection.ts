export type ReportedSandboxStatus =
  | 'off'
  | 'booting'
  | 'ready'
  | 'working'
  | 'finalizing'
  | 'degraded'
  | 'shutting-down'
  | 'failed'
  | 'unknown';

export type PhysicalState = 'stopped' | 'creating' | 'running' | 'stopping' | 'failed' | 'unknown';
export type ConnectionState = 'disconnected' | 'connected' | 'ready';
export type WorkState = 'idle' | 'active' | 'finalizing';

export function projectReportedStatus(input: {
  physical: PhysicalState;
  connection: ConnectionState;
  work: WorkState;
}): ReportedSandboxStatus {
  switch (input.physical) {
    case 'stopped':
      return 'off';
    case 'failed':
      return 'failed';
    case 'unknown':
      return 'unknown';
    case 'stopping':
      return 'shutting-down';
    case 'creating':
      return 'booting';
    case 'running':
      if (input.connection === 'disconnected') return 'degraded';
      if (input.connection !== 'ready') return 'booting';
      switch (input.work) {
        case 'idle':
          return 'ready';
        case 'active':
          return 'working';
        case 'finalizing':
          return 'finalizing';
      }
  }
}
