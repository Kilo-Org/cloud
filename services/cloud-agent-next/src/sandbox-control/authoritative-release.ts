import { confirmStopped, type ObserveResult, type PhysicalRecord } from './physical-lifecycle.js';
import type { StopResult } from './provider.js';

export function releaseIfAuthoritativelyDead(
  record: PhysicalRecord,
  evidence: { stop?: StopResult; observe?: ObserveResult }
): PhysicalRecord {
  if (record.state !== 'failed') return record;
  if (evidence.stop === 'terminal' || evidence.observe === 'terminal') {
    return confirmStopped(record);
  }
  return record;
}
