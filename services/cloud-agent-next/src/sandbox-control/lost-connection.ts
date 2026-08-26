import { observe, type ObserveResult, type PhysicalRecord } from './physical-lifecycle.js';

export function reconcileLostConnection(
  record: PhysicalRecord,
  result: ObserveResult
): { record: PhysicalRecord; armReconnectGrace: boolean } {
  if (record.state !== 'running') {
    return { record, armReconnectGrace: false };
  }
  const next = observe(record, result);
  return {
    record: next,
    armReconnectGrace: next.state === 'running',
  };
}
