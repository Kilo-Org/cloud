import type { AuditBatch } from '@kilocode/sts-contracts';
import { sha256Hex } from '@kilocode/worker-utils/sha256';
import { canonicalJson } from './canonical';

/**
 * The hash every stream chain starts from. A stream's first batch links to this value, so the
 * chain is a total order over every object the stream ever archived.
 */
export const GENESIS_HASH = '0'.repeat(64);

/** `sha256(prevHash || canonicalJson(batch))`, lowercase hex. */
export function chainHash(prevHash: string, batch: AuditBatch): Promise<string> {
  return sha256Hex(`${prevHash}${canonicalJson(batch)}`);
}
