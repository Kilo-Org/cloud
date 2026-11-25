import { AuditBatchSchema } from '@kilocode/sts-contracts';
import { z } from 'zod';

/** The slice of the R2 bucket binding the archive and checkpoint code needs. */
export type ArchiveBucket = Pick<R2Bucket, 'put' | 'get' | 'head' | 'list'>;

export const ARCHIVE_PREFIX = 'streams/';
export const CHECKPOINT_PREFIX = 'checkpoints/';

const HashSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const ArchivedBatchSchema = z.strictObject({
  batch: AuditBatchSchema,
  prevHash: HashSchema,
  hash: HashSchema,
});
export type ArchivedBatch = z.infer<typeof ArchivedBatchSchema>;

/** The key already holds a different chain hash: a second writer, or a rewritten object. */
export class ArchiveConflictError extends Error {
  constructor(
    readonly key: string,
    readonly storedHash: string,
    readonly expectedHash: string
  ) {
    super(`archive object ${key} holds hash ${storedHash}, expected ${expectedHash}`);
    this.name = 'ArchiveConflictError';
  }
}

export function archiveObjectKey(stream: string, toSeq: number): string {
  return `${ARCHIVE_PREFIX}${stream}/${String(toSeq).padStart(12, '0')}.json.gz`;
}

export function archiveSequenceOf(key: string): number | null {
  const match = /\/(\d{12})\.json\.gz$/.exec(key);
  return match ? Number(match[1]) : null;
}

async function pipeThrough(
  bytes: Uint8Array,
  transform: CompressionStream | DecompressionStream
): Promise<Uint8Array<ArrayBuffer>> {
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Uint8Array(await new Response(source.pipeThrough(transform)).arrayBuffer());
}

export function gzipJson(value: unknown): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return pipeThrough(bytes, new CompressionStream('gzip'));
}

/**
 * Writes an object only if the key is free. A bucket-lock rule rejects the write to a key that
 * already exists; that is success for the caller to confirm by reading the stored object back.
 */
export async function putImmutable(
  bucket: ArchiveBucket,
  key: string,
  body: Uint8Array,
  contentType: string
): Promise<'written' | 'existing'> {
  try {
    await bucket.put(key, body, { httpMetadata: { contentType } });
    return 'written';
  } catch (error) {
    const existing = await bucket.head(key);
    if (!existing) throw error;
    return 'existing';
  }
}

export async function writeArchivedBatch(
  bucket: ArchiveBucket,
  object: ArchivedBatch
): Promise<'written' | 'existing'> {
  const key = archiveObjectKey(object.batch.stream, object.batch.toSeq);
  const outcome = await putImmutable(bucket, key, await gzipJson(object), 'application/gzip');
  if (outcome === 'written') return outcome;

  const stored = await readArchivedObject(bucket, key);
  if (!stored) throw new Error(`archive object ${key} disappeared between write and read`);
  if (stored.hash !== object.hash) {
    throw new ArchiveConflictError(key, stored.hash, object.hash);
  }
  return 'existing';
}

export async function readArchivedObject(
  bucket: ArchiveBucket,
  key: string
): Promise<ArchivedBatch | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  const compressed = new Uint8Array(await object.arrayBuffer());
  const json = await pipeThrough(compressed, new DecompressionStream('gzip'));
  return ArchivedBatchSchema.parse(JSON.parse(new TextDecoder().decode(json)) as unknown);
}

/** Every key under `prefix`, following R2's cursor until the listing is complete. */
export async function listObjectKeys(bucket: ArchiveBucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const object of page.objects) keys.push(object.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}
