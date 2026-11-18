import { sha256Hex } from '@kilocode/worker-utils';

import type { CloneBatchRow } from '../dos/SessionIngestDO';

/**
 * The one-line identity of a clone source row: item id, item type, and the
 * stored body reference (the R2 key for an offloaded body, the inline body
 * otherwise). The clone stage digest is built from these lines, so a body
 * change always changes the digest.
 */
export function cloneSourceDigestLine(row: CloneBatchRow): string {
  return `${row.itemId}:${row.itemType}:${row.itemDataR2Key ?? row.itemData}`;
}

/** Bytes one source row adds to a clone window. */
export function cloneSourceRowBytes(row: CloneBatchRow): number {
  const bodyBytes = row.itemDataR2Key === null ? utf8ByteLength(row.itemData) : 0;
  return utf8ByteLength(row.itemId) + utf8ByteLength(row.itemType) + bodyBytes;
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Chain one source row onto the digest of the rows before it. `previous` is
 * empty for the first row.
 *
 * Per-row chaining keeps the stage digest independent of how the source is
 * split into export windows, so a resumed request continues from the digest the
 * stage recorded and a verification pass can read the source in different
 * windows and still compare the same value.
 */
export async function chainCloneRowDigest(previous: string, line: string): Promise<string> {
  return previous === '' ? sha256Hex(line) : sha256Hex(`${previous}\n${line}`);
}
