export { manualAnalysisAdmissionCopy } from './security-agent-command-copy';

export function isAwaitingManualAnalysisAdmission(
  hasActiveStartCommand: boolean,
  analysisStatus: string | null | undefined
): boolean {
  return hasActiveStartCommand && analysisStatus !== 'pending' && analysisStatus !== 'running';
}
